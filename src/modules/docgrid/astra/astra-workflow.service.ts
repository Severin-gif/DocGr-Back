import { normalizedPath } from './astra-source-domain';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { DocumentFileService } from '../../document-workflow/document-file.service';
import { StructuredLegalDocument } from '../../document-workflow/document-workflow.types';
import { AstraSourcesService } from './astra-sources.service';
import {
  AstraContext, AstraDb, AstraDomainResult, AstraOperation, assertKeys, digest,
  integerInput, objectInput, stringInput, unsupported, uuidInput,
} from './astra.contracts';

export const ASTRA_WORKFLOW_TOOLS = [
  'docgrid_propose_package', 'docgrid_plan_document', 'docgrid_submit_document', 'docgrid_propose_patch',
  'docgrid_restore_version', 'docgrid_export_version', 'docgrid_get_artifact',
  'docgrid_get_history', 'docgrid_compare_versions',
] as const;

type CanonicalDocument = Omit<StructuredLegalDocument, 'sections'> & {
  sections: Array<{ id: string; heading?: string; paragraphs: string[]; paragraphIds: string[];
    tables?: Array<{ id: string; headers?: string[]; rows: string[][] }> }>;
};
type Binding = {
  task_id: string; project_id: string; grant_id: string; plan_digest: string; scope_digest: string;
  plan_revision: number; source_snapshot_id: string; source_refs: unknown[];
  state: 'AWAITING_CONFIRMATION' | 'APPROVED' | 'SUBMITTED' | 'CANCELLED';
};
type VersionMeta = { source_snapshot_id: string; source_refs: unknown[]; content_hash: string;
  export_status: string; pdf_hash: string | null; preview_error: string | null };

/** Deterministic binding over DocumentTask/PreparedLegalDocument/DocumentVersion.
 * Content comes from the scoped executor after human approval; this service has no LLM dependency.
 */
@Injectable()
export class AstraWorkflowService {
  constructor(private readonly files: DocumentFileService, private readonly sources: AstraSourcesService) {}

  async execute(tx: AstraDb, ctx: AstraContext, tool: string, input: Record<string, unknown>): Promise<AstraDomainResult> {
    switch (tool) {
      case 'docgrid_propose_package': return this.proposePackage(tx,ctx,input);
      case 'docgrid_plan_document': return this.plan(tx, ctx, input);
      case 'docgrid_submit_document': return this.submit(tx, ctx, input);
      case 'docgrid_propose_patch': return this.propose(tx, ctx, input, false);
      case 'docgrid_restore_version': return this.propose(tx, ctx, input, true);
      case 'docgrid_get_artifact': {
        assertKeys(input, ['artifactId', 'version']);
        return { output: await this.artifact(tx, ctx, uuidInput(input, 'artifactId'), integerInput(input, 'version', 1, 2147483647)) };
      }
      case 'docgrid_export_version': return this.exportVersion(tx, ctx, input);
      case 'docgrid_get_history': return this.history(tx, ctx, input);
      case 'docgrid_compare_versions': return this.compare(tx, ctx, input);
      default: return unsupported(tool);
    }
  }

  /** Called exclusively by the human approval dispatcher; never exposed as an agent tool. */
  async approve(tx: AstraDb, ctx: AstraContext, operation: AstraOperation, _input: Record<string, unknown>): Promise<AstraDomainResult> {
    if(operation.tool==='docgrid_propose_package')return this.approvePackage(tx,ctx,operation);
    const approval = objectInput(operation.approval);
    if (operation.tool === 'docgrid_plan_document') {
      const binding = await this.binding(tx, ctx, uuidInput(approval, 'taskId'));
      if (binding.state !== 'AWAITING_CONFIRMATION' || binding.plan_revision !== approval.planRevision ||
        binding.plan_digest !== approval.planDigest || binding.scope_digest !== approval.scopeDigest) {
        throw new ConflictException('STALE_PLAN: review the current plan and scope');
      }
      await this.sources.validateSourceRefs(tx, ctx, binding.source_snapshot_id, binding.source_refs);
      await tx.$executeRaw`UPDATE docgrid.dg_astra_document_tasks SET state='APPROVED', approved_by=${ctx.humanActorId ?? ctx.ownerId}, approved_at=now()
        WHERE task_id=${binding.task_id}::uuid`;
      // Deliberately never QUEUED: legacy workers must not pick up an ASTRA task.
      await tx.documentTask.update({ where: { id: binding.task_id }, data: { confirmedAt: new Date() } });
      return { output: { taskId: binding.task_id, planRevision: binding.plan_revision, planDigest: binding.plan_digest,
        scopeDigest: binding.scope_digest, status: 'APPROVED', nextAction: 'docgrid_submit_document' } };
    }
    if (operation.tool === 'docgrid_propose_patch' || operation.tool === 'docgrid_restore_version') {
      const rows = await tx.$queryRaw<any[]>`SELECT * FROM docgrid.dg_astra_document_proposals
        WHERE id=${uuidInput(approval, 'proposalId')}::uuid AND project_id=${ctx.projectId}::uuid FOR UPDATE`;
      const proposal = rows[0];
      if (!proposal || proposal.status !== 'PROPOSED' || proposal.content_hash !== approval.contentHash) {
        throw new ConflictException('Proposal is stale or already accepted');
      }
      const document = await this.requireDocument(tx, ctx, proposal.document_id);
      if (document.currentVersion !== proposal.base_version) throw new ConflictException('BASE_VERSION_CONFLICT');
      await this.sources.validateSourceRefs(tx, ctx, proposal.source_snapshot_id, proposal.source_refs);
      const output = await this.appendVersion(tx, ctx, document, this.normalizeContent(proposal.content),
        proposal.source_snapshot_id, proposal.source_refs, operation.tool === 'docgrid_restore_version' ? 'Restore historical content' : 'Accepted addressed patch');
      await tx.$executeRaw`UPDATE docgrid.dg_astra_document_proposals SET status='ACCEPTED',accepted_by=${ctx.humanActorId ?? ctx.ownerId},accepted_at=now()
        WHERE id=${proposal.id}::uuid`;
      return { output };
    }
    return unsupported(operation.tool);
  }

