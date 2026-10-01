const assert=require('node:assert/strict');
module.exports=async({call,jwt,base})=>{
 const p=await call('/api/docgrid/repositories','POST',{name:'Management test'},jwt('owner'),201),root='/api/docgrid/repositories/'+p.id;
 const upload=async(text,path='/materials',token=jwt('owner'),status=201)=>{const f=new FormData();f.append('file',new Blob([text],{type:'text/plain'}),'test.txt');const r=await fetch(base+root+path,{method:'POST',headers:{authorization:'Bearer '+token},body:f});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;};
 const original=await upload('Первый текст');
 const same=await upload('Первый текст','/materials/'+original.id+'/compare');assert.equal(same.identical,true);assert.equal(same.current.text,same.candidate.text);
 const changed=await upload('Новая версия','/materials/'+original.id+'/compare');assert.equal(changed.identical,false);assert.equal(changed.candidate.text,'Новая версия');
 await upload('Не разрешено','/materials/'+original.id+'/compare',jwt('stranger'),404);
 assert.equal((await call(root+'/files')).materials.length,1,'comparison must not save candidate');
 await call(root+'/files/'+original.id+'/trash','POST',{kind:'material',action:'trash'},jwt('owner'),201);assert.equal((await call(root+'/files')).materials.length,0);
 await call(root+'/files/'+original.id+'/trash','POST',{kind:'material',action:'restore'},jwt('owner'),201);assert.equal((await call(root+'/files')).materials.length,1);
 await call(root+'/discussions/settings','PUT',{enabled:false});assert.equal((await call(root+'/discussions/context')).reason,'disabled');
 await call(root+'/discussions/context/refresh','POST',{},jwt('owner'),400);
 await call(root+'/discussions/settings','PUT',{enabled:true});const context=await call(root+'/discussions/context/refresh','POST',{},jwt('owner'),201);assert.equal(context.state,'queued');assert.equal(context.canPrepare,true);
 await call(root,'DELETE',undefined,jwt('stranger'),404);
 await call(root,'DELETE');await call(root+'/overview','GET',undefined,jwt('owner'),404);
 assert.ok(!(await call('/api/docgrid/repositories')).some(r=>r.id===p.id));
 console.log('PASS management: comparison bytes/text, no overwrite, trash/restore, context enable/retry, project deletion ACL and cascade');
};
