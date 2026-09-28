import { AstraWorkflowService } from './astra-workflow.service';
import { AstraContext, AstraOperation } from './astra.contracts';
const id = '00000000-0000-4000-8000-000000000001';
const ctx: AstraContext = { projectId: id, operationId: id, ownerId: 'owner', grantId: id,
  agentRef: 'astra', runId: 'run', requestKey: 'key', traceId: 'trace', allowedSourceIds: null };
const plan = { title: 'Претензия', documentType: 'Претензия', goal: 'Вернуть долг', sections: ['Обстоятельства', 'Требования'] };
const content = { title: 'Претензия', sections: [{ id: 'facts', heading: 'Факты', paragraphs: ['Долг 10 рублей'], paragraphIds: ['p1'] }] };
const binding = { task_id: id, project_id: id, grant_id: id, plan_revision: 1, plan_digest: 'a'.repeat(64), scope_digest: 'b'.repeat(64),
  source_snapshot_id: id, source_refs: [], state: 'AWAITING_CONFIRMATION' };
function setup() {
  const tx = { $queryRaw: jest.fn(), $executeRaw: jest.fn().mockResolvedValue(1),
    documentTask: { create: jest.fn().mockResolvedValue({ id }), update: jest.fn() },
    preparedLegalDocument: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
    documentVersion: { create: jest.fn(), findUnique: jest.fn() },
  };
  const files = { createAndStoreRecoverable: jest.fn() };
  const sources = { validateSourceRefs: jest.fn().mockResolvedValue([]) };
  return { tx, files, sources, service: new AstraWorkflowService(files as any, sources as any) };
}

describe('ASTRA canonical workflow authorization and version integrity', () => {
  it('saves plan metadata only with exact plan/scope/revision, without a document or export', async () => {
    const { tx, service, files } = setup();
    const result = await service.execute(tx as any, ctx, 'docgrid_plan_document', {
      purpose: 'Подготовить претензию', requestedResult: 'Претензия', plan, sourceSnapshotId: id, sourceRefs: [],
    });
    expect(result.status).toBe('needs_user_action');
    expect(result.approval).toMatchObject({ taskId: id, planRevision: 1 });
    expect((result.approval as any).planDigest).toHaveLength(64);
    expect((result.approval as any).scopeDigest).toHaveLength(64);
    expect(tx.documentTask.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'AWAITING_CONFIRMATION' }) }));
    expect(tx.preparedLegalDocument.create).not.toHaveBeenCalled();
    expect(tx.documentVersion.create).not.toHaveBeenCalled();
    expect(files.createAndStoreRecoverable).not.toHaveBeenCalled();
  });

  it('refuses submit before human approval and refuses a stale revision after approval', async () => {
    const { tx, service } = setup();
    tx.$queryRaw.mockResolvedValueOnce([binding]).mockResolvedValueOnce([{ ...binding, state: 'APPROVED', plan_revision: 2 }]);
    const request = { taskId: id, planRevision: 1, planDigest: binding.plan_digest, content };
    await expect(service.execute(tx as any, ctx, 'docgrid_submit_document', request)).rejects.toThrow('HUMAN_APPROVAL_REQUIRED');
    await expect(service.execute(tx as any, ctx, 'docgrid_submit_document', request)).rejects.toThrow('STALE_PLAN');
    expect(tx.preparedLegalDocument.create).not.toHaveBeenCalled();
    expect(tx.documentVersion.create).not.toHaveBeenCalled();
  });

  it('rejects an old approval and never queues backend generation', async () => {
    const { tx, service } = setup();
    tx.$queryRaw.mockResolvedValue([{ ...binding, plan_revision: 2 }]);
    const operation = { tool: 'docgrid_plan_document', approval: { taskId: id, planRevision: 1, planDigest: binding.plan_digest, scopeDigest: binding.scope_digest } } as unknown as AstraOperation;
    await expect(service.approve(tx as any, ctx, operation, {})).rejects.toThrow('STALE_PLAN');
    expect(tx.documentTask.update).not.toHaveBeenCalled();
    tx.$queryRaw.mockResolvedValue([binding]);
    await service.approve(tx as any, { ...ctx, humanActorId: 'reviewer' }, operation, {});
    expect(tx.documentTask.update).toHaveBeenCalledWith({ where: { id }, data: { confirmedAt: expect.any(Date) } });
    expect(tx.preparedLegalDocument.create).not.toHaveBeenCalled();
  });

  it('detects a concurrent base version before applying any content', async () => {
    const { tx, service } = setup();
    tx.$queryRaw.mockResolvedValue([{ document_id: id, grant_id: id }]);
    tx.preparedLegalDocument.findUnique.mockResolvedValue({ id, currentVersion: 2, nextVersion: 3 });
    await expect(service.execute(tx as any, ctx, 'docgrid_propose_patch', { artifactId: id, baseVersion: 1,
      changes: [{ blockId: 'p1', type: 'replace_paragraph', text: 'Долг 20 рублей' }] })).rejects.toThrow('BASE_VERSION_CONFLICT');
    expect(tx.documentVersion.create).not.toHaveBeenCalled();
  });

  it('compare-and-swap rejects losing writers without reserving or duplicating a version', async () => {
    const { tx, service } = setup();
    tx.preparedLegalDocument.updateMany.mockResolvedValue({ count: 0 });
    await expect((service as any).appendVersion(tx, ctx, { id, currentVersion: 1, nextVersion: 2 }, content, id, [], 'Patch')).rejects.toThrow('BASE_VERSION_CONFLICT');
    expect(tx.documentVersion.create).not.toHaveBeenCalled();
  });

  it('requires unique addressed blocks and only supported structured content', () => {
    const { service } = setup();
    expect(() => service.normalizeContent({ ...content, sections: [{ id: 'p1', paragraphs: ['x'], paragraphIds: ['p1'] }] })).toThrow('unique');
    expect(() => service.normalizeContent({ ...content, html: '<script>opaque content</script>' })).toThrow('Unknown fields');
    expect(service.normalizeContent(content)).toEqual(content);
  });

  it('prevents narrow grants reading uncited artifacts created by another grant', async () => {
    const { tx, service } = setup();
    tx.$queryRaw.mockResolvedValue([{ document_id: id, grant_id: 'other-grant' }]);
    await expect(service.execute(tx as any, { ...ctx, allowedSourceIds: [] }, 'docgrid_get_artifact', { artifactId: id, version: 1 })).rejects.toThrow('outside');
    expect(tx.preparedLegalDocument.findUnique).not.toHaveBeenCalled();
  });

  it('withdraws approval before submission without deleting history or creating content', async () => {
    const { tx, service } = setup();
    tx.$queryRaw.mockResolvedValue([{ ...binding, state: 'APPROVED' }]);
    await service.cancel(tx as any, ctx, { tool: 'docgrid_plan_document', approval: { taskId: id, planRevision: 1, planDigest: binding.plan_digest } } as any);
    expect(tx.documentTask.update).toHaveBeenCalledWith({ where: { id }, data: { status: 'CANCELLED' } });
    expect(tx.documentVersion.create).not.toHaveBeenCalled();
  });
});

