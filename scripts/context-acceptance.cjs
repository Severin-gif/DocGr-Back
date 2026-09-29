const assert=require('node:assert/strict');const {createServer}=require('node:http');
module.exports=async({call,jwt,db,app})=>{
 const {ProjectContextService}=require('../dist/modules/docgrid/project-context.service'),{AiTimeBudgetService}=require('../dist/modules/docgrid/ai-time-budget.service');
 const memory=app.get(ProjectContextService),budget=app.get(AiTimeBudgetService),old=process.env.DOCGRID_ORCHESTRA_URL;let calls=0,bad=false;
 const server=createServer(async(req,res)=>{let data='';for await(const c of req)data+=c;const input=JSON.parse(data);calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({result:{points:[{text:'Факт из материала',quote:bad?'invented':input.text.slice(0,20)}],concerns:[]}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.DOCGRID_ORCHESTRA_URL='http://127.0.0.1:'+server.address().port;
 try{
  const p=await call('/api/docgrid/repositories','POST',{name:'Контекст'},jwt('owner'),201),root='/api/docgrid/repositories/'+p.id;
  await call(root+'/discussions/context','GET',undefined,jwt('stranger'),404);
  const source=await call(root+'/artifacts','POST',{title:'Исходная позиция',content:'Подтверждённый факт. '.repeat(750)},jwt('owner'),201);
  const tick=async()=>{await db.$executeRaw`UPDATE docgrid.dg_project_context SET retry_at=now()+interval '1 day'`;await db.$executeRaw`UPDATE docgrid.dg_project_context SET retry_at=now() WHERE project_id=${p.id}::uuid`;await memory.tick();};
  for(let n=0;n<3;n++)await tick();
  let state=await call(root+'/discussions/context');assert.equal(state.state,'ready');assert.equal(state.coverage.chunks,2);assert.equal(state.coverage.processed,2);assert.equal(calls,2);
  const hidden=await memory.context(p.id,[]);assert.equal(hidden.summary,'');
  const visible=await memory.context(p.id,[source.id]);assert.match(visible.summary,/Факт из материала/);
  await memory.retry(p.id);await tick();assert.equal(calls,2,'unchanged chunks cached');
  await db.$executeRaw`UPDATE docgrid.workspace_documents SET content='Новая позиция' WHERE id=${source.id}::uuid`;
  state=await call(root+'/discussions/context');assert.equal(state.state,'queued');assert.ok(state.revision>state.checkedRevision);assert.equal((await memory.context(p.id,[source.id])).summary,'','stale notes never enter context');
  bad=true;await tick();state=await call(root+'/discussions/context');assert.equal(state.state,'failed');
  bad=false;await tick();state=await call(root+'/discussions/context');assert.equal(state.state,'ready');
  process.env.DOCGRID_AI_MONTHLY_HOURS='0';await memory.retry(p.id);await tick();
  // A cached result may remain, but the current check is visibly blocked by the exhausted budget.
  state=await call(root+'/discussions/context');assert.equal(state.state,'blocked');assert.equal(state.reason,'hours_exhausted');
  await assert.rejects(()=>budget.reserve(p.id),e=>e.getStatus()===429);
  delete process.env.DOCGRID_AI_MONTHLY_HOURS;
  const token=await budget.reserve(p.id);await budget.finish(token);const first=await budget.status(p.id);await budget.finish(token);assert.deepEqual(await budget.status(p.id),first,'charge settlement idempotent');
  console.log('PASS project memory: all chunks, durable cache, live-source invalidation, project ACL and source scope, bad quotes, exhausted time and idempotent accounting');
 }finally{delete process.env.DOCGRID_AI_MONTHLY_HOURS;if(old===undefined)delete process.env.DOCGRID_ORCHESTRA_URL;else process.env.DOCGRID_ORCHESTRA_URL=old;await new Promise(r=>server.close(r));}
};
