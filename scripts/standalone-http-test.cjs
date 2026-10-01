const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
let passed=false; process.on('beforeExit',()=>{if(!passed){console.error('Acceptance did not complete');process.exitCode=1;}});
const { spawn } = require('node:child_process');
async function run(args) {
 await new Promise((resolve,reject)=>{const p=spawn(process.execPath,args,{stdio:'inherit',env:process.env});p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(Error('Child exit '+code)));});
}
(async()=>{
 let embedded,socket,app,db;
 try {
  if(process.argv.includes('--embedded')){
   const {PGlite}=require('@electric-sql/pglite');const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket');
   embedded=await PGlite.create();socket=new PGLiteSocketServer({db:embedded,port:0,host:'127.0.0.1',maxConnections:4});await socket.start();
   process.env.DATABASE_URL='postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres';
  }
  assert.ok(process.env.DATABASE_URL,'Use an isolated docgrid_test database');
  const url=new URL(process.env.DATABASE_URL);
  if(!embedded)assert.match(url.pathname,/^\/docgrid_test[a-z0-9_-]*$/i);
  url.searchParams.set('schema','docgrid');url.searchParams.set('connection_limit','1');process.env.DATABASE_URL=url.toString();
  const {Client}=require('pg');const check=new Client({connectionString:process.env.DATABASE_URL});await check.connect();
  assert.equal((await check.query("SELECT to_regclass('docgrid.workspace_projects') AS t")).rows[0].t,null);await check.end();
  await run(['scripts/migrate.cjs']);await run(['scripts/migrate.cjs']);
  process.env.NODE_ENV='test';process.env.DOCGRID_IDENTITY_JWT_SECRET='a'.repeat(64);process.env.DOCGRID_SERVICE_TOKEN='b'.repeat(64);process.env.DOCGRID_MATERIAL_STORAGE='database';delete process.env.LEGAL_CORE_URL;
  const {PrismaService}=require('../dist/prisma/prisma.service');
  app=await require('../dist/server').createApplication();console.log('App initialized');await app.listen(0,'127.0.0.1');console.log('App listening');db=app.get(PrismaService);
  const base=await app.getUrl();console.log('Acceptance target',base,'DB',new URL(process.env.DATABASE_URL).host);
  const timeout=setTimeout(()=>{console.error('HTTP acceptance timeout');process.exit(1)},120000);timeout.unref();
  function jwt(sub){const h=Buffer.from(JSON.stringify({alg:'HS256'})).toString('base64url');const p=Buffer.from(JSON.stringify({sub,email:sub+'@example.test',role:'USER',plan:'pro',typ:'docgrid_access',iss:'ai-orchestra',aud:'legal-core-docgrid',exp:Math.floor(Date.now()/1000)+300})).toString('base64url');return `${h}.${p}.${createHmac('sha256','a'.repeat(64)).update(`${h}.${p}`).digest('base64url')}`;}
  async function call(path,method='GET',body,token=jwt('owner'),status=200){const r=await fetch(base+path,{signal:AbortSignal.timeout(10000),method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const t=await r.text();assert.equal(r.status,status,t);return t?JSON.parse(t):null;}
  assert.equal((await call('/health')).service,'docgrid-back');assert.equal((await call('/ready')).status,'ready');
  await call('/api/docgrid/repositories','GET',undefined,null,401);
  const forged=await fetch(base+'/api/docgrid/repositories',{headers:{'x-docgrid-service-token':'b'.repeat(64),'x-docgrid-subject':'owner','x-docgrid-email':'owner@example.test','x-docgrid-role':'ADMIN','x-docgrid-plan':'pro'}});assert.equal(forged.status,401);
  await call('/api/docgrid/internal/agent-oauth/codes','POST',{},null,404);await call('/api/projects','GET',undefined,null,404);
  const p=await call('/api/docgrid/repositories','POST',{name:'Standalone test'},jwt('owner'),201);const prefix='/api/docgrid/repositories/'+p.id;
  await call(prefix+'/overview','GET',undefined,jwt('stranger'),404);
  await call(prefix+'/folders','POST',{path:'/Case/Nested'},jwt('owner'),201);
  const bytes=Buffer.from('Original evidence\n');const form=new FormData();form.append('path','/Case/Nested');form.append('file',new Blob([bytes],{type:'text/plain'}),'proof.txt');
  const upload=await fetch(base+prefix+'/materials',{method:'POST',headers:{authorization:'Bearer '+jwt('owner')},body:form});const material=await upload.json();assert.equal(upload.status,201,JSON.stringify(material));
  const download=await fetch(base+prefix+'/materials/'+material.id+'/download',{headers:{authorization:'Bearer '+jwt('owner')}});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  await call(prefix+'/materials/'+material.id+'/download','GET',undefined,jwt('stranger'),404);
  const artifact=await call(prefix+'/artifacts','POST',{title:'Draft',content:'Text'},jwt('owner'),201);assert.ok(artifact.id);
  const home=await call('/api/docgrid/home');assert.ok(JSON.stringify(home).includes('Standalone test'));
  const grant=await call(prefix+'/agents/grants','POST',{requestKey:'new-grant',agentRef:'any-llm',actions:['docgrid_get_capabilities'],expiresAt:new Date(Date.now()+3600000).toISOString(),maxOperations:20},jwt('owner'),201);assert.ok(grant.token.startsWith('dga_'));
  await call(prefix+'/agents/grants','GET',undefined,grant.token,401);
  const catalog=await call('/api/docgrid/agents/catalog?projectId='+p.id,'GET',undefined,grant.token);assert.ok(catalog.tools.length);
  const mcp=await call('/api/docgrid/mcp/'+p.id,'POST',{jsonrpc:'2.0',id:1,method:'tools/list',params:{}},grant.token);assert.ok(mcp.result?.tools?.length,JSON.stringify(mcp));
  await require('./file-management-acceptance.cjs')({call,jwt,base});
  await require('./context-acceptance.cjs')({call,jwt,db,app});
  await require('./discussion-acceptance.cjs')({call,prefix,p,material,jwt,db});
  await require('./ocr-search-acceptance.cjs')({call,prefix,p,material,jwt,db,app});
  const tables=await db.$queryRaw`SELECT table_schema,table_name FROM information_schema.tables WHERE table_name IN ('workspace_projects','User','_prisma_migrations') AND table_schema IN ('public','docgrid')`;
  assert.ok(tables.length>=3);assert.ok(tables.every(t=>t.table_schema==='docgrid'),JSON.stringify(tables));
  clearTimeout(timeout);passed=true;console.log('PASS standalone HTTP + real Prisma: SSO, forged headers rejected, project isolation, nested upload/download, draft, Home, agent grants, MCP, isolated schema and repeatable migrations; no Legal Core');
 }finally{await app?.close();await socket?.stop();await embedded?.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