  async cancel(tx: AstraDb, ctx: AstraContext, operation: AstraOperation): Promise<void> {
    const approval = objectInput(operation.approval);
    if (operation.tool === 'docgrid_plan_document') {
      const binding = await this.binding(tx, ctx, uuidInput(approval, 'taskId'));
      if (binding.state === 'SUBMITTED' || binding.plan_revision !== approval.planRevision || binding.plan_digest !== approval.planDigest) {
        throw new ConflictException('Cannot cancel a submitted or superseded plan');
      }
      await tx.$executeRaw`UPDATE docgrid.dg_astra_document_tasks SET state='CANCELLED' WHERE task_id=${binding.task_id}::uuid`;
      await tx.documentTask.update({ where: { id: binding.task_id }, data: { status: 'CANCELLED' } });
      return;
    }
    if (['docgrid_propose_patch', 'docgrid_restore_version'].includes(operation.tool)) {
      const changed = await tx.$executeRaw`UPDATE docgrid.dg_astra_document_proposals SET status='CANCELLED'
        WHERE id=${uuidInput(approval, 'proposalId')}::uuid AND project_id=${ctx.projectId}::uuid AND status='PROPOSED'`;
      if (changed !== 1) throw new ConflictException('Proposal cannot be cancelled');
    }
  }

  private async proposePackage(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>): Promise<AstraDomainResult> {
    assertKeys(input,['baseTreeRevision','folder','documents','sourceSnapshotId','sourceRefs','attachmentIds','missingData']);
    if(ctx.allowedSourceIds!==null)throw new BadRequestException('PROJECT_SCOPE_REQUIRED_FOR_FOLDERS');
    const folder=normalizedPath(input.folder);
    if(folder==='/')throw new BadRequestException('Choose a package folder');
    if(!Array.isArray(input.documents)||!input.documents.length||input.documents.length>8)throw new BadRequestException('Invalid package documents');
    const documents=input.documents.map(v=>this.normalizeContent(v));
    if(new Set(documents.map(d=>d.title)).size!==documents.length)throw new BadRequestException('Duplicate titles');
    const snapshotId=uuidInput(input,'sourceSnapshotId');
    const sourceRefs=await this.sources.validateSourceRefs(tx,ctx,snapshotId,input.sourceRefs);
    if(!Array.isArray(input.attachmentIds)||input.attachmentIds.length>20)throw new BadRequestException('Invalid attachments');
    const attachmentIds=[...new Set(input.attachmentIds.map(id=>uuidInput({id},'id')))];
    if(attachmentIds.some(id=>!sourceRefs.some(r=>r.sourceId===id)))throw new BadRequestException('Attachment not in reviewed sources');
    const missingData=this.strings(input.missingData,'missingData',60,2000);
    const folders=await tx.$queryRaw<Array<{path:string}>>`SELECT path FROM docgrid.docgrid_folders WHERE project_id=${ctx.projectId}::uuid`;
    const existing=new Set(folders.map(f=>f.path)),changes:Array<Record<string,unknown>>=[];
    const destination=folder+'/Приложения';
    const parts=destination.split('/').filter(Boolean);
    for(let i=1;i<=parts.length;i++){const path='/'+parts.slice(0,i).join('/');if(!existing.has(path))changes.push({action:'create_folder',path});}
    for(const sourceId of attachmentIds)changes.push({action:'move_source',sourceId,path:destination});
    // A non-empty structure proposal binds this package to the live tree and rejects stale approval.
    if(!changes.length)throw new ConflictException('Package folder already exists without new attachments; choose a new folder');
    const structure=await this.sources.execute(tx,ctx,'docgrid_propose_structure',{baseTreeRevision:input.baseTreeRevision,changes});
    const approval={folder,documents,sourceSnapshotId:snapshotId,sourceRefs,missingData,structure:structure.approval};
    return {status:'needs_user_action',approval,output:{kind:'package',status:'DRAFT',...approval,attachmentIds}};
  }

