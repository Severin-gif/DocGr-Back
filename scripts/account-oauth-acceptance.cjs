const assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
module.exports=async function({call,jwt,base,p,prefix,db}) {
 const origin='https://api.docgrid.ru', resource=origin+'/api/docgrid/mcp';
 // Both discovery documents must include the accepted legacy scope and tools.
 for(const path of ['/.well-known/oauth-protected-resource/api/docgrid/mcp','/.well-known/oauth-authorization-server/api/docgrid/oauth','/api/docgrid/oauth/.well-known/oauth-authorization-server']){
  const response=await fetch(base+path);assert.equal(response.status,200);
  const metadata=await response.json();assert.ok(metadata.scopes_supported.includes('docgrid'));
  assert.ok(metadata.scopes_supported.includes('docgrid_get_project'));
  assert.equal(new Set(metadata.scopes_supported).size,metadata.scopes_supported.length);
 }
 const redirect='http://127.0.0.1:8765/callback';
 const client=await call('/api/docgrid/oauth/register','POST',{client_name:'External SDK acceptance',redirect_uris:[redirect]},null,201);
 const verifier='v'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
 async function begin(scope='docgrid_get_project',fixed=''){
  const query=new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',resource:resource+fixed,scope,state:'client-state',code_challenge:challenge,code_challenge_method:'S256'});
  const r=await fetch(base+'/api/docgrid/oauth/authorize?'+query,{redirect:'manual'});assert.equal(r.status,303);
  const location=new URL(r.headers.get('location'));assert.equal(location.origin,'https://docgrid.ru');
  return new URLSearchParams(location.hash.slice(1)).get('ticket');
 }
 const prepare=(ticket,who='owner',status=201)=>call('/api/docgrid/oauth/account/prepare','POST',{ticket},who?jwt(who):null,status);
 const decide=(receipt,extra={},who='owner',status=201)=>call('/api/docgrid/oauth/account/decide','POST',{receipt,decision:'allow',projectId:p.id,actions:['docgrid_get_project'],...extra},jwt(who),status);
 const ticket=await begin();await prepare(ticket,null,401);
 const consent=await prepare(ticket);assert.deepEqual(consent.tools.map(t=>t.name),['docgrid_get_project']);
 await decide(consent.receipt,{},'stranger',401); // A different account cannot consume the receipt.
 const result=await decide(consent.receipt);const callback=new URL(result.redirectUrl);
 assert.equal(callback.searchParams.get('state'),'client-state');assert.equal(callback.searchParams.get('iss'),origin+'/api/docgrid/oauth');
 await decide(consent.receipt,{},'owner',401);
 const exchange={grant_type:'authorization_code',client_id:client.client_id,redirect_uri:redirect,resource,code:callback.searchParams.get('code'),code_verifier:verifier};
 await call('/api/docgrid/oauth/token','POST',{...exchange,code_verifier:'z'.repeat(64)},null,400);
 await call('/api/docgrid/oauth/token','POST',{...exchange,resource:resource+'/'+p.id},null,400);
 const access=await call('/api/docgrid/oauth/token','POST',exchange,null,200);assert.equal(access.scope,'docgrid_get_project');
 await call('/api/docgrid/oauth/token','POST',exchange,null,400);
 await call('/api/docgrid/oauth/account/prepare','POST',{ticket},access.access_token,401);
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const sdk=new Client({name:'DocGrid-external-acceptance',version:'1.0.0'});
 try {
  await sdk.connect(new StreamableHTTPClientTransport(new URL(base+'/api/docgrid/mcp'),{requestInit:{headers:{Authorization:'Bearer '+access.access_token}}}));
  const tools=await sdk.listTools();assert.ok(tools.tools.some(t=>t.name==='docgrid_get_project'));assert.ok(!tools.tools.some(t=>t.name==='docgrid_read_source'));
  const output=await sdk.callTool({name:'docgrid_get_project',arguments:{runId:'sdk',requestKey:randomUUID(),input:{}}});assert.equal(output.isError,false);assert.equal(output.structuredContent.output.id,p.id);
  await assert.rejects(()=>sdk.callTool({name:'docgrid_read_source',arguments:{runId:'sdk',requestKey:randomUUID(),input:{}}}));
  await assert.rejects(()=>sdk.callTool({name:'docgrid_get_project',arguments:{projectId:randomUUID(),runId:'sdk',requestKey:randomUUID(),input:{}}}));
  const grants=await call(prefix+'/agents/grants');const grant=grants.grants.find(g=>g.agentRef==='OAuth: External SDK acceptance');assert.ok(grant);
  await call(prefix+'/agents/grants/'+grant.id+'/revoke','POST',{requestKey:randomUUID()},jwt('owner'),201);
  await assert.rejects(()=>sdk.listTools());
 } finally {await sdk.close();}
 await decide((await prepare(await begin())).receipt,{actions:['docgrid_read_source']},'owner',400);
 await decide((await prepare(await begin(),'stranger')).receipt,{},'stranger',404);
 const legacy=await prepare(await begin('docgrid'));assert.ok(legacy.tools.some(t=>t.name==='docgrid_get_project'));
 await decide(legacy.receipt,{decision:'deny'});
 const denied=await decide((await prepare(await begin())).receipt,{decision:'deny'});assert.equal(new URL(denied.redirectUrl).searchParams.get('error'),'access_denied');
 const fixed=await prepare(await begin('docgrid_get_project','/'+p.id));await decide(fixed.receipt,{projectId:randomUUID()},'owner',400);
 await prepare('tampered','owner',400);
 const events=await db.$queryRaw`SELECT event_type FROM docgrid_live.docgrid_events WHERE project_id=${p.id}::uuid AND event_type IN ('astra.grant.created','astra.grant.revoked','astra.operation.completed')`;
 assert.ok(events.some(e=>e.event_type==='astra.grant.created'));assert.ok(events.some(e=>e.event_type==='astra.grant.revoked'));
 console.log('PASS account OAuth + real external MCP SDK: DCR, PKCE, account binding, consent, scopes, project isolation, one-use codes, SDK initialize/list/call, revocation and audit');
};
