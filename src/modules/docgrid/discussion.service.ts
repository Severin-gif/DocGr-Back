import { BadGatewayException, BadRequestException, ConflictException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AstraService } from './astra/astra.service';
import { assertKeys, digest, integerInput, objectInput, stringInput, uuidInput } from './astra/astra.contracts';
import { ChatSource, DiscussionMode, DiscussionResult, PAYMENT_FIELDS, validateDiscussionResult } from './discussion.protocol';

@Injectable()
export class DiscussionService {
  constructor(private readonly db:PrismaService,private readonly agents:AstraService){}
  private dailyLimit() {
    const n=Number(process.env.DOCGRID_AI_DAILY_REQUEST_LIMIT ?? 30);
    return Number.isInteger(n)&&n>=1&&n<=500?n:30;
  }
  private async providerConfig() {
    const base=process.env.DOCGRID_ORCHESTRA_URL||'',token=process.env.DOCGRID_SERVICE_TOKEN||'';
    if(!base||token.length<32)return {available:false,models:[] as {id:string;label:string}[]};
    try {
      const response=await fetch(base.replace(/\/$/,'')+'/internal/docgrid/config',{headers:{'x-docgrid-service-token':token},redirect:'error',signal:AbortSignal.timeout(5000)});
      if(!response.ok){await response.body?.cancel();throw Error('config');}
      const data=await response.json() as any;
      const models=Array.isArray(data.discussionModels)?data.discussionModels.filter((m:any)=>typeof m.id==='string'&&m.id.length<=100&&typeof m.label==='string'&&m.label.length<=180).slice(0,20):[];
      return {available:data.enabled===true&&models.length>0,models};
    }catch{return {available:false,models:[] as {id:string;label:string}[]};}
  }
  async config(user:string,project:string) {
    const access=await this.agents.builtinAccess(user,project),provider=await this.providerConfig();
    const rows=await this.db.$queryRaw<any[]>`SELECT requests FROM docgrid.dg_ai_daily_usage WHERE user_id=${user} AND day=(now() AT TIME ZONE 'UTC')::date`;
    const limit=this.dailyLimit(),used=rows[0]?.requests||0;
    return {...access,...provider,limit,used,remaining:Math.max(0,limit-used),resetAt:new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),new Date().getUTCDate()+1)).toISOString()};
  }
  async settings(user:string,project:string,raw:unknown) {
    const r=objectInput(raw);assertKeys(r,['enabled']);if(typeof r.enabled!=='boolean')throw new BadRequestException('Укажите состояние встроенной LLM');
    return this.agents.setBuiltinEnabled(user,project,r.enabled);
  }
  private async thread(user:string,project:string,id:string){
    await this.agents.getCatalog(user,project);
    const rows=await this.db.$queryRaw<any[]>`SELECT * FROM docgrid.dg_discussions WHERE id=${id}::uuid AND project_id=${project}::uuid AND owner_id=${user}`;
    if(!rows[0])throw new NotFoundException('Обсуждение не найдено');return rows[0];
  }
  async list(user:string,project:string){
    await this.agents.getCatalog(user,project);
    return this.db.$queryRaw<any[]>`SELECT id,title,grant_id AS "grantId",created_at AS "createdAt" FROM docgrid.dg_discussions WHERE project_id=${project}::uuid AND owner_id=${user} ORDER BY created_at DESC LIMIT 100`;
  }
  async create(user:string,project:string,raw:unknown){
    const r=objectInput(raw);assertKeys(r,['title','grantId']);const title=stringInput(r,'title',180);
    const grantId=r.grantId?uuidInput(r,'grantId'):(await this.agents.createBuiltinGrant(user,project)).id;
    if(r.grantId){const grants=await this.agents.listGrants(user,project),grant=grants.grants.find(g=>g.id===grantId);
    if(!grant||grant.revokedAt||new Date(grant.expiresAt).getTime()<=Date.now())throw new BadRequestException('Выберите действующий доступ LLM');}
    const rows=await this.db.$queryRaw<any[]>`INSERT INTO docgrid.dg_discussions(project_id,owner_id,grant_id,title) VALUES(${project}::uuid,${user},${grantId}::uuid,${title}) RETURNING id,title,grant_id AS "grantId"`;
    return rows[0];
  }
  async turns(user:string,project:string,id:string){
    await this.thread(user,project,id);
    // A terminated process must not leave a conversation permanently blocked.
    await this.db.$executeRaw`UPDATE docgrid.dg_discussion_turns SET status='failed',error='Запрос прерван. Отправьте сообщение повторно.',updated_at=now() WHERE discussion_id=${id}::uuid AND status='running' AND updated_at<now()-interval '10 minutes'`;
    return this.db.$queryRaw<any[]>`SELECT id,instruction,mode,status,result,context,provider,error,proposal_id AS "proposalId",created_at AS "createdAt" FROM docgrid.dg_discussion_turns WHERE discussion_id=${id}::uuid ORDER BY created_at,id LIMIT 200`;
  }
  async send(user:string,project:string,id:string,raw:unknown){
    const r=objectInput(raw);assertKeys(r,['requestKey','instruction','mode','task','sourceIds','folder','offset','query','model']);
    const requestKey=stringInput(r,'requestKey',120),instruction=stringInput(r,'instruction',8000),mode=stringInput(r,'mode',20) as DiscussionMode;
    if(!['advisor','helper','assistant'].includes(mode))throw new BadRequestException('Неизвестный режим');
    const task=stringInput(r,'task',20);if(!['chat','sort','package'].includes(task)||(mode==='advisor'&&task==='package'))throw new BadRequestException('Задача недоступна в этом режиме');
    const model=stringInput(r,'model',100,false)||'default';
    const offset=integerInput(r,'offset',0,5000,0),query=stringInput(r,'query',200,false);
    const folder=r.folder===undefined?null:stringInput(r,'folder',500);
    if(r.sourceIds!==undefined&&(!Array.isArray(r.sourceIds)||r.sourceIds.length>500))throw new BadRequestException('Слишком много выбранных файлов');
    const selected=r.sourceIds===undefined?null:(r.sourceIds as unknown[]).map(sourceId=>uuidInput({sourceId},'sourceId'));
    const thread=await this.thread(user,project,id),bodyDigest=digest(r),turnId=randomUUID();
    const prior=await this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM docgrid.dg_discussions WHERE id=${id}::uuid FOR UPDATE`;
      const existing=await tx.$queryRaw<any[]>`SELECT * FROM docgrid.dg_discussion_turns WHERE discussion_id=${id}::uuid AND request_key=${requestKey}`;
      if(existing[0]){if(existing[0].body_digest!==bodyDigest)throw new ConflictException('Ключ запроса уже использован');return existing[0];}
      const running=await tx.$queryRaw<any[]>`SELECT id FROM docgrid.dg_discussion_turns WHERE discussion_id=${id}::uuid AND status='running'`;
      if(running.length)throw new ConflictException('Дождитесь ответа в этом обсуждении');
      const count=await tx.$queryRaw<{n:number}[]>`SELECT count(*)::int AS n FROM docgrid.dg_discussion_turns WHERE discussion_id=${id}::uuid`;
      if(count[0].n>=200)throw new BadRequestException('Создайте новое обсуждение');
      const config=await this.providerConfig();
      if(!config.available)throw new ServiceUnavailableException('Встроенная LLM временно недоступна. Проверьте подключение в настройках проекта.');
      if(!config.models.some((m:any)=>m.id===model))throw new BadRequestException('Выбранная модель недоступна');
      const limit=this.dailyLimit();
      const budget=await tx.$queryRaw<any[]>`INSERT INTO docgrid.dg_ai_daily_usage(user_id,day,requests) VALUES(${user},(now() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(user_id,day) DO UPDATE SET requests=docgrid.dg_ai_daily_usage.requests+1 WHERE docgrid.dg_ai_daily_usage.requests<${limit} RETURNING requests`;
      if(!budget.length)throw new HttpException('Дневной лимит ИИ исчерпан. Он обновляется в 00:00 UTC.',429);
      await tx.$executeRaw`INSERT INTO docgrid.dg_discussion_turns(id,discussion_id,request_key,body_digest,instruction,mode,status) VALUES(${turnId}::uuid,${id}::uuid,${requestKey},${bodyDigest},${instruction},${mode},'running')`;
      return null;
    },{timeout:15000});
    if(prior)return {id:prior.id,status:prior.status};
    const call=async(tool:string,input:Record<string,unknown>)=>(await this.agents.executeForUser(user,thread.grant_id,tool,{projectId:project,runId:turnId,traceId:turnId,requestKey:randomUUID(),input})).output as any;
    try{
      let snapshot=await call('docgrid_get_snapshot',{capture:true,limit:200});
      const snapshotId=snapshot.snapshotId,treeRevision=snapshot.treeRevision,manifest:any[]=[...snapshot.manifest];
      while(snapshot.continuation){snapshot=await call('docgrid_get_snapshot',{snapshotId,cursor:snapshot.continuation,limit:200});manifest.push(...snapshot.manifest);}
      if(selected?.some(sourceId=>!manifest.some(s=>s.sourceId===sourceId)))throw new BadRequestException('Выбранный файл недоступен в рамках этого доступа');
      let candidates=manifest.filter(s=>(selected===null||selected.includes(s.sourceId))&&(!folder||folder==='/'||s.path===folder||s.path.startsWith(folder+'/')));
      // Explicit literal search: do not claim semantic retrieval or complete project reading.
      if(query){let hit=await call('docgrid_search',{snapshotId,query,limit:50});const ids=new Set<string>(hit.matches.map((m:any)=>m.sourceRef.sourceId));while(hit.continuation){hit=await call('docgrid_search',{snapshotId,query,limit:50,cursor:hit.continuation});hit.matches.forEach((m:any)=>ids.add(m.sourceRef.sourceId));}candidates=candidates.filter(s=>ids.has(s.sourceId));}
      const batch=candidates.slice(offset,offset+20),sources:ChatSource[]=[],refs:any[]=[],coverage:any[]=[];
      for(const s of batch){const read=await call('docgrid_read_source',{sourceRef:s.sourceRef,maxChars:5000});sources.push({id:s.sourceId,title:s.title,path:s.path,text:read.text,status:read.truncated?'PARTIAL':read.status});refs.push(s.sourceRef);coverage.push({sourceId:s.sourceId,title:s.title,path:s.path,status:read.status,truncated:read.truncated,characters:read.text.length,sourceRef:s.sourceRef});}
      const context={snapshotId,treeRevision,sourceRefs:refs,sources:coverage,total:candidates.length,offset,nextOffset:offset+batch.length<candidates.length?offset+batch.length:null,query:query||null};
      await this.db.$executeRaw`UPDATE docgrid.dg_discussion_turns SET context=${JSON.stringify(context)}::jsonb WHERE id=${turnId}::uuid`;
      const history=await this.db.$queryRaw<any[]>`SELECT instruction,result FROM docgrid.dg_discussion_turns WHERE discussion_id=${id}::uuid AND status='completed' ORDER BY created_at DESC LIMIT 4`;
      const token=process.env.DOCGRID_SERVICE_TOKEN||'',base=process.env.DOCGRID_ORCHESTRA_URL||'';
      if(token.length<32||!base)throw new ServiceUnavailableException('Настройте DOCGRID_ORCHESTRA_URL и DOCGRID_SERVICE_TOKEN в Doc-Back');
      const url=new URL(base);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new ServiceUnavailableException('Некорректный адрес AI-Orchestra');
      const response=await fetch(base.replace(/\/$/,'')+'/internal/docgrid/discussion',{method:'POST',redirect:'error',signal:AbortSignal.timeout(85000),headers:{'Content-Type':'application/json','x-docgrid-service-token':token},body:JSON.stringify({model,mode,task,instruction,sources,history:history.reverse().flatMap(h=>[{role:'user',text:h.instruction},{role:'assistant',text:h.result.answer}])})});
      if(!response.ok||!response.body){await response.body?.cancel();throw new BadGatewayException(`ИИ недоступен (${response.status}). Проверьте настройки AI-Orchestra.`);}
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1000000){await reader.cancel();throw new Error('Response limit');}chunks.push(value);}}finally{reader.releaseLock();}
      let payload:any,result:DiscussionResult;
      try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));result=validateDiscussionResult(payload.result,sources,mode);}catch{throw new BadGatewayException('Модель вернула неподтверждённые данные или неверный формат. Предложение не создано.');}
      // Fresh authorization after model latency; revoked grants cannot commit a new result.
      await call('docgrid_get_capabilities',{});
      const provider={model:typeof payload.model==='string'?payload.model.slice(0,200):null,requestId:payload.requestId,usage:payload.usage};
      await this.db.$executeRaw`UPDATE docgrid.dg_discussion_turns SET status='completed',result=${JSON.stringify(result)}::jsonb,provider=${JSON.stringify(provider)}::jsonb,updated_at=now() WHERE id=${turnId}::uuid AND status='running'`;
      return {id:turnId,status:'completed'};
    }catch(error){const message=error instanceof ServiceUnavailableException||error instanceof BadGatewayException||error instanceof BadRequestException?error.message:'Не удалось обработать запрос. Проверьте права LLM и доступность модели.';
      await this.db.$executeRaw`UPDATE docgrid.dg_discussion_turns SET status='failed',error=${message},updated_at=now() WHERE id=${turnId}::uuid`;throw error;
    }
  }
  async propose(user:string,project:string,id:string,turnId:string){
    const thread=await this.thread(user,project,id);
    const rows=await this.db.$queryRaw<any[]>`SELECT * FROM docgrid.dg_discussion_turns WHERE id=${turnId}::uuid AND discussion_id=${id}::uuid`;
    const turn=rows[0];if(!turn||turn.status!=='completed'||turn.mode==='advisor')throw new BadRequestException('Нет доступного предложения');
    if(turn.proposal_id)return this.agents.getOperation(user,project,turn.proposal_id);
    const result=turn.result as DiscussionResult,context=turn.context,pack=result.package;
    let tool:string,input:Record<string,unknown>;
    if(pack){
      const missing=[...pack.missingData,'Проверить актуальность права, госпошлины и банковских реквизитов перед подачей и оплатой.'];
      const docs=[...pack.documents];
      if(pack.payment){const map=new Map(pack.payment.map(f=>[f.field,f]));docs.push({title:'Платёжное поручение — черновик реквизитов',text:'НЕ ДЛЯ ОПЛАТЫ. Реквизиты перенесены из материалов и не проверены на актуальность.\n'+PAYMENT_FIELDS.map(field=>{const f=map.get(field);return `${field}: ${f?.value||'[ТРЕБУЕТСЯ ЗАПОЛНИТЬ]'}${f?.value?' (источник: '+f.evidence.map(e=>e.sourceId).join(', ')+')':''}`;}).join('\n')});}
      const contents=docs.map(d=>({title:d.title,subtitle:'Черновик — требуется проверка',sections:[{id:'body',paragraphs:[d.text],paragraphIds:['body-text']}],warnings:missing}));
      tool='docgrid_propose_package';input={baseTreeRevision:context.treeRevision,folder:pack.folder,documents:contents,sourceSnapshotId:context.snapshotId,sourceRefs:context.sourceRefs,attachmentIds:pack.sourceIds,missingData:missing};
    }else{
      const items=result.classifications.filter(c=>c.confidence==='high'&&c.evidence.length&&context.sources.some((s:any)=>s.sourceId===c.sourceId&&s.path!==c.destination));
      if(!items.length)throw new BadRequestException('Нет переносов с высокой уверенностью и подтверждёнными источниками');
      const folders=await this.db.$queryRaw<{path:string}[]>`SELECT path FROM docgrid.docgrid_folders WHERE project_id=${project}::uuid`;
      const paths=new Set(folders.map(f=>f.path)),changes:Record<string,unknown>[]=[];
      for(const item of items){const parts=item.destination.split('/').filter(Boolean);for(let i=1;i<=parts.length;i++){const path='/'+parts.slice(0,i).join('/');if(!paths.has(path)){paths.add(path);changes.push({action:'create_folder',path});}}changes.push({action:'move_source',sourceId:item.sourceId,path:item.destination});}
      tool='docgrid_propose_structure';input={baseTreeRevision:context.treeRevision,changes};
    }
    const operation=await this.agents.executeForUser(user,thread.grant_id,tool,{projectId:project,runId:turnId,traceId:turnId,requestKey:'discussion-proposal:'+turnId,input});
    await this.db.$executeRaw`UPDATE docgrid.dg_discussion_turns SET proposal_id=${operation.id}::uuid WHERE id=${turnId}::uuid`;
    return operation;
  }
}

