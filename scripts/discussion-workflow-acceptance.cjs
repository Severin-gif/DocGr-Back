/* Real HTTP, SQL, permission checks and Astra approvals; only the model response is synthetic. */
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {randomUUID}=require('node:crypto');
module.exports=async({call,prefix,material,jwt,db})=>{
 let calls=0,badPlan=false,failStep=false,hold,entered;
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url.endsWith('/config'))return res.end(JSON.stringify({enabled:true,discussionModels:[{id:'default',label:'Fixture'}]}));
  let raw='';for await(const b of req)raw+=b;const input=JSON.parse(raw);calls++;
  assert.deepEqual(input.sources.map(s=>s.id),[material.id]);
  assert.ok(!input.projectContext.summary.includes('excluded-secret'));
  if(input.instruction==='Уточнение')assert.ok(input.history.some(h=>h.text==='Анализ завершён'),'ordinary chat can discuss completed workflow results');
  const result={answer:'Анализ завершён',warnings:[],classifications:[],package:null};
  if(input.instruction.startsWith('Составь план задачи'))result.answer=badPlan?'не JSON':JSON.stringify({title:'Проверка материалов',steps:[{title:'Изучить доказательства',instruction:'Проверь факты',task:'chat'},{title:'Разложить материалы',instruction:'Предложи папку',task:'sort'}]});
  else {
   if(hold){entered();await hold;hold=null;}
   if(failStep){res.statusCode=503;return res.end('{}');}
   if(input.task==='sort')result.classifications=[{sourceId:material.id,category:'Доказательства',destination:'/WorkflowResult',reason:'Подтверждено',confidence:'high',evidence:[{sourceId:material.id,quote:'Original evidence'}]}];
  }
  res.end(JSON.stringify({result,model:'fixture'}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.DOCGRID_ORCHESTRA_URL='http://127.0.0.1:'+server.address().port;
 process.env.DOCGRID_AI_DAILY_REQUEST_LIMIT='100';
 try {
  const thread=await call(prefix+'/discussions','POST',{title:'Workflow'},jwt('owner'),201),root=prefix+'/discussions/'+thread.id;
  const body={requestKey:randomUUID(),goal:'Проверить и разложить материалы',model:'default',sourceIds:[material.id]};
  const create=(extra={},status=201)=>call(root+'/workflows','POST',{...body,...extra},jwt('owner'),status);
  const run=(w,key=randomUUID(),status=201)=>call(root+'/workflows/'+w.id+'/run','POST',{requestKey:key},jwt('owner'),status);
  const latest=async()=>(await call(root+'/workflows'))[0];
  const approve=async(w,extra={},status=201)=>{const op=await call(prefix+'/agents/operations/'+w.plan_operation_id);return call(prefix+'/agents/operations/'+op.id+'/approve','POST',{requestKey:randomUUID(),approvalDigest:op.approvalDigest,planRevision:op.approval.planRevision,...extra},jwt('owner'),status);};
  await create({sourceIds:[]},400);await create({folder:'/../invalid'},400);
  const caps=await call(root+'/capabilities');assert.ok(caps.tools.some(t=>t.name==='docgrid_plan_document'));assert.ok(!caps.tools.some(t=>t.name==='docgrid_submit_document'));
  await call(root+'/workflows','GET',undefined,jwt('stranger'),404);
  const w=await create();assert.equal(w.status,'awaiting_approval');assert.equal(w.steps.length,2);assert.equal(calls,1);
  assert.equal((await create()).id,w.id);assert.equal(calls,1);await create({goal:'different'},409);await create({requestKey:randomUUID()},409);
  await run(w,randomUUID(),409);await approve(w,{approvalDigest:'0'.repeat(64)},409);await approve(w);
  assert.equal((await latest()).status,'ready');
  const firstKey=randomUUID();let release;hold=new Promise(r=>release=r);const started=new Promise(r=>entered=r);
  const firstRun=run(w,firstKey);await started;
  await run(w,firstKey);await run(w,randomUUID(),409);
  await call(root+'/turns','POST',{requestKey:randomUUID(),instruction:'Concurrent chat',task:'chat',mode:'advisor'},jwt('owner'),409);
  release();await firstRun;assert.equal((await latest()).steps[0].status,'completed');assert.equal((await latest()).status,'ready');
  const count=calls;await run(w,firstKey);assert.equal(calls,count,'replayed execution must not start the next stage');
  // Ordinary chat remains available between stages, without affecting their state.
  await call(root+'/turns','POST',{requestKey:randomUUID(),instruction:'Уточнение',task:'chat',mode:'advisor',sourceIds:[material.id]},jwt('owner'),201);
  assert.equal((await latest()).status,'ready');
  const before=(await call(prefix+'/files')).materials.find(s=>s.id===material.id).path;
  await run(w);const waiting=await latest();assert.equal(waiting.status,'needs_user_action');assert.equal((await call(prefix+'/files')).materials.find(s=>s.id===material.id).path,before);
  await run(w,randomUUID(),409);
  const eventCount=waiting.events.length;await latest();assert.equal((await latest()).events.length,eventCount,'polling does not duplicate audit events');
  const op=await call(prefix+'/agents/operations/'+waiting.steps[1].proposalId);
  await call(prefix+'/agents/operations/'+op.id+'/approve','POST',{requestKey:randomUUID(),approvalDigest:op.approvalDigest},jwt('owner'),201);
  const complete=await latest();assert.equal(complete.status,'completed');assert.equal(complete.steps[1].status,'completed');assert.ok(complete.events.some(e=>e.type==='approved'));assert.ok(complete.steps[1].turnId);
  assert.equal((await call(prefix+'/files')).materials.find(s=>s.id===material.id).path,'/WorkflowResult');
  await run(w,randomUUID(),409);
  // Even a broadly scoped external grant cannot use workflow approval to submit a document.
  const catalog=await call(prefix+'/agents/catalog');
  const external=await call(prefix+'/agents/grants','POST',{requestKey:randomUUID(),agentRef:'External fixture',actions:catalog.tools.map(t=>t.name),expiresAt:new Date(Date.now()+3600000).toISOString(),maxOperations:100},jwt('owner'),201);
  const externalThread=await call(prefix+'/discussions','POST',{title:'External workflow',grantId:external.grant.id},jwt('owner'),201);
  const ew=await call(prefix+'/discussions/'+externalThread.id+'/workflows','POST',{...body,requestKey:randomUUID()},jwt('owner'),201);
  const eop=await call(prefix+'/agents/operations/'+ew.plan_operation_id);await approve(ew);
  await call('/api/docgrid/agents/tools/docgrid_submit_document','POST',{projectId:prefix.split('/').at(-1),runId:randomUUID(),traceId:randomUUID(),requestKey:randomUUID(),input:{taskId:eop.approval.taskId,planRevision:eop.approval.planRevision,planDigest:eop.approval.planDigest,content:{title:'Must not exist',sections:[{id:'body',paragraphs:['Unapproved content']}]}}},external.token,409);
  assert.equal((await call(prefix+'/files')).artifacts.length,0);
  await call(prefix+'/discussions/'+externalThread.id+'/workflows/'+ew.id+'/cancel','POST',{requestKey:randomUUID()},jwt('owner'),201);
  // Failed model calls persist; retry is explicit, no optimistic completed flag.
  const retry=await create({requestKey:randomUUID()});await approve(retry);failStep=true;await run(retry,randomUUID(),502);assert.equal((await latest()).status,'failed');
  failStep=false;await run(retry);assert.equal((await latest()).steps[0].status,'completed');
  await call(root+'/workflows/'+retry.id+'/cancel','POST',{requestKey:randomUUID()},jwt('owner'),201);assert.equal((await latest()).status,'cancelled');
  badPlan=true;await create({requestKey:randomUUID()},400);assert.equal((await latest()).status,'failed');
  await call(root+'/workflows/'+(await latest()).id+'/cancel','POST',{requestKey:randomUUID()},jwt('owner'),201);badPlan=false;
  // Source isolation and owner-only approval retain the existing access model.
  const denied=await create({requestKey:randomUUID()});
  await call(prefix+'/discussions/settings','PUT',{enabled:false},jwt('owner'));
  await approve(denied,{},403);await call(prefix+'/discussions/settings','PUT',{enabled:true},jwt('owner'));
  await approve(denied);
  await call(prefix+'/agents/grants/'+thread.grantId+'/revoke','POST',{requestKey:randomUUID()},jwt('owner'),201);
  await run(denied,randomUUID(),403);assert.equal((await latest()).status,'failed');
  // Restart recovery: expired lease fails closed when no durable turn exists.
  await db.$executeRaw`UPDATE docgrid_live.dg_discussion_workflows SET status='running',steps=jsonb_set(steps,'{0,status}','"running"'),updated_at=now()-interval '11 minutes' WHERE id=${denied.id}::uuid`;
  assert.equal((await latest()).status,'failed');
  console.log('PASS discussion workflow: durable plan and events, exact approval, scope, sequential execution, idempotent replay, ordinary chat, separate document approval, failure/retry, cancellation, disabled/revoked grant and restart recovery');
 } finally {await new Promise(r=>server.close(r));delete process.env.DOCGRID_ORCHESTRA_URL;delete process.env.DOCGRID_AI_DAILY_REQUEST_LIMIT;}
};

