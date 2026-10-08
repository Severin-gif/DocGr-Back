import { commitDocxSnapshot } from './commit-docx-snapshot';
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DocGridMaterialStorageService, readMaterialBytes } from './docgrid-material-storage.service';
import { DocumentFileService } from '../document-workflow/document-file.service';
import type { StructuredLegalDocument } from '../document-workflow/document-workflow.types';
import { renderWorkspaceDocx, safeDownloadName } from './workspace-document-export';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { objectInput, stringInput, uuidInput, integerInput, assertKeys } from './astra/astra.contracts';

type Item={kind:'material'|'document'|'artifact';id:string;title:string;label:string;role:'main'|'attachment';format:'original'|'docx'|'pdf';sha256?:string;revision?:number;branchId?:string;content?:string;docxBase64?:string;docxHash?:string;structured?:StructuredLegalDocument;size?:number;status?:string};
type PackageRow={id:string;group_id:string;version:number;title:string;metadata:{court:string;caseNumber:string;notes:string};items:Item[];created_at:Date};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const optionalText=(input:Record<string,unknown>,key:string,max:number)=>stringInput(input[key]===''?{...input,[key]:undefined}:input,key,max,false);

@Injectable()
export class CourtPackageService {
  private building=false;
  constructor(private readonly db:PrismaService,private readonly storage:DocGridMaterialStorageService,private readonly files:DocumentFileService){}
  private async access(db:any,user:string,project:string,write=false){
    const rows=await db.$queryRaw`SELECT p.id FROM docgrid.workspace_projects p WHERE p.id=${project}::uuid AND (p.owner_id=${user} OR EXISTS(SELECT 1 FROM docgrid.docgrid_members m WHERE m.project_id=p.id AND m.user_id=${user} AND (${!write} OR m.role IN ('EDITOR','REVIEWER')))) FOR UPDATE OF p`;
    if(!rows.length)throw new NotFoundException('Проект не найден или недостаточно прав');
  }
  private view(row:PackageRow){return {id:row.id,groupId:row.group_id,version:row.version,title:row.title,...row.metadata,createdAt:row.created_at,items:row.items.map(({content,structured,docxBase64,...item})=>item)};}
  async list(user:string,project:string){await this.access(this.db,user,project);const rows=await this.db.$queryRaw<PackageRow[]>`SELECT id,group_id,version,title,metadata,created_at,(SELECT jsonb_agg(item-'content'-'structured'-'docxBase64') FROM jsonb_array_elements(items) item) AS items FROM docgrid.dg_court_packages WHERE project_id=${project}::uuid ORDER BY created_at DESC LIMIT 100`;return rows.map(r=>this.view(r));}
  private async row(user:string,project:string,id:string){await this.access(this.db,user,project);const [row]=await this.db.$queryRaw<PackageRow[]>`SELECT * FROM docgrid.dg_court_packages WHERE id=${id}::uuid AND project_id=${project}::uuid`;if(!row)throw new NotFoundException('Комплект не найден');return row;}
  private async documentSnapshot(db:any,row:any,branch:string,id:string):Promise<Buffer>{
    const {bytes,digest,version}=await commitDocxSnapshot(db,id,row.head_commit_id,row.content,row);
    if(row.head_commit_id){
      // Repair earlier branch-local conversions too; the commit's bytes are authoritative.
      await db.$executeRaw`UPDATE docgrid.docgrid_branch_documents SET docx_bytes=${bytes},docx_sha256=${digest},format_version=${version} WHERE head_commit_id=${row.head_commit_id}::uuid AND document_id=${id}::uuid AND content=${row.content}`;
    }else{
      await db.$executeRaw`UPDATE docgrid.docgrid_branch_documents SET docx_bytes=${bytes},docx_sha256=${digest},format_version=${version} WHERE branch_id=${branch}::uuid AND document_id=${id}::uuid AND revision=${row.revision}`;
    }
    return bytes;
  }
  async capture(user:string,project:string,raw:unknown){
    const input=objectInput(raw);assertKeys(input,['title','court','caseNumber','notes','items','previousId']);
    const title=stringInput(input,'title',180),metadata={court:optionalText(input,'court',300),caseNumber:optionalText(input,'caseNumber',100),notes:optionalText(input,'notes',4000)};
    if(!Array.isArray(input.items)||!input.items.length||input.items.length>200)throw new BadRequestException('Выберите от 1 до 200 документов');
    return this.db.$transaction(async tx=>{
      await this.access(tx,user,project,true);
      const id=randomUUID();let group:string=id,version=1;
      if(input.previousId){const previous=uuidInput(input,'previousId');const [old]=await tx.$queryRaw<PackageRow[]>`SELECT * FROM docgrid.dg_court_packages WHERE id=${previous}::uuid AND project_id=${project}::uuid`;if(!old)throw new NotFoundException('Предыдущий комплект не найден');const [latest]=await tx.$queryRaw<any[]>`SELECT max(version)::int AS version FROM docgrid.dg_court_packages WHERE group_id=${old.group_id}::uuid`;if(latest.version!==old.version)throw new ConflictException('У комплекта уже есть новая версия. Обновите список.');group=old.group_id;version=old.version+1;}
      const items:Item[]=[],seen=new Set<string>();
      let fileBytes=0,textBytes=2; // JSON array brackets; Base64 is accounted as decoded files.
      for(const value of input.items as unknown[]){
        const v=objectInput(value);assertKeys(v,['kind','id','role','label','format','sha256','revision','branchId']);const sourceId=uuidInput(v,'id');
        if(!['material','document','artifact'].includes(String(v.kind))||!['main','attachment'].includes(String(v.role)))throw new BadRequestException('Некорректный элемент комплекта');
        const key=v.kind+':'+sourceId;if(seen.has(key))throw new BadRequestException('Один документ выбран дважды');seen.add(key);
        const label=optionalText(v,'label',180);let item:Item;
        if(v.kind==='material'){
          const [m]=await tx.$queryRaw<any[]>`SELECT id,title,sha256,byte_size AS size,extraction_status AS status FROM docgrid.docgrid_materials WHERE id=${sourceId}::uuid AND project_id=${project}::uuid AND deleted_at IS NULL`;
          if(!m)throw new NotFoundException('Исходный файл удалён или недоступен');if(v.sha256!==m.sha256)throw new ConflictException('Исходный файл изменился. Обновите список.');
          item={kind:'material',id:sourceId,title:m.title,label:label||m.title,role:v.role as Item['role'],format:'original',sha256:m.sha256,size:Number(m.size),status:m.status};
        }else if(v.kind==='document'){
          const branch=uuidInput(v,'branchId'),revision=integerInput(v,'revision',1,2147483647);
          const [d]=await tx.$queryRaw<any[]>`SELECT d.title,b.content,b.revision,b.docx_bytes,b.docx_sha256,b.format_version,b.head_commit_id FROM docgrid.docgrid_branch_documents b JOIN docgrid.workspace_documents d ON d.id=b.document_id JOIN docgrid.docgrid_branches br ON br.id=b.branch_id WHERE d.id=${sourceId}::uuid AND br.id=${branch}::uuid AND br.project_id=${project}::uuid AND d.project_id=${project}::uuid AND d.docgrid_deleted_at IS NULL`;
          if(!d)throw new NotFoundException('Редакция документа не найдена');if(d.revision!==revision)throw new ConflictException('Документ изменился. Обновите список и выберите актуальную редакцию.');
          const bytes=await this.documentSnapshot(tx,d,branch,sourceId);
          item={kind:'document',id:sourceId,title:d.title,label:label||d.title,role:v.role as Item['role'],format:v.format==='pdf'?'pdf':'docx',branchId:branch,revision,content:d.content,size:bytes.length,docxBase64:bytes.toString('base64'),docxHash:hash(bytes),sha256:hash(d.content)};
        }else{
          const revision=integerInput(v,'revision',1,2147483647);
          const rows=await tx.$queryRaw<any[]>`SELECT v.title,v.structured_content AS content,v.docx_object_key,v.checksum FROM docgrid.document_versions v JOIN docgrid.dg_astra_documents a ON a.document_id=v.document_id WHERE a.project_id=${project}::uuid AND v.document_id=${sourceId}::uuid AND v.version=${revision}`;
          if(!rows[0])throw new NotFoundException('Версия подготовленного документа недоступна');
          const bytes=rows[0].docx_object_key?await this.files.read(rows[0].docx_object_key):await this.files.renderDocx(rows[0].content);
          if(rows[0].checksum&&hash(bytes)!==rows[0].checksum)throw new ConflictException('Контрольная сумма DOCX подготовленного документа не совпадает');
          item={kind:'artifact',id:sourceId,title:rows[0].title,label:label||rows[0].title,role:v.role as Item['role'],format:v.format==='pdf'?'pdf':'docx',revision,structured:rows[0].content,size:bytes.length,docxBase64:bytes.toString('base64'),docxHash:hash(bytes),sha256:hash(JSON.stringify(rows[0].content))};
        }
        fileBytes+=item.size||0;
        const {docxBase64,...textItem}=item;
        textBytes+=Buffer.byteLength(JSON.stringify(textItem))+(items.length?1:0);
        if(fileBytes>500*1024*1024||textBytes>8*1024*1024)throw new BadRequestException('Комплект превышает 500 МБ файлов или 8 МБ текста редакций');
        items.push(item);
      }
      if(items.filter(i=>i.role==='main').length!==1||items[0].role!=='main')throw new BadRequestException('Первым должен быть один основной документ');
      const [saved]=await tx.$queryRaw<PackageRow[]>`INSERT INTO docgrid.dg_court_packages(id,project_id,group_id,version,title,metadata,items,created_by) VALUES(${id}::uuid,${project}::uuid,${group}::uuid,${version},${title},${JSON.stringify(metadata)}::jsonb,${JSON.stringify(items)}::jsonb,${user}) RETURNING *`;
      await tx.$executeRaw`INSERT INTO docgrid.docgrid_events(project_id,actor_id,event_type,entity_type,entity_id,metadata) VALUES(${project}::uuid,${user},'package.saved','package',${id}::uuid,${JSON.stringify({title,version,items:items.length})}::jsonb)`;
      return this.view(saved);
    },{timeout:30000});
  }
  async check(user:string,project:string,id:string){
    const row=await this.row(user,project,id),warnings:string[]=[],errors:string[]=[],seen=new Set<string>();
    for(const item of row.items){
      if(item.sha256&&seen.has(item.sha256))warnings.push(`${item.label}: содержимое совпадает с другим приложением`);if(item.sha256)seen.add(item.sha256);
      if(item.kind==='material'){
        const [m]=await this.db.$queryRaw<any[]>`SELECT sha256,deleted_at,extraction_status FROM docgrid.docgrid_materials WHERE id=${item.id}::uuid AND project_id=${project}::uuid`;
        if(!m||m.sha256!==item.sha256)errors.push(`${item.label}: сохранённый оригинал недоступен или повреждён`);
        else {if(m.deleted_at)warnings.push(`${item.label}: находится в корзине; в комплект войдёт сохранённый оригинал`);if(m.extraction_status!=='READY')warnings.push(`${item.label}: текст распознан не полностью`);}
        if(!/\.pdf$/i.test(item.title))warnings.push(`${item.label}: исходный формат сохранён; проверьте допустимость для выбранного способа подачи`);
      }else if(item.kind==='document'){
        const [d]=await this.db.$queryRaw<any[]>`SELECT b.revision,d.docgrid_deleted_at FROM docgrid.docgrid_branch_documents b JOIN docgrid.workspace_documents d ON d.id=b.document_id WHERE b.branch_id=${item.branchId}::uuid AND b.document_id=${item.id}::uuid AND d.project_id=${project}::uuid`;
        if(!d||d.docgrid_deleted_at||d.revision!==item.revision)warnings.push(`${item.label}: исходная редакция изменилась или удалена; комплект содержит сохранённую редакцию ${item.revision}`);
      }
    }
    if(!row.metadata.court)warnings.push('Не указан суд');
    return {state:errors.length?'blocked':warnings.length?'review':'checked',errors,warnings,checkedAt:new Date().toISOString(),scope:'Проверка состава и доступности файлов. Подписи, процессуальные требования и приём судом не проверялись.'};
  }
  async documentFile(user:string,project:string,branch:string,id:string,revision:number,format:string){
    if(!['docx','pdf'].includes(format)||!Number.isSafeInteger(revision)||revision<1)throw new BadRequestException('Выберите формат и сохранённую редакцию');
    const saved=await this.db.$transaction(async tx=>{
      await this.access(tx,user,project);
      const [row]=await tx.$queryRaw<any[]>`SELECT d.title,b.content,b.revision,b.docx_bytes,b.docx_sha256,b.format_version,b.head_commit_id FROM docgrid.docgrid_branch_documents b JOIN docgrid.workspace_documents d ON d.id=b.document_id JOIN docgrid.docgrid_branches br ON br.id=b.branch_id WHERE b.branch_id=${branch}::uuid AND b.document_id=${id}::uuid AND br.project_id=${project}::uuid AND d.project_id=${project}::uuid AND d.docgrid_deleted_at IS NULL FOR UPDATE OF b`;
      if(!row)throw new NotFoundException('Документ не найден');if(row.revision!==revision)throw new ConflictException('Редакция изменилась. Обновите документ перед экспортом.');
      return {title:row.title,bytes:await this.documentSnapshot(tx,row,branch,id)};
    },{timeout:30000});
    let bytes=saved.bytes;
    if(format==='pdf'){try{bytes=await this.files.convertDocxToPdf(bytes);}catch{throw new ServiceUnavailableException('Не удалось создать PDF. DOCX доступен; попробуйте PDF позже.');}}
    await this.access(this.db,user,project);
    return {bytes,title:safeDownloadName(saved.title.replace(/\.docx$/i,''))+'.'+format,mime:format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
  }
  async archive(user:string,project:string,id:string){
    const row=await this.row(user,project,id),check=await this.check(user,project,id);
    if(check.errors.length)throw new ConflictException(check.errors.join('; '));
    if(this.building)throw new ServiceUnavailableException('Сейчас собирается другой комплект. Повторите скачивание через минуту.');
    this.building=true;let directory='',handedOff=false;
    try{
      directory=await mkdtemp(join(tmpdir(),'docgrid-package-'));
      const zip=new JSZip(),manifest:Array<{name:string;sha256:string;size:number;sourceId:string;revision?:number}>=[];let total=0;
      for(let index=0;index<row.items.length;index++){
        const item=row.items[index];let bytes:Buffer,extension:string;
        if(item.kind==='material'){
          const [m]=await this.db.$queryRaw<any[]>`SELECT bytes,storage_key,byte_size,sha256 FROM docgrid.docgrid_materials WHERE id=${item.id}::uuid AND project_id=${project}::uuid`;
          if(!m||m.sha256!==item.sha256)throw new ConflictException('Оригинал недоступен');bytes=await readMaterialBytes(m,this.storage);
          if(hash(bytes)!==item.sha256)throw new ConflictException('Контрольная сумма оригинала не совпадает');extension=/\.[a-z0-9]{1,10}$/i.exec(item.title)?.[0]||'.bin';
        }else{
          bytes=item.docxBase64?Buffer.from(item.docxBase64,'base64'):item.kind==='artifact'?await this.files.renderDocx(item.structured!):await renderWorkspaceDocx(item.content!);
          if(item.docxHash&&hash(bytes)!==item.docxHash)throw new ConflictException('Контрольная сумма сохранённой редакции DOCX не совпадает');
          extension='.'+item.format;
          if(item.format==='pdf'){try{bytes=await this.files.convertDocxToPdf(bytes);}catch{throw new ServiceUnavailableException(`Не удалось создать PDF «${item.label}». Создайте новую версию комплекта с форматом DOCX или повторите позже.`);}}
        }
        total+=bytes.length;if(total>550*1024*1024)throw new BadRequestException('Результат сборки превышает 550 МБ');
        const name=String(index+1).padStart(3,'0')+'_'+safeDownloadName(item.label.replace(/\.(pdf|docx?|txt|rtf|xlsx?|png|jpe?g|tiff?)$/i,''))+extension;
        const path=join(directory,String(index));await writeFile(path,bytes);manifest.push({name,sha256:hash(bytes),size:bytes.length,sourceId:item.id,revision:item.revision});
        zip.file(name,createReadStream(path),{date:new Date(row.created_at)});
      }
      const inventory=[row.title,`Версия комплекта: ${row.version}`,row.metadata.court,row.metadata.caseNumber?`Дело: ${row.metadata.caseNumber}`:'','ОПИСЬ',...manifest.map((f,i)=>`${i+1}. ${row.items[i].label} — ${f.name} (${f.size} байт)`,),row.metadata.notes].filter(Boolean).join('\n');
      zip.file('000_Опись.docx',await renderWorkspaceDocx(inventory));zip.file('000_Опись.txt',inventory);
      zip.file('manifest.json',JSON.stringify({packageId:row.id,version:row.version,createdAt:row.created_at,files:manifest,check},null,2));
      await this.access(this.db,user,project);
      await this.db.$executeRaw`INSERT INTO docgrid.docgrid_events(project_id,actor_id,event_type,entity_type,entity_id,metadata) VALUES(${project}::uuid,${user},'package.exported','package',${id}::uuid,${JSON.stringify({version:row.version,files:manifest.length,bytes:total})}::jsonb)`;
      const stream=zip.generateNodeStream({streamFiles:true,compression:'STORE'}) as Readable;let cleaned=false;const cleanup=()=>{if(cleaned)return;cleaned=true;this.building=false;void rm(directory,{recursive:true,force:true});};stream.once('close',cleanup);stream.once('end',cleanup);stream.once('error',cleanup);handedOff=true;
      return {stream,title:safeDownloadName(row.title)+'_v'+row.version+'.zip'};
    }finally{if(!handedOff){this.building=false;if(directory)await rm(directory,{recursive:true,force:true});}}
  }
}
