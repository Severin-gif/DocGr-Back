import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, open, stat } from 'node:fs/promises';
import { join, extname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupExpiredPdfUploads } from './pdf-temporary-files';
import { PrismaService } from '../../prisma/prisma.service';
import { DocGridService } from './docgrid.service';
import { CourtPackageService } from './court-package.service';
import { pdfInputSchema, sourceSchema, ToolInput, toolInputSchema, ToolSource } from './document-tools.contract';

type Job={id:string;project_id:string;actor_id:string;tool:string;title:string;config:ToolInput & {secret?:string};state:string;result:unknown[];warnings:string[];error:string|null};
type EngineResult={error?:string;outputs?:{file:string}[];warnings?:string[];pages?:number;page?:number;image?:string;inputBytes?:number;outputBytes?:number};
export type PdfFile={originalname:string;path:string;size:number};
export type ToolLease={release:()=>void};
const MAX_BYTES=100*1024*1024;
const mime:Record<string,string>={'.pdf':'application/pdf','.zip':'application/zip','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};

@Injectable()
export class DocumentToolsService implements OnModuleInit,OnModuleDestroy {
  private timer?:NodeJS.Timeout;
  private cleanupTimer?:NodeJS.Timeout;
  private cleanupActive?:Promise<void>;
  private active?:Promise<void>;
  private readonly operations=new Set<ToolLease>();
  acquireOperation():ToolLease {
    this.enabled();
    const lease=this.tryAcquireOperation();
    if(!lease)throw new ServiceUnavailableException('Обработчик занят. Повторите через несколько секунд');
    return lease;
  }
  private tryAcquireOperation():ToolLease|undefined {
    if(this.stopped||this.operations.size>=2)return;
    const lease={release:()=>{this.operations.delete(lease);}};
    this.operations.add(lease);return lease;
  }
  private stopped=false;
  private readonly logger=new Logger('DocumentTools');
  constructor(private readonly db:PrismaService,private readonly grid:DocGridService,private readonly packages:CourtPackageService){}
  onModuleInit(){
    if(process.env.NODE_ENV==='test')return;
    const cleanup=()=>{if(!this.cleanupActive)this.cleanupActive=cleanupExpiredPdfUploads().catch(()=>this.logger.warn('PDF temporary directory cleanup failed')).finally(()=>{this.cleanupActive=undefined;});};
    cleanup();this.cleanupTimer=setInterval(cleanup,60000);this.cleanupTimer.unref();
    if(process.env.DOCGRID_TOOLS_ENABLED==='false')return;
    this.timer=setInterval(()=>{if(!this.active&&!this.stopped)this.active=this.tick().catch(()=>this.logger.warn('Document tools queue unavailable')).finally(()=>{this.active=undefined;});},2500);
    this.timer.unref();
  }
  async onModuleDestroy(){this.stopped=true;if(this.timer)clearInterval(this.timer);if(this.cleanupTimer)clearInterval(this.cleanupTimer);await Promise.all([this.active,this.cleanupActive]);}
  private enabled(){if(process.env.DOCGRID_TOOLS_ENABLED==='false')throw new ServiceUnavailableException('Инструменты временно отключены');}
  private async access(db:PrismaService|any,user:string,project:string,write=false){
    const rows=await db.$queryRaw`SELECT p.id FROM docgrid.workspace_projects p WHERE p.id=${project}::uuid AND (p.owner_id=${user} OR EXISTS (SELECT 1 FROM docgrid.docgrid_members m WHERE m.project_id=p.id AND m.user_id=${user} AND (${!write} OR m.role IN ('EDITOR','REVIEWER'))))`;
    if(!rows.length)throw new NotFoundException('Проект недоступен или недостаточно прав');
  }
  private key(){const key=process.env.DOCGRID_TOOLS_SECRET||process.env.DOCGRID_SERVICE_TOKEN;if(!key)throw new ServiceUnavailableException('Не настроен ключ защищённой обработки');return createHash('sha256').update(key).digest();}
  private encrypt(value:string){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key(),iv);return Buffer.concat([iv,c.update(value,'utf8'),c.final(),c.getAuthTag()]).toString('base64');}
  private decrypt(value:string){const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',this.key(),b.subarray(0,12));d.setAuthTag(b.subarray(-16));return Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString('utf8');}
  private async source(user:string,project:string,s:ToolSource){
    if(s.kind==='document')return this.packages.documentFile(user,project,s.branchId,s.id,s.revision,'docx');
    const m=await this.grid.material(user,project,s.id);
    if(m.sha256!==s.sha256)throw new ConflictException('Исходный файл изменился. Выберите его заново.');
    return {title:m.title,mime:m.mime,bytes:Buffer.from(m.bytes)};
  }
  private view(row:Job){return {id:row.id,tool:row.tool,title:row.title,state:row.state,result:row.result,warnings:row.warnings,error:row.error};}
  async list(user:string,project:string){await this.access(this.db,user,project);const rows=await this.db.$queryRaw<Job[]>`SELECT id,tool,title,state,result,warnings,error FROM docgrid.dg_tool_jobs WHERE project_id=${project}::uuid ORDER BY created_at DESC LIMIT 50`;return rows.map(r=>this.view(r));}
  async enqueue(user:string,project:string,raw:unknown){
    this.enabled();const parsed=toolInputSchema.safeParse(raw);if(!parsed.success)throw new BadRequestException(parsed.error.issues.map(i=>i.message).join('; '));
    const cfg:ToolInput & {secret?:string}=parsed.data;
    await this.access(this.db,user,project,true);
    // Validate sources before accepting a job; compare again when the worker reads them.
    let total=0;
    for(const s of cfg.sources){
      const f=await this.source(user,project,s);total+=f.bytes.length;
      if(total>MAX_BYTES)throw new BadRequestException('За одну операцию доступно 100 МБ');
      const ext=extname(f.title).toLowerCase();const allowed=cfg.tool==='images-pdf'?['.png','.jpg','.jpeg']:cfg.tool==='docx-pdf'?['.docx']:cfg.tool==='bundle'||cfg.tool==='merge'?['.pdf','.docx','.png','.jpg','.jpeg']:cfg.tool==='ocr'?['.pdf','.png','.jpg','.jpeg']:['.pdf'];
      if(!allowed.includes(ext))throw new BadRequestException('Формат выбранного файла не подходит для операции');
    }
    if(cfg.options.password){cfg.secret=this.encrypt(cfg.options.password);delete cfg.options.password;}
    return this.db.$transaction(async tx=>{
      await this.access(tx,user,project,true);
      // Serialize queue admission and bound outstanding jobs across replicas.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(29140002)`;
      const [existing]=await tx.$queryRaw<Job[]>`SELECT * FROM docgrid.dg_tool_jobs WHERE id=${cfg.requestId}::uuid`;
      if(existing){if(existing.project_id!==project||existing.actor_id!==user)throw new ConflictException('Повторите операцию с новым идентификатором');return this.view(existing);}
      const [pending]=await tx.$queryRaw<{count:number}[]>`SELECT count(*)::int AS count FROM docgrid.dg_tool_jobs WHERE actor_id=${user} AND state IN ('queued','running')`;
      if(pending.count>=5)throw new BadRequestException('Дождитесь завершения предыдущих операций (не более пяти в очереди)');
      const [row]=await tx.$queryRaw<Job[]>`INSERT INTO docgrid.dg_tool_jobs(id,project_id,actor_id,tool,title,config) VALUES(${cfg.requestId}::uuid,${project}::uuid,${user},${cfg.tool},${cfg.title},${JSON.stringify(cfg)}::jsonb) RETURNING *`;
      return this.view(row);
    });
  }
  async inspect(user:string,project:string,raw:unknown){
    this.enabled();await this.access(this.db,user,project);
    const body=raw as {source?:unknown;page?:number};const parsed=sourceSchema.safeParse(body?.source);
    if(!parsed.success||!Number.isInteger(body.page)||body.page!<1||body.page!>300)throw new BadRequestException('Выберите файл и страницу');
    const lease=this.acquireOperation();let dir='';
    try{const f=await this.source(user,project,parsed.data);if(extname(f.title).toLowerCase()!=='.pdf'||f.bytes.length>MAX_BYTES)throw new BadRequestException('Предпросмотр поддерживает PDF до 100 МБ');dir=await mkdtemp(join(tmpdir(),'dg-preview-'));const path=join(dir,'source.pdf');await writeFile(path,f.bytes);return await this.engine(dir,{tool:'inspect',files:[{path,title:f.title}],options:{page:body.page}},30000);}
    finally{try{if(dir)await rm(dir,{recursive:true,force:true});}finally{lease.release();}}
  }
  private async pdfFiles(files:PdfFile[]){
    if(!files?.length||files.length>30||files.reduce((n,f)=>n+f.size,0)>MAX_BYTES)throw new BadRequestException('Выберите до 30 PDF общим размером не более 100 МБ');
    for(const file of files){
      const handle=await open(file.path,'r');
      try{
        const header=Buffer.alloc(1024);const {bytesRead}=await handle.read(header,0,1024,0);
        if(!file.originalname.toLowerCase().endsWith('.pdf')||!header.subarray(0,bytesRead).includes(Buffer.from('%PDF-')))throw new BadRequestException('Поддерживаются только файлы PDF');
      }finally{await handle.close();}
    }
  }
  private async withPdf(files:PdfFile[],tool:string,options:unknown,lease:ToolLease,signal?:AbortSignal){
    this.enabled();
    if(!this.operations.has(lease))throw new ServiceUnavailableException('Резервирование обработки истекло');
    signal?.throwIfAborted();await this.pdfFiles(files);
    // The upload interceptor owns the directory and lease through processing and cleanup.
    const dir=resolve(files[0].path,'..');
    const inputs=files.map(file=>({path:file.path,title:/[^\x00-\x7f]/.test(file.originalname)?Buffer.from(file.originalname,'latin1').toString('utf8'):file.originalname}));
    const result=await this.engine(dir,{tool,files:inputs,options},tool==='inspect'?30000:75000,signal);
    if(tool==='inspect')return {preview:result};
    const output=result.outputs?.[0];
    if(!output||result.outputs?.length!==1||basename(output.file)!==output.file||!mime[extname(output.file)])throw new BadRequestException('Не удалось создать результат');
    const path=join(dir,output.file);
    if((await stat(path)).size>MAX_BYTES)throw new BadRequestException('Результат превышает 100 МБ');
    return {file:{stream:createReadStream(path),mime:mime[extname(output.file)],extension:extname(output.file)}};
  }
  async processPdf(files:PdfFile[],raw:unknown,lease:ToolLease,signal?:AbortSignal){
    const body=raw as {tool?:string;options?:string};let options:unknown;
    try{options=JSON.parse(body?.options||'{}');}catch{throw new BadRequestException('Некорректные настройки');}
    const parsed=pdfInputSchema.safeParse({tool:body?.tool,count:files?.length,options});
    if(!parsed.success)throw new BadRequestException(parsed.error.issues.map(i=>i.message).join('; '));
    return (await this.withPdf(files,parsed.data.tool,parsed.data.options,lease,signal)).file!;
  }
  async previewPdf(files:PdfFile[],page:number,lease:ToolLease,signal?:AbortSignal){
    if(files?.length!==1||!Number.isInteger(page)||page<1||page>300)throw new BadRequestException('Выберите один PDF и страницу от 1 до 300');
    return (await this.withPdf(files,'inspect',{page},lease,signal)).preview!;
  }
  private engine(dir:string,config:unknown,timeout=300000,signal?:AbortSignal):Promise<EngineResult>{
    return (async()=>{
      signal?.throwIfAborted();
      const input=join(dir,'input.json');await writeFile(input,JSON.stringify(config),{mode:0o600});
      return new Promise<EngineResult>((resolveResult,reject)=>{
        signal?.throwIfAborted();
        const child=spawn(process.env.DOCGRID_TOOLS_PYTHON||'python3',[resolve('scripts/document-tools.py'),input],{detached:true,stdio:['ignore','pipe','pipe']});
        let output='',done=false;
        const finish=(error?:Error,result?:EngineResult)=>{
          if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
          try{process.kill(-child.pid!,'SIGKILL');}catch{}
          const settle=()=>error?reject(error):resolveResult(result!);
          // Do not return the shared slot until the killed worker has actually closed.
          if(child.exitCode===null&&child.signalCode===null)child.once('close',settle);else settle();
        };
        const abort=()=>finish(new BadRequestException('Запрос отменён'));
        signal?.addEventListener('abort',abort,{once:true});
        const timer=setTimeout(()=>finish(new BadRequestException('Превышено время обработки. Разделите файл на части.')),timeout);
        child.stdout.on('data',b=>{output+=b.toString();if(output.length>3*1024*1024)finish(new BadRequestException('Результат обработки слишком велик'));});
        child.stderr.on('data',()=>{});child.on('error',()=>finish(new ServiceUnavailableException('Обработчик документов недоступен')));
        child.on('close',()=>{try{const result=JSON.parse(output) as EngineResult;if(result.error)finish(new BadRequestException(result.error));else finish(undefined,result);}catch{finish(new BadRequestException('Не удалось обработать документ'));}});
      });
    })();
  }
  async tick(){
    const lease=this.tryAcquireOperation();if(!lease)return;
    try{await this.tickReserved();}finally{lease.release();}
  }
  private async tickReserved(){
    const job=await this.db.$transaction(async tx=>{
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(29140002)`;
      // A crashed job is failed, never silently rerun after possibly storing a result.
      await tx.$executeRaw`UPDATE docgrid.dg_tool_jobs SET state='failed',error='Обработка прервана перезапуском сервиса. Проверьте папку результатов перед повтором.',config=config-'secret',updated_at=now() WHERE state='running' AND lease_until<now()`;
      const busy=await tx.$queryRaw<any[]>`SELECT id FROM docgrid.dg_tool_jobs WHERE state='running' LIMIT 1`;if(busy.length)return null;
      const [row]=await tx.$queryRaw<Job[]>`SELECT * FROM docgrid.dg_tool_jobs WHERE state='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if(!row)return null;
      await tx.$executeRaw`UPDATE docgrid.dg_tool_jobs SET state='running',lease_until=now()+interval '10 minutes',updated_at=now() WHERE id=${row.id}::uuid`;return row;
    });
    if(!job)return;
    let dir='';
    const heartbeat=setInterval(()=>{void this.db.$executeRaw`UPDATE docgrid.dg_tool_jobs SET lease_until=now()+interval '10 minutes' WHERE id=${job.id}::uuid AND state='running'`.catch(()=>this.logger.warn('Document tools lease renewal failed'));},30000);
    heartbeat.unref();
    try{
      await this.access(this.db,job.actor_id,job.project_id,true);dir=await mkdtemp(join(tmpdir(),'dg-tools-'));
      const files=[];let total=0;
      for(const [i,s] of job.config.sources.entries()){
        const f=await this.source(job.actor_id,job.project_id,s);total+=f.bytes.length;if(total>MAX_BYTES)throw new BadRequestException('Превышен лимит 100 МБ');
        const path=join(dir,`source-${i}${extname(f.title).toLowerCase()}`);await writeFile(path,f.bytes);files.push({path,title:f.title});
      }
      const options={...job.config.options};if(job.config.secret)options.password=this.decrypt(job.config.secret);
      const result=await this.engine(dir,{tool:job.tool,files,options});
      const saved:Array<{id:string;title:string;bytes:number;mime:string;inputBytes?:number}>=[];
      for(const output of result.outputs||[]){
        if(basename(output.file)!==output.file||!mime[extname(output.file)])throw new BadRequestException('Недопустимый результат обработки');
        const bytes=await readFile(join(dir,output.file));if(bytes.length>MAX_BYTES)throw new BadRequestException('Результат превышает 100 МБ');
        const title=job.title.replace(/[\x00-\x1f/\\]/g,'_').replace(/\.(pdf|zip|docx|xlsx)$/i,'')+'-'+job.id.slice(0,8)+extname(output.file);
        const material=await this.grid.uploadMaterial(job.actor_id,job.project_id,{originalname:title,mimetype:mime[extname(output.file)],buffer:bytes},job.config.path);
        saved.push({id:material.id,title,bytes:bytes.length,mime:mime[extname(output.file)],inputBytes:result.inputBytes});
      }
      if(!saved.length)throw new BadRequestException('Результат не создан');
      await this.db.$transaction(async tx=>{
        await this.access(tx,job.actor_id,job.project_id,true);
        await tx.$executeRaw`UPDATE docgrid.dg_tool_jobs SET state='completed',result=${JSON.stringify(saved)}::jsonb,warnings=${JSON.stringify(result.warnings||[])}::jsonb,config=config-'secret',updated_at=now() WHERE id=${job.id}::uuid`;
        const metadata={tool:job.tool,title:job.title,sources:job.config.sources,outputs:saved,inputBytes:result.inputBytes,outputBytes:result.outputBytes};
        await tx.$executeRaw`INSERT INTO docgrid.docgrid_events(project_id,actor_id,event_type,entity_type,entity_id,metadata) VALUES(${job.project_id}::uuid,${job.actor_id},'tools.completed','tool',${job.id}::uuid,${JSON.stringify(metadata)}::jsonb)`;
      });
    }catch(error){
      const message=error instanceof BadRequestException||error instanceof NotFoundException||error instanceof ConflictException||error instanceof ServiceUnavailableException?error.message:'Не удалось завершить обработку. Проверьте файлы и повторите.';
      await this.db.$executeRaw`UPDATE docgrid.dg_tool_jobs SET state='failed',error=${message},config=config-'secret',updated_at=now() WHERE id=${job.id}::uuid`;
    }finally{clearInterval(heartbeat);if(dir)await rm(dir,{recursive:true,force:true});}
  }
}