  private async approvePackage(tx:AstraDb,ctx:AstraContext,operation:AstraOperation):Promise<AstraDomainResult>{
    const a=objectInput(operation.approval);
    await this.sources.validateSourceRefs(tx,ctx,a.sourceSnapshotId as string,a.sourceRefs);
    await this.sources.approve(tx,ctx,{...operation,tool:'docgrid_propose_structure',approval:a.structure},{});
    const artifacts=[];
    for(const content of a.documents as CanonicalDocument[]){
      const planned=await this.plan(tx,ctx,{purpose:'Подготовить согласованный комплект документов',requestedResult:content.title,
        plan:{title:content.title,documentType:'draft',goal:'Черновик для проверки пользователем',sections:content.sections.map(s=>s.heading||content.title),missingData:a.missingData},sourceSnapshotId:a.sourceSnapshotId,sourceRefs:a.sourceRefs});
      const plan=objectInput(planned.approval);
      await this.approve(tx,ctx,{...operation,tool:'docgrid_plan_document',approval:plan},{});
      const submitted=await this.submit(tx,ctx,{taskId:plan.taskId,planRevision:plan.planRevision,planDigest:plan.planDigest,content});
      const artifact=objectInput(submitted.output);
      await tx.$executeRaw`UPDATE docgrid.dg_astra_documents SET path=${a.folder as string} WHERE document_id=${artifact.artifactId as string}::uuid AND project_id=${ctx.projectId}::uuid`;
      artifacts.push(artifact);
    }
    return {output:{kind:'package',status:'DRAFT',folder:a.folder,artifacts,missingData:a.missingData,externalActions:false}};
  }

  private async plan(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>): Promise<AstraDomainResult> {
    assertKeys(input, ['taskId', 'basePlanRevision', 'purpose', 'requestedResult', 'plan', 'sourceSnapshotId', 'sourceRefs']);
    const purpose = stringInput(input, 'purpose', 8000);
    const requestedResult = stringInput(input, 'requestedResult', 2000);
    const plan = objectInput(input.plan);
    assertKeys(plan, ['title', 'documentType', 'goal', 'sections', 'inputsUsed', 'missingData', 'assumptions', 'warnings']);
    const normalizedPlan = {
      title: stringInput(plan, 'title', 240), documentType: stringInput(plan, 'documentType', 160),
      goal: stringInput(plan, 'goal', 2000), sections: this.strings(plan.sections, 'sections', 80, 500),
      inputsUsed: this.strings(plan.inputsUsed ?? [], 'inputsUsed', 100, 500),
      missingData: this.strings(plan.missingData ?? [], 'missingData', 100, 1000),
      assumptions: this.strings(plan.assumptions ?? [], 'assumptions', 100, 1000),
      warnings: this.strings(plan.warnings ?? [], 'warnings', 100, 1000),
    };
    const sourceSnapshotId = uuidInput(input, 'sourceSnapshotId');
    const sourceRefs = await this.sources.validateSourceRefs(tx, ctx, sourceSnapshotId, input.sourceRefs);
    const scopeDigest = digest({ projectId: ctx.projectId, grantId: ctx.grantId, sourceSnapshotId, sourceRefs, requestedResult });
    const planDigest = digest({ purpose, requestedResult, plan: normalizedPlan, scopeDigest });
    let taskId = uuidInput(input, 'taskId', false);
    let planRevision = 1;
    if (taskId) {
      const previous = await this.binding(tx, ctx, taskId);
      const baseRevision = integerInput(input, 'basePlanRevision', 1, 2147483646);
      if (['SUBMITTED', 'CANCELLED'].includes(previous.state) || previous.plan_revision !== baseRevision) throw new ConflictException('STALE_PLAN');
      planRevision = previous.plan_revision + 1;
      await tx.documentTask.update({ where: { id: taskId }, data: {
        request: purpose, plan: { ...normalizedPlan, executionTrack: 'DOCGRID_AGENT', requestedResult },
        planRevision, confirmedAt: null, status: 'AWAITING_CONFIRMATION',
      } });
      await tx.$executeRaw`UPDATE docgrid.dg_astra_document_tasks SET plan_digest=${planDigest},scope_digest=${scopeDigest},
        plan_revision=${planRevision},source_snapshot_id=${sourceSnapshotId}::uuid,source_refs=${JSON.stringify(sourceRefs)}::jsonb,
        state='AWAITING_CONFIRMATION',approved_by=NULL,approved_at=NULL,operation_id=${ctx.operationId}::uuid WHERE task_id=${taskId}::uuid`;
    } else {
      if (input.basePlanRevision !== undefined) throw new BadRequestException('basePlanRevision requires taskId');
      const task = await tx.documentTask.create({ data: { ownerId: ctx.ownerId, operation: 'CREATE', request: purpose,
        status: 'AWAITING_CONFIRMATION', plan: { ...normalizedPlan, executionTrack: 'DOCGRID_AGENT', requestedResult }, planRevision, attachments: [] } });
      taskId = task.id;
      await tx.$executeRaw`INSERT INTO docgrid.dg_astra_document_tasks
        (task_id,project_id,grant_id,operation_id,plan_digest,scope_digest,plan_revision,source_snapshot_id,source_refs,state)
        VALUES (${taskId}::uuid,${ctx.projectId}::uuid,${ctx.grantId}::uuid,${ctx.operationId}::uuid,${planDigest},${scopeDigest},
        ${planRevision},${sourceSnapshotId}::uuid,${JSON.stringify(sourceRefs)}::jsonb,'AWAITING_CONFIRMATION')`;
    }
    const approval = { taskId, planRevision, planDigest, scopeDigest };
    return { status: 'needs_user_action', nextAction: 'Approve the exact document plan in DocGrid', approval,
      output: { ...approval, plan: normalizedPlan, sourceSnapshotId, sourceRefs, status: 'AWAITING_CONFIRMATION' } };
  }

