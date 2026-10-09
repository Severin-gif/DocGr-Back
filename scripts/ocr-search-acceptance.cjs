const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
module.exports=async function({call,prefix,p,jwt,db,app}) {
 const [owner]=await db.$queryRaw`SELECT owner_id FROM docgrid.workspace_projects WHERE id=${p.id}::uuid`;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dg-ocr-test-'));
 try {
  execFileSync('python3',['-c',`from PIL import Image,ImageDraw,ImageFont
import sys
im=Image.new('RGB',(1600,450),'white'); d=ImageDraw.Draw(im)
f=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',48)
d.text((50,80),'Договор поставки. Задолженность 125000 рублей.',font=f,fill='black')
d.text((50,170),'ООО Ромашка. Проверка документов.',font=f,fill='black')
im.save(sys.argv[1]+'/scan.png'); im.save(sys.argv[1]+'/scan.pdf',save_all=True,append_images=[im])`,dir]);
  async function material(title,bytes,text='',status='UNREAD') {
   const id=randomUUID(),hash=createHash('sha256').update(bytes).digest('hex');
   await db.$executeRaw`INSERT INTO docgrid.docgrid_materials(id,project_id,title,path,mime,bytes,byte_size,sha256,extracted_text,extraction_status,created_by) VALUES(${id}::uuid,${p.id}::uuid,${title},'/OCR','application/octet-stream',${bytes}::bytea,${bytes.length},${hash},${text},${status},${owner.owner_id})`;
   return {id,hash};
  }
  const png=await material('scan.png',fs.readFileSync(path.join(dir,'scan.png')));
  const pdf=await material('scan.pdf',fs.readFileSync(path.join(dir,'scan.pdf')));
  const {DocGridOcrService}=require('../dist/modules/docgrid/docgrid-ocr.service');
  const worker=app.get(DocGridOcrService);
  await call(prefix+'/extraction','GET',undefined,jwt('stranger'),404);
  await worker.enqueue();
  // Other acceptance suites also leave PDF fixtures in the global queue.
  // Give these two fixtures explicit priority instead of relying on UUID ordering.
  await db.$executeRaw`UPDATE docgrid.dg_ocr_jobs SET updated_at=now()-interval '1 day' WHERE material_id IN (${png.id}::uuid,${pdf.id}::uuid)`;
  // Simulate a terminated worker: page 1 is durable, lease expired; page 2 must resume.
  await db.$executeRaw`UPDATE docgrid.dg_ocr_jobs SET state='running',attempts=1,lease_until=now()-interval '1 minute',lease_token=${randomUUID()}::uuid WHERE material_id=${pdf.id}::uuid`;
  await db.$executeRaw`INSERT INTO docgrid.dg_ocr_pages(material_id,page,text,method,status) VALUES(${pdf.id}::uuid,1,'Сохранённая первая страница','ocr','READY')`;
  await worker.tick();await worker.tick();
  const text=await call(prefix+'/materials/'+png.id+'/text');
  assert.equal(text.status,'READY');assert.match(text.text,/125000/);assert.match(text.text,/Задолженность/);assert.equal(text.pages[0].page,1);
  const resumed=await call(prefix+'/materials/'+pdf.id+'/text');assert.equal(resumed.pages.length,2);assert.ok(resumed.text.startsWith('Сохранённая первая страница'));assert.match(resumed.text,/125000/);
  const original=await db.$queryRaw`SELECT sha256,bytes FROM docgrid.docgrid_materials WHERE id=${pdf.id}::uuid`;assert.equal(createHash('sha256').update(original[0].bytes).digest('hex'),pdf.hash);
  const jobs=(await call(prefix+'/extraction')).jobs;assert.equal(jobs.find(j=>j.id===pdf.id).state,'done');
  await call(prefix+'/materials/'+pdf.id+'/ocr','POST',{},jwt('reader'),404);
  // An unread page cannot erase an earlier extraction or be represented as a complete scan.
  const broken=await material('broken.pdf',Buffer.from('%PDF-broken'),'Preserved evidence','READY');
  await worker.enqueue();
  await db.$executeRaw`UPDATE docgrid.dg_ocr_jobs SET updated_at=now()-interval '1 day' WHERE material_id=${broken.id}::uuid`;
  await worker.tick();
  assert.equal((await call(prefix+'/materials/'+broken.id+'/text')).text,'Preserved evidence');
  const [brokenJob]=await db.$queryRaw`SELECT state FROM docgrid.dg_ocr_jobs WHERE material_id=${broken.id}::uuid`;
  assert.equal(brokenJob.state,'failed');
  // Relevant evidence after the old 5,000-character cutoff and after the first 20 files.
  for(let n=0;n<24;n++)await material('filler'+n+'.txt',Buffer.from('irrelevant'),'irrelevant','READY');
  const longText='Вводные материалы. '.repeat(900)+'Взыскание задолженности с контрагента Ромашка. Уникальныйфакт 987654.';
  const long=await material('long.txt',Buffer.from(longText),longText,'READY');
  await call(prefix+'/search','POST',{query:'задолженность'},jwt('stranger'),404);
  await call(prefix+'/discussions/settings','PUT',{enabled:false},jwt('owner'));
  const human=await call(prefix+'/search','POST',{query:'уникальныйфакт'},jwt('owner'),201);assert.ok(human.matches.some(m=>m.sourceRef.sourceId===long.id));
  await call(prefix+'/discussions/settings','PUT',{enabled:true},jwt('owner'));
  const grant=await call(prefix+'/agents/grants','POST',{requestKey:randomUUID(),agentRef:'ocr-test',actions:['docgrid_get_snapshot','docgrid_search','docgrid_read_source'],expiresAt:new Date(Date.now()+3600000).toISOString(),maxOperations:50},jwt('owner'),201);
  const invoke=(tool,input,token=grant.token,status=200)=>call('/api/docgrid/mcp/'+p.id,'POST',{jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:tool,arguments:{runId:randomUUID(),requestKey:randomUUID(),input}}},token,status);
  function output(r){assert.ok(!r.error,JSON.stringify(r));const blocks=r.result?.content;const data=r.result?.structuredContent||JSON.parse(blocks[0].text);return data.output||data.result||data;}
  const snapshot=output(await invoke('docgrid_get_snapshot',{capture:true,limit:200}));
  const ranked=output(await invoke('docgrid_search',{snapshotId:snapshot.snapshotId,query:'задолженность уникальныйфакт',mode:'ranked',limit:50}));
  assert.ok(ranked.matches.some(m=>m.sourceRef.sourceId===long.id&&m.locator.start>5000),JSON.stringify(ranked));
  const pageHits=output(await invoke('docgrid_search',{snapshotId:snapshot.snapshotId,query:'125000',mode:'ranked',limit:50}));
  const pageHit=pageHits.matches.find(m=>m.sourceRef.sourceId===pdf.id&&m.page===2);assert.ok(pageHit);
  const read=output(await invoke('docgrid_read_source',{sourceRef:pageHit.sourceRef,maxChars:5000}));assert.match(read.text,/125000/);assert.equal(read.pages[0].page,2);
  const scoped=await call(prefix+'/agents/grants','POST',{requestKey:randomUUID(),agentRef:'restricted-test',actions:['docgrid_search'],allowedSourceIds:[png.id],expiresAt:new Date(Date.now()+3600000).toISOString(),maxOperations:10},jwt('owner'),201);
  const restricted=output(await invoke('docgrid_search',{snapshotId:snapshot.snapshotId,query:'задолженность',mode:'ranked'},scoped.token));
  assert.ok(restricted.matches.length);assert.ok(restricted.matches.every(m=>m.sourceRef.sourceId===png.id));
  const first=output(await invoke('docgrid_search',{snapshotId:snapshot.snapshotId,query:'задолженность',mode:'ranked',limit:1}));assert.ok(first.continuation);
  const second=output(await invoke('docgrid_search',{snapshotId:snapshot.snapshotId,query:'задолженность',mode:'ranked',limit:1,cursor:first.continuation}));assert.notDeepEqual(first.matches,second.matches);
  // Exercise the real discussion -> AI Orchestra boundary with a local service fixture.
  let supplied;
  const orchestra=require('node:http').createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/internal/docgrid/config'){res.end(JSON.stringify({enabled:true,discussionModels:[{id:'default',label:'Fixture'}]}));return;}
    assert.equal(req.headers['x-docgrid-service-token'],'b'.repeat(64));
    let body='';for await(const chunk of req)body+=chunk;supplied=JSON.parse(body);
    res.end(JSON.stringify({result:{answer:'Проверка передачи найденных фрагментов',warnings:[],classifications:[],package:null},model:'fixture'}));
  });
  await new Promise(resolve=>orchestra.listen(0,'127.0.0.1',resolve));
  process.env.DOCGRID_ORCHESTRA_URL='http://127.0.0.1:'+orchestra.address().port;
  try {
    const thread=await call(prefix+'/discussions','POST',{title:'Поиск по всему делу'},jwt('owner'),201);
    await call(prefix+'/discussions/'+thread.id+'/turns','POST',{requestKey:randomUUID(),instruction:'Найди Уникальныйфакт',mode:'advisor',task:'chat'},jwt('owner'),201);
    assert.ok(supplied.sources.some(s=>s.id===long.id&&s.text.includes('987654')));
    const turns=await call(prefix+'/discussions/'+thread.id+'/turns');assert.equal(turns[0].context.retrieval.algorithm,'russian-simple-passages-v1');assert.ok(turns[0].context.total>20);
  } finally {await new Promise(resolve=>orchestra.close(resolve));delete process.env.DOCGRID_ORCHESTRA_URL;}
  // Search is immutable even when live extraction is replaced.
  await db.$executeRaw`UPDATE docgrid.docgrid_materials SET extracted_text='changed' WHERE id=${long.id}::uuid`;
  assert.ok(output(await invoke('docgrid_search',{snapshotId:snapshot.snapshotId,query:'уникальныйфакт',mode:'ranked'})).matches.some(m=>m.sourceRef.sourceId===long.id));
  await call(prefix+'/agents/grants/'+scoped.grant.id+'/revoke','POST',{requestKey:randomUUID()},jwt('owner'),201);
  await invoke('docgrid_search',{snapshotId:snapshot.snapshotId,query:'задолженность',mode:'ranked'},scoped.token,403);
  console.log('PASS real Russian OCR, scanned PDF pages, expired lease resume, preserved originals/text, project ACL, ranked full-case tail retrieval, scoped grants, page locators, pagination and immutable snapshots');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
};
