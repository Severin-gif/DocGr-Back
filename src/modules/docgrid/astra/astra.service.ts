import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { ASTRA_CATALOG_VERSION, ASTRA_SPEC_VERSION, AstraContext, AstraDb, AstraDomainResult, AstraOperation, assertKeys, canonical, digest, integerInput, objectInput, persistedOperationInput, stringInput, unsupported, uuidInput } from './astra.contracts';
import { ASTRA_SOURCE_SCHEMAS, ASTRA_SOURCE_TOOLS, AstraSourcesService } from './astra-sources.service';
import { ASTRA_WORKFLOW_SCHEMAS, ASTRA_WORKFLOW_TOOLS, AstraWorkflowService } from './astra-workflow.service';
import { ASTRA_UPLOAD_LIMITS, ASTRA_UPLOAD_SCHEMAS, ASTRA_UPLOAD_TOOLS, AstraUploadService } from './astra-upload.service';

type Grant = {
  id: string; projectId: string; ownerId: string; agentRef: string; actions: string[]; builtin: boolean;
  allowedSourceIds: string[] | null; expiresAt: Date; revokedAt: Date | null;
  maxOperations: number; usedOperations: number; createdAt: Date; bodyDigest: string;
};
const CORE_TOOLS = ['docgrid_get_capabilities', 'docgrid_get_operation', 'docgrid_wait_for_operation', 'docgrid_get_operation_result', 'docgrid_cancel_operation'];
const MUTATING = /_(plan|submit|propose|restore|export|cancel|upload)_/;

@Injectable()
export class AstraService {
  constructor(private readonly prisma: PrismaService, private readonly sources: AstraSourcesService, private readonly workflow: AstraWorkflowService, private readonly uploads: AstraUploadService) {}