  private async submit(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>): Promise<AstraDomainResult> {
    assertKeys(input, ['taskId', 'planRevision', 'planDigest', 'content']);
    const binding = await this.binding(tx, ctx, uuidInput(input, 'taskId'));
    if (binding.state !== 'APPROVED') throw new ConflictException('HUMAN_APPROVAL_REQUIRED');
    if (binding.plan_revision !== integerInput(input, 'planRevision', 1, 2147483647) || binding.plan_digest !== stringInput(input, 'planDigest', 64)) {
      throw new ConflictException('STALE_PLAN');
    }
    const content = this.normalizeContent(input.content);
    await this.sources.validateSourceRefs(tx, ctx, binding.source_snapshot_id, binding.source_refs);
    const document = await tx.preparedLegalDocument.create({ data: { ownerId: ctx.ownerId, title: content.title, currentVersion: 0, nextVersion: 1 } });
    await tx.$executeRaw`INSERT INTO docgrid.dg_astra_documents(document_id,project_id,task_id)
      VALUES (${document.id}::uuid,${ctx.projectId}::uuid,${binding.task_id}::uuid)`;
    const output = await this.appendVersion(tx, ctx, document, content, binding.source_snapshot_id, binding.source_refs, 'Approved document plan');
    await tx.documentTask.update({ where: { id: binding.task_id }, data: { documentId: document.id,
      status: 'READY', resultVersion: 1, completedAt: new Date() } });
    await tx.$executeRaw`UPDATE docgrid.dg_astra_document_tasks SET state='SUBMITTED' WHERE task_id=${binding.task_id}::uuid`;
    return { output };
  }

  private async propose(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>, restore: boolean): Promise<AstraDomainResult> {
    assertKeys(input, restore ? ['artifactId', 'baseVersion', 'restoreVersion'] : ['artifactId', 'baseVersion', 'changes']);
    const artifactId = uuidInput(input, 'artifactId');
    const baseVersion = integerInput(input, 'baseVersion', 1, 2147483646);
    const document = await this.requireDocument(tx, ctx, artifactId);
    if (document.currentVersion !== baseVersion) throw new ConflictException('BASE_VERSION_CONFLICT');
    const base = await this.version(tx, ctx, artifactId, baseVersion);
    const restored = restore ? await this.version(tx, ctx, artifactId, integerInput(input, 'restoreVersion', 1, 2147483647)) : null;
    const content = this.normalizeContent(restored?.row.structuredContent ?? base.row.structuredContent);
    const changes = restore ? [{ type: 'restore', fromVersion: restored!.row.version, toBaseVersion: baseVersion }] : this.applyChanges(content, input.changes);
    const meta = restored?.meta ?? base.meta;
    await this.sources.validateSourceRefs(tx, ctx, meta.source_snapshot_id, meta.source_refs);
    const contentHash = digest(content);
    const rows = await tx.$queryRaw<Array<{ id: string }>>`INSERT INTO docgrid.dg_astra_document_proposals
      (operation_id,project_id,document_id,base_version,content,changes,source_snapshot_id,source_refs,content_hash,status)
      VALUES (${ctx.operationId}::uuid,${ctx.projectId}::uuid,${artifactId}::uuid,${baseVersion},${JSON.stringify(content)}::jsonb,
      ${JSON.stringify(changes)}::jsonb,${meta.source_snapshot_id}::uuid,${JSON.stringify(meta.source_refs)}::jsonb,${contentHash},'PROPOSED') RETURNING id`;
    return { status: 'needs_user_action', nextAction: 'Review and accept the proposed version in DocGrid',
      approval: { proposalId: rows[0].id, artifactId, baseVersion, contentHash },
      output: { proposalId: rows[0].id, artifactId, baseVersion, changes, contentHash, status: 'PROPOSED' } };
  }

  private async appendVersion(tx: AstraDb, ctx: AstraContext, document: { id: string; currentVersion: number; nextVersion: number },
    content: CanonicalDocument, snapshotId: string, sourceRefs: unknown[], reason: string) {
    const nextVersion = Math.max(document.currentVersion + 1, document.nextVersion);
    const changed = await tx.preparedLegalDocument.updateMany({ where: { id: document.id, currentVersion: document.currentVersion },
      data: { currentVersion: nextVersion, nextVersion: nextVersion + 1, title: content.title } });
    if (changed.count !== 1) throw new ConflictException('BASE_VERSION_CONFLICT');
    const previous = document.currentVersion ? await tx.documentVersion.findUnique({ where: { documentId_version: { documentId: document.id, version: document.currentVersion } } }) : null;
    const row = await tx.documentVersion.create({ data: { documentId: document.id, version: nextVersion,
      status: 'CONTENT_READY', title: content.title, structuredContent: content as unknown as Prisma.InputJsonValue,
      plainText: this.toPlainText(content), sourceVersionId: previous?.id ?? null, changeRequest: reason,
      createdBy: ctx.humanActorId ?? ctx.ownerId, readyAt: new Date() } });
    await tx.$executeRaw`INSERT INTO docgrid.dg_astra_document_versions
      (version_id,operation_id,source_snapshot_id,source_refs,content_hash,agent_ref)
      VALUES (${row.id}::uuid,${ctx.operationId}::uuid,${snapshotId}::uuid,${JSON.stringify(sourceRefs)}::jsonb,${digest(content)},${ctx.agentRef})`;
    return this.artifact(tx, ctx, document.id, nextVersion);
  }

