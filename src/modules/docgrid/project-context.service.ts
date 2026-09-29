import { Injectable, Logger, OnModuleInit, OnModuleDestroy, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AiTimeBudgetService } from './ai-time-budget.service';
import { validateContextResult } from './project-context.protocol';
const CHUNK=10000;
@Injectable()
export class ProjectContextService implements OnModuleInit,OnModuleDestroy {
 private timer?:NodeJS.Timeout;private active?:Promise<void>;private log=new Logger('ProjectContext');
 constructor(private readonly db:PrismaService,private readonly budget:AiTimeBudgetService){}
 onModuleInit(){if(process.env.NODE_ENV==='test'||process.env.DOCGRID_CONTEXT_ENABLED==='false')return;this.timer=setInterval(()=>{if(!this.active)this.active=this.tick().catch(()=>this.log.warn('Context worker failed')).finally(()=>{this.active=undefined;});},5000);this.timer.unref();}
 async onModuleDestroy(){if(this.timer)clearInterval(this.timer);await this.active;}
 async ensure(project:string){await this.db.$executeRaw`INSERT INTO docgrid.dg_project_context(project_id) VALUES(${project}::uuid) ON CONFLICT DO NOTHING`;}
 async status(project:string){await this.ensure(project);const [row]=await this.db.$queryRaw<any[]>`SELECT revision,checked_revision AS "checkedRevision",state,reason,summary,coverage,updated_at AS "updatedAt" FROM docgrid.dg_project_context WHERE project_id=${project}::uuid`;const time=await this.budget.status(project);if(time.remainingMs<90000)return {...row,state:'blocked',reason:'hours_exhausted',time};return {...row,time};}
 async context(project:string,sourceIds:string[]){
  // Read only notes bound to live content and the caller's already authorized snapshot scope.
  const rows=await this.db.$queryRaw<any[]>`SELECT v.source_id,v.title,v.kind,n.chunk,n.note FROM docgrid.dg_context_sources v JOIN docgrid.dg_context_notes n ON n.project_id=v.project_id AND n.source_id=v.source_id AND n.fingerprint=v.fingerprint WHERE v.project_id=${project}::uuid AND v.source_id IN(SELECT jsonb_array_elements_text(${JSON.stringify(sourceIds)}::jsonb)) ORDER BY v.source_id,n.chunk LIMIT 3000`;
  const state=await this.status(project);let summary='',included=0;
  for(const r of rows){const part=`${r.title} [${r.source_id}; ${r.kind}; фрагмент ${r.chunk+1}]: ${r.note.points.map((p:any)=>p.text).join(' ')}\n`;if(summary.length+part.length>24000)continue;summary+=part;included++;}
  return {summary,state:state.state,revision:state.revision,checkedRevision:state.checkedRevision,coverage:state.coverage,omittedNotes:Math.max(0,rows.length-included),warning:'Производное резюме, не доказательство. Цитаты и юридические выводы сверять с оригиналами. Проверка охвата не подтверждает законность.'};
 }
 async retry(project:string){await this.ensure(project);await this.db.$executeRaw`UPDATE docgrid.dg_project_context SET state='queued',reason=NULL,retry_at=now() WHERE project_id=${project}::uuid`;return this.status(project);}
 async tick(){
  await this.db.$executeRaw`INSERT INTO docgrid.dg_project_context(project_id) SELECT id FROM docgrid.workspace_projects ON CONFLICT DO NOTHING`;
  const token=randomUUID();const job=await this.db.$transaction(async tx=>{
   // One background model call across replicas. Leases survive process restarts.
   await tx.$executeRaw`SELECT pg_advisory_xact_lock(29180001)`;
   const busy=await tx.$queryRaw<any[]>`SELECT project_id FROM docgrid.dg_project_context WHERE lease_until>now() LIMIT 1`;if(busy.length)return null;
   const [j]=await tx.$queryRaw<any[]>`SELECT c.*,COALESCE(s.builtin_enabled,true) AS enabled FROM docgrid.dg_project_context c LEFT JOIN docgrid.dg_ai_settings s ON s.project_id=c.project_id WHERE (c.state IN ('queued','running','blocked','failed') OR c.checked_revision<>c.revision) AND c.retry_at<=now() ORDER BY c.retry_at,c.project_id LIMIT 1 FOR UPDATE OF c SKIP LOCKED`;
   if(!j)return null;
   await tx.$executeRaw`UPDATE docgrid.dg_project_context SET state='running',lease_token=${token}::uuid,lease_until=now()+interval '2 minutes' WHERE project_id=${j.project_id}::uuid`;return j;
  });if(!job)return;
  const project=job.project_id;let reservation:Awaited<ReturnType<AiTimeBudgetService['reserve']>>|undefined;
  try{
   if(!job.enabled){await this.fail(project,token,'blocked','disabled');return;}
   const base=process.env.DOCGRID_ORCHESTRA_URL||'',key=process.env.DOCGRID_SERVICE_TOKEN||'';
   if(!base||key.length<32){await this.fail(project,token,'blocked','unavailable');return;}
   const sources=await this.db.$queryRaw<any[]>`SELECT source_id,title,path,status,kind,fingerprint,length(content)::int AS length FROM docgrid.dg_context_sources WHERE project_id=${project}::uuid ORDER BY source_id LIMIT 5001`;
   if(sources.length>5000){await this.fail(project,token,'blocked','source_limit');return;}
   const notes=await this.db.$queryRaw<any[]>`SELECT n.source_id,n.chunk,n.note FROM docgrid.dg_context_notes n JOIN docgrid.dg_context_sources v ON v.project_id=n.project_id AND v.source_id=n.source_id AND v.fingerprint=n.fingerprint WHERE n.project_id=${project}::uuid ORDER BY n.source_id,n.chunk`;
   let missing:{source:any;chunk:number}|undefined,total=0;
   const known=new Set(notes.map(n=>`${n.source_id}:${n.chunk}`));
   for(const s of sources){const count=Math.ceil(s.length/CHUNK);total+=count;for(let n=0;n<count;n++)if(!known.has(`${s.source_id}:${n}`)&&!missing)missing={source:s,chunk:n};}
   if(missing){
    const {source:s,chunk}=missing;
    const [part]=await this.db.$queryRaw<any[]>`SELECT substring(content FROM ${chunk*CHUNK+1}::int FOR ${CHUNK}::int) AS text FROM docgrid.dg_context_sources WHERE project_id=${project}::uuid AND source_id=${s.source_id} AND fingerprint=${s.fingerprint}`;
    if(!part)return;
    reservation=await this.budget.reserve(project);
    const response=await fetch(base.replace(/\/$/,'')+'/internal/docgrid/context',{method:'POST',redirect:'error',signal:AbortSignal.timeout(85000),headers:{'Content-Type':'application/json','x-docgrid-service-token':key},body:JSON.stringify({text:part.text,title:s.title,kind:s.kind})});
    if(!response.ok) {await response.body?.cancel();throw new Error('provider');}
    const raw=await response.text();if(raw.length>50000)throw new Error('response limit');const note=validateContextResult(JSON.parse(raw).result,part.text);
    // Do not commit a result after disabling AI or changing the source.
    await this.db.$executeRaw`INSERT INTO docgrid.dg_context_notes(project_id,source_id,fingerprint,chunk,note) SELECT ${project}::uuid,${s.source_id},${s.fingerprint},${chunk},${JSON.stringify(note)}::jsonb WHERE EXISTS(SELECT 1 FROM docgrid.dg_context_sources WHERE project_id=${project}::uuid AND source_id=${s.source_id} AND fingerprint=${s.fingerprint}) AND NOT EXISTS(SELECT 1 FROM docgrid.dg_ai_settings WHERE project_id=${project}::uuid AND builtin_enabled=false) ON CONFLICT DO NOTHING`;
    notes.push({source_id:s.source_id,chunk,note});
   }
   const processed=notes.length,unread=sources.filter(s=>s.status!=='READY'||!s.length).length;
   const coverage={sources:sources.length,chunks:total,processed,unread};
   const complete=processed===total&&unread===0,state=processed<total?'queued':complete?'ready':'partial';
   // Saved summary is bounded and explicitly records omitted notes; original per-chunk notes remain durable.
   let summary='',included=0;for(const n of notes){const s=sources.find(s=>s.source_id===n.source_id);const line=`${s?.kind==='review'?'Предлагаемые изменения: ':s?.kind==='artifact'?'Подготовленный документ: ':''}${s?.title} [${n.source_id}]\n${n.note.points.map((p:any)=>'• '+p.text).join('\n')}${n.note.concerns.length?'\nПроверить: '+n.note.concerns.join('; '):''}\n\n`;if(summary.length+line.length<=60000){summary+=line;included++;}}
   await this.db.$executeRaw`UPDATE docgrid.dg_project_context SET state=${state},reason=${unread?'incomplete_sources':null},summary=${summary},coverage=${JSON.stringify({...coverage,omittedNotes:notes.length-included})}::jsonb,checked_revision=${processed===total?job.revision:0},retry_at=now()+interval '5 seconds',updated_at=now() WHERE project_id=${project}::uuid AND revision=${job.revision} AND lease_token=${token}::uuid`;
   await this.db.$executeRaw`DELETE FROM docgrid.dg_context_notes n WHERE project_id=${project}::uuid AND NOT EXISTS(SELECT 1 FROM docgrid.dg_context_sources v WHERE v.project_id=n.project_id AND v.source_id=n.source_id AND v.fingerprint=n.fingerprint)`;
  }catch(e){const exhausted=e instanceof HttpException&&e.getStatus()===429;await this.fail(project,token,exhausted?'blocked':'failed',exhausted?'hours_exhausted':'provider_error');}
  finally{if(reservation)await this.budget.finish(reservation);await this.db.$executeRaw`UPDATE docgrid.dg_project_context SET lease_token=NULL,lease_until=NULL WHERE project_id=${project}::uuid AND lease_token=${token}::uuid`;}
 }
 private async fail(project:string,token:string,state:string,reason:string){await this.db.$executeRaw`UPDATE docgrid.dg_project_context SET state=${state},reason=${reason},retry_at=now()+interval '5 minutes',updated_at=now() WHERE project_id=${project}::uuid AND lease_token=${token}::uuid`;}
}
