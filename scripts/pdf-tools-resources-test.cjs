process.env.NODE_ENV='test';
process.env.DOCGRID_IDENTITY_JWT_SECRET='pdf-resource-test-only-secret-000000';
process.env.DOCGRID_SERVICE_TOKEN='pdf-resource-test-only-token-000000';
require('reflect-metadata');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {mkdtemp,readdir,stat,writeFile,readFile,chmod,utimes,symlink,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {Module}=require('@nestjs/common');
const {NestFactory}=require('@nestjs/core');
const {PdfToolsController}=require('../dist/modules/docgrid/pdf-tools.controller');
const {PdfUploadInterceptor}=require('../dist/modules/docgrid/pdf-upload.interceptor');
const {DocumentToolsService}=require('../dist/modules/docgrid/document-tools.service');
const {cleanupExpiredPdfUploads,PDF_UPLOAD_RETENTION_MS}=require('../dist/modules/docgrid/pdf-temporary-files');
const MAX=100*1024*1024;
const eventually=async(fn)=>{for(let i=0;i<500;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Condition timed out');};
(async()=>{
 const scratch=await mkdtemp(join(tmpdir(),'pdf-resource-test-'));const previous=process.env.TMPDIR;process.env.TMPDIR=scratch;
 const forbidden=new Proxy({}, {get(){throw Error('PDF tools accessed project storage');}});
 const service=new DocumentToolsService(forbidden,forbidden,forbidden);
 Reflect.defineMetadata('__guards__',[{canActivate:()=>true}],PdfToolsController);
 let engineCalls=0,running=0,maxRunning=0,hold;
 const seen=[];const realEngine=service.engine.bind(service);
 service.engine=async(dir,config,_timeout,signal)=>{
  engineCalls++;running++;maxRunning=Math.max(maxRunning,running);
  try{
   for(const file of config.files){seen.push((await stat(file.path)).size);assert.equal(file.buffer,undefined);}
   if(hold)await Promise.race([hold.promise,new Promise((_,reject)=>signal?.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))]);
   if(config.tool==='inspect')return {pages:1,image:'data:image/png;base64,AA=='};
   await writeFile(join(dir,'result.pdf'),'%PDF-1.7\nresult');return {outputs:[{file:'result.pdf'}]};
  }finally{running--;}
 };
 class TestModule{};Module({controllers:[PdfToolsController],providers:[PdfUploadInterceptor,{provide:DocumentToolsService,useValue:service}]})(TestModule);
 const app=await NestFactory.create(TestModule,{logger:false,abortOnError:false});await app.listen(0,'127.0.0.1');const base=await app.getUrl();
 const start=(path='process')=>{
  let resolveResponse,rejectResponse;const response=new Promise((r,j)=>{resolveResponse=r;rejectResponse=j;});
  const req=http.request(base+'/api/docgrid/tools/'+path,{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=dgtest'}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolveResponse({status:res.statusCode,body:Buffer.concat(chunks)}));});
  req.on('error',rejectResponse);response.catch(()=>{});
  return {req,response};
 };
 const write=async(req,chunk)=>{if(!req.write(chunk))await once(req,'drain');};
 const header=name=>Buffer.from(`--dgtest\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`);
 const tail=path=>Buffer.from(path==='preview'?'\r\n--dgtest\r\nContent-Disposition: form-data; name="page"\r\n\r\n1\r\n--dgtest--\r\n':'\r\n--dgtest\r\nContent-Disposition: form-data; name="tool"\r\n\r\ncompress\r\n--dgtest--\r\n');
 const sendFile=async(req,size,name='file.pdf')=>{await write(req,header(name));await write(req,Buffer.from('%PDF-'));let left=size-5;const chunk=Buffer.alloc(256*1024);while(left){const n=Math.min(left,chunk.length);await write(req,chunk.subarray(0,n));left-=n;}};
 const clean=async()=>eventually(async()=>service.operations.size===0&&(await readdir(scratch)).length===0);
 try{
  // Two uploads are admitted before body buffering; a third is rejected without a temp dir.
  const a=start(),b=start();a.req.flushHeaders();b.req.flushHeaders();await eventually(()=>service.operations.size===2);
  assert.equal((await readdir(scratch)).length,2);
  const rejected=start();rejected.req.end();assert.equal((await rejected.response).status,503);assert.equal((await readdir(scratch)).length,2);assert.equal(engineCalls,0);
  hold={};hold.promise=new Promise(r=>hold.resolve=r);
  await Promise.all([sendFile(a.req,MAX),sendFile(b.req,MAX)]);a.req.end(tail());b.req.end(tail());
  await eventually(()=>running===2);assert.equal(maxRunning,2);hold.resolve();hold=undefined;
  assert.equal((await a.response).status,201);assert.equal((await b.response).status,201);assert.deepEqual(seen,[MAX,MAX]);await clean();
  // Combined quota and per-file quota; neither reaches the engine.
  let calls=engineCalls;let over=start();await sendFile(over.req,60*1024*1024);await write(over.req,Buffer.from('\r\n'));await sendFile(over.req,41*1024*1024,'second.pdf');over.req.end(tail());assert.equal((await over.response).status,400);assert.equal(engineCalls,calls);await clean();
  over=start();await sendFile(over.req,MAX+1);over.req.end(tail());assert.ok([400,413].includes((await over.response).status));assert.equal(engineCalls,calls);await clean();
  const many=start();for(let i=0;i<31;i++){if(i)await write(many.req,Buffer.from('\r\n'));await sendFile(many.req,5,`file-${i}.pdf`);}many.req.end(tail());assert.ok([400,413].includes((await many.response).status));assert.equal(engineCalls,calls);await clean();
  // Cancellation during upload closes writers, removes partial files, restores capacity.
  const cancelled=start();await sendFile(cancelled.req,1024*1024);await eventually(()=>service.operations.size===1);cancelled.req.destroy();await cancelled.response.catch(()=>{});await clean();
  const empty=start();empty.req.flushHeaders();await eventually(()=>service.operations.size===1);empty.req.destroy();await empty.response.catch(()=>{});await clean();
  // Disconnect after uploading also cancels processing, keeping the slot until it stops.
  hold={};hold.promise=new Promise(r=>hold.resolve=r);
  const processing=start();await sendFile(processing.req,16);processing.req.end(tail());await eventually(()=>running===1);processing.req.destroy();await processing.response.catch(()=>{});await clean();hold.resolve();hold=undefined;
  // Use the actual spawn/abort path and verify the worker exits before capacity returns.
  const workerDir=await mkdtemp(join(tmpdir(),'worker-fixture-'));
  const executable=join(workerDir,'slow-python');
  await writeFile(executable,'#!/usr/bin/env python3\nimport os,sys,time,pathlib\npathlib.Path(sys.argv[2]).with_name("pid").write_text(str(os.getpid()))\ntime.sleep(60)\n');await chmod(executable,0o700);
  const fakeEngine=service.engine,python=process.env.DOCGRID_TOOLS_PYTHON;
  process.env.DOCGRID_TOOLS_PYTHON=executable;service.engine=realEngine;
  try{
   const slow=start();await sendFile(slow.req,16);slow.req.end(tail());let pid;
   await eventually(async()=>{const dirs=(await readdir(scratch)).filter(name=>name.startsWith('dg-pdf-'));if(!dirs.length)return false;try{pid=Number(await readFile(join(scratch,dirs[0],'pid'),'utf8'));return true;}catch{return false;}});
   slow.req.destroy();await slow.response.catch(()=>{});
   await eventually(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
   await rm(workerDir,{recursive:true,force:true});await clean();
  }finally{service.engine=fakeEngine;if(python===undefined)delete process.env.DOCGRID_TOOLS_PYTHON;else process.env.DOCGRID_TOOLS_PYTHON=python;await rm(workerDir,{recursive:true,force:true});}
  // Upload deadline includes clients stalled before sending any file.
  const originalTimeout=PdfUploadInterceptor.prototype.uploadTimeoutMs;PdfUploadInterceptor.prototype.uploadTimeoutMs=()=>50;
  const stalled=start();stalled.req.flushHeaders();await stalled.response.catch(()=>{});await clean();PdfUploadInterceptor.prototype.uploadTimeoutMs=originalTimeout;
  // Preview shares admission with project operations (the same service lease).
  const projectLease=service.acquireOperation();hold={};hold.promise=new Promise(r=>hold.resolve=r);
  const preview=start('preview');await sendFile(preview.req,16);preview.req.end(tail('preview'));await eventually(()=>running===1);
  assert.throws(()=>service.acquireOperation(),/занят/);
  const blocked=start();blocked.req.end();assert.equal((await blocked.response).status,503);
  hold.resolve();hold=undefined;assert.equal((await preview.response).status,201);projectLease.release();await clean();
  // Interrupted response/download: no result buffer, lease survives until stream closes.
  const smallEngine=service.engine;
  service.engine=async(dir)=>{const file=join(dir,'result.pdf');const handle=await require('node:fs/promises').open(file,'w');try{await handle.truncate(50*1024*1024);}finally{await handle.close();}return {outputs:[{file:'result.pdf'}]};};
  const response=await new Promise((resolve,reject)=>{const req=http.request(base+'/api/docgrid/tools/process',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=dgtest'}},res=>{res.pause();resolve(res);});req.on('error',reject);req.end(Buffer.concat([header('result.pdf'),Buffer.from('%PDF-'),tail()]));});
  await eventually(()=>service.operations.size===1);response.destroy();await clean();service.engine=smallEngine;
  // Orphans after a crash expire, recent directories and unrelated paths survive.
  const orphan=await mkdtemp(join(scratch,'dg-pdf-')),recent=await mkdtemp(join(scratch,'dg-pdf-')),unrelated=await mkdtemp(join(scratch,'other-'));
  const old=new Date(Date.now()-PDF_UPLOAD_RETENTION_MS-1000);await utimes(orphan,old,old);await utimes(unrelated,old,old);
  const link=join(scratch,'dg-pdf-symlink');await symlink(unrelated,link);
  await cleanupExpiredPdfUploads(scratch);await assert.rejects(()=>stat(orphan),{code:'ENOENT'});assert.ok((await stat(recent)).isDirectory());assert.ok((await stat(unrelated)).isDirectory());
  await rm(recent,{recursive:true});await rm(unrelated,{recursive:true});await rm(link);await clean();
  assert.ok(maxRunning<=2);
  console.log('PASS two concurrent streamed 100 MiB uploads, early admission, aggregate/file/count limits, upload/processing cancellation, deadline, cleanup and shared preview capacity');
 }finally{await app.close();if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;await rm(scratch,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
