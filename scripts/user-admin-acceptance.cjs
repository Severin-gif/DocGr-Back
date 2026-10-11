const assert=require('node:assert/strict');
module.exports=async({base,call,jwt,db,p,grant})=>{
 process.env.DOCGRID_ADMIN_TOKEN='admin'.repeat(10);
 const root='/internal/docgrid/admin/users';
 async function admin(path='',method='GET',body,status=200,token=process.env.DOCGRID_ADMIN_TOKEN){
  const r=await fetch(base+root+path,{method,headers:{'x-docgrid-admin-token':token,'x-docgrid-admin-actor':'test-admin',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const b=await r.json();assert.equal(r.status,status,JSON.stringify(b));return b;
 }
 await call(root,'GET',undefined,jwt('owner'),401);
 await admin('','GET',undefined,401,'wrong');
 const list=await admin('?q=owner%40example.test');assert.equal(list.total,1);
 const user=list.users[0];assert.equal(user.email,'owner@example.test');assert.ok(user.projects>=1);
 assert.equal(user.passwordHash,undefined);assert.equal(user.localLoginDisabled,undefined);
 await admin('?page=0','GET',undefined,400);await admin('?status=invalid','GET',undefined,400);
 await admin('/'+user.id+'/access','POST',{blocked:true,reason:''},400);
 await admin('/missing/access','POST',{blocked:true,reason:'test'},404);
 await admin('/'+user.id+'/access','POST',{blocked:true,reason:'Support block'},201);
 const blocked=await admin('?q=owner%40example.test&status=blocked');assert.equal(blocked.total,1);
 await call('/api/docgrid/home','GET',undefined,jwt('owner'),403);
 await call('/api/docgrid/repositories/'+p.id+'/overview','GET',undefined,jwt('owner'),403);
 await call('/api/docgrid/agents/catalog?projectId='+p.id,'GET',undefined,grant.token,403);
 // A freshly issued token must not overwrite the local block.
 await call('/api/docgrid/repositories','GET',undefined,jwt('owner'),403);
 await call('/api/docgrid/repositories','GET',undefined,jwt('stranger'));
 await admin('/'+user.id+'/access','POST',{blocked:true,reason:'Repeated request'},201);
 assert.equal((await admin('/'+user.id+'/history')).length,1);
 await admin('/'+user.id+'/access','POST',{blocked:false,reason:'Resolved'},201);
 await call('/api/docgrid/home','GET',undefined,jwt('owner'));
 await call('/api/docgrid/agents/catalog?projectId='+p.id,'GET',undefined,grant.token);
 const history=await admin('/'+user.id+'/history');assert.equal(history.length,2);assert.equal(history[0].actor,'test-admin');
 assert.equal((await admin('?q=owner%40example.test&status=active')).total,1);
 assert.equal(await db.workspaceProject.count({where:{id:p.id}}),1);
 console.log('PASS user admin: search, secret omission, guards, validation, audit, SSO-persistent block, agent block and restore');
};