  private async exportVersion(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>): Promise<AstraDomainResult> {
    assertKeys(input, ['artifactId', 'version', 'format']);
    if (input.format !== undefined && !['docx', 'pdf', 'both'].includes(String(input.format))) throw new BadRequestException('Invalid format');
    const id = uuidInput(input, 'artifactId');
    const number = integerInput(input, 'version', 1, 2147483647);
    // Same database transaction serializes all export/retry operations for this immutable version.
    const { row, meta, document } = await this.version(tx, ctx, id, number, true);
    if (meta.export_status !== 'READY') {
      const content = this.normalizeContent(row.structuredContent);
      if (digest(content) !== meta.content_hash) throw new ConflictException('CONTENT_HASH_MISMATCH');
      const stored = await this.files.createAndStoreRecoverable(document.ownerId, id, number, content, {
        docxObjectKey: row.docxObjectKey, pdfObjectKey: row.pdfObjectKey, generatePdf: input.format !== 'docx', checksum: row.checksum, pdfHash: meta.pdf_hash,
      });
      await tx.documentVersion.update({ where: { id: row.id }, data: {
        docxObjectKey: stored.docxObjectKey, docxSize: stored.docxSize, checksum: stored.checksum,
        ...(stored.pdfObjectKey ? { status: 'READY' as const, pdfObjectKey: stored.pdfObjectKey, pdfSize: stored.pdfSize } : {}),
      } });
      await tx.$executeRaw`UPDATE docgrid.dg_astra_document_versions SET export_status=${stored.pdfObjectKey ? 'READY' : stored.previewError ? 'PREVIEW_FAILED' : 'DOCX_READY'},
        pdf_hash=${stored.pdfHash ?? null},preview_error=${stored.previewError ?? null} WHERE version_id=${row.id}::uuid`;
    }
    return { output: await this.artifact(tx, ctx, id, number) };
  }

