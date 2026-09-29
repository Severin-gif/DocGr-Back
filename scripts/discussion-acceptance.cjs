const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {randomUUID}=require('node:crypto');
module.exports=async function({call,prefix,p,material,jwt,db}){
 let task='sort',calls=0;
 const server=createServer(async(req,res)=>{
  if(req.url==='/internal/docgrid/config'){res.setHeader('content-type','application/json');res.end(JSON.stringify({enabled:true,discussionModels:[{id:'default',label:'Fixture'},{id:'claude',label:'Claude fixture'}]}));return;}
  let body='';for await(const c of req)body+=c;
  const input=JSON.parse(body);calls++;assert.equal(req.headers['x-docgrid-service-token'],'b'.repeat(64));
  const s=input.sources.find(s=>s.id===material.id);
  const result={answer:'Проверено по тексту',warnings:[],classifications:[],package:null};
  if(task==='sort')result.classifications=[{sourceId:s.id,category:'Доказательства',destination:'/Разобрано',reason:'Подтверждено текстом',confidence:'high',evidence:[{sourceId:s.id,quote:'Original evidence'}]}];
  if(task==='package')result.package={folder:'/Дебиторка/ООО Ромашка',documents:[{title:'Иск — черновик',text:'Обстоятельства: Original evidence. [ТРЕБУЕТСЯ: сумма долга, договор и надлежащий суд]'}],sourceIds:[s.id],missingData:['Подтвердить стороны и сумму долга'],payment:[{field:'Получатель',value:null,evidence:[]}]};
  if(task==='instruction'){assert.equal(input.task,'instruction');result.legalInstruction={title:'Порядок взыскания',goal:'Подготовить требование',facts:[{text:'Доказательство в материалах',evidence:[{sourceId:s.id,quote:'Original evidence'}]}],steps:[{action:'Проверить доказательство',purpose:'Определить основания требования',documents:['Исходный документ'],deadline:null,evidence:[]}],legalBasis:[],missingData:['Срок и правовое основание'],risks:['Неполные материалы'],checklist:['Доказательства сопоставлены']};}
  if(task==='bad')result.classifications=[{sourceId:s.id,category:'X',destination:'/X',reason:'X',confidence:'high',evidence:[{sourceId:s.id,quote:'invented quote'}]}];
  res.setHeader('content-type','application/json');res.end(JSON.stringify({result,model:'acceptance-stub',usage:{total_tokens:5}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 process.env.DOCGRID_ORCHESTRA_URL='http://127.0.0.1:'+server.address().port;
 try{
  const catalog=await call(prefix+'/agents/catalog');
  const grant=await call(prefix+'/agents/grants','POST',{requestKey:randomUUID(),agentRef:'built-in-test',actions:catalog.tools.map(t=>t.name),expiresAt:new Date(Date.now()+3600000).toISOString(),maxOperations:300},jwt('owner'),201);
  const thread=await call(prefix+'/discussions','POST',{title:'Проверка сортировки',grantId:grant.grant.id},jwt('owner'),201);
  const root=prefix+'/discussions/'+thread.id;
  await call(root+'/turns','GET',undefined,jwt('stranger'),404);
  const send=(extra={},status=201)=>call(root+'/turns','POST',{requestKey:randomUUID(),instruction:'Разбери документы',mode:'helper',task:'sort',sourceIds:[material.id],...extra},jwt('owner'),status);
  const requestKey=randomUUID();const sent=await send({requestKey});
  const repeated=await send({requestKey});assert.equal(sent.id,repeated.id);assert.equal(calls,1);
  const turns=await call(root+'/turns');assert.equal(turns[0].context.total,1);assert.equal(turns[0].result.classifications[0].sourceId,material.id);
  const proposed=await call(root+'/turns/'+sent.id+'/proposal','POST',{},jwt('owner'),201);
  assert.equal(proposed.status,'needs_user_action');
  assert.equal((await call(prefix+'/files')).materials.find(m=>m.id===material.id).path,'/Case/Nested');
  await call(prefix+'/agents/operations/'+proposed.id+'/approve','POST',{requestKey:randomUUID(),approvalDigest:proposed.approvalDigest},jwt('owner'),201);
  assert.equal((await call(prefix+'/files')).materials.find(m=>m.id===material.id).path,'/Разобрано');
  // Stale tree must fail atomically, without moving sources.
  const stale=await send();const staleOp=await call(root+'/turns/'+stale.id+'/proposal','POST',{},jwt('owner'),400); // already in target: no move
  assert.ok(staleOp);
  const advisor=await send({mode:'advisor'});await call(root+'/turns/'+advisor.id+'/proposal','POST',{},jwt('owner'),400);
  const before=calls;await send({sourceIds:[randomUUID()]},400);assert.equal(calls,before);
  task='package';const packet=await send({task:'package'});
  const pack=await call(root+'/turns/'+packet.id+'/proposal','POST',{},jwt('owner'),201);assert.equal(pack.result.documents.length,2);
  await call(prefix+'/folders','POST',{path:'/Changed'},jwt('owner'),201);
  await call(prefix+'/agents/operations/'+pack.id+'/approve','POST',{requestKey:randomUUID(),approvalDigest:pack.approvalDigest},jwt('owner'),409);
  assert.equal((await call(prefix+'/files')).artifacts.length,0);
  const fresh=await send({task:'package'}),freshPack=await call(root+'/turns/'+fresh.id+'/proposal','POST',{},jwt('owner'),201);
  const accepted=await call(prefix+'/agents/operations/'+freshPack.id+'/approve','POST',{requestKey:randomUUID(),approvalDigest:freshPack.approvalDigest},jwt('owner'),201);
  assert.equal(accepted.result.artifacts.length,2);
  const tree=await call(prefix+'/files');assert.equal(tree.artifacts.length,2);assert.equal(tree.materials.find(m=>m.id===material.id).path,'/Дебиторка/ООО Ромашка/Приложения');
  assert.ok(tree.artifacts.every(a=>a.path==='/Дебиторка/ООО Ромашка'));
  const id=tree.artifacts[0].id;const draft=await call(prefix+'/agents/artifacts/'+id+'/versions/1');assert.ok(draft.plainText.includes('Черновик'));
  // Legal instruction: preview does not create a file; two reviewed saves reuse the folder without moving originals.
  task='instruction';
  await send({task:'instruction',mode:'advisor'},400);
  const originalPath=tree.materials.find(m=>m.id===material.id).path;
  for(let n=0;n<2;n++){
    const instruction=await send({task:n?'instruction':'chat',instruction:'Подготовь юридическую инструкцию по взысканию'});
    const turn=(await call(root+'/turns')).find(t=>t.id===instruction.id);assert.equal(turn.context.task,'instruction');assert.equal(turn.result.package.folder,'/Юридические инструкции');
    assert.equal((await call(prefix+'/files')).artifacts.length,2+n);
    const op=await call(root+'/turns/'+instruction.id+'/proposal','POST',{},jwt('owner'),201);
    const again=await call(root+'/turns/'+instruction.id+'/proposal','POST',{},jwt('owner'),201);assert.equal(again.id,op.id);
    const accepted=await call(prefix+'/agents/operations/'+op.id+'/approve','POST',{requestKey:randomUUID(),approvalDigest:op.approvalDigest},jwt('owner'),201);
    const output=await call(prefix+'/agents/artifacts/'+accepted.result.artifacts[0].artifactId+'/versions/1');assert.match(output.plainText,/Порядок действий/);assert.match(output.plainText,/Контроль готовности/);
    const current=await call(prefix+'/files');assert.equal(current.artifacts.filter(a=>a.path==='/Юридические инструкции').length,n+1);assert.equal(current.materials.find(m=>m.id===material.id).path,originalPath);assert.ok(!current.folders.some(f=>f.path==='/Юридические инструкции/Приложения'));
  }
  const changed=await send({task:'instruction'}),op=await call(root+'/turns/'+changed.id+'/proposal','POST',{},jwt('owner'),201);
  await call(prefix+'/folders','POST',{path:'/AnotherChange'},jwt('owner'),201);
  await call(prefix+'/agents/operations/'+op.id+'/approve','POST',{requestKey:randomUUID(),approvalDigest:op.approvalDigest},jwt('owner'),409);
  assert.equal((await call(prefix+'/files')).artifacts.length,4);
  console.log('PASS legal instructions: explicit/chat request, preview, reviewed save, repeated folder, idempotent proposal, original preservation and stale rejection');
  task='bad';await send({},502);assert.equal((await call(root+'/turns')).at(-1).status,'failed');
  await call(prefix+'/agents/grants/'+grant.grant.id+'/revoke','POST',{requestKey:randomUUID()},jwt('owner'),201);
  await send({},403);
  // Built-in chat starts without a manually created grant; live ACL and settings remain authoritative.
  task='chat';
  await call('/api/docgrid/repositories','GET',undefined,jwt('reader'));
  await call(prefix+'/members','PUT',{email:'reader@example.test',role:'READER'},jwt('owner'));
  const cfg=await call(prefix+'/discussions/config','GET',undefined,jwt('reader'));assert.equal(cfg.canPrepare,false);assert.equal(cfg.models.length,2);
  const builtin=await call(prefix+'/discussions','POST',{title:'Обычная LLM'},jwt('reader'),201);
  const broot=prefix+'/discussions/'+builtin.id;
  const bsend=(extra={},status=201)=>call(broot+'/turns','POST',{requestKey:randomUUID(),instruction:'Объясни',mode:'advisor',task:'chat',sourceIds:[material.id],model:'claude',...extra},jwt('reader'),status);
  await bsend();
  await bsend({model:'arbitrary-provider-model'},400);
  // Viewer cannot turn a generated package into a writable proposal.
  task='package';const readonlyPack=await bsend({mode:'helper',task:'package'});
  await call(broot+'/turns/'+readonlyPack.id+'/proposal','POST',{},jwt('reader'),404);
  task='instruction';const readonlyInstruction=await bsend({mode:'helper',task:'instruction'});
  await call(broot+'/turns/'+readonlyInstruction.id+'/proposal','POST',{},jwt('reader'),404);
  await call(prefix+'/discussions/settings','PUT',{enabled:false},jwt('reader'),404);
  await call(prefix+'/discussions/settings','PUT',{enabled:false},jwt('owner'));
  await bsend({},403);
  await call(prefix+'/discussions','POST',{title:'Запрещено'},jwt('reader'),403);
  await call(prefix+'/discussions/settings','PUT',{enabled:true},jwt('owner'));
  task='chat';
  process.env.DOCGRID_AI_DAILY_REQUEST_LIMIT='1';
  await bsend({},429);
  // Two discussions still share one quota. Their requests cannot race past the last slot.
  await db.$executeRaw`UPDATE docgrid.dg_ai_daily_usage SET requests=0 WHERE user_id=(SELECT owner_id FROM docgrid.dg_discussions WHERE id=${builtin.id}::uuid)`;
  const second=await call(prefix+'/discussions','POST',{title:'Второй чат'},jwt('reader'),201);
  const race=await Promise.allSettled([bsend(),call(prefix+'/discussions/'+second.id+'/turns','POST',{requestKey:randomUUID(),instruction:'Объясни',mode:'advisor',task:'chat',sourceIds:[material.id]},jwt('reader'),201)]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(race.find(r=>r.status==='rejected').reason.actual,429);
  assert.equal((await call(prefix+'/discussions/config','GET',undefined,jwt('reader'))).remaining,0);
  delete process.env.DOCGRID_AI_DAILY_REQUEST_LIMIT;
  const text=await call(prefix+'/materials/'+material.id+'/text','GET',undefined,jwt('reader'));assert.match(text.text,/Original evidence/);
  await call(prefix+'/materials/'+material.id+'/extract','POST',{},jwt('reader'),404);
  assert.equal((await call(prefix+'/materials/'+material.id+'/extract','POST',{},jwt('owner'),201)).status,'READY');
  await call(prefix+'/members','PUT',{email:'reader@example.test',role:'REMOVE'},jwt('owner'));
  await bsend({},404);
  console.log('PASS built-in defaults, model allowlist, reader ACL, owner settings, daily limit and extraction authorization');
  console.log('PASS discussions: ACL, idempotent sends, evidence quotes, reviewed moves, advisor boundary, stale package rollback, draft package + attachments + payment gaps, grant revocation');
 }finally{await new Promise(resolve=>server.close(resolve));delete process.env.DOCGRID_ORCHESTRA_URL;}
};
