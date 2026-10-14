import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AstraService } from './astra/astra.service';
import { assertKeys, digest, objectInput, stringInput } from './astra/astra.contracts';
import { DiscussionService } from './discussion.service';
import { expectsProposal, parseWorkflowPlan, planningInstruction, workflowEnvironment, WorkflowStep } from './discussion-workflow.protocol';

const terminal = (s:string) => ['completed','cancelled'].includes(s);
const planBinding = (w:any) => 'discussion-workflow:' + digest({goal:w.goal,model:w.model,environment:w.environment,
  steps:w.steps.map((s:WorkflowStep)=>({id:s.id,title:s.title,instruction:s.instruction,task:s.task}))});
@Injectable()
export class DiscussionWorkflowService {
  constructor(private readonly db:PrismaService,private readonly agents:AstraService,private readonly discussions:DiscussionService) {}
  private async access(user:string,project:string,id:string) {
    await this.agents.getCatalog(user,project);
    const [thread]=await this.db.$queryRaw<any[]>`SELECT * FROM docgrid_live.dg_discussions WHERE id=${id}::uuid AND project_id=${project}::uuid AND owner_id=${user}`;
    if(!thread)throw new NotFoundException('Обсуждение не найдено');
    return thread;
  }
  private event(w:any,type:string,extra:Record<string,unknown>={}) {
    w.events=[...w.events,{type,at:new Date().toISOString(),...extra}];
  }
  private async save(tx:any,w:any) {
    await tx.$executeRaw`UPDATE docgrid_live.dg_discussion_workflows SET plan_operation_id=${w.plan_operation_id||null}::uuid,status=${w.status},steps=${JSON.stringify(w.steps)}::jsonb,events=${JSON.stringify(w.events)}::jsonb,error=${w.error||null},updated_at=now() WHERE id=${w.id}::uuid`;
  }
  private async row(tx:any,id:string,workflowId:string) {
    const [w]=await tx.$queryRaw`SELECT * FROM docgrid_live.dg_discussion_workflows WHERE id=${workflowId}::uuid AND discussion_id=${id}::uuid FOR UPDATE`;
    if(!w)throw new NotFoundException('План не найден');return w;
  }
  // Only reconcile after the worker has finished or its ten-minute lease has expired.
  // This prevents observing a completed turn between result persistence and proposal creation.
  private async reconcile(tx:any,w:any,force=false) {
    if(terminal(w.status))return w;
    const old=JSON.stringify(w);
    const stale=Date.now()-new Date(w.updated_at).getTime()>600000;
    if(w.status==='cancelling'&&!stale)return w;
    if(w.status==='planning') {
      if(stale){w.status='failed';w.error='Формирование плана прервано. Отмените попытку и сформируйте новый план.';this.event(w,'interrupted');}
    } else {
      const [op]=w.plan_operation_id?await tx.$queryRaw`SELECT status,input FROM docgrid_live.dg_astra_operations WHERE id=${w.plan_operation_id}::uuid`:[];
      if(op?.status==='cancelled') {w.status='cancelled';this.event(w,'cancelled');}
      else if(w.status==='awaiting_approval'&&op?.status==='completed') {
        if(op.input.requestedResult!==planBinding(w))throw new ConflictException('План изменён после согласования');
        w.status='ready';this.event(w,'approved');
      }
      if(w.status==='cancelling'&&stale){w.status='failed';w.error='Отмена прервана. Повторите отмену плана.';}
      const step=w.steps.find((s:WorkflowStep)=>['running','needs_user_action'].includes(s.status));
      if(step&&w.status!=='cancelled'&&(force||stale||step.status==='needs_user_action')) {
        const previousStatus=step.status;
        const [turn]=await tx.$queryRaw`SELECT * FROM docgrid_live.dg_discussion_turns WHERE discussion_id=${w.discussion_id}::uuid AND request_key=${step.requestKey}`;
        if(turn?.status==='completed') {
          step.turnId=turn.id;step.result=turn.result.answer;step.proposalId=turn.proposal_id;
          step.nextOffset=step.task==='sort'&&step.offset+20<w.environment.sourceIds.length?step.offset+20:null;
          if(turn.proposal_id) {
            const [proposal]=await tx.$queryRaw`SELECT status FROM docgrid_live.dg_astra_operations WHERE id=${turn.proposal_id}::uuid`;
            step.status=proposal?.status==='completed'?'completed':proposal?.status==='needs_user_action'?'needs_user_action':'cancelled';
          } else if(expectsProposal(turn)) {step.status='failed';step.error='Результат готов, но предложение изменений не создано. Повторите этап.';}
          else {step.status='completed';}
        } else if(turn?.status==='failed'||stale||force) {
          step.status='failed';step.error=turn?.error||'Выполнение прервано. Можно повторить этап.';
        }
        if(step.status==='completed'&&step.task==='sort'&&step.nextOffset!==null&&step.nextOffset!==undefined) {
          // Continue the same approved sorting step with its original, frozen scope.
          step.offset=step.nextOffset;step.status='pending';
          this.event(w,'batch_completed',{stepId:step.id,turnId:step.turnId,nextOffset:step.offset});
        }
        w.status=step.status==='needs_user_action'?'needs_user_action':step.status==='failed'?'failed':step.status==='cancelled'?'cancelled':w.steps.every((s:WorkflowStep)=>s.status==='completed')?'completed':'ready';
        if(step.status!=='running'&&step.status!==previousStatus)this.event(w,'step_'+step.status,{stepId:step.id,turnId:step.turnId,proposalId:step.proposalId});
      }
    }
    if(JSON.stringify(w)!==old)await this.save(tx,w);
    return w;
  }
  async list(user:string,project:string,id:string) {
    await this.access(user,project,id);
    return this.db.$transaction(async tx=>{
      await tx.$executeRaw`UPDATE docgrid_live.dg_discussion_turns SET status='failed',error='Запрос прерван. Повторите этап.',updated_at=now() WHERE discussion_id=${id}::uuid AND status='running' AND updated_at<now()-interval '10 minutes'`;
      const rows=await tx.$queryRaw<any[]>`SELECT * FROM docgrid_live.dg_discussion_workflows WHERE discussion_id=${id}::uuid ORDER BY created_at DESC,id DESC LIMIT 30 FOR UPDATE`;
      for(const w of rows)await this.reconcile(tx,w);
      return rows;
    });
  }
  async capabilities(user:string,project:string,id:string) {
    const t=await this.access(user,project,id);
    const op=await this.agents.executeForUser(user,t.grant_id,'docgrid_get_capabilities',{projectId:project,runId:id,traceId:id,input:{}});
    return op.output;
  }
  async create(user:string,project:string,id:string,raw:unknown) {
    const r=objectInput(raw);assertKeys(r,['requestKey','goal','model','folder','sourceIds']);
    const requestKey=stringInput(r,'requestKey',120),goal=stringInput(r,'goal',4000),model=stringInput(r,'model',100,false)||'default';
    const environment=workflowEnvironment(r),thread=await this.access(user,project,id),bodyDigest=digest({goal,model,environment});
    const access=await this.agents.builtinAccess(user,project);
    if(!access.canPrepare||!access.enabled)throw new BadRequestException('Планирование недоступно для текущего доступа');
    const created=await this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM docgrid_live.dg_discussions WHERE id=${id}::uuid FOR UPDATE`;
      const [prior]=await tx.$queryRaw<any[]>`SELECT * FROM docgrid_live.dg_discussion_workflows WHERE discussion_id=${id}::uuid AND request_key=${requestKey}`;
      if(prior){if(prior.body_digest!==bodyDigest)throw new ConflictException('Ключ запроса уже использован');return {w:prior,fresh:false};}
      const active=await tx.$queryRaw<any[]>`SELECT id FROM docgrid_live.dg_discussion_workflows WHERE discussion_id=${id}::uuid AND status NOT IN ('completed','cancelled')`;
      if(active.length)throw new ConflictException('Завершите или отмените текущий план');
      const turns=await tx.$queryRaw<any[]>`SELECT id FROM docgrid_live.dg_discussion_turns WHERE discussion_id=${id}::uuid AND status='running'`;
      if(turns.length)throw new ConflictException('Дождитесь ответа');
      const [w]=await tx.$queryRaw<any[]>`INSERT INTO docgrid_live.dg_discussion_workflows(discussion_id,request_key,body_digest,goal,model,environment,status) VALUES(${id}::uuid,${requestKey},${bodyDigest},${goal},${model},${JSON.stringify(environment)}::jsonb,'planning') RETURNING *`;
      return {w,fresh:true};
    });
    if(!created.fresh)return created.w;
    const w=created.w;
    try {
      const capabilities=await this.capabilities(user,project,id) as any;
      if(!capabilities.tools.some((t:any)=>t.name==='docgrid_plan_document'))throw new BadRequestException('Доступ исполнителя не разрешает планирование');
      const turn=await this.discussions.send(user,project,id,{requestKey:w.id+':plan',instruction:planningInstruction(goal),mode:'advisor',task:'chat',model,...environment},w.id);
      const [saved]=await this.db.$queryRaw<any[]>`SELECT * FROM docgrid_live.dg_discussion_turns WHERE id=${turn.id}::uuid`;
      if(saved?.status!=='completed')throw new ConflictException('План ещё формируется');
      const ids=saved.context.candidateIds;
      if(!Array.isArray(ids)||ids.length>500)throw new BadRequestException('Для плана выберите папку или не более 500 документов');
      // Freeze the source inventory, not only the folder label. Later moves cannot skip batches.
      w.environment={...environment,sourceIds:ids};
      const plan=parseWorkflowPlan(saved.result.answer);w.title=plan.title;w.steps=plan.steps;
      const toolForTask={sort:'docgrid_propose_structure',package:'docgrid_propose_package',instruction:'docgrid_propose_package'};
      if(w.steps.some((s:WorkflowStep)=>s.task!=='chat'&&!capabilities.tools.some((t:any)=>t.name===toolForTask[s.task as keyof typeof toolForTask])))throw new BadRequestException('План требует инструмент, не разрешённый текущим доступом');
      const operation=await this.agents.executeForUser(user,thread.grant_id,'docgrid_plan_document',{
        projectId:project,runId:w.id,traceId:w.id,requestKey:w.id+':approval',input:{purpose:goal,requestedResult:planBinding(w),
          plan:{title:plan.title,documentType:'План обсуждения',goal:goal.slice(0,2000),sections:plan.steps.map(s=>`${s.title} [${s.task}]: ${s.instruction}`),
            inputsUsed:[environment.folder,`Модель: ${model}`,...Array.from({length:Math.ceil(w.environment.sourceIds.length/12)},(_,i)=>w.environment.sourceIds.slice(i*12,i*12+12).join(', '))],warnings:['Согласование плана не разрешает применение правок документов. Каждое предложение требует отдельного согласования.']},
          sourceSnapshotId:saved.context.snapshotId,sourceRefs:saved.context.sourceRefs}});
      this.event(w,'plan_created',{turnId:turn.id,operationId:operation.id});
      await this.db.$executeRaw`UPDATE docgrid_live.dg_discussion_workflows SET environment=${JSON.stringify(w.environment)}::jsonb,title=${w.title},steps=${JSON.stringify(w.steps)}::jsonb,plan_operation_id=${operation.id}::uuid,status='awaiting_approval',events=${JSON.stringify(w.events)}::jsonb,updated_at=now() WHERE id=${w.id}::uuid AND status='planning'`;
    } catch(e) {
      const error=e instanceof Error?e.message:'План не сформирован';this.event(w,'failed',{error});
      await this.db.$executeRaw`UPDATE docgrid_live.dg_discussion_workflows SET status='failed',error=${error},events=${JSON.stringify(w.events)}::jsonb,updated_at=now() WHERE id=${w.id}::uuid AND status='planning'`;
      throw e;
    }
    return (await this.list(user,project,id)).find(x=>x.id===w.id);
  }
  async run(user:string,project:string,id:string,workflowId:string,raw:unknown) {
    const r=objectInput(raw);assertKeys(r,['requestKey']);const requestKey=stringInput(r,'requestKey',120);
    await this.access(user,project,id);
    const claim=await this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM docgrid_live.dg_discussions WHERE id=${id}::uuid FOR UPDATE`;
      const w=await this.reconcile(tx,await this.row(tx,id,workflowId));
      if(w.events.some((e:any)=>e.requestKey===requestKey))return null;
      if(!['ready','failed'].includes(w.status)||!w.steps.length)throw new ConflictException('Сначала согласуйте план и завершите текущий этап');
      const [op]=await tx.$queryRaw<any[]>`SELECT status,input FROM docgrid_live.dg_astra_operations WHERE id=${w.plan_operation_id}::uuid`;
      if(op?.status!=='completed'||op.input.requestedResult!==planBinding(w))throw new ConflictException('Нет согласования текущего плана');
      const [binding]=await tx.$queryRaw<any[]>`SELECT state FROM docgrid_live.dg_astra_document_tasks WHERE operation_id=${w.plan_operation_id}::uuid`;
      if(binding?.state!=='APPROVED')throw new ConflictException('План отменён или заменён');
      const running=await tx.$queryRaw<any[]>`SELECT id FROM docgrid_live.dg_discussion_turns WHERE discussion_id=${id}::uuid AND status='running'`;
      if(running.length)throw new ConflictException('Дождитесь ответа');
      const step=w.steps.find((s:WorkflowStep)=>s.status!=='completed') as WorkflowStep;
      if(!step||!['pending','failed'].includes(step.status))throw new ConflictException('Этап недоступен');
      if(step.attempt>=40)throw new BadRequestException('Лимит попыток этапа исчерпан. Начните новый план.');
      step.attempt++;step.status='running';step.error=undefined;step.requestKey=`${w.id}:${step.id}:${step.attempt}`;
      w.status='running';w.error=null;this.event(w,'step_started',{stepId:step.id,requestKey});await this.save(tx,w);
      return {w,step};
    });
    if(claim) {
      const {w,step}=claim;
      try {
        await this.capabilities(user,project,id); // Fresh ACL, enabled flag, grant expiry and scope.
        await this.discussions.send(user,project,id,{requestKey:step.requestKey,instruction:`Задача: ${w.goal}\nЭтап ${step.id}: ${step.title}\n${step.instruction}`,task:step.task,mode:step.task==='chat'?'advisor':'helper',model:w.model,folder:'/',sourceIds:step.task==='sort'?w.environment.sourceIds.slice(step.offset,step.offset+20):w.environment.sourceIds},w.id);
      } catch(e) {
        await this.db.$transaction(async tx=>{
          const current=await this.row(tx,id,w.id),s=current.steps.find((s:WorkflowStep)=>s.id===step.id);
          s.status='failed';s.error=e instanceof Error?e.message:'Ошибка выполнения';current.status='failed';this.event(current,'step_failed',{stepId:s.id,error:s.error});await this.save(tx,current);
        });
        throw e;
      }
      await this.db.$transaction(async tx=>this.reconcile(tx,await this.row(tx,id,w.id),true));
    }
    return this.list(user,project,id);
  }
  async cancel(user:string,project:string,id:string,workflowId:string,raw:unknown) {
    const r=objectInput(raw);assertKeys(r,['requestKey']);const requestKey=stringInput(r,'requestKey',120);
    await this.access(user,project,id);
    const w=await this.db.$transaction(async tx=>{
      const current=await this.reconcile(tx,await this.row(tx,id,workflowId));
      if(terminal(current.status))return current;
      if(['planning','running','cancelling'].includes(current.status))throw new ConflictException('Дождитесь окончания текущего запроса');
      if(!current.plan_operation_id){const [op]=await tx.$queryRaw<any[]>`SELECT id FROM docgrid_live.dg_astra_operations WHERE run_id=${current.id} AND tool='docgrid_plan_document' AND project_id=${project}::uuid`;current.plan_operation_id=op?.id||null;}
      current.status='cancelling';this.event(current,'cancellation_requested');await this.save(tx,current);return current;
    });
    if(terminal(w.status))return w;
    try {
      // A durable cancellation claim blocks concurrent run requests before any decision is made.
      for(const s of w.steps as WorkflowStep[])if(s.proposalId&&s.status==='needs_user_action') {
        const op=await this.agents.getOperation(user,project,s.proposalId);
        if(op.status==='needs_user_action')await this.agents.decideOperation(user,project,s.proposalId,'cancel',{requestKey:requestKey+':change'});
      }
      if(w.plan_operation_id) {
        const op=await this.agents.getOperation(user,project,w.plan_operation_id);
        if(op.status!=='cancelled')await this.agents.decideOperation(user,project,w.plan_operation_id,'cancel',{requestKey:requestKey+':plan'});
      }
      await this.db.$transaction(async tx=>{
        const current=await this.row(tx,id,w.id);current.status='cancelled';this.event(current,'cancelled');await this.save(tx,current);
      });
    } catch(e) {
      await this.db.$transaction(async tx=>{const current=await this.row(tx,id,w.id);current.status='failed';current.error='Отмена не завершена. Повторите отмену.';await this.save(tx,current);});
      throw e;
    }
    return (await this.list(user,project,id)).find(x=>x.id===workflowId);
  }
}

