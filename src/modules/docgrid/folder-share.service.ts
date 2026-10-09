import { Injectable,BadRequestException,ConflictException,NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { DocGridMaterialStorageService,readMaterialBytes } from './docgrid-material-storage.service';
import { digest,folderPath,inFolder,parsed,shareInput,proposalInput } from './folder-share.protocol';
import { normalizeDocumentContent,RICH_PREFIX } from './document-quality';
import { DOCX_STRUCTURE_VERSION } from './document-structure';
import { renderWorkspaceDocx } from './workspace-document-export';
import { extractMaterialText } from './docgrid-material-extraction';
import { officeView } from './office-view';
import { CorpusRow,corpusReport,corpusSource,documentText } from './shared-corpus';
import { editSpreadsheet } from './office-edit';
type Db=Prisma.TransactionClient;
type Share={id:string;project_id:string;path:string;mode:string;name:string;expires_at:Date;revoked_at:Date|null};
type Entry={id:string;title:string;path:string;content?:string;revision?:number;head?:string;branch?:string;sha256?:string;mime?:string;bytes?:Uint8Array;storage_key?:string;byte_size?:number;docx_bytes?:Uint8Array;docx_sha256?:string};
const MAX_BYTES=32*1024*1024,PROJECT_BYTES=500*1024*1024;
@Injectable()
export class FolderShareService {
 constructor(private readonly db:PrismaService,private readonly storage:DocGridMaterialStorageService){}
 private async access(tx:Db,user:string,project:string,owner=false){
  const rows=await tx.$queryRaw<any[]>`SELECT p.id FROM docgrid.workspace_projects p WHERE p.id=${project}::uuid AND (p.owner_id=${user} OR (${!owner} AND EXISTS(SELECT 1 FROM docgrid.docgrid_members m WHERE m.project_id=p.id AND m.user_id=${user} AND m.role='REVIEWER'))) FOR UPDATE OF p`;
  if(!rows[0])throw new NotFoundException('Проект не найден или недостаточно прав');
 }
 private async share(tx:Db,token:string,propose=false):Promise<Share>{
  if(!/^dgs_[A-Za-z0-9_-]{43}$/.test(token))throw new NotFoundException('Ссылка недоступна');
  const [row]=await tx.$queryRaw<Share[]>`SELECT s.*,p.name FROM docgrid.dg_folder_shares s JOIN docgrid.workspace_projects p ON p.id=s.project_id WHERE s.token_hash=${digest(token)} AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP AND (${!propose} OR s.mode='PROPOSE') FOR SHARE OF s`;
  if(!row)throw new NotFoundException('Ссылка недоступна или не разрешает предложения');return row;
 }
 private async entry(tx:Db,share:Share,kind:string,id:string):Promise<Entry>{
  const rows=kind==='material'
   ?await tx.$queryRaw<Entry[]>`SELECT id,title,path,sha256,mime,bytes,storage_key,byte_size FROM docgrid.docgrid_materials WHERE id=${id}::uuid AND project_id=${share.project_id}::uuid AND deleted_at IS NULL`
   :await tx.$queryRaw<Entry[]>`SELECT d.id,d.title,d.path,b.content,b.revision,b.head_commit_id AS head,b.branch_id AS branch,b.docx_bytes,b.docx_sha256 FROM docgrid.workspace_documents d JOIN docgrid.docgrid_branch_documents b ON b.document_id=d.id JOIN docgrid.docgrid_branches br ON br.id=b.branch_id WHERE d.id=${id}::uuid AND d.project_id=${share.project_id}::uuid AND br.project_id=d.project_id AND br.name='main' AND d.docgrid_deleted_at IS NULL`;
  if(!rows[0]||!inFolder(rows[0].path,share.path))throw new NotFoundException('Файл недоступен');
  // Project locks serialize all proposal merges and existing DocGrid writes.
  return rows[0];
 }
 private stamp(row:Entry){return digest(JSON.stringify([row.id,row.path,row.sha256??null,row.revision??null,row.content??null]));}
 private view(row:Entry,kind:string){return {id:row.id,title:row.title,path:row.path,kind,baseHash:this.stamp(row),mime:row.mime,revision:row.revision};}
 private async folders(tx:Db,project:string,path:string){
  const parts=path.split('/').filter(Boolean);
  for(let i=1;i<=parts.length;i++)await tx.$executeRaw`INSERT INTO docgrid.docgrid_folders(project_id,path) VALUES(${project}::uuid,${'/'+parts.slice(0,i).join('/')}) ON CONFLICT DO NOTHING`;
 }
 private async event(tx:Db,project:string,user:string,type:string,id:string,metadata:unknown={}){
  await tx.$executeRaw`INSERT INTO docgrid.docgrid_events(project_id,actor_id,event_type,entity_type,entity_id,metadata) VALUES(${project}::uuid,${user},${type},'shared-pr',${id}::uuid,${JSON.stringify(metadata)}::jsonb)`;
 }
 async create(user:string,project:string,input:unknown){
  const dto=parsed(shareInput,input),path=folderPath(dto.path),expires=new Date(dto.expiresAt);
  if(expires.getTime()<=Date.now()||expires.getTime()>Date.now()+366*86400000)throw new BadRequestException('Срок ссылки: до одного года');
  return this.db.$transaction(async tx=>{
   await this.access(tx,user,project,true);
   if(path!=='/'&&!(await tx.$queryRaw<any[]>`SELECT id FROM docgrid.docgrid_folders WHERE project_id=${project}::uuid AND path=${path}`)[0])throw new NotFoundException('Папка не найдена');
   const token='dgs_'+randomBytes(32).toString('base64url');
   const [row]=await tx.$queryRaw<any[]>`INSERT INTO docgrid.dg_folder_shares(project_id,token_hash,path,mode,expires_at,created_by) VALUES(${project}::uuid,${digest(token)},${path},${dto.mode},${expires},${user}) RETURNING id,path,mode,expires_at AS "expiresAt",created_at AS "createdAt"`;
   await this.event(tx,project,user,'share.created',row.id,{path,mode:dto.mode});return {...row,token};
  });
 }
 async list(user:string,project:string){return this.db.$transaction(async tx=>{
  await this.access(tx,user,project,true);return tx.$queryRaw<any[]>`SELECT id,path,mode,expires_at AS "expiresAt",revoked_at AS "revokedAt",created_at AS "createdAt" FROM docgrid.dg_folder_shares WHERE project_id=${project}::uuid ORDER BY created_at DESC`;
 });}
 async revoke(user:string,project:string,id:string){return this.db.$transaction(async tx=>{
  await this.access(tx,user,project,true);
  const rows=await tx.$queryRaw<any[]>`UPDATE docgrid.dg_folder_shares SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP) WHERE id=${id}::uuid AND project_id=${project}::uuid RETURNING id`;
  if(!rows[0])throw new NotFoundException('Ссылка не найдена');await this.event(tx,project,user,'share.revoked',id);return {revoked:true};
 });}
 async accessSummary(user:string,project:string){return this.db.$transaction(async tx=>{
  await this.access(tx,user,project,true);
  const [counts]=await tx.$queryRaw<any[]>`SELECT
   (SELECT count(*)::int FROM docgrid.dg_folder_shares WHERE project_id=${project}::uuid AND revoked_at IS NULL AND expires_at>now()) AS links,
   (SELECT count(*)::int FROM docgrid.dg_astra_grants WHERE project_id=${project}::uuid AND builtin=false AND revoked_at IS NULL AND expires_at>now()) AS agents,
   (SELECT count(*)::int FROM docgrid.docgrid_members m JOIN docgrid.workspace_projects p ON p.id=m.project_id WHERE m.project_id=${project}::uuid AND m.user_id<>p.owner_id) AS members`;
  return counts;
 });}
 async revokeAll(user:string,project:string,scope:'external'|'all'){return this.db.$transaction(async tx=>{
  await this.access(tx,user,project,true);
  const links=await tx.$executeRaw`UPDATE docgrid.dg_folder_shares SET revoked_at=now() WHERE project_id=${project}::uuid AND revoked_at IS NULL`;
  const agents=await tx.$executeRaw`UPDATE docgrid.dg_astra_grants SET revoked_at=now() WHERE project_id=${project}::uuid AND builtin=false AND revoked_at IS NULL`;
  const operations=await tx.$executeRaw`UPDATE docgrid.dg_astra_operations SET status='cancelled',updated_at=now() WHERE project_id=${project}::uuid AND status IN ('running','needs_user_action') AND grant_id IN (SELECT id FROM docgrid.dg_astra_grants WHERE project_id=${project}::uuid AND builtin=false AND revoked_at IS NOT NULL)`;
  const members=scope==='all'?await tx.$executeRaw`DELETE FROM docgrid.docgrid_members m USING docgrid.workspace_projects p WHERE m.project_id=p.id AND p.id=${project}::uuid AND m.user_id<>p.owner_id`:0;
  const result={revoked:true,scope,links,agents,operations,members};
  await this.event(tx,project,user,'access.revoked_all',project,result);return result;
 });}
 private async corpus(tx:Db,project:string,path:string){
  // Filter at the database boundary; a prefix such as /Case never includes /Case2.
  const [counts]=await tx.$queryRaw<Array<{total:number}>>`SELECT (
   (SELECT count(*) FROM docgrid.docgrid_materials WHERE project_id=${project}::uuid AND deleted_at IS NULL AND (${path}='/' OR path=${path} OR left(path,length(${path})+1)=${path}||'/'))+
   (SELECT count(*) FROM docgrid.workspace_documents d JOIN docgrid.docgrid_branch_documents b ON b.document_id=d.id JOIN docgrid.docgrid_branches br ON br.id=b.branch_id WHERE d.project_id=${project}::uuid AND br.project_id=d.project_id AND br.name='main' AND d.docgrid_deleted_at IS NULL AND (${path}='/' OR d.path=${path} OR left(d.path,length(${path})+1)=${path}||'/'))+
   (SELECT count(*) FROM docgrid.dg_astra_documents a WHERE a.project_id=${project}::uuid AND (${path}='/' OR a.path=${path} OR left(a.path,length(${path})+1)=${path}||'/'))
  )::int AS total`;
  const materials=await tx.$queryRaw<CorpusRow[]>`SELECT m.id,m.title,m.path,'material' AS kind,m.mime,m.sha256,
   encode(sha256(convert_to(m.extracted_text,'UTF8')),'hex') AS fingerprint,encode(sha256(convert_to(m.extracted_pages::text,'UTF8')),'hex') AS "pageFingerprint",
   LEAST(char_length(m.extracted_text),2000000) AS characters,m.extracted_text ~ '[^[:space:]]' AS "hasText",
   CASE WHEN char_length(m.extracted_text)>2000000 THEN 'PARTIAL' ELSE m.extraction_status END AS status,
   CASE WHEN char_length(m.extracted_text)>2000000 THEN 'text_limit' ELSE m.extraction_reason END AS reason,j.total_pages AS "totalPages",j.state AS "ocrState"
   FROM docgrid.docgrid_materials m LEFT JOIN docgrid.dg_ocr_jobs j ON j.material_id=m.id
   WHERE m.project_id=${project}::uuid AND m.deleted_at IS NULL AND (${path}='/' OR m.path=${path} OR left(m.path,length(${path})+1)=${path}||'/') ORDER BY m.path,m.title,m.id LIMIT 5000`;
  const documents=await tx.$queryRaw<CorpusRow[]>`WITH sources AS (
   SELECT d.id,d.title,d.path,'document' AS kind,b.revision,b.content
   FROM docgrid.workspace_documents d JOIN docgrid.docgrid_branch_documents b ON b.document_id=d.id JOIN docgrid.docgrid_branches br ON br.id=b.branch_id
   WHERE d.project_id=${project}::uuid AND br.project_id=d.project_id AND br.name='main' AND d.docgrid_deleted_at IS NULL AND (${path}='/' OR d.path=${path} OR left(d.path,length(${path})+1)=${path}||'/')
   UNION ALL
   SELECT d.id,d.title,a.path,'artifact' AS kind,d.current_version AS revision,COALESCE(v.plain_text,'') AS content
   FROM docgrid.dg_astra_documents a JOIN docgrid.prepared_legal_documents d ON d.id=a.document_id LEFT JOIN docgrid.document_versions v ON v.document_id=d.id AND v.version=d.current_version
   WHERE a.project_id=${project}::uuid AND (${path}='/' OR a.path=${path} OR left(a.path,length(${path})+1)=${path}||'/')
  ) SELECT id,title,path,kind,revision,encode(sha256(convert_to(content,'UTF8')),'hex') AS fingerprint,content,0 AS characters,true AS "hasText",'READY' AS status,NULL AS reason FROM (
   SELECT *,sum(octet_length(content)) OVER (ORDER BY path,title,id) AS cumulative_bytes FROM sources
  ) bounded WHERE cumulative_bytes<=33554432 ORDER BY path,title,id LIMIT 5000`;
  return corpusReport([...materials,...documents],Number(counts.total));
 }
 async coverage(user:string,project:string,path:string){return this.db.$transaction(async tx=>{
  await this.access(tx,user,project,true);return {path:folderPath(path),...await this.corpus(tx,project,folderPath(path))};
 });}
 async manifest(token:string,offset=0,limit=50,indexVersion?:string){return this.db.$transaction(async tx=>{
  const share=await this.share(tx,token),report=await this.corpus(tx,share.project_id,share.path);
  if(indexVersion&&indexVersion!==report.indexVersion)throw new ConflictException('Список источников изменился. Начните чтение списка заново.');
  if(offset>report.indexed)throw new BadRequestException('Смещение за пределами списка');
  return {name:share.name,path:share.path,expiresAt:share.expires_at,...report,sources:report.sources.slice(offset,offset+limit),sourceOffset:offset,nextSourceOffset:offset+limit<report.indexed?offset+limit:null};
 });}
 async text(token:string,kind:string,id:string,version:string,offset:number,limit:number){return this.db.$transaction(async tx=>{
  const share=await this.share(tx,token);
  const rows=kind==='material'
   ?await tx.$queryRaw<Array<CorpusRow&{text:string;pages:unknown}>>`SELECT m.id,m.title,m.path,'material' AS kind,m.mime,m.sha256,
    encode(sha256(convert_to(m.extracted_text,'UTF8')),'hex') AS fingerprint,encode(sha256(convert_to(m.extracted_pages::text,'UTF8')),'hex') AS "pageFingerprint",left(m.extracted_text,2000000) AS text,m.extracted_pages AS pages,
    LEAST(char_length(m.extracted_text),2000000) AS characters,m.extracted_text ~ '[^[:space:]]' AS "hasText",
    CASE WHEN char_length(m.extracted_text)>2000000 THEN 'PARTIAL' ELSE m.extraction_status END AS status,
    CASE WHEN char_length(m.extracted_text)>2000000 THEN 'text_limit' ELSE m.extraction_reason END AS reason,j.total_pages AS "totalPages",j.state AS "ocrState"
    FROM docgrid.docgrid_materials m LEFT JOIN docgrid.dg_ocr_jobs j ON j.material_id=m.id WHERE m.id=${id}::uuid AND m.project_id=${share.project_id}::uuid AND m.deleted_at IS NULL`
   :kind==='document'?await tx.$queryRaw<Array<CorpusRow&{text?:string;pages?:unknown}>>`SELECT d.id,d.title,d.path,'document' AS kind,b.revision,b.content,encode(sha256(convert_to(b.content,'UTF8')),'hex') AS fingerprint,0 AS characters,true AS "hasText",'READY' AS status,NULL AS reason FROM docgrid.workspace_documents d JOIN docgrid.docgrid_branch_documents b ON b.document_id=d.id JOIN docgrid.docgrid_branches br ON br.id=b.branch_id WHERE d.id=${id}::uuid AND d.project_id=${share.project_id}::uuid AND br.project_id=d.project_id AND br.name='main' AND d.docgrid_deleted_at IS NULL AND octet_length(b.content)<=33554432`
   :await tx.$queryRaw<Array<CorpusRow&{text?:string;pages?:unknown}>>`SELECT d.id,d.title,a.path,'artifact' AS kind,d.current_version AS revision,COALESCE(v.plain_text,'') AS content,encode(sha256(convert_to(COALESCE(v.plain_text,''),'UTF8')),'hex') AS fingerprint,0 AS characters,true AS "hasText",'READY' AS status,NULL AS reason FROM docgrid.dg_astra_documents a JOIN docgrid.prepared_legal_documents d ON d.id=a.document_id LEFT JOIN docgrid.document_versions v ON v.document_id=d.id AND v.version=d.current_version WHERE d.id=${id}::uuid AND a.project_id=${share.project_id}::uuid AND octet_length(COALESCE(v.plain_text,''))<=33554432`;
  const row=rows[0];if(!row||!inFolder(row.path,share.path))throw new NotFoundException('Файл недоступен');
  const source=corpusSource(row);
  if(source.version!==version)throw new ConflictException('Текст или версия файла изменились. Получите новый список источников.');
  const text=kind==='material'?row.text!:kind==='document'?documentText(row.content || ''):row.content || '';
  if(offset>text.length)throw new BadRequestException('Смещение за пределами текста');
  let end=Math.min(offset+limit,text.length);
  // Avoid splitting an astral code point between consecutive chunks.
  if(end<text.length&&end>offset&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
  return {...source,text:text.slice(offset,end),offset,nextOffset:end<text.length?end:null,totalCharacters:text.length,offsetUnit:'UTF-16 code units',pages:row.pages || [],pageOffsetUnit:'UTF-16 code units'};
 });}
 async files(token:string){return this.db.$transaction(async tx=>{
  const share=await this.share(tx,token);
  const materials=await tx.$queryRaw<Entry[]>`SELECT id,title,path,sha256,mime FROM docgrid.docgrid_materials WHERE project_id=${share.project_id}::uuid AND deleted_at IS NULL ORDER BY path,title`;
  const documents=await tx.$queryRaw<Entry[]>`SELECT d.id,d.title,d.path,b.content,b.revision FROM docgrid.workspace_documents d JOIN docgrid.docgrid_branch_documents b ON b.document_id=d.id JOIN docgrid.docgrid_branches br ON br.id=b.branch_id WHERE d.project_id=${share.project_id}::uuid AND br.project_id=d.project_id AND br.name='main' AND d.docgrid_deleted_at IS NULL ORDER BY d.path,d.title`;
  const folders=await tx.$queryRaw<any[]>`SELECT path FROM docgrid.docgrid_folders WHERE project_id=${share.project_id}::uuid ORDER BY path`;
  return {name:share.name,path:share.path,mode:share.mode,expiresAt:share.expires_at,files:[...materials.filter(r=>inFolder(r.path,share.path)).map(r=>this.view(r,'material')),...documents.filter(r=>inFolder(r.path,share.path)).map(r=>this.view(r,'document'))],folders:folders.filter(r=>inFolder(r.path,share.path))};
 });}
 async read(token:string,kind:string,id:string){
  const row=await this.db.$transaction(async tx=>this.entry(tx,await this.share(tx,token),kind,id));
  const bytes=kind==='material'?await readMaterialBytes(row as any,this.storage):row.docx_bytes?Buffer.from(row.docx_bytes):await renderWorkspaceDocx(row.content!);
  if(kind==='document'&&row.docx_sha256&&createHash('sha256').update(bytes).digest('hex')!==row.docx_sha256)throw new ConflictException('Контрольная сумма DOCX не совпадает');
  await this.db.$transaction(async tx=>this.entry(tx,await this.share(tx,token),kind,id));
  return {bytes,title:kind==='material'?row.title:row.title.replace(/\.docx$/i,'')+'.docx'};
 }
 async content(token:string,kind:string,id:string){
  const row=await this.db.$transaction(async tx=>this.entry(tx,await this.share(tx,token),kind,id));
  const view=kind==='document'?{kind:'docx',content:row.content,warnings:[]}:await officeView(row.title,await readMaterialBytes(row as any,this.storage));
  const after=await this.db.$transaction(async tx=>this.entry(tx,await this.share(tx,token),kind,id));
  if(this.stamp(after)!==this.stamp(row))throw new ConflictException('Файл изменился. Откройте его заново.');
  return {...this.view(row,kind),view};
 }
 async propose(user:string,token:string,input:unknown){
  const dto=parsed(proposalInput,input);
  if(dto.kind==='EDIT'&&dto.fileKind==='document'&&dto.content===undefined)throw new BadRequestException('Нужен текст DOCX');
  const initial=await this.db.$transaction(async tx=>{
   const share=await this.share(tx,token,true);return {share,row:await this.entry(tx,share,dto.fileKind,dto.id)};
  });
  const {row}=initial;
  if(this.stamp(row)!==dto.baseHash)throw new ConflictException('Файл изменился. Обновите его перед отправкой PR.');
  let bytes:Buffer|null=null,content:string|undefined,title=row.title,mime=row.mime;
  let before:unknown=row.content??null,changes:unknown=null;
  if(dto.kind==='EDIT'){
   if(dto.fileKind==='document'){
    if(dto.content===undefined||dto.cells)throw new BadRequestException('Нужен текст редакции DOCX');
    content=normalizeDocumentContent(dto.content);
    bytes=await renderWorkspaceDocx(content);mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
   }else if(/\.docx$/i.test(row.title)){
    if(dto.content===undefined||dto.cells||!dto.content.startsWith(RICH_PREFIX))throw new BadRequestException('Нужна редакция DOCX');
    const view=await officeView(row.title,await readMaterialBytes(row as any,this.storage)) as any;
    before=normalizeDocumentContent(RICH_PREFIX+view.html);content=normalizeDocumentContent(dto.content);
    bytes=await renderWorkspaceDocx(content);mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
   }else if(/\.(xlsx|xls)$/i.test(row.title)){
    if(!dto.cells||dto.content!==undefined)throw new BadRequestException('Нужны правки ячеек Excel');
    const original=await readMaterialBytes(row as any,this.storage),view=await officeView(row.title,original) as any;
    if(view.sheets.some((s:any)=>s.partial)||view.warnings.some((w:string)=>w.includes('50 листов')))throw new BadRequestException('Книга показана частично. Правки через PR недоступны.');
    const seen=new Set<string>();
    changes=dto.cells.map(p=>{
     const sheet=view.sheets.find((s:any)=>s.name===p.sheet);if(!sheet)throw new BadRequestException('Лист не найден');
     const key=JSON.stringify([p.sheet,p.row,p.column]);if(seen.has(key))throw new BadRequestException('Ячейка повторяется');seen.add(key);
     const c=sheet.rows.find((r:any)=>r.index===p.row)?.cells.find((c:any)=>c.column===p.column);
     return {...p,before:c?.formula?'='+c.formula:c?.value||''};
    });
    bytes=await editSpreadsheet(row.title,original,dto.cells);title=title.replace(/\.xls$/i,'.xlsx');mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
   }else throw new BadRequestException('Правка содержимого доступна только для DOCX и Excel');
   if(content===before||Array.isArray(changes)&&changes.every(p=>p.value===p.before))throw new BadRequestException('Нет изменений');
  }
  if(bytes&&bytes.length>MAX_BYTES)throw new BadRequestException('Редакция превышает 32 МБ');
  const path=dto.kind==='MOVE'?folderPath(dto.path):row.path;
  if(!inFolder(path,initial.share.path))throw new BadRequestException('Перемещение за пределы общей папки недоступно');
  if(dto.kind==='MOVE'&&path===row.path)throw new BadRequestException('Папка не изменилась');
  return this.db.$transaction(async tx=>{
   // Lock order is project -> share everywhere a mutation is involved.
   await tx.$queryRaw`SELECT id FROM docgrid.workspace_projects WHERE id=${initial.share.project_id}::uuid FOR UPDATE`;
   const share=await this.share(tx,token,true),fresh=await this.entry(tx,share,dto.fileKind,dto.id);
   if(this.stamp(fresh)!==dto.baseHash)throw new ConflictException('Файл изменился. Обновите его.');
   if(bytes)await this.quota(tx,share.project_id,bytes.length);
   const payload={fileKind:dto.fileKind,id:dto.id,baseHash:dto.baseHash,fromPath:row.path,path,title,mime,content,before,changes,sourceTitle:row.title};
   const [pr]=await tx.$queryRaw<any[]>`INSERT INTO docgrid.dg_shared_proposals(project_id,share_id,author_id,title,body,kind,payload,bytes,byte_size) VALUES(${share.project_id}::uuid,${share.id}::uuid,${user},${dto.title},${dto.body},${dto.kind},${JSON.stringify(payload)}::jsonb,${bytes}::bytea,${bytes?.length||0}) RETURNING id,status`;
   await this.event(tx,share.project_id,user,'shared-pr.opened',pr.id,{kind:dto.kind});return pr;
  });
 }
 private async quota(tx:Db,project:string,size:number,exclude?:string){
  const [row]=await tx.$queryRaw<any[]>`SELECT (SELECT COALESCE(sum(byte_size),0) FROM docgrid.docgrid_materials WHERE project_id=${project}::uuid)+(SELECT COALESCE(sum(byte_size),0) FROM docgrid.dg_shared_proposals WHERE project_id=${project}::uuid AND status='OPEN' AND (${exclude??null}::uuid IS NULL OR id<>${exclude??null}::uuid)) AS size`;
  if(Number(row.size)+size>PROJECT_BYTES)throw new BadRequestException('В проекте доступно 500 МБ, включая исходники и открытые PR');
 }
 async upload(user:string,token:string,file:{originalname:string;mimetype:string;buffer:Buffer},path:unknown,body:unknown){
  if(!file?.buffer?.length||file.buffer.length>MAX_BYTES)throw new BadRequestException('Новый файл: от 1 байта до 32 МБ');
  if(body!==undefined&&(typeof body!=='string'||body.length>4000))throw new BadRequestException('Слишком длинное описание');
  const decoded=Buffer.from(file.originalname,'latin1').toString('utf8');
  const title=(/[^\u0000-\u00ff]/.test(file.originalname)||decoded.includes('\uFFFD')?file.originalname:decoded).replace(/[\u0000-\u001f/\\]/g,'_').slice(0,180);
  const destination=folderPath(path);
  await this.db.$transaction(async tx=>{const share=await this.share(tx,token,true);if(!inFolder(destination,share.path))throw new BadRequestException('Папка за пределами общего доступа');});
  // Extraction runs before the transaction; the accepted bytes are immutable.
  const extraction=await extractMaterialText(title,file.buffer);
  return this.db.$transaction(async tx=>{
   const [s]=await tx.$queryRaw<any[]>`SELECT project_id FROM docgrid.dg_folder_shares WHERE token_hash=${digest(token)}`;
   if(!s)throw new NotFoundException('Ссылка недоступна');
   await tx.$queryRaw`SELECT id FROM docgrid.workspace_projects WHERE id=${s.project_id}::uuid FOR UPDATE`;
   const share=await this.share(tx,token,true);
   if(!inFolder(destination,share.path))throw new BadRequestException('Папка за пределами общего доступа');
   await this.quota(tx,share.project_id,file.buffer.length);
   const payload={path:destination,title,mime:(file.mimetype||'application/octet-stream').slice(0,150),extraction};
   const [pr]=await tx.$queryRaw<any[]>`INSERT INTO docgrid.dg_shared_proposals(project_id,share_id,author_id,title,body,kind,payload,bytes,byte_size) VALUES(${share.project_id}::uuid,${share.id}::uuid,${user},${'Добавить: '+title.substring(0,170)},${body||''},'ADD',${JSON.stringify(payload)}::jsonb,${file.buffer}::bytea,${file.buffer.length}) RETURNING id,status`;
   await this.event(tx,share.project_id,user,'shared-pr.opened',pr.id,{kind:'ADD'});return pr;
  });
 }
 async proposals(user:string,project:string){return this.db.$transaction(async tx=>{
  await this.access(tx,user,project);
  return tx.$queryRaw<any[]>`SELECT p.id,p.title,p.body,p.kind,p.status,p.payload,p.byte_size AS size,p.created_at AS "createdAt",p.decided_at AS "decidedAt",p.result_id AS "resultId",u.email AS author FROM docgrid.dg_shared_proposals p JOIN docgrid."User" u ON u.id=p.author_id WHERE p.project_id=${project}::uuid ORDER BY p.created_at DESC LIMIT 200`;
 });}
 async mine(user:string,token:string){return this.db.$transaction(async tx=>{
  const share=await this.share(tx,token);
  return tx.$queryRaw<any[]>`SELECT id,title,kind,status,created_at AS "createdAt" FROM docgrid.dg_shared_proposals WHERE share_id=${share.id}::uuid AND author_id=${user} ORDER BY created_at DESC LIMIT 100`;
 });}
 async candidate(user:string,project:string,id:string){return this.db.$transaction(async tx=>{
  await this.access(tx,user,project);
  const [row]=await tx.$queryRaw<any[]>`SELECT bytes,payload FROM docgrid.dg_shared_proposals WHERE id=${id}::uuid AND project_id=${project}::uuid`;
  if(!row?.bytes)throw new NotFoundException('Файл предложения недоступен');return {bytes:Buffer.from(row.bytes),title:row.payload.title};
 });}
 async decide(user:string,project:string,id:string,accept:boolean){return this.db.$transaction(async tx=>{
  await this.access(tx,user,project);
  const [pr]=await tx.$queryRaw<any[]>`SELECT * FROM docgrid.dg_shared_proposals WHERE id=${id}::uuid AND project_id=${project}::uuid FOR UPDATE`;
  if(!pr)throw new NotFoundException('PR не найден');
  if(pr.status!=='OPEN')throw new ConflictException('PR уже рассмотрен');
  if(!accept){await tx.$executeRaw`UPDATE docgrid.dg_shared_proposals SET status='CLOSED',bytes=NULL,byte_size=0,decided_at=CURRENT_TIMESTAMP,decided_by=${user} WHERE id=${id}::uuid`;await this.event(tx,project,user,'shared-pr.closed',id);return {status:'CLOSED'};}
  const [share]=await tx.$queryRaw<Share[]>`SELECT * FROM docgrid.dg_folder_shares WHERE id=${pr.share_id}::uuid AND revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP FOR SHARE`;
  if(!share)throw new ConflictException('Доступ по ссылке отозван или истёк. PR можно отклонить.');
  const p=pr.payload;let row:Entry|undefined,resultId=p.id;
  if(pr.kind!=='ADD'){
   row=await this.entry(tx,share,p.fileKind,p.id);
   if(this.stamp(row)!==p.baseHash)throw new ConflictException('Файл или редакция изменились после отправки PR. Требуется новый PR.');
  }
  if(pr.kind==='MOVE'){
   await this.collision(tx,project,p.fileKind,row!.title,p.path,row!.id);await this.folders(tx,project,p.path);
   if(p.fileKind==='material')await tx.$executeRaw`UPDATE docgrid.docgrid_materials SET path=${p.path} WHERE id=${p.id}::uuid`;
   else await tx.$executeRaw`UPDATE docgrid.workspace_documents SET path=${p.path},updated_at=CURRENT_TIMESTAMP WHERE id=${p.id}::uuid`;
  }else if(pr.kind==='EDIT'&&p.fileKind==='document'){
   const content=p.content,next=row!.revision!+1,commitId=randomUUID();
   await tx.$executeRaw`INSERT INTO docgrid.docgrid_commits(id,project_id,branch_id,document_id,parent_commit_id,author_id,message,before_content,after_content,content_hash) VALUES(${commitId}::uuid,${project}::uuid,${row!.branch}::uuid,${p.id}::uuid,${row!.head}::uuid,${pr.author_id},${pr.title},${row!.content},${content},${digest([row!.branch,p.id,String(next),pr.title,content].join('\0'))})`;
   await tx.$executeRaw`UPDATE docgrid.docgrid_branch_documents SET content=${content},revision=${next},head_commit_id=${commitId}::uuid,workspace_version=workspace_version+1,updated_at=CURRENT_TIMESTAMP WHERE branch_id=${row!.branch}::uuid AND document_id=${p.id}::uuid`;
   const bytes=pr.bytes?Buffer.from(pr.bytes):await renderWorkspaceDocx(content),hash=createHash('sha256').update(bytes).digest('hex');
   await tx.$executeRaw`UPDATE docgrid.docgrid_branch_documents SET docx_bytes=${bytes},docx_sha256=${hash},format_version=${DOCX_STRUCTURE_VERSION} WHERE branch_id=${row!.branch}::uuid AND document_id=${p.id}::uuid`;
   await tx.$executeRaw`UPDATE docgrid.docgrid_commits SET docx_bytes=${bytes},docx_sha256=${hash},format_version=${DOCX_STRUCTURE_VERSION} WHERE id=${commitId}::uuid`;
   const [doc]=await tx.$queryRaw<any[]>`UPDATE docgrid.workspace_documents SET content=${content},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${p.id}::uuid RETURNING version`;
   await tx.$executeRaw`INSERT INTO docgrid.workspace_document_versions(document_id,version,content,author_id,message) VALUES(${p.id}::uuid,${doc.version},${content},${pr.author_id},${pr.title})`;
  }else{
   const bytes=Buffer.from(pr.bytes);await this.quota(tx,project,bytes.length,id);
   const title=pr.kind==='EDIT'?p.title.replace(/\.(docx|xlsx)$/i,'')+' — редакция '+id.substring(0,8)+(/\.docx$/i.test(p.title)?'.docx':'.xlsx'):p.title;
   await this.collision(tx,project,'material',title,p.path);await this.folders(tx,project,p.path);
   const extracted=p.extraction||{text:'',status:'UNREAD',reason:null};
   const hash=createHash('sha256').update(bytes).digest('hex');
   const [material]=await tx.$queryRaw<any[]>`INSERT INTO docgrid.docgrid_materials(project_id,title,path,mime,bytes,byte_size,sha256,extracted_text,extraction_status,extraction_reason,created_by) VALUES(${project}::uuid,${title},${p.path},${p.mime},${bytes}::bytea,${bytes.length},${hash},${extracted.text},${extracted.status},${extracted.reason},${pr.author_id}) RETURNING id`;
   resultId=material.id;
  }
  await tx.$executeRaw`UPDATE docgrid.dg_shared_proposals SET status='MERGED',bytes=NULL,byte_size=0,decided_at=CURRENT_TIMESTAMP,decided_by=${user},result_id=${resultId}::uuid WHERE id=${id}::uuid`;
  await tx.$executeRaw`UPDATE docgrid.docgrid_branches SET updated_at=CURRENT_TIMESTAMP WHERE project_id=${project}::uuid AND name='main'`;
  await tx.$executeRaw`UPDATE docgrid.workspace_projects SET updated_at=CURRENT_TIMESTAMP WHERE id=${project}::uuid`;
  await this.event(tx,project,user,'shared-pr.merged',id,{kind:pr.kind,resultId});return {status:'MERGED',resultId};
 },{timeout:30000});}
 private async collision(tx:Db,project:string,kind:string,title:string,path:string,except?:string){
  const rows=kind==='material'?await tx.$queryRaw<any[]>`SELECT id FROM docgrid.docgrid_materials WHERE project_id=${project}::uuid AND title=${title} AND path=${path} AND deleted_at IS NULL AND (${except??null}::uuid IS NULL OR id<>${except??null}::uuid)`:await tx.$queryRaw<any[]>`SELECT id FROM docgrid.workspace_documents WHERE project_id=${project}::uuid AND title=${title} AND path=${path} AND docgrid_deleted_at IS NULL AND (${except??null}::uuid IS NULL OR id<>${except??null}::uuid)`;
  if(rows.length)throw new ConflictException('В папке уже есть файл с таким именем');
 }
}
