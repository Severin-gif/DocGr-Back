process.env.NODE_ENV='test';
process.env.DOCGRID_IDENTITY_JWT_SECRET='standalone-pdf-test-only-secret-000000';
process.env.DOCGRID_SERVICE_TOKEN='standalone-pdf-test-only-token-000000';
require('reflect-metadata');
const assert=require('node:assert/strict');
const {Module,UnauthorizedException}=require('@nestjs/common');
const {NestFactory}=require('@nestjs/core');
const {execFileSync}=require('node:child_process');
const {PdfToolsController}=require('../dist/modules/docgrid/pdf-tools.controller');
const {DocumentToolsService}=require('../dist/modules/docgrid/document-tools.service');
const {DocGridIdentityGuard}=require('../dist/modules/docgrid/docgrid-identity.guard');
(async()=>{
 const forbidden=new Proxy({}, {get(){throw new Error('Standalone PDF must never access projects or storage');}});
 const service=new DocumentToolsService(forbidden,forbidden,forbidden);
 const guard={canActivate(context){if(context.switchToHttp().getRequest().headers.authorization!=='Bearer test')throw new UnauthorizedException();return true;}};
 assert.deepEqual(Reflect.getMetadata('__guards__',PdfToolsController),[DocGridIdentityGuard]);
 Reflect.defineMetadata('__guards__',[guard],PdfToolsController);
 class TestModule{};Module({controllers:[PdfToolsController],providers:[{provide:DocumentToolsService,useValue:service},{provide:DocGridIdentityGuard,useValue:guard}]})(TestModule);
 const app=await NestFactory.create(TestModule,{logger:false,abortOnError:false});await app.listen(0,'127.0.0.1');const base=await app.getUrl();
 const pdf=execFileSync(process.env.DOCGRID_TOOLS_PYTHON||'python3',['-c','import io,sys;from reportlab.pdfgen import canvas;b=io.BytesIO();c=canvas.Canvas(b);c.drawString(80,700,"PDF ONLY");c.showPage();c.save();sys.stdout.buffer.write(b.getvalue())']);
 const post=async(path,fields,files=[{name:'test.pdf',bytes:pdf}],auth=true)=>{const data=new FormData();for(const file of files)data.append('files',new Blob([file.bytes],{type:'application/pdf'}),file.name);for(const [k,v] of Object.entries(fields))data.append(k,v);return fetch(base+'/api/docgrid/tools/'+path,{method:'POST',headers:auth?{Authorization:'Bearer test'}:{},body:data});};
 try{
  let res=await post('process',{tool:'number',options:'{}'},undefined,false);assert.equal(res.status,401);
  res=await post('process',{tool:'number',options:'{}'});assert.equal(res.status,201,await res.clone().text());assert.match(res.headers.get('content-type'),/application\/pdf/);assert.equal(res.headers.get('cache-control'),'no-store');assert.ok(Buffer.from(await res.arrayBuffer()).includes(Buffer.from('%PDF-')));
  res=await post('preview',{page:'1'});assert.equal(res.status,201);const preview=await res.json();assert.equal(preview.pages,1);assert.match(preview.image,/^data:image/);
  res=await post('process',{tool:'pages',options:JSON.stringify({mode:'split'})});assert.equal(res.status,201);assert.match(res.headers.get('content-type'),/zip/);assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0,2).toString(),'PK');
  for(const [tool,options,files] of [['merge','{}'],['protect','{}'],['docx-pdf','{}'],['compress','{'],['compress','{}',[{name:'fake.pdf',bytes:Buffer.from('not pdf')}]],['compress','{}',[{name:'document.docx',bytes:pdf}]]]){
   res=await post('process',{tool,options},files);assert.equal(res.status,400,tool);await res.body.cancel();
  }
  console.log('PASS standalone authenticated multipart PDF/ZIP/preview, invalid inputs, zero project/storage access');
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