  private tools(): string[] { return [...new Set([...CORE_TOOLS, ...ASTRA_SOURCE_TOOLS, ...ASTRA_WORKFLOW_TOOLS, ...ASTRA_UPLOAD_TOOLS])]; }
  private isMutation(tool: string, input: Record<string, unknown> = {}): boolean { return MUTATING.test(tool) || (tool === 'docgrid_get_snapshot' && input.capture === true); }
  private catalog() {
    const schemas={...ASTRA_SOURCE_SCHEMAS,...ASTRA_WORKFLOW_SCHEMAS,...ASTRA_UPLOAD_SCHEMAS};
    return {
      catalogVersion: ASTRA_CATALOG_VERSION, specVersion: ASTRA_SPEC_VERSION, executionTrack: 'DOCGRID_AGENT',
      transport:{method:'POST',path:'/api/docgrid/agents/tools/{toolName}',authentication:'Authorization: Bearer <DocGrid grant>',
        envelope:{type:'object',additionalProperties:false,required:['projectId','runId','traceId','input'],properties:{projectId:{type:'string',format:'uuid'},runId:{type:'string',minLength:1,maxLength:120},traceId:{type:'string',minLength:1,maxLength:120},requestKey:{type:'string',minLength:1,maxLength:120,description:'Required for mutations; repeated key must bind the same tool, run and input'},input:{type:'object'}}}},
      tools: this.tools().map(name => ({ name, mutating: this.isMutation(name),
        ...(name==='docgrid_get_snapshot'?{mutationCondition:'input.capture === true'}:{}),
        description: schemas[name]?.description || (name==='docgrid_get_capabilities'?'Read the scoped tool catalog and remaining budget.':name==='docgrid_wait_for_operation'?'Read current durable state immediately; callers poll, this endpoint does not block.':name.replace(/^docgrid_/, '').replace(/_/g, ' ')),
        inputSchema:schemas[name]?.inputSchema || {type:'object',additionalProperties:false,properties:name==='docgrid_get_capabilities'?{}:{operationId:{type:'string',format:'uuid'}},required:name==='docgrid_get_capabilities'?[]:['operationId']},
      })),
      limits: { maxOperations: 10000, maxGrantDays: 30, maxInputBytes: 1048576, paidCalls: 0, upload: ASTRA_UPLOAD_LIMITS }, readiness: 'deterministic_adapter',
      limitations: ['No model execution or paid calls', 'Unsupported capabilities return UNSUPPORTED', 'Cancellation supports pending proposals and approved plans before document submission; execution is synchronous and atomic'],
    };
  }
  private async requireProject(tx: AstraDb, ownerId: string, projectId: string, action: 'read' | 'write' | 'owner' = 'read'): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT p.id FROM docgrid.workspace_projects p WHERE p.id=${projectId}::uuid AND (p.owner_id=${ownerId} OR EXISTS (SELECT 1 FROM docgrid.docgrid_members m WHERE m.project_id=p.id AND m.user_id=${ownerId} AND (${action}='read' OR (${action}='write' AND m.role IN ('EDITOR','REVIEWER'))))) FOR UPDATE OF p`;
    if (!rows.length) throw new NotFoundException('Project not found or access denied');
  }
  private async grantById(tx: AstraDb, id: string): Promise<Grant> {
    const rows = await tx.$queryRaw<Grant[]>`SELECT id,builtin,project_id AS "projectId",owner_id AS "ownerId",agent_ref AS "agentRef",actions,allowed_source_ids AS "allowedSourceIds",expires_at AS "expiresAt",revoked_at AS "revokedAt",max_operations AS "maxOperations",used_operations AS "usedOperations",created_at AS "createdAt",body_digest AS "bodyDigest" FROM docgrid.dg_astra_grants WHERE id=${id}::uuid FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException('Grant not found');
    return rows[0];
  }
  private publicGrant(grant: Grant) { const { bodyDigest: _digest, ownerId: _owner, ...result } = grant; return result; }
  private assertGrant(grant: Grant, projectId: string, tool?: string) {
    if (grant.projectId !== projectId || grant.revokedAt || new Date(grant.expiresAt).getTime() <= Date.now()) throw new ForbiddenException('Grant expired, revoked or outside project scope');
    if (tool && tool !== 'docgrid_get_capabilities' && !grant.actions.includes(tool)) throw new ForbiddenException('Action is outside grant scope');
  }
  private async authorizedGrant(tx: AstraDb, token: string, projectId: string, tool: string, mutation: boolean): Promise<Grant> {
    const hash = createHash('sha256').update(token).digest('hex');
    const rows = await tx.$queryRaw<{ id: string; ownerId: string }[]>`SELECT id,owner_id AS "ownerId" FROM docgrid.dg_astra_grants WHERE token_hash=${hash} AND project_id=${projectId}::uuid`;
    if (!rows[0]) throw new UnauthorizedException('Invalid DocGrid grant');
    await this.requireProject(tx, rows[0].ownerId, projectId, mutation ? 'write' : 'read');
    const grant = await this.grantById(tx, rows[0].id);
    this.assertGrant(grant, projectId, tool);
    return grant;
  }
  private context(grant: Grant, operation: Pick<AstraOperation, 'id' | 'runId' | 'requestKey' | 'traceId'>): AstraContext {
    return { operationId: operation.id, projectId: grant.projectId, ownerId: grant.ownerId, grantId: grant.id, agentRef: grant.agentRef, runId: operation.runId, requestKey: operation.requestKey, traceId: operation.traceId, allowedSourceIds: grant.allowedSourceIds, principalKind: 'agent' };
  }
  private async operation(tx: AstraDb, projectId: string, id: string): Promise<AstraOperation> {
    const rows = await tx.$queryRaw<AstraOperation[]>`SELECT id,project_id AS "projectId",grant_id AS "grantId",tool,run_id AS "runId",request_key AS "requestKey",trace_id AS "traceId",status,input,result,approval,approval_digest AS "approvalDigest",error,passport,created_at AS "createdAt",updated_at AS "updatedAt" FROM docgrid.dg_astra_operations WHERE id=${id}::uuid AND project_id=${projectId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException('Operation not found');
    return rows[0];
  }
  private async event(tx: AstraDb, ctx: AstraContext, eventType: string, metadata: unknown = {}) {
    await tx.$executeRaw`INSERT INTO docgrid.docgrid_events(project_id,actor_id,event_type,entity_type,entity_id,metadata) VALUES (${ctx.projectId}::uuid,${ctx.ownerId},${eventType},'astra_operation',${ctx.operationId}::uuid,${JSON.stringify({ agentRef: ctx.agentRef, grantRef: ctx.grantId, runId: ctx.runId, traceId: ctx.traceId, metadata })}::jsonb)`;
  }
  // Discovery authenticates the live grant but does not spend the operation budget.
  async describeGrant(token: string, projectId: string) {
    return this.prisma.$transaction(async tx => {
      const grant = await this.authorizedGrant(tx, token, projectId, 'docgrid_get_capabilities', false);
      return { ...this.catalog(), tools: this.catalog().tools.filter(tool => tool.name === 'docgrid_get_capabilities' || grant.actions.includes(tool.name)),
        grant: { ...this.publicGrant(grant), remainingOperations: grant.maxOperations - grant.usedOperations } };
    });
  }
  async getCatalog(ownerId: string, projectId: string) { return this.prisma.$transaction(async tx => { await this.requireProject(tx, ownerId, projectId); return this.catalog(); }); }
  async listGrants(ownerId: string, projectId: string) {
    return this.prisma.$transaction(async tx => { await this.requireProject(tx, ownerId, projectId, 'owner'); const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM docgrid.dg_astra_grants WHERE project_id=${projectId}::uuid ORDER BY created_at DESC LIMIT 200`; return { grants: await Promise.all(rows.map(async row => this.publicGrant(await this.grantById(tx, row.id)))) }; });
  }
  async createGrant(ownerId: string, projectId: string, raw: unknown) {
    const input = objectInput(raw); assertKeys(input, ['requestKey','agentRef','actions','expiresAt','maxOperations','allowedSourceIds']);
    const requestKey = stringInput(input,'requestKey',120), agentRef = stringInput(input,'agentRef',120);
    const expiresAt = new Date(stringInput(input,'expiresAt',40));
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 30 * 86400000) throw new BadRequestException('Grant expiry must be within 30 days');
    const maxOperations = integerInput(input,'maxOperations',1,10000);
    if (!Array.isArray(input.actions) || !input.actions.length || input.actions.length > 50 || input.actions.some(action => typeof action !== 'string' || !this.tools().includes(action))) throw new BadRequestException('Invalid grant actions');
    const actions = [...new Set(input.actions as string[])].sort();
    let allowedSourceIds: string[] | null = null;
    if (input.allowedSourceIds !== undefined) {
      if (!Array.isArray(input.allowedSourceIds) || input.allowedSourceIds.length > 500) throw new BadRequestException('Invalid allowedSourceIds');
      allowedSourceIds = [...new Set(input.allowedSourceIds.map(id => uuidInput({ id },'id')))].sort();
    }
    const bodyDigest = digest({ agentRef,actions,expiresAt:expiresAt.toISOString(),maxOperations,allowedSourceIds });
    return this.prisma.$transaction(async tx => {
      await this.requireProject(tx,ownerId,projectId,'owner');
      const existing = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM docgrid.dg_astra_grants WHERE project_id=${projectId}::uuid AND owner_id=${ownerId} AND request_key=${requestKey}`;
      if (existing[0]) { const grant = await this.grantById(tx,existing[0].id); if (grant.bodyDigest !== bodyDigest) throw new ConflictException('requestKey already used with a different body'); return { grant:this.publicGrant(grant),token:null,credentialIssuedPreviously:true }; }
      for (const sourceId of allowedSourceIds || []) {
        const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM docgrid.docgrid_materials WHERE id=${sourceId}::uuid AND project_id=${projectId}::uuid AND deleted_at IS NULL UNION ALL SELECT id FROM docgrid.workspace_documents WHERE id=${sourceId}::uuid AND project_id=${projectId}::uuid AND docgrid_deleted_at IS NULL UNION ALL SELECT document_id AS id FROM docgrid.dg_astra_documents WHERE document_id=${sourceId}::uuid AND project_id=${projectId}::uuid`;
        if (!rows.length) throw new BadRequestException('A scoped source does not belong to this project');
      }
      const id=randomUUID(), token=`dga_${randomBytes(32).toString('base64url')}`, tokenHash=createHash('sha256').update(token).digest('hex');
      await tx.$executeRaw`INSERT INTO docgrid.dg_astra_grants(id,project_id,owner_id,agent_ref,token_hash,actions,allowed_source_ids,expires_at,max_operations,request_key,body_digest) VALUES (${id}::uuid,${projectId}::uuid,${ownerId},${agentRef},${tokenHash},${JSON.stringify(actions)}::jsonb,${allowedSourceIds === null ? null : JSON.stringify(allowedSourceIds)}::jsonb,${expiresAt},${maxOperations},${requestKey},${bodyDigest})`;
      const grant = await this.grantById(tx,id);
      await this.event(tx,this.context(grant,{id,runId:'grant-management',requestKey,traceId:requestKey}),'astra.grant.created',{actions,expiresAt,maxOperations});
      return { grant:this.publicGrant(grant),token,credentialIssuedPreviously:false };
    });
  }
  private async priorDecision(tx: AstraDb, ownerId: string, projectId: string, requestKey: string, bodyDigest: string): Promise<unknown | undefined> {
    const rows=await tx.$queryRaw<{bodyDigest:string;result:unknown}[]>`SELECT body_digest AS "bodyDigest",result FROM docgrid.dg_astra_decisions WHERE project_id=${projectId}::uuid AND actor_id=${ownerId} AND request_key=${requestKey}`;
    if (!rows[0]) return undefined;
    if (rows[0].bodyDigest !== bodyDigest) throw new ConflictException('requestKey already used with a different body');
    return rows[0].result;
  }
  private async saveDecision(tx: AstraDb, ownerId: string, projectId: string, requestKey: string, action: string, target: string, bodyDigest: string, result: unknown) {
    await tx.$executeRaw`INSERT INTO docgrid.dg_astra_decisions(id,project_id,actor_id,request_key,action,target_id,body_digest,result) VALUES (${randomUUID()}::uuid,${projectId}::uuid,${ownerId},${requestKey},${action},${target}::uuid,${bodyDigest},${JSON.stringify(result)}::jsonb)`;
  }
  async revokeGrant(ownerId:string,projectId:string,id:string,raw:unknown) {
    const input=objectInput(raw);assertKeys(input,['requestKey']);const requestKey=stringInput(input,'requestKey',120),bodyDigest=digest({action:'revoke',id});
    return this.prisma.$transaction(async tx=>{
      await this.requireProject(tx,ownerId,projectId,'owner');const grant=await this.grantById(tx,id);if(grant.projectId!==projectId)throw new NotFoundException('Grant not found');
      const prior=await this.priorDecision(tx,ownerId,projectId,requestKey,bodyDigest);if(prior!==undefined)return prior;
      await tx.$executeRaw`UPDATE docgrid.dg_astra_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=${id}::uuid`;
      await tx.$executeRaw`UPDATE docgrid.dg_astra_operations SET status='cancelled',updated_at=now() WHERE grant_id=${id}::uuid AND status IN ('running','needs_user_action')`;
      const result={grant:this.publicGrant(await this.grantById(tx,id))};await this.saveDecision(tx,ownerId,projectId,requestKey,'revoke',id,bodyDigest,result);
      await this.event(tx,this.context(grant,{id,runId:'grant-management',requestKey,traceId:requestKey}),'astra.grant.revoked');return result;
    });
  }
  async listArtifacts(ownerId: string, projectId: string, cursor?: string) {
    const after = cursor ? uuidInput({ cursor }, 'cursor') : null;
    return this.prisma.$transaction(async tx => {
      await this.requireProject(tx, ownerId, projectId);
      const rows = await tx.$queryRaw<Array<{ artifactId: string; version: number; title: string; agentRef: string; createdAt: Date }>>`
        SELECT d.id AS "artifactId",d.current_version AS version,d.title,m.agent_ref AS "agentRef",v.created_at AS "createdAt"
        FROM docgrid.dg_astra_documents a JOIN docgrid.prepared_legal_documents d ON d.id=a.document_id
        JOIN docgrid.document_versions v ON v.document_id=d.id AND v.version=d.current_version
        JOIN docgrid.dg_astra_document_versions m ON m.version_id=v.id
        WHERE a.project_id=${projectId}::uuid AND (${after}::uuid IS NULL OR d.id>${after}::uuid)
        ORDER BY d.id LIMIT 51`;
      return { artifacts: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].artifactId : null };
    });
  }
  async listOperations(ownerId:string,projectId:string) {
    return this.prisma.$transaction(async tx=>{
      await this.requireProject(tx,ownerId,projectId);
      const operations=await tx.$queryRaw<unknown[]>`SELECT id,grant_id AS "grantId",passport->>'actorRef' AS "agentRef",tool,status,run_id AS "runId",trace_id AS "traceId",created_at AS "createdAt",updated_at AS "updatedAt",approval_digest AS "approvalDigest",CASE WHEN error IS NULL THEN NULL ELSE jsonb_build_object('status',error->'status','response',jsonb_strip_nulls(jsonb_build_object('code',left(error#>>'{response,code}',80),'message',left(COALESCE(error#>>'{response,message}',error->>'response','Operation failed'),500)))) END AS error,jsonb_strip_nulls(jsonb_build_object('artifactId',result->'artifactId','version',result->'version','taskId',result->'taskId','planRevision',result->'planRevision','title',result->'title')) AS result FROM docgrid.dg_astra_operations WHERE project_id=${projectId}::uuid ORDER BY created_at DESC LIMIT 100`;
      return {operations};
    });
  }
  async getOperation(ownerId:string,projectId:string,id:string) {return this.prisma.$transaction(async tx=>{await this.requireProject(tx,ownerId,projectId);return this.operation(tx,projectId,id);});}

  private async dispatch(tx:AstraDb,ctx:AstraContext,tool:string,input:Record<string,unknown>,grant:Grant):Promise<AstraDomainResult> {
    if(tool==='docgrid_get_capabilities') {assertKeys(input,[]);return {output:{...this.catalog(),tools:this.catalog().tools.filter(item=>item.name==='docgrid_get_capabilities'||grant.actions.includes(item.name)),grant:{...this.publicGrant(grant),remainingOperations:grant.maxOperations-grant.usedOperations-1}}};}
    if(CORE_TOOLS.includes(tool)) {
      assertKeys(input,['operationId']);const operation=await this.operation(tx,ctx.projectId,uuidInput(input,'operationId'));
      if(operation.grantId!==ctx.grantId)throw new NotFoundException('Operation not found');
      this.assertGrant(grant,ctx.projectId,operation.tool);
      if(tool==='docgrid_cancel_operation') {
        const approvedPlan=operation.tool==='docgrid_plan_document'&&operation.status==='completed';
        if(!['needs_user_action','cancelled'].includes(operation.status)&&!approvedPlan)throw new ConflictException('Operation is already terminal');
        if(operation.status!=='cancelled') {
          if((ASTRA_WORKFLOW_TOOLS as readonly string[]).includes(operation.tool))await this.workflow.cancel(tx,ctx,operation);
          else await this.sources.cancel(tx,ctx,operation);
          await tx.$executeRaw`UPDATE docgrid.dg_astra_operations SET status='cancelled',updated_at=now() WHERE id=${operation.id}::uuid`;
        }
        await this.event(tx,ctx,'astra.operation.cancelled',{targetOperationId:operation.id});
        return {output:await this.operation(tx,ctx.projectId,operation.id)};
      }
      return {output:operation};
    }
    if((ASTRA_WORKFLOW_TOOLS as readonly string[]).includes(tool))return this.workflow.execute(tx,ctx,tool,input);
    if((ASTRA_SOURCE_TOOLS as readonly string[]).includes(tool))return this.sources.execute(tx,ctx,tool,input);
    if((ASTRA_UPLOAD_TOOLS as readonly string[]).includes(tool))return this.uploads.execute(tx,ctx,tool,input);
    return unsupported(tool);
  }
  async execute(token:string,tool:string,raw:unknown) {
    return this.executeAuthorized(tool,raw,(tx,projectId,mutation)=>this.authorizedGrant(tx,token,projectId,tool,mutation));
  }
  async builtinAccess(user: string, project: string, write = false) {
    return this.prisma.$transaction(async tx => {
      await this.requireProject(tx, user, project, write ? 'owner' : 'read');
      const rows = await tx.$queryRaw<any[]>`SELECT p.owner_id=${user} AS "isOwner", (p.owner_id=${user} OR EXISTS(SELECT 1 FROM docgrid.docgrid_members m WHERE m.project_id=p.id AND m.user_id=${user} AND m.role IN ('EDITOR','REVIEWER'))) AS "canPrepare", COALESCE(s.builtin_enabled,true) AS enabled FROM docgrid.workspace_projects p LEFT JOIN docgrid.dg_ai_settings s ON s.project_id=p.id WHERE p.id=${project}::uuid`;
      return rows[0] as {isOwner:boolean;canPrepare:boolean;enabled:boolean};
    });
  }
  async setBuiltinEnabled(user: string, project: string, enabled: boolean) {
    return this.prisma.$transaction(async tx => {
      await this.requireProject(tx,user,project,'owner');
      await tx.$executeRaw`INSERT INTO docgrid.dg_ai_settings(project_id,builtin_enabled) VALUES(${project}::uuid,${enabled}) ON CONFLICT(project_id) DO UPDATE SET builtin_enabled=EXCLUDED.builtin_enabled`;
      await tx.$executeRaw`INSERT INTO docgrid.docgrid_events(project_id,actor_id,event_type,entity_type,entity_id,metadata) VALUES(${project}::uuid,${user},'ai.settings.changed','repository',${project}::uuid,${JSON.stringify({builtinEnabled:enabled})}::jsonb)`;
      return {enabled};
    });
  }
  // Internal only: the credential is never issued. Each call still rechecks the user's live ACL.
  async createBuiltinGrant(user:string,project:string) {
    return this.prisma.$transaction(async tx=>{
      await this.requireProject(tx,user,project);
      const settings=await tx.$queryRaw<any[]>`SELECT builtin_enabled FROM docgrid.dg_ai_settings WHERE project_id=${project}::uuid`;
      if(settings[0]?.builtin_enabled===false)throw new ForbiddenException('Встроенная LLM отключена владельцем проекта');
      const actions=['docgrid_get_snapshot','docgrid_read_source','docgrid_search','docgrid_propose_structure','docgrid_propose_package'];
      const id=randomUUID(), requestKey='builtin:'+id, expiresAt=new Date(Date.now()+30*86400000);
      const tokenHash=createHash('sha256').update(randomBytes(32)).digest('hex');
      await tx.$executeRaw`INSERT INTO docgrid.dg_astra_grants(id,project_id,owner_id,agent_ref,token_hash,actions,expires_at,max_operations,request_key,body_digest,builtin) VALUES(${id}::uuid,${project}::uuid,${user},'Встроенная LLM',${tokenHash},${JSON.stringify(actions)}::jsonb,${expiresAt},10000,${requestKey},${digest({user,project,id})},true)`;
      const grant=await this.grantById(tx,id);
      await this.event(tx,this.context(grant,{id,runId:'grant-management',requestKey,traceId:requestKey}),'astra.grant.created',{builtin:true,expiresAt,actions});
      return this.publicGrant(grant);
    });
  }
  // Same ledger, scopes, approval dispatcher and budgets as external connectors.
  async executeForUser(ownerId:string,grantId:string,tool:string,raw:unknown) {
    return this.executeAuthorized(tool,raw,async(tx,projectId,mutation)=>{
      await this.requireProject(tx,ownerId,projectId);
      const grant=await this.grantById(tx,grantId);
      if(grant.ownerId!==ownerId)throw new ForbiddenException('Grant owner mismatch');
      {
        const settings=await tx.$queryRaw<any[]>`SELECT builtin_enabled FROM docgrid.dg_ai_settings WHERE project_id=${projectId}::uuid`;
        if(settings[0]?.builtin_enabled===false)throw new ForbiddenException('Встроенная LLM отключена владельцем проекта');
      }
      // A captured snapshot is derived read data, not a document edit. Viewers may capture
      // it only through this internal grant; proposals still require current write access.
      await this.requireProject(tx,ownerId,projectId,mutation && !(grant.builtin && tool==='docgrid_get_snapshot')?'write':'read');
      this.assertGrant(grant,projectId,tool); return grant;
    });
  }
  private async executeAuthorized(tool:string,raw:unknown,authorize:(tx:AstraDb,projectId:string,mutation:boolean)=>Promise<Grant>) {
    if(!this.tools().includes(tool))unsupported(tool);
    const body=objectInput(raw);assertKeys(body,['projectId','runId','requestKey','traceId','input']);
    if(Buffer.byteLength(canonical(body))>1048576)throw new BadRequestException('Input exceeds 1 MiB');
    const projectId=uuidInput(body,'projectId'),runId=stringInput(body,'runId',120),traceId=stringInput(body,'traceId',120),input=objectInput(body.input);
    const mutation=this.isMutation(tool,input),requestKey=stringInput(body,'requestKey',120,mutation)||randomUUID();
    const bodyDigest=digest({projectId,runId,tool,input});
    const operation=await this.prisma.$transaction(async tx=>{
      const grant=await authorize(tx,projectId,mutation);
      const existing=await tx.$queryRaw<{id:string;bodyDigest:string}[]>`SELECT id,body_digest AS "bodyDigest" FROM docgrid.dg_astra_operations WHERE grant_id=${grant.id}::uuid AND request_key=${requestKey}`;
      if(existing[0]){if(existing[0].bodyDigest!==bodyDigest)throw new ConflictException('requestKey already used with a different body');const cached=await this.operation(tx,projectId,existing[0].id);this.assertGrant(grant,projectId,tool);return cached;}
      if(grant.usedOperations>=grant.maxOperations)throw new ForbiddenException({code:'BUDGET_EXHAUSTED',message:'Grant operation budget exhausted'});
      const id=randomUUID(),ctx=this.context(grant,{id,runId,requestKey,traceId});
      await tx.$executeRaw`UPDATE docgrid.dg_astra_grants SET used_operations=used_operations+1 WHERE id=${grant.id}::uuid`;
      const sourceRef=input.sourceRef&&typeof input.sourceRef==='object'?input.sourceRef as Record<string,unknown>:{};
      const passport={executionTrack:'DOCGRID_AGENT',specVersion:ASTRA_SPEC_VERSION,runId,projectId,sourceSnapshotId:input.sourceSnapshotId??input.snapshotId??sourceRef.snapshotId??null,actorRef:grant.agentRef,grantRef:grant.id,policyRef:`grant:${grant.id}`,toolCatalogVersion:ASTRA_CATALOG_VERSION,codeRuntimeVersions:{adapter:process.env.ASTRA_BUILD_SHA||process.env.GIT_SHA||'unreported',node:process.version},acceptanceCriteria:input.requestedResult??null,budgetPolicy:{maxOperations:grant.maxOperations,paidCalls:0}};
      const persistedInput=persistedOperationInput(tool,input);
      await tx.$executeRaw`INSERT INTO docgrid.dg_astra_operations(id,project_id,grant_id,tool,run_id,request_key,trace_id,body_digest,input,status,passport) VALUES (${id}::uuid,${projectId}::uuid,${grant.id}::uuid,${tool},${runId},${requestKey},${traceId},${bodyDigest},${JSON.stringify(persistedInput)}::jsonb,'running',${JSON.stringify(passport)}::jsonb)`;
      await tx.$executeRawUnsafe('SAVEPOINT astra_domain');
      try {
        const result=await this.dispatch(tx,ctx,tool,input,grant),approval=result.approval??null,approvalDigest=approval===null?null:digest({tool,input,approval});
        if(result.status==='needs_user_action'&&approval===null)throw new Error('Approval metadata required');
        this.assertGrant(grant,projectId,tool);
        const output=result.output&&typeof result.output==='object'?result.output as Record<string,unknown>:{};
        passport.sourceSnapshotId=passport.sourceSnapshotId??output.sourceSnapshotId??output.snapshotId??null;
        await tx.$executeRaw`UPDATE docgrid.dg_astra_operations SET status=${result.status||'completed'},result=${JSON.stringify(result.output??null)}::jsonb,approval=${JSON.stringify(approval)}::jsonb,approval_digest=${approvalDigest},passport=${JSON.stringify(passport)}::jsonb,updated_at=now() WHERE id=${id}::uuid`;
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT astra_domain');
        await this.event(tx,ctx,'astra.operation.executed',{tool,status:result.status||'completed'});
      } catch(error) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT astra_domain');
        const status=error instanceof HttpException?error.getStatus():500,response=error instanceof HttpException?error.getResponse():{message:'DocGrid operation failed'};
        await tx.$executeRaw`UPDATE docgrid.dg_astra_operations SET status='failed',error=${JSON.stringify({status,response})}::jsonb,updated_at=now() WHERE id=${id}::uuid`;
        await this.event(tx,ctx,'astra.operation.failed',{tool,status});
      }
      return this.operation(tx,projectId,id);
    },{maxWait:10000,timeout:90000});
    if(operation.status==='failed'){const error=operation.error as {status:number;response:string|object};throw new HttpException({operationId:operation.id,error:error.response},error.status);}
    return {...operation,operationId:operation.id,output:operation.result,nextAction:operation.status==='needs_user_action'?'human_approval':undefined};
  }
  async decideOperation(ownerId:string,projectId:string,id:string,action:'approve'|'cancel',raw:unknown) {
    const input=objectInput(raw);assertKeys(input,action==='approve'?['requestKey','approvalDigest','planRevision']:['requestKey']);
    const requestKey=stringInput(input,'requestKey',120);if(action==='approve')stringInput(input,'approvalDigest',64);
    const bodyDigest=digest({action,id,...input});
    return this.prisma.$transaction(async tx=>{
      await this.requireProject(tx,ownerId,projectId,'owner');const operation=await this.operation(tx,projectId,id),grant=await this.grantById(tx,operation.grantId);
      if(action==='approve'&&grant.builtin){const settings=await tx.$queryRaw<any[]>`SELECT builtin_enabled FROM docgrid.dg_ai_settings WHERE project_id=${projectId}::uuid`;if(settings[0]?.builtin_enabled===false)throw new ForbiddenException('Встроенная LLM отключена владельцем проекта');}
      if(action==='approve'){await this.requireProject(tx,grant.ownerId,projectId,'write');this.assertGrant(grant,projectId,operation.tool);}
      const prior=await this.priorDecision(tx,ownerId,projectId,requestKey,bodyDigest);if(prior!==undefined)return prior;
      const cancellableApprovedPlan=action==='cancel'&&operation.tool==='docgrid_plan_document'&&operation.status==='completed';
      if(operation.status!=='needs_user_action'&&!cancellableApprovedPlan)throw new ConflictException('Operation is not awaiting approval');
      const ctx={...this.context(grant,operation),humanActorId:ownerId};
      if(action==='cancel') {
        if((ASTRA_WORKFLOW_TOOLS as readonly string[]).includes(operation.tool))await this.workflow.cancel(tx,ctx,operation);
        else await this.sources.cancel(tx,ctx,operation);
        await tx.$executeRaw`UPDATE docgrid.dg_astra_operations SET status='cancelled',updated_at=now() WHERE id=${id}::uuid`;
      }
      else {
        if(input.approvalDigest!==operation.approvalDigest)throw new ConflictException('Approval is stale or does not match the displayed proposal');
        const approval=objectInput(operation.approval);if(typeof approval.planRevision==='number'&&input.planRevision!==approval.planRevision)throw new ConflictException('Plan revision does not match');
        const result=(ASTRA_WORKFLOW_TOOLS as readonly string[]).includes(operation.tool)?await this.workflow.approve(tx,ctx,operation,input):await this.sources.approve(tx,ctx,operation,input);
        if(result.status==='needs_user_action')throw new ConflictException('Approval did not complete');
        this.assertGrant(grant,projectId,operation.tool);
        await tx.$executeRaw`UPDATE docgrid.dg_astra_operations SET status='completed',result=${JSON.stringify(result.output??null)}::jsonb,updated_at=now() WHERE id=${id}::uuid AND status='needs_user_action'`;
      }
      await this.event(tx,{...ctx,ownerId},`astra.operation.${action==='approve'?'approved':'cancelled'}`,{approvalDigest:operation.approvalDigest,approvedBy:ownerId});
      const result=await this.operation(tx,projectId,id);await this.saveDecision(tx,ownerId,projectId,requestKey,action,id,bodyDigest,result);return result;
    },{maxWait:10000,timeout:60000});
  }
  private humanContext(ownerId:string,projectId:string):AstraContext{return {operationId:randomUUID(),projectId,ownerId,grantId:'',agentRef:'human',runId:'human-read',requestKey:randomUUID(),traceId:randomUUID(),allowedSourceIds:null,principalKind:'human'};}
  async humanArtifact(ownerId:string,projectId:string,artifactId:string,version?:number) {
    return this.prisma.$transaction(async tx=>{await this.requireProject(tx,ownerId,projectId);const result=await this.workflow.execute(tx,this.humanContext(ownerId,projectId),version===undefined?'docgrid_get_history':'docgrid_get_artifact',version===undefined?{artifactId}:{artifactId,version});return result.output;});
  }
  async artifactFile(principal:string,isAgent:boolean,projectId:string,artifactId:string,version:number,format:string) {
    if(!Number.isSafeInteger(version)||version<1||!['docx','pdf'].includes(format))throw new BadRequestException('Invalid artifact version or format');
    // Downloads consume the same durable read budget as tool calls and record exact artifact provenance.
    const downloadOperation=isAgent?await this.execute(principal,'docgrid_get_artifact',{projectId,runId:'artifact-download',requestKey:randomUUID(),traceId:randomUUID(),input:{artifactId,version}}):undefined;
    return this.prisma.$transaction(async tx=>{
      let ctx:AstraContext;
      let checkedGrant:Grant|undefined;
      if(isAgent){checkedGrant=await this.authorizedGrant(tx,principal,projectId,'docgrid_get_artifact',false);ctx=this.context(checkedGrant,downloadOperation!);}
      else {await this.requireProject(tx,principal,projectId);ctx=this.humanContext(principal,projectId);}
      const file=await this.workflow.getArtifactFile(tx,ctx,artifactId,version,format);
      if(checkedGrant)this.assertGrant(checkedGrant,projectId,'docgrid_get_artifact');
      await this.event(tx,ctx,'astra.artifact.downloaded',{artifactId,version,format});
      return file;
    },{timeout:30000});
  }
  async sourceOriginal(token:string,projectId:string,sourceId:string,snapshotId:string,hash:string) {
    if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))throw new BadRequestException('Invalid source hash');
    const sourceRef={sourceId,snapshotId,version:hash,hash};
    const operation=await this.execute(token,'docgrid_get_source_original',{projectId,runId:'source-original-download',requestKey:randomUUID(),traceId:randomUUID(),input:{sourceRef}});
    return this.prisma.$transaction(async tx=>{
      const grant=await this.authorizedGrant(tx,token,projectId,'docgrid_get_source_original',false),ctx=this.context(grant,operation);
      const file=await this.sources.getOriginal(tx,ctx,sourceRef);
      this.assertGrant(grant,projectId,'docgrid_get_source_original');
      await this.event(tx,ctx,'astra.source.original_downloaded',{sourceRef});
      return file;
    },{timeout:30000});
  }
}


