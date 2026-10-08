import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import JSZip from 'jszip';
import { CourtPackageService } from './modules/docgrid/court-package.service';
import { renderWorkspaceDocx } from './modules/docgrid/workspace-document-export';

const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const MiB=1024*1024;
function adapter(db:any):any {
  const query=(parts:TemplateStringsArray,args:unknown[])=>db.query(parts.map((p,i)=>p+(i<args.length?'$'+(i+1):'')).join(''),args);
  return {
    $queryRaw:async(parts:TemplateStringsArray,...args:unknown[])=>(await query(parts,args)).rows,
    $executeRaw:async(parts:TemplateStringsArray,...args:unknown[])=>(await query(parts,args)).affectedRows,
    $transaction:(fn:(tx:any)=>unknown)=>db.transaction((tx:any)=>fn(adapter(tx))),
  };
}

test('court package snapshots and resource limits (PostgreSQL semantics)', async t=>{
  const pg=await PGlite.create();t.after(()=>pg.close());
  await pg.exec(`CREATE SCHEMA docgrid;
    CREATE TABLE docgrid.workspace_projects(id uuid PRIMARY KEY,owner_id text);
    CREATE TABLE docgrid.docgrid_members(project_id uuid,user_id text,role text);
    CREATE TABLE docgrid.docgrid_branches(id uuid PRIMARY KEY,project_id uuid);
    CREATE TABLE docgrid.workspace_documents(id uuid PRIMARY KEY,project_id uuid,title text,docgrid_deleted_at timestamp);
    CREATE TABLE docgrid.docgrid_commits(id uuid PRIMARY KEY,document_id uuid,after_content text,docx_bytes bytea,docx_sha256 text,format_version text);
    CREATE TABLE docgrid.docgrid_branch_documents(branch_id uuid,document_id uuid,content text,revision int,head_commit_id uuid,docx_bytes bytea,docx_sha256 text,format_version text);
    CREATE TABLE docgrid.docgrid_materials(id uuid,project_id uuid,title text,sha256 text,byte_size bigint,extraction_status text,deleted_at timestamp);
    CREATE TABLE docgrid.dg_court_packages(id uuid PRIMARY KEY,project_id uuid,group_id uuid,version int,title text,metadata jsonb,items jsonb,created_by text,created_at timestamp DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE docgrid.docgrid_events(project_id uuid,actor_id text,event_type text,entity_type text,entity_id uuid,metadata jsonb);`);
  const db=adapter(pg),service=new CourtPackageService(db,{} as never,{} as never);
  const project=randomUUID(),a=randomUUID(),b=randomUUID(),c=randomUUID(),doc=randomUUID(),commit=randomUUID();
  await pg.query('INSERT INTO docgrid.workspace_projects VALUES ($1,$2)',[project,'owner']);
  for(const branch of [a,b,c])await pg.query('INSERT INTO docgrid.docgrid_branches VALUES ($1,$2)',[branch,project]);
  await pg.query('INSERT INTO docgrid.workspace_documents(id,project_id,title) VALUES ($1,$2,$3)',[doc,project,'Иск']);
  await pg.query('INSERT INTO docgrid.docgrid_commits(id,document_id,after_content) VALUES ($1,$2,$3)',[commit,doc,'Старый текст']);
  for(const branch of [a,b,c])await pg.query('INSERT INTO docgrid.docgrid_branch_documents(branch_id,document_id,content,revision,head_commit_id) VALUES ($1,$2,$3,1,$4)',[branch,doc,'Старый текст',commit]);
  const download=(branch:string)=>service.documentFile('owner',project,branch,doc,1,'docx');
  let original:Buffer;
  await t.test('lazy conversion populates every branch and repeated exports reuse the commit',async()=>{
    original=(await download(a)).bytes;
    for(const branch of [b,c,a])assert.deepEqual((await download(branch)).bytes,original);
    const rows=await pg.query<any>('SELECT docx_bytes,docx_sha256 FROM docgrid.docgrid_branch_documents');
    for(const row of rows.rows){assert.deepEqual(Buffer.from(row.docx_bytes),original);assert.equal(row.docx_sha256,hash(original));}
    const [saved]=await db.$queryRaw`SELECT docx_bytes FROM docgrid.docgrid_commits`;
    assert.deepEqual(Buffer.from(saved.docx_bytes),original);
  });
  await t.test('existing commit overrides divergent branch bytes without changing the commit',async()=>{
    const other=await renderWorkspaceDocx('Other');
    await pg.query('UPDATE docgrid.docgrid_branch_documents SET docx_bytes=$1,docx_sha256=$2 WHERE branch_id=$3',[other,hash(other),b]);
    assert.deepEqual((await download(b)).bytes,original);
    const [saved]=await db.$queryRaw`SELECT docx_bytes FROM docgrid.docgrid_commits`;
    assert.deepEqual(Buffer.from(saved.docx_bytes),original);
  });
  await t.test('corrupt commit and mismatched text are rejected',async()=>{
    await pg.query('UPDATE docgrid.docgrid_commits SET docx_sha256=$1',[hash(Buffer.from('bad'))]);
    await assert.rejects(download(a),/Контрольная сумма/);
    await pg.query('UPDATE docgrid.docgrid_commits SET docx_sha256=$1',[hash(original)]);
    await pg.query('UPDATE docgrid.docgrid_branch_documents SET content=$1 WHERE branch_id=$2',['Changed',b]);
    await assert.rejects(download(b),/не совпадает с редакцией/);
    await pg.query('UPDATE docgrid.docgrid_branch_documents SET content=$1 WHERE branch_id=$2',['Старый текст',b]);
  });
  const item=(id:string,role='main')=>({kind:'document',id,branchId:a,revision:1,role,format:'docx'});
  const capture=(items:unknown[])=>service.capture('owner',project,{title:'Подача',items});
  let large:Buffer,second:string,bundle:any;
  await t.test('multiple valid DOCX exceeding 8 MiB as Base64 fit the text budget',async()=>{
    const zip=await JSZip.loadAsync(original);zip.file('padding.bin',Buffer.alloc(3.2*MiB,7));
    large=await zip.generateAsync({type:'nodebuffer',compression:'STORE'});
    await pg.query('UPDATE docgrid.docgrid_commits SET docx_bytes=$1,docx_sha256=$2',[large,hash(large)]);
    second=randomUUID();const secondCommit=randomUUID();
    await pg.query('INSERT INTO docgrid.workspace_documents(id,project_id,title) VALUES ($1,$2,$3)',[second,project,'Приложение']);
    await pg.query('INSERT INTO docgrid.docgrid_commits VALUES ($1,$2,$3,$4,$5,$6)',[secondCommit,second,'Второй текст',large,hash(large),'test-v1']);
    await pg.query('INSERT INTO docgrid.docgrid_branch_documents VALUES ($1,$2,$3,1,$4,NULL,NULL,NULL)',[a,second,'Второй текст',secondCommit]);
    bundle=await capture([item(doc),item(second,'attachment')]);
    assert.equal(bundle.items.length,2);assert.equal(bundle.items[0].size,large.length);assert.equal(bundle.items[0].docxBase64,undefined);
    const [saved]=await db.$queryRaw`SELECT items FROM docgrid.dg_court_packages WHERE id=${bundle.id}::uuid`;
    assert.ok(Buffer.byteLength(JSON.stringify(saved.items))>8*MiB);
  });
  await t.test('repeated archives preserve each DOCX and manifest checksum',async()=>{
    for(let i=0;i<2;i++){
      const {stream}=await service.archive('owner',project,bundle.id);const chunks:Buffer[]=[];
      await new Promise<void>((resolve,reject)=>{stream.on('data',chunk=>chunks.push(Buffer.from(chunk)));stream.once('end',resolve);stream.once('error',reject);});
      const zip=await JSZip.loadAsync(Buffer.concat(chunks));const manifest=JSON.parse(await zip.file('manifest.json')!.async('string'));
      assert.equal(manifest.files.length,2);
      for(const file of manifest.files){const bytes=await zip.file(file.name)!.async('nodebuffer');assert.deepEqual(bytes,large);assert.equal(file.sha256,hash(bytes));assert.equal(file.size,bytes.length);}
    }
  });
  await t.test('tampered package DOCX is rejected before archive export',async()=>{
    await pg.query("UPDATE docgrid.dg_court_packages SET items=jsonb_set(items,'{0,docxHash}',to_jsonb('bad'::text)) WHERE id=$1",[bundle.id]);
    await assert.rejects(service.archive('owner',project,bundle.id),/Контрольная сумма/);
  });
  await t.test('binary sizes of materials and DOCX share the 500 MiB budget',async()=>{
    const material=randomUUID();await pg.query('INSERT INTO docgrid.docgrid_materials VALUES ($1,$2,$3,$4,$5,$6,NULL)',[material,project,'file.pdf','hash',498*MiB,'READY']);
    await assert.rejects(capture([item(doc),{kind:'material',id:material,role:'attachment',sha256:'hash'}]),/500 МБ/);
  });
  await t.test('text and metadata still enforce 8 MiB independently of binary size',async()=>{
    const text='я'.repeat(4*MiB);
    await pg.query('UPDATE docgrid.docgrid_commits SET after_content=$1 WHERE id=$2',[text,commit]);
    await pg.query('UPDATE docgrid.docgrid_branch_documents SET content=$1 WHERE document_id=$2',[text,doc]);
    await assert.rejects(capture([item(doc)]),/8 МБ текста/);
  });
});