  async getArtifactFile(tx: AstraDb, ctx: AstraContext, artifactId: string, number: number, format: string) {
    if (!['docx', 'pdf'].includes(format)) throw new BadRequestException('Invalid format');
    const { row, meta } = await this.version(tx, ctx, artifactId, number);
    const key = format === 'docx' ? row.docxObjectKey : row.pdfObjectKey;
    if (!key) throw new NotFoundException(format === 'pdf' && meta.export_status === 'PREVIEW_FAILED' ? 'PREVIEW_FAILED' : 'Artifact has not been exported');
    const bytes = await this.files.read(key);
    const expected = format === 'docx' ? row.checksum : meta.pdf_hash;
    if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected) throw new ConflictException('ARTIFACT_HASH_MISMATCH');
    return { bytes, mime: format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf',
      fileName: `document-${artifactId}-v${number}.${format}` };
  }

  private async artifact(tx: AstraDb, ctx: AstraContext, id: string, number: number) {
    const { row, meta } = await this.version(tx, ctx, id, number);
    const root = ctx.grantId
      ? `/api/docgrid/astra/artifacts/${id}/versions/${number}`
      : `/api/docgrid/repositories/${ctx.projectId}/astra/artifacts/${id}/versions/${number}`;
    const query = ctx.grantId ? `?projectId=${ctx.projectId}` : '';
    return { artifactId: id, version: number, versionId: row.id, title: row.title,
      content: row.structuredContent, plainText: row.plainText, contentHash: meta.content_hash,
      sourceSnapshotId: meta.source_snapshot_id, sourceRefs: meta.source_refs,
      exportStatus: meta.export_status, previewError: meta.preview_error,
      docxUrl: row.docxObjectKey ? `${root}/docx${query}` : null, pdfUrl: row.pdfObjectKey ? `${root}/pdf${query}` : null,
      docxHash: row.checksum, pdfHash: meta.pdf_hash,
      stableUrl: `/projects/${ctx.projectId}?section=files&artifactId=${id}&version=${number}` };
  }

  private async history(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>): Promise<AstraDomainResult> {
    assertKeys(input, ['artifactId', 'beforeVersion', 'limit']);
    const id = uuidInput(input, 'artifactId');
    await this.requireDocument(tx, ctx, id);
    const limit = integerInput(input, 'limit', 1, 100, 30);
    const before = integerInput(input, 'beforeVersion', 1, 2147483647, 2147483647);
    const rows = await tx.documentVersion.findMany({ where: { documentId: id, version: { lt: before } },
      orderBy: { version: 'desc' }, take: limit + 1, select: { id: true, version: true, title: true, createdAt: true, changeRequest: true, sourceVersionId: true } });
    // A project match alone does not authorize disclosure through a source-scoped grant.
    for (const row of rows) await this.version(tx, ctx, id, row.version);
    return { output: { artifactId: id, versions: rows.slice(0, limit),
      nextBeforeVersion: rows.length > limit ? rows[limit - 1].version : null } };
  }

  private async compare(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>): Promise<AstraDomainResult> {
    assertKeys(input, ['artifactId', 'fromVersion', 'toVersion']);
    const id = uuidInput(input, 'artifactId');
    const from = await this.version(tx, ctx, id, integerInput(input, 'fromVersion', 1, 2147483647));
    const to = await this.version(tx, ctx, id, integerInput(input, 'toVersion', 1, 2147483647));
    const a = this.blocks(this.normalizeContent(from.row.structuredContent));
    const b = this.blocks(this.normalizeContent(to.row.structuredContent));
    const changes = [...new Set([...a.keys(), ...b.keys()])].filter(key => JSON.stringify(a.get(key)) !== JSON.stringify(b.get(key)))
      .map(blockId => ({ blockId, before: a.get(blockId) ?? null, after: b.get(blockId) ?? null }));
    return { output: { artifactId: id, fromVersion: from.row.version, toVersion: to.row.version,
      fromHash: from.meta.content_hash, toHash: to.meta.content_hash, changes } };
  }

  private async requireDocument(tx: AstraDb, ctx: AstraContext, id: string) {
    const bindings = await tx.$queryRaw<Array<{ document_id: string; grant_id: string }>>`SELECT d.document_id,t.grant_id
      FROM docgrid.dg_astra_documents d JOIN docgrid.dg_astra_document_tasks t ON t.task_id=d.task_id
      WHERE d.document_id=${id}::uuid AND d.project_id=${ctx.projectId}::uuid`;
    if (!bindings.length) throw new NotFoundException('Artifact not found in the authorized project');
    if (ctx.principalKind !== 'human' && ctx.allowedSourceIds !== null && bindings[0].grant_id !== ctx.grantId && !ctx.allowedSourceIds.includes(id)) {
      throw new NotFoundException('Artifact is outside the authorized source scope');
    }
    const doc = await tx.preparedLegalDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Artifact not found');
    return doc;
  }

  private async version(tx: AstraDb, ctx: AstraContext, id: string, number: number, lock = false) {
    const document = await this.requireDocument(tx, ctx, id);
    if (lock) await tx.$queryRaw`SELECT id FROM docgrid.document_versions WHERE document_id=${id}::uuid AND version=${number} FOR UPDATE`;
    const row = await tx.documentVersion.findUnique({ where: { documentId_version: { documentId: id, version: number } } });
    if (!row) throw new NotFoundException('Exact artifact version not found');
    const rows = await tx.$queryRaw<VersionMeta[]>`SELECT * FROM docgrid.dg_astra_document_versions WHERE version_id=${row.id}::uuid`;
    if (!rows[0]) throw new NotFoundException('Version binding not found');
    // File-scoped grants cannot read results based on sources outside their current scope.
    await this.sources.validateSourceRefs(tx, ctx, rows[0].source_snapshot_id, rows[0].source_refs);
    return { row, meta: rows[0], document };
  }

  private async binding(tx: AstraDb, ctx: AstraContext, id: string): Promise<Binding> {
    const rows = await tx.$queryRaw<Binding[]>`SELECT * FROM docgrid.dg_astra_document_tasks
      WHERE task_id=${id}::uuid AND project_id=${ctx.projectId}::uuid AND grant_id=${ctx.grantId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException('Document task not found');
    return rows[0];
  }

  normalizeContent(value: unknown): CanonicalDocument {
    const item = objectInput(value);
    assertKeys(item, ['title', 'subtitle', 'addressee', 'introduction', 'sections', 'requests', 'signatureBlock', 'warnings']);
    if (JSON.stringify(item).length > 500_000) throw new BadRequestException('Document content limit exceeded');
    if (!Array.isArray(item.sections) || !item.sections.length || item.sections.length > 100) throw new BadRequestException('Invalid sections');
    const ids = new Set<string>();
    const blockId = (raw: unknown) => {
      if (typeof raw !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(raw) || ids.has(raw)) throw new BadRequestException('Block IDs must be valid and unique');
      ids.add(raw); return raw;
    };
    const content: CanonicalDocument = { title: stringInput(item, 'title', 240), sections: item.sections.map(raw => {
      const section = objectInput(raw);
      assertKeys(section, ['id', 'heading', 'paragraphs', 'paragraphIds', 'tables']);
      const id = blockId(section.id);
      const paragraphs = this.strings(section.paragraphs, 'paragraphs', 1000, 20_000);
      if (!Array.isArray(section.paragraphIds) || section.paragraphIds.length !== paragraphs.length) throw new BadRequestException('paragraphIds must address every paragraph');
      const result: CanonicalDocument['sections'][number] = { id, paragraphs, paragraphIds: section.paragraphIds.map(blockId) };
      if (section.heading !== undefined) result.heading = stringInput(section, 'heading', 500);
      if (section.tables !== undefined) {
        if (!Array.isArray(section.tables) || section.tables.length > 50) throw new BadRequestException('Invalid tables');
        result.tables = section.tables.map(rawTable => {
          const table = objectInput(rawTable); assertKeys(table, ['id', 'headers', 'rows']);
          const tableId = blockId(table.id);
          const normalized = this.normalizeTable(table);
          return { id: tableId, ...normalized };
        });
      }
      return result;
    }) };
    for (const field of ['subtitle', 'addressee', 'introduction'] as const) if (item[field] !== undefined) content[field] = stringInput(item, field, 20_000);
    for (const field of ['requests', 'signatureBlock', 'warnings'] as const) if (item[field] !== undefined) content[field] = this.strings(item[field], field, 200, 5000);
    return content;
  }

  private normalizeTable(table: Record<string, unknown>) {
    if (!Array.isArray(table.rows) || !table.rows.length || table.rows.length > 500) throw new BadRequestException('Invalid table rows');
    const rows = table.rows.map(row => this.strings(row, 'table cells', 30, 5000, true));
    const columns = rows[0].length;
    if (!columns || rows.some(row => row.length !== columns)) throw new BadRequestException('Table rows must have equal column counts');
    const headers = table.headers === undefined ? undefined : this.strings(table.headers, 'headers', 30, 5000, true);
    if (headers && headers.length !== columns) throw new BadRequestException('Header count must match columns');
    return { ...(headers ? { headers } : {}), rows };
  }

  private applyChanges(content: CanonicalDocument, value: unknown) {
    if (!Array.isArray(value) || !value.length || value.length > 100) throw new BadRequestException('Invalid changes');
    const seen = new Set<string>();
    return value.map(raw => {
      const change = objectInput(raw);
      assertKeys(change, ['blockId', 'type', 'text', 'table']);
      const id = stringInput(change, 'blockId', 80);
      if (seen.has(id)) throw new BadRequestException('Duplicate addressed change');
      seen.add(id);
      for (const section of content.sections) {
        const index = section.paragraphIds.indexOf(id);
        if (change.type === 'replace_paragraph' && index >= 0) {
          if (change.table !== undefined) throw new BadRequestException('Unexpected table');
          const before = section.paragraphs[index];
          const after = stringInput(change, 'text', 20_000);
          section.paragraphs[index] = after;
          return { blockId: id, type: change.type, before, after };
        }
        const table = section.tables?.find(item => item.id === id);
        if (change.type === 'replace_table' && table) {
          if (change.text !== undefined) throw new BadRequestException('Unexpected text');
          const replacement = objectInput(change.table); assertKeys(replacement, ['headers', 'rows']);
          const before = JSON.parse(JSON.stringify(table));
          const after = { id, ...this.normalizeTable(replacement) };
          section.tables![section.tables!.indexOf(table)] = after;
          return { blockId: id, type: change.type, before, after };
        }
      }
      throw new BadRequestException('Addressed block or patch type is unsupported');
    });
  }

  private blocks(content: CanonicalDocument): Map<string, unknown> {
    const result = new Map<string, unknown>([['$sectionOrder', content.sections.map(section => section.id)], ['$title', content.title], ['$subtitle', content.subtitle ?? null],
      ['$addressee', content.addressee ?? null], ['$introduction', content.introduction ?? null],
      ['$requests', content.requests ?? []], ['$signatureBlock', content.signatureBlock ?? []], ['$warnings', content.warnings ?? []]]);
    for (const section of content.sections) {
      result.set(section.id, { heading: section.heading ?? null, paragraphIds: section.paragraphIds, tableIds: (section.tables ?? []).map(t => t.id) });
      section.paragraphIds.forEach((id, i) => result.set(id, section.paragraphs[i]));
      section.tables?.forEach(table => result.set(table.id, table));
    }
    return result;
  }

  private strings(value: unknown, name: string, maxItems: number, maxChars: number, empty = false): string[] {
    if (!Array.isArray(value) || value.length > maxItems || value.some(v => typeof v !== 'string' || (!empty && !v.trim()) || v.length > maxChars || v.includes('\u0000'))) {
      throw new BadRequestException(`Invalid ${name}`);
    }
    return value as string[];
  }

  private toPlainText(content: CanonicalDocument): string {
    return [content.title, content.subtitle, content.addressee, content.introduction,
      ...content.sections.flatMap(section => [section.heading, ...section.paragraphs,
        ...(section.tables ?? []).flatMap(table => [...(table.headers ? [table.headers.join('\t')] : []), ...table.rows.map(row => row.join('\t'))])]),
      ...(content.requests?.length ? ['ПРОШУ:', ...content.requests.map((text, i) => `${i + 1}. ${text}`)] : []),
      ...(content.signatureBlock ?? [])].filter(Boolean).join('\n\n');
  }
}

const uuidSchema = { type: 'string', format: 'uuid' };
const versionSchema = { type: 'integer', minimum: 1, maximum: 2147483647 };
const textList = { type: 'array', items: { type: 'string' } };
const sourceRefSchema = { type: 'object', additionalProperties: false, required: ['snapshotId', 'sourceId', 'version', 'hash'],
  properties: { snapshotId: uuidSchema, sourceId: uuidSchema, version: { type: 'string' }, hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    locator: { type: 'object', additionalProperties: false, required: ['kind', 'unit', 'start', 'end'], properties: { kind: { const: 'text_range' }, unit: { const: 'utf16' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 } } } } };
const tableSchema = { type: 'object', additionalProperties: false, required: ['id', 'rows'], properties: {
  id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,79}$' }, headers: textList,
  rows: { type: 'array', minItems: 1, maxItems: 500, items: { ...textList, maxItems: 30 } },
} };
const contentSchema = { type: 'object', additionalProperties: false, required: ['title', 'sections'], properties: {
  title: { type: 'string', maxLength: 240 }, subtitle: { type: 'string' }, addressee: { type: 'string' }, introduction: { type: 'string' },
  requests: textList, signatureBlock: textList, warnings: textList, sections: { type: 'array', minItems: 1, maxItems: 100, items: {
    type: 'object', additionalProperties: false, required: ['id', 'paragraphs', 'paragraphIds'], properties: {
      id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{0,79}$' }, heading: { type: 'string' }, paragraphs: textList, paragraphIds: textList,
      tables: { type: 'array', maxItems: 50, items: tableSchema },
    },
  } },
} };
const schema = (required: string[], properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required, properties });
export const ASTRA_WORKFLOW_SCHEMAS: Record<string, { description: string; inputSchema: unknown }> = {
  docgrid_propose_package: {description:'Propose a reviewed folder, source attachments and draft documents; human approval applies them atomically. No sending or payments.',inputSchema:{type:'object',additionalProperties:false,required:['baseTreeRevision','folder','documents','sourceSnapshotId','sourceRefs','attachmentIds','missingData'],properties:{baseTreeRevision:{type:'string'},folder:{type:'string'},documents:{type:'array',maxItems:8,items:{type:'object'}},sourceSnapshotId:{type:'string',format:'uuid'},sourceRefs:{type:'array',items:{type:'object'}},attachmentIds:{type:'array',maxItems:20,items:{type:'string',format:'uuid'}},missingData:{type:'array',items:{type:'string'}}}}},
  docgrid_plan_document: { description: 'Save a metadata-only plan; human approval binds its digest, scope and revision before content or files can exist.',
    inputSchema: schema(['purpose', 'requestedResult', 'plan', 'sourceSnapshotId', 'sourceRefs'], {
      taskId: uuidSchema, basePlanRevision: versionSchema, purpose: { type: 'string', maxLength: 8000 }, requestedResult: { type: 'string', maxLength: 2000 },
      sourceSnapshotId: uuidSchema, sourceRefs: { type: 'array', items: sourceRefSchema },
      plan: schema(['title', 'documentType', 'goal', 'sections'], { title: { type: 'string', maxLength: 240 }, documentType: { type: 'string' }, goal: { type: 'string' }, sections: textList, inputsUsed: textList, missingData: textList, assumptions: textList, warnings: textList }),
    }) },
  docgrid_submit_document: { description: 'Persist the executor-supplied canonical content only after exact human approval. No model is called; export is separate.',
    inputSchema: schema(['taskId', 'planRevision', 'planDigest', 'content'], { taskId: uuidSchema, planRevision: versionSchema, planDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, content: contentSchema }) },
  docgrid_propose_patch: { description: 'Propose addressed paragraph/table changes against current baseVersion; only human acceptance creates a new version.',
    inputSchema: schema(['artifactId', 'baseVersion', 'changes'], { artifactId: uuidSchema, baseVersion: versionSchema, changes: { type: 'array', minItems: 1, maxItems: 100, items: schema(['blockId', 'type'], {
      blockId: { type: 'string' }, type: { enum: ['replace_paragraph', 'replace_table'] }, text: { type: 'string' },
      table: schema(['rows'], { headers: textList, rows: tableSchema.properties.rows }),
    }) } }) },
  docgrid_restore_version: { description: 'Propose restoring historical content; human acceptance creates a new version and retains every prior version.',
    inputSchema: schema(['artifactId', 'baseVersion', 'restoreVersion'], { artifactId: uuidSchema, baseVersion: versionSchema, restoreVersion: versionSchema }) },
  docgrid_export_version: { description: 'Export exact immutable content to DOCX/PDF; PDF retry preserves DOCX and never regenerates text.',
    inputSchema: schema(['artifactId', 'version'], { artifactId: uuidSchema, version: versionSchema, format: { enum: ['docx', 'pdf', 'both'] } }) },
  docgrid_get_artifact: { description: 'Read exact canonical content, source provenance, protected file links and export status.',
    inputSchema: schema(['artifactId', 'version'], { artifactId: uuidSchema, version: versionSchema }) },
  docgrid_get_history: { description: 'List immutable artifact revisions in descending order with bounded continuation.',
    inputSchema: schema(['artifactId'], { artifactId: uuidSchema, beforeVersion: versionSchema, limit: { type: 'integer', minimum: 1, maximum: 100 } }) },
  docgrid_compare_versions: { description: 'Compare two exact canonical versions by addressed blocks, reporting before/after and content hashes.',
    inputSchema: schema(['artifactId', 'fromVersion', 'toVersion'], { artifactId: uuidSchema, fromVersion: versionSchema, toVersion: versionSchema }) },
};

