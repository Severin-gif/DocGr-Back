import { DocGridMaterialStorageService, readMaterialBytes } from '../docgrid-material-storage.service';
import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AstraContext, AstraDb, AstraDomainResult, AstraOperation } from './astra.contracts';
import { assertRevision, boundedInt, idField, makeCursor, normalizedPath, readCursor, scopeSource, sha256, sliceSource, strictKeys, sumDecimals, textField } from './astra-source-domain';

export const ASTRA_SOURCE_TOOLS = [
  'docgrid_get_project', 'docgrid_list_tree', 'docgrid_get_snapshot', 'docgrid_read_source',
  'docgrid_get_source_original', 'docgrid_search', 'docgrid_get_source_history', 'docgrid_compare_source_versions',
  'docgrid_propose_structure', 'docgrid_propose_relation', 'docgrid_calculate_sum',
] as const;

type Entry = { id: string; kind: 'material' | 'document' | 'artifact' | 'folder'; title: string; path: string; version: string; hash: string | null; size: number; textSize?: number; status?: string; extractionFingerprint?: string | null };
type Source = { sourceId: string; kind: 'material' | 'document' | 'artifact'; version: string; hash: string; extractionRevision: string; status: 'READY' | 'PARTIAL' | 'UNREAD' | 'FAILED'; title: string; path: string; mime: string; byteSize: number; content: string; warnings: string[] };
type Snapshot = { id: string; projectId: string; grantId: string; treeRevision: string; manifest: { entries: Entry[]; relations: unknown[] }; cursorSecret: string; createdAt: Date };
export type AstraSourceRef = { snapshotId: string; sourceId: string; version: string; hash: string; locator?: { kind: 'text_range'; unit: 'utf16'; start: number; end: number } };
type StructureChange = { action: 'move_source' | 'rename_source' | 'create_folder' | 'remove_empty_folder'; sourceId?: string; path?: string; title?: string };

@Injectable()
export class AstraSourcesService {
  constructor(@Optional() private readonly materialStorage?: DocGridMaterialStorageService) {}
  async execute(tx: AstraDb, ctx: AstraContext, tool: string, input: Record<string, unknown>): Promise<AstraDomainResult> {
    if (input.projectId !== undefined && input.projectId !== ctx.projectId) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND' });
    // Project identity lives in the verified scope. A matching projectId is accepted for connector clients.
    const args = { ...input }; delete args.projectId;
    switch (tool) {
      case 'docgrid_get_project': return this.project(tx, ctx, args);
      case 'docgrid_list_tree': return this.tree(tx, ctx, args);
      case 'docgrid_get_snapshot': return this.getSnapshot(tx, ctx, args);
      case 'docgrid_read_source': return this.read(tx, ctx, args);
      case 'docgrid_get_source_original': return this.originalMetadata(tx, ctx, args);
      case 'docgrid_search': return this.search(tx, ctx, args);
      case 'docgrid_get_source_history': return this.history(tx, ctx, args);
      case 'docgrid_compare_source_versions': return this.compare(tx, ctx, args);
      case 'docgrid_propose_structure': return this.proposeStructure(tx, ctx, args);
      case 'docgrid_propose_relation': return this.proposeRelation(tx, ctx, args);
      case 'docgrid_calculate_sum': return this.calculate(tx, ctx, args);
      default: throw new BadRequestException({ code: 'UNSUPPORTED', tool });
    }
  }

  private async project(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>) {
    strictKeys(input, []);
    const rows = await tx.$queryRaw<any[]>`SELECT id,name,description FROM docgrid.workspace_projects WHERE id=${ctx.projectId}::uuid`;
    if (!rows[0]) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND' });
    return { output: { ...rows[0], executionTrack: 'DOCGRID_AGENT', sourceScope: ctx.allowedSourceIds, href: `/projects/${ctx.projectId}` } };
  }

  private async liveTree(tx: AstraDb, ctx: AstraContext) {
    const ids = ctx.allowedSourceIds === null ? null : JSON.stringify(ctx.allowedSourceIds);
    const entries = await tx.$queryRaw<Entry[]>`
      SELECT id,'material' AS kind,title,path,sha256::text AS version,sha256::text AS hash,
        byte_size::int AS size,octet_length(extracted_text)::int AS "textSize",extraction_status AS status,encode(sha256(convert_to(extracted_text,'UTF8')),'hex') AS "extractionFingerprint"
      FROM docgrid.docgrid_materials WHERE project_id=${ctx.projectId}::uuid AND deleted_at IS NULL
        AND (${ids}::jsonb IS NULL OR id::text IN (SELECT jsonb_array_elements_text(${ids}::jsonb)))
      UNION ALL
      SELECT id,'document',title,path,version::text,encode(sha256(convert_to(content,'UTF8')),'hex'),octet_length(content)::int,octet_length(content)::int,'READY',encode(sha256(convert_to(content,'UTF8')),'hex')
      FROM docgrid.workspace_documents WHERE project_id=${ctx.projectId}::uuid AND docgrid_deleted_at IS NULL
        AND (${ids}::jsonb IS NULL OR id::text IN (SELECT jsonb_array_elements_text(${ids}::jsonb)))
      UNION ALL
      SELECT d.id,'artifact',d.title,b.path,d.current_version::text,encode(sha256(convert_to(v.plain_text,'UTF8')),'hex'),octet_length(v.plain_text)::int,octet_length(v.plain_text)::int,'READY',encode(sha256(convert_to(v.plain_text,'UTF8')),'hex')
      FROM docgrid.dg_astra_documents b JOIN docgrid.prepared_legal_documents d ON d.id=b.document_id
      JOIN docgrid.document_versions v ON v.document_id=d.id AND v.version=d.current_version
      WHERE b.project_id=${ctx.projectId}::uuid AND (${ids}::jsonb IS NULL OR d.id::text IN (SELECT jsonb_array_elements_text(${ids}::jsonb)))
      UNION ALL
      SELECT id,'folder','',path,'',NULL,0,0,NULL,NULL FROM docgrid.docgrid_folders
      WHERE project_id=${ctx.projectId}::uuid AND ${ids}::jsonb IS NULL ORDER BY kind,id LIMIT 5001`;
    if (entries.length > 5000) throw new BadRequestException({ code: 'SCOPE_TOO_LARGE', limit: 5000 });
    const relations = await tx.$queryRaw<any[]>`SELECT id,from_ref AS "fromRef",to_ref AS "toRef",relation_type AS type,status
      FROM docgrid.dg_astra_relations WHERE project_id=${ctx.projectId}::uuid AND
      (${ids}::jsonb IS NULL OR (from_ref->>'sourceId' IN (SELECT jsonb_array_elements_text(${ids}::jsonb))
      AND to_ref->>'sourceId' IN (SELECT jsonb_array_elements_text(${ids}::jsonb)))) ORDER BY id LIMIT 5001`;
    if (relations.length > 5000) throw new BadRequestException({ code: 'SCOPE_TOO_LARGE', limit: 5000 });
    return { entries, relations, revision: sha256(JSON.stringify({ entries, relations })) };
  }

  private binding(ctx: AstraContext, snapshot: Snapshot, tool: string, scope: unknown) {
    return { projectId: ctx.projectId, grantId: ctx.grantId, ownerId: ctx.ownerId, snapshotId: snapshot.id, tool, scope };
  }

  private async loadSnapshot(tx: AstraDb, ctx: AstraContext, id: string): Promise<Snapshot> {
    const rows = await tx.$queryRaw<Snapshot[]>`SELECT id,project_id AS "projectId",grant_id AS "grantId",tree_revision AS "treeRevision",
      manifest,cursor_secret AS "cursorSecret",created_at AS "createdAt" FROM docgrid.dg_astra_snapshots
      WHERE id=${id}::uuid AND project_id=${ctx.projectId}::uuid `;
    if (!rows[0]) throw new NotFoundException({ code: 'SNAPSHOT_NOT_FOUND' });
    // Fresh project ACL is checked by the adapter. A new grant may read historical snapshots
    // only within its current source scope; cursor bindings still include its own grant ID.
    if (ctx.allowedSourceIds !== null) {
      rows[0].manifest.entries = rows[0].manifest.entries.filter(e => e.kind !== 'folder' && ctx.allowedSourceIds!.includes(e.id));
      rows[0].manifest.relations = rows[0].manifest.relations.filter((r: any) => ctx.allowedSourceIds!.includes(r.fromRef?.sourceId) && ctx.allowedSourceIds!.includes(r.toRef?.sourceId));
    }
    return rows[0];
  }

  private async tree(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>) {
    strictKeys(input, ['snapshotId', 'path', 'cursor', 'limit']);
    const limit = boundedInt(input, 'limit', 100, 1, 200);
    const path = input.path === undefined ? '/' : normalizedPath(input.path);
    const snapshot = input.snapshotId ? await this.loadSnapshot(tx, ctx, idField(input, 'snapshotId')) : null;
    if (input.cursor && !snapshot) throw new BadRequestException({ code: 'SNAPSHOT_REQUIRED_FOR_CONTINUATION' });
    const live = snapshot ? null : await this.liveTree(tx, ctx);
    const entries = (snapshot?.manifest.entries || live!.entries).filter(e => path === '/' || e.path === path || e.path.startsWith(path + '/'));
    const binding = snapshot && this.binding(ctx, snapshot, 'tree', { path, limit });
    const offset = input.cursor ? readCursor(snapshot!.cursorSecret, binding, input.cursor) : 0;
    const end = Math.min(entries.length, offset + limit);
    const truncated = end < entries.length;
    return { output: { entries: entries.slice(offset, end), treeRevision: snapshot?.treeRevision || live!.revision,
      snapshotId: snapshot?.id || null, total: entries.length, truncated,
      continuation: truncated && snapshot ? makeCursor(snapshot.cursorSecret, binding, end) : null,
      nextAction: truncated && !snapshot ? 'Explicitly capture a source snapshot, then paginate that snapshot' : null } };
  }

  private async getSnapshot(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>) {
    strictKeys(input, ['snapshotId', 'capture', 'cursor', 'limit']);
    if (input.capture !== undefined && typeof input.capture !== 'boolean') throw new BadRequestException({ code: 'INVALID_INPUT', field: 'capture' });
    let snapshot: Snapshot;
    if (input.snapshotId) {
      if (input.capture) throw new BadRequestException({ code: 'AMBIGUOUS_SNAPSHOT_REQUEST' });
      snapshot = await this.loadSnapshot(tx, ctx, idField(input, 'snapshotId'));
    } else {
      if (input.capture !== true || input.cursor) throw new BadRequestException({ code: 'EXPLICIT_SNAPSHOT_CAPTURE_REQUIRED' });
      const tree = await this.liveTree(tx, ctx);
      if (tree.entries.reduce((n, e) => n + (e.textSize || 0), 0) > 32 * 1024 * 1024) throw new BadRequestException({ code: 'SNAPSHOT_TEXT_LIMIT', maxBytes: 32 * 1024 * 1024 });
      const existing = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM docgrid.dg_astra_snapshots WHERE project_id=${ctx.projectId}::uuid AND grant_id=${ctx.grantId}::uuid AND tree_revision=${tree.revision} LIMIT 1`;
      if (existing[0]) {
        snapshot = await this.loadSnapshot(tx, ctx, existing[0].id);
        await this.event(tx, ctx, 'astra.snapshot.reused', { snapshotId: snapshot.id });
      } else {
      const retained = await tx.$queryRaw<Array<{ snapshots: number; bytes: string }>>`SELECT
        (SELECT count(*)::int FROM docgrid.dg_astra_snapshots WHERE project_id=${ctx.projectId}::uuid) AS snapshots,
        COALESCE(sum(octet_length(s.content)),0)::text AS bytes FROM docgrid.dg_astra_snapshot_sources s
        JOIN docgrid.dg_astra_snapshots p ON p.id=s.snapshot_id WHERE p.project_id=${ctx.projectId}::uuid`;
      const nextBytes = tree.entries.reduce((n, e) => n + (e.textSize || 0), 0);
      if (retained[0].snapshots >= 64 || Number(retained[0].bytes) + nextBytes > 128 * 1024 * 1024) throw new BadRequestException({ code: 'SNAPSHOT_RETENTION_LIMIT', maxSnapshots: 64, maxTextBytes: 128 * 1024 * 1024 });
      const rows = await tx.$queryRaw<Snapshot[]>`INSERT INTO docgrid.dg_astra_snapshots(project_id,grant_id,tree_revision,manifest,cursor_secret)
        VALUES(${ctx.projectId}::uuid,${ctx.grantId}::uuid,${tree.revision},${JSON.stringify({ entries: tree.entries, relations: tree.relations })}::jsonb,${randomBytes(32).toString('hex')})
        RETURNING id,project_id AS "projectId",grant_id AS "grantId",tree_revision AS "treeRevision",manifest,cursor_secret AS "cursorSecret",created_at AS "createdAt"`;
      snapshot = rows[0];
      for (const entry of tree.entries.filter(e => e.kind !== 'folder')) {
        const source = await this.captureSource(tx, ctx, entry);
        await tx.$executeRaw`INSERT INTO docgrid.dg_astra_snapshot_sources(snapshot_id,source_id,kind,version,hash,extraction_revision,status,title,path,mime,byte_size,content,warnings)
          VALUES(${snapshot.id}::uuid,${entry.id}::uuid,${source.kind},${source.version},${source.hash},${source.extractionRevision},${source.status},${source.title},${source.path},${source.mime},${source.byteSize},${source.content},${JSON.stringify(source.warnings)}::jsonb)`;
      }
      await this.event(tx, ctx, 'astra.snapshot.captured', { snapshotId: snapshot.id, treeRevision: tree.revision, sources: tree.entries.filter(e => e.kind !== 'folder').length });
      }
    }
    const limit = boundedInt(input, 'limit', 100, 1, 200);
    const bind = this.binding(ctx, snapshot, 'manifest', { limit });
    const offset = input.cursor ? readCursor(snapshot.cursorSecret, bind, input.cursor) : 0;
    const allowed = ctx.allowedSourceIds === null ? null : JSON.stringify(ctx.allowedSourceIds);
    const sources = await tx.$queryRaw<any[]>`SELECT source_id AS "sourceId",kind,version,hash,extraction_revision AS "extractionRevision",status,title,path,mime,
      byte_size::text AS "byteSize",length(content)::int AS "extractedCodePoints",warnings FROM docgrid.dg_astra_snapshot_sources
      WHERE snapshot_id=${snapshot.id}::uuid AND (${allowed}::jsonb IS NULL OR source_id::text IN (SELECT jsonb_array_elements_text(${allowed}::jsonb))) ORDER BY source_id LIMIT ${limit + 1} OFFSET ${offset}`;
    const more = sources.length > limit;
    return { output: { snapshotId: snapshot.id, treeRevision: snapshot.treeRevision, createdAt: snapshot.createdAt,
      manifest: sources.slice(0, limit).map(s => ({ ...s, sourceRef: { snapshotId: snapshot.id, sourceId: s.sourceId, version: s.version, hash: s.hash }, sourceIntegrity: 'verified_at_capture' })),
      truncated: more, continuation: more ? makeCursor(snapshot.cursorSecret, bind, offset + limit) : null,
      stages: { captured: true, delivered: 'manifest_only', understood: false } } };
  }

  private async captureSource(tx: AstraDb, ctx: AstraContext, entry: Entry): Promise<Source> {
    scopeSource(ctx.allowedSourceIds, entry.id);
    if (entry.kind === 'material') {
      const rows = await tx.$queryRaw<any[]>`SELECT sha256,bytes,storage_key,byte_size,extracted_text AS content,extraction_status AS status,mime FROM docgrid.docgrid_materials
        WHERE id=${entry.id}::uuid AND project_id=${ctx.projectId}::uuid AND deleted_at IS NULL`;
      const row = rows[0];
      if (!row || row.sha256 !== entry.version) throw new ConflictException({ code: 'SOURCE_INTEGRITY_FAILED', sourceId: entry.id });
      await readMaterialBytes(row, this.materialStorage);
      const status = ['READY', 'PARTIAL', 'UNREAD', 'FAILED'].includes(row.status) ? row.status : 'UNREAD';
      const content = ['READY', 'PARTIAL'].includes(status) ? row.content : '';
      return { sourceId: entry.id, kind: 'material', version: row.sha256, hash: row.sha256, extractionRevision: sha256(content),
        status, title: entry.title, path: entry.path, mime: row.mime, byteSize: entry.size, content,
        warnings: [ ...(status === 'PARTIAL' ? ['Existing extraction is incomplete; continuation covers extracted text only'] : []),
          ...(['UNREAD', 'FAILED'].includes(status) ? ['No readable extraction; original remains unchanged'] : []),
          'Legacy extractor supplies text offsets only; PDF page, DOCX paragraph and sheet/cell locators are unavailable' ] };
    }
    if (entry.kind === 'artifact') {
      const rows = await tx.$queryRaw<any[]>`SELECT v.plain_text AS content FROM docgrid.document_versions v JOIN docgrid.dg_astra_documents b ON b.document_id=v.document_id
        WHERE b.project_id=${ctx.projectId}::uuid AND v.document_id=${entry.id}::uuid AND v.version=${Number(entry.version)}`;
      if (!rows[0]) throw new ConflictException({ code: 'SOURCE_VERSION_MISSING', sourceId: entry.id });
      const content = rows[0].content, hash = sha256(content);
      if (hash !== entry.hash) throw new ConflictException({ code: 'SOURCE_INTEGRITY_FAILED', sourceId: entry.id });
      return { sourceId: entry.id, kind: 'artifact', version: entry.version, hash, extractionRevision: hash, status: 'READY', title: entry.title, path: entry.path, mime: 'text/plain; charset=utf-8', byteSize: Buffer.byteLength(content), content, warnings: [] };
    }
    const rows = await tx.$queryRaw<any[]>`SELECT v.content FROM docgrid.workspace_document_versions v JOIN docgrid.workspace_documents d ON d.id=v.document_id
      WHERE d.id=${entry.id}::uuid AND d.project_id=${ctx.projectId}::uuid AND d.docgrid_deleted_at IS NULL AND v.version=${Number(entry.version)}`;
    if (!rows[0]) throw new ConflictException({ code: 'SOURCE_VERSION_MISSING', sourceId: entry.id });
    const content = rows[0].content;
    const hash = sha256(content);
    if (hash !== entry.hash) throw new ConflictException({ code: 'SOURCE_INTEGRITY_FAILED', sourceId: entry.id });
    return { sourceId: entry.id, kind: 'document', version: entry.version, hash, extractionRevision: hash, status: 'READY', title: entry.title, path: entry.path,
      mime: 'text/plain; charset=utf-8', byteSize: Buffer.byteLength(content), content, warnings: [] };
  }

  private async source(tx: AstraDb, ctx: AstraContext, snapshotId: string, sourceId: string): Promise<Source> {
    scopeSource(ctx.allowedSourceIds, sourceId);
    const rows = await tx.$queryRaw<Source[]>`SELECT source_id AS "sourceId",kind,version,hash,extraction_revision AS "extractionRevision",status,title,path,mime,byte_size::int AS "byteSize",content,warnings
      FROM docgrid.dg_astra_snapshot_sources s JOIN docgrid.dg_astra_snapshots p ON p.id=s.snapshot_id
      WHERE s.snapshot_id=${snapshotId}::uuid AND s.source_id=${sourceId}::uuid AND p.project_id=${ctx.projectId}::uuid `;
    if (!rows[0]) throw new NotFoundException({ code: 'SOURCE_NOT_FOUND' });
    return rows[0];
  }

  async validateSourceRefs(tx: AstraDb, ctx: AstraContext, snapshotId: string, refs: unknown): Promise<AstraSourceRef[]> {
    idField({ snapshotId }, 'snapshotId');
    await this.loadSnapshot(tx, ctx, snapshotId);
    if (!Array.isArray(refs) || refs.length > 100) throw new BadRequestException({ code: 'INVALID_SOURCE_REFS' });
    const out: AstraSourceRef[] = [];
    for (const ref of refs) {
      strictKeys(ref, ['snapshotId', 'sourceId', 'version', 'hash', 'locator']);
      if (ref.snapshotId !== snapshotId) throw new BadRequestException({ code: 'SOURCE_SNAPSHOT_MISMATCH' });
      const sourceId = idField(ref, 'sourceId');
      const source = await this.source(tx, ctx, snapshotId, sourceId);
      if (ref.version !== source.version || ref.hash !== source.hash) throw new ConflictException({ code: 'SOURCE_VERSION_MISMATCH' });
      const result: AstraSourceRef = { snapshotId, sourceId, version: source.version, hash: source.hash };
      if (ref.locator !== undefined) {
        strictKeys(ref.locator, ['kind', 'unit', 'start', 'end']);
        if (ref.locator.kind !== 'text_range' || ref.locator.unit !== 'utf16') throw new BadRequestException({ code: 'UNSUPPORTED_LOCATOR' });
        const start = boundedInt(ref.locator, 'start', -1, 0, source.content.length);
        const end = boundedInt(ref.locator, 'end', -1, start, source.content.length);
        if (!['READY', 'PARTIAL'].includes(source.status)) throw new BadRequestException({ code: 'SOURCE_UNREAD' });
        result.locator = { kind: 'text_range', unit: 'utf16', start, end };
      }
      out.push(result);
    }
    return out;
  }

  async getOriginal(tx: AstraDb, ctx: AstraContext, rawRef: unknown): Promise<{ bytes: Buffer; mime: string; fileName: string }> {
    strictKeys(rawRef, ['snapshotId', 'sourceId', 'version', 'hash']);
    const snapshotId = idField(rawRef, 'snapshotId');
    const [ref] = await this.validateSourceRefs(tx, ctx, snapshotId, [rawRef]);
    const source = await this.source(tx, ctx, snapshotId, ref.sourceId);
    if (source.kind !== 'material') throw new BadRequestException({ code: 'UNSUPPORTED', message: 'Original byte access applies to uploaded materials; use version export for canonical documents' });
    const maxBytes = 32 * 1024 * 1024;
    if (source.byteSize > maxBytes) throw new BadRequestException({ code: 'SOURCE_ORIGINAL_SIZE_LIMIT', maxBytes });
    const rows = await tx.$queryRaw<any[]>`SELECT bytes,storage_key,byte_size,sha256,sha256::text AS hash FROM docgrid.docgrid_materials
      WHERE id=${ref.sourceId}::uuid AND project_id=${ctx.projectId}::uuid AND deleted_at IS NULL AND byte_size<=${maxBytes}`;
    const row = rows[0];
    if (!row) throw new NotFoundException({ code: 'SOURCE_ORIGINAL_NOT_FOUND' });
    const bytes = await readMaterialBytes(row, this.materialStorage);
    if (bytes.length > maxBytes || bytes.length !== source.byteSize || row.hash !== ref.hash || ref.version !== ref.hash || sha256(bytes) !== ref.hash) {
      throw new ConflictException({ code: 'SOURCE_INTEGRITY_FAILED', sourceId: ref.sourceId });
    }
    return { bytes, mime: source.mime, fileName: source.title };
  }

  private async originalMetadata(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>) {
    strictKeys(input, ['sourceRef']);
    const original = await this.getOriginal(tx, ctx, input.sourceRef);
    const ref = input.sourceRef as AstraSourceRef;
    const source = await this.source(tx, ctx, ref.snapshotId, ref.sourceId);
    return { output: { sourceRef: ref, fileName: original.fileName, mime: original.mime, size: original.bytes.length, hash: ref.hash,
      status: source.status, sourceIntegrity: 'verified', stages: { originalAvailable: true, extraction: source.status, understood: false },
      url: `/api/docgrid/astra/sources/${ref.sourceId}/original?projectId=${ctx.projectId}&snapshotId=${ref.snapshotId}&hash=${ref.hash}`,
      authorization: 'Requires a fresh authorized DocGrid grant with docgrid_get_source_original permission; URL contains no credentials', maxBytes: 32 * 1024 * 1024 } };
  }

  private async read(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>) {
    strictKeys(input, ['sourceRef', 'cursor', 'maxChars', 'start']);
    strictKeys(input.sourceRef, ['snapshotId', 'sourceId', 'version', 'hash']);
    const snapshotId = idField(input.sourceRef, 'snapshotId');
    const [ref] = await this.validateSourceRefs(tx, ctx, snapshotId, [input.sourceRef]);
    const snapshot = await this.loadSnapshot(tx, ctx, snapshotId);
    const source = await this.source(tx, ctx, snapshotId, ref.sourceId);
    const maxChars = boundedInt(input, 'maxChars', 8000, 2, 20000);
    if (input.cursor && input.start !== undefined) throw new BadRequestException({ code: 'AMBIGUOUS_LOCATOR' });
    const binding = this.binding(ctx, snapshot, 'read', { sourceId: source.sourceId, version: source.version, hash: source.hash, extractionRevision: source.extractionRevision, maxChars });
    const start = input.cursor ? readCursor(snapshot.cursorSecret, binding, input.cursor) : boundedInt(input, 'start', 0, 0, source.content.length);
    const part = sliceSource(source.content, start, maxChars);
    return { output: { ...part, sourceRef: ref, status: source.status, hash: source.hash, extractionRevision: source.extractionRevision,
      extractionMethod: source.kind !== 'material' ? 'workspace-version-text' : 'legacy-stored-extraction', warnings: source.warnings,
      continuation: part.truncated ? makeCursor(snapshot.cursorSecret, binding, part.locator.end) : null,
      coverage: { unit: 'utf16', deliveredStart: start, deliveredEnd: part.locator.end, extractedCharacters: source.content.length, sourceComplete: source.status === 'READY', understood: false },
      untrustedContent: true } };
  }

  private async search(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>) {
    strictKeys(input, ['snapshotId', 'query', 'mode', 'sourceIds', 'cursor', 'limit']);
    const snapshot = await this.loadSnapshot(tx, ctx, idField(input, 'snapshotId'));
    const query = textField(input, 'query', 200);
    const mode = input.mode === undefined ? 'fulltext' : input.mode;
    if (!['fulltext', 'filename'].includes(mode as string)) throw new BadRequestException({ code: 'INVALID_SEARCH_MODE' });
    let sourceIds: string[] | null = ctx.allowedSourceIds;
    if (input.sourceIds !== undefined) {
      if (!Array.isArray(input.sourceIds) || input.sourceIds.length > 100) throw new BadRequestException({ code: 'INVALID_SOURCE_SCOPE' });
      sourceIds = input.sourceIds.map(sourceId => idField({ sourceId }, 'sourceId'));
      for (const id of sourceIds) { scopeSource(ctx.allowedSourceIds, id); await this.source(tx, ctx, snapshot.id, id); }
    }
    const limit = boundedInt(input, 'limit', 20, 1, 50);
    const binding = this.binding(ctx, snapshot, 'search', { query, mode, sourceIds, limit });
    const offset = input.cursor ? readCursor(snapshot.cursorSecret, binding, input.cursor) : 0;
    const scope = sourceIds === null ? null : JSON.stringify(sourceIds);
    // Literal substring search, not SQL wildcard interpretation. One bounded hit per source.
    const rows = await tx.$queryRaw<any[]>`SELECT source_id AS "sourceId",version,hash,status,title,content,extraction_revision AS "extractionRevision"
      FROM docgrid.dg_astra_snapshot_sources WHERE snapshot_id=${snapshot.id}::uuid AND
      (${scope}::jsonb IS NULL OR source_id::text IN (SELECT jsonb_array_elements_text(${scope}::jsonb))) AND
      ((${mode}='filename' AND position(lower(${query}) in lower(title))>0) OR (${mode}='fulltext' AND status IN ('READY','PARTIAL') AND position(lower(${query}) in lower(content))>0))
      ORDER BY source_id LIMIT ${limit + 1} OFFSET ${offset}`;
    const stats = await tx.$queryRaw<any[]>`SELECT status,count(*)::int AS count FROM docgrid.dg_astra_snapshot_sources WHERE snapshot_id=${snapshot.id}::uuid AND
      (${scope}::jsonb IS NULL OR source_id::text IN (SELECT jsonb_array_elements_text(${scope}::jsonb))) GROUP BY status`;
    const complete = !stats.some(s => s.status !== 'READY');
    return { output: { mode, algorithm: 'literal-substring-v1', snapshotId: snapshot.id, scope: sourceIds, index: { complete, statuses: stats, coverage: 'stored extraction only', zeroResultsProveAbsence: false },
      matches: rows.slice(0, limit).map(s => {
        const value = mode === 'filename' ? s.title : s.content;
        const position = value.toLowerCase().indexOf(query.toLowerCase());
        const snippet = sliceSource(value, Math.max(0, position - 100), 500);
        return { sourceRef: { snapshotId: snapshot.id, sourceId: s.sourceId, version: s.version, hash: s.hash }, title: s.title, status: s.status,
          snippet: snippet.text, locator: mode === 'filename' ? { kind: 'filename' } : snippet.locator, untrustedContent: true };
      }), truncated: rows.length > limit, continuation: rows.length > limit ? makeCursor(snapshot.cursorSecret, binding, offset + limit) : null } };
  }

  private async history(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>) {
    strictKeys(input, ['snapshotId', 'sourceId', 'beforeVersion', 'limit']);
    const snapshot = await this.loadSnapshot(tx, ctx, idField(input, 'snapshotId'));
    const source = await this.source(tx, ctx, snapshot.id, idField(input, 'sourceId'));
    if (source.kind === 'material') return { output: { sourceId: source.sourceId, versions: [{ version: source.version, hash: source.hash }], immutableOriginal: true, truncated: false } };
    const limit = boundedInt(input, 'limit', 20, 1, 50);
    const before = boundedInt(input, 'beforeVersion', Number(source.version) + 1, 1, Number(source.version) + 1);
    const rows = source.kind === 'artifact' ? await tx.$queryRaw<any[]>`SELECT v.version,v.change_request AS message,v.created_at AS "createdAt",v.plain_text AS content FROM docgrid.document_versions v
      JOIN docgrid.dg_astra_documents b ON b.document_id=v.document_id WHERE b.document_id=${source.sourceId}::uuid AND b.project_id=${ctx.projectId}::uuid
      AND v.version<${before} ORDER BY v.version DESC LIMIT ${limit + 1}` : await tx.$queryRaw<any[]>`SELECT v.version,v.message,v.created_at AS "createdAt",v.content FROM docgrid.workspace_document_versions v
      JOIN docgrid.workspace_documents d ON d.id=v.document_id WHERE d.id=${source.sourceId}::uuid AND d.project_id=${ctx.projectId}::uuid
      AND v.version<${before} ORDER BY v.version DESC LIMIT ${limit + 1}`;
    return { output: { sourceId: source.sourceId, snapshotId: snapshot.id, versions: rows.slice(0, limit).map(({ content, ...row }) => ({ ...row, version: String(row.version), hash: sha256(content) })),
      truncated: rows.length > limit, nextBeforeVersion: rows.length > limit ? rows[limit - 1].version : null } };
  }

  private async compare(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>) {
    strictKeys(input, ['beforeRef', 'afterRef', 'maxChars']);
    const sources: Source[] = [];
    for (const field of ['beforeRef', 'afterRef']) {
      strictKeys(input[field], ['snapshotId', 'sourceId', 'version', 'hash']);
      const ref = input[field] as Record<string, unknown>;
      const snapshotId = idField(ref, 'snapshotId');
      const [validated] = await this.validateSourceRefs(tx, ctx, snapshotId, [ref]);
      sources.push(await this.source(tx, ctx, snapshotId, validated.sourceId));
    }
    if (sources[0].sourceId !== sources[1].sourceId) throw new BadRequestException({ code: 'DIFFERENT_SOURCES' });
    if (sources.some(s => s.status !== 'READY')) throw new BadRequestException({ code: 'INCOMPLETE_EXTRACTION', message: 'Complete comparison requires two readable complete sources' });
    const maxChars = boundedInt(input, 'maxChars', 8000, 2, 20000);
    const [before, after] = sources.map(s => s.content);
    let start = 0;
    while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
    let end = 0;
    while (end < Math.min(before.length, after.length) - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
    const removed = before.slice(start, before.length - end), added = after.slice(start, after.length - end);
    return { output: { beforeRef: input.beforeRef, afterRef: input.afterRef, equal: before === after,
      diff: { kind: 'single-replacement', unit: 'utf16', start, beforeEnd: before.length - end, afterEnd: after.length - end,
        removed: removed.slice(0, maxChars), added: added.slice(0, maxChars), removedHash: sha256(removed), addedHash: sha256(added) },
      truncated: removed.length > maxChars || added.length > maxChars, nextAction: 'Use read_source for complete version text and continuation' } };
  }

  private structureDiff(ctx: AstraContext, entries: Entry[], raw: unknown) {
    if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new BadRequestException({ code: 'INVALID_STRUCTURE_CHANGES' });
    const state = entries.map(e => ({ ...e }));
    const changes: StructureChange[] = [], inverse: StructureChange[] = [], diff: unknown[] = [];
    for (const value of raw) {
      strictKeys(value, ['action', 'sourceId', 'path', 'title']);
      const action = value.action;
      if (action === 'move_source' || action === 'rename_source') {
        if ((action === 'move_source' && value.title !== undefined) || (action === 'rename_source' && value.path !== undefined)) throw new BadRequestException({ code: 'INVALID_STRUCTURE_CHANGE' });
        const sourceId = idField(value, 'sourceId'); scopeSource(ctx.allowedSourceIds, sourceId);
        const entry = state.find(e => e.id === sourceId && e.kind !== 'folder');
        if (!entry) throw new NotFoundException({ code: 'SOURCE_NOT_FOUND' });
        if (action === 'move_source') {
          const path = normalizedPath(value.path);
          if (path !== '/' && !state.some(e => e.kind === 'folder' && e.path === path)) throw new BadRequestException({ code: 'DESTINATION_FOLDER_MISSING' });
          changes.push({ action, sourceId, path }); inverse.unshift({ action, sourceId, path: entry.path });
          diff.push({ action, sourceId, from: entry.path, to: path }); entry.path = path;
        } else {
          const title = textField(value, 'title', 180);
          if (/[\x00-\x1f/\\]/.test(title) || !title.trim()) throw new BadRequestException({ code: 'INVALID_TITLE' });
          changes.push({ action, sourceId, title }); inverse.unshift({ action, sourceId, title: entry.title });
          diff.push({ action, sourceId, from: entry.title, to: title }); entry.title = title;
        }
      } else if (action === 'create_folder' || action === 'remove_empty_folder') {
        if (ctx.allowedSourceIds !== null) throw new BadRequestException({ code: 'PROJECT_SCOPE_REQUIRED_FOR_FOLDERS' });
        if (value.sourceId !== undefined || value.title !== undefined) throw new BadRequestException({ code: 'INVALID_STRUCTURE_CHANGE' });
        const path = normalizedPath(value.path);
        if (path === '/') throw new BadRequestException({ code: 'ROOT_FOLDER_IMMUTABLE' });
        const existing = state.find(e => e.kind === 'folder' && e.path === path);
        if (action === 'create_folder') {
          if (existing) throw new ConflictException({ code: 'FOLDER_ALREADY_EXISTS' });
          state.push({ id: `proposal:${path}`, kind: 'folder', title: '', path, version: '', hash: null, size: 0 });
          inverse.unshift({ action: 'remove_empty_folder', path });
        } else {
          if (!existing) throw new NotFoundException({ code: 'FOLDER_NOT_FOUND' });
          if (state.some(e => e !== existing && (e.path === path || e.path.startsWith(path + '/')))) throw new ConflictException({ code: 'FOLDER_NOT_EMPTY' });
          state.splice(state.indexOf(existing), 1); inverse.unshift({ action: 'create_folder', path });
        }
        changes.push({ action, path }); diff.push({ action, path });
      } else throw new BadRequestException({ code: 'UNSUPPORTED_STRUCTURE_CHANGE' });
    }
    return { changes, inverse, diff };
  }

  private async proposeStructure(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>): Promise<AstraDomainResult> {
    strictKeys(input, ['baseTreeRevision', 'changes']);
    const tree = await this.liveTree(tx, ctx); assertRevision(tree.revision, input.baseTreeRevision);
    const proposal = this.structureDiff(ctx, tree.entries, input.changes);
    return { status: 'needs_user_action', nextAction: 'Human approval of this exact structure proposal is required',
      output: { kind: 'structure', status: 'PROPOSED', baseTreeRevision: tree.revision, diff: proposal.diff, rollbackChanges: proposal.inverse },
      approval: { kind: 'structure', baseTreeRevision: tree.revision, changes: proposal.changes, inverse: proposal.inverse, diff: proposal.diff } };
  }

  private async proposeRelation(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>): Promise<AstraDomainResult> {
    strictKeys(input, ['baseTreeRevision', 'fromRef', 'toRef', 'type', 'basis', 'relationId', 'action']);
    const tree = await this.liveTree(tx, ctx); assertRevision(tree.revision, input.baseTreeRevision);
    if (input.action === 'reject') {
      if (['fromRef', 'toRef', 'type', 'basis'].some(k => input[k] !== undefined)) throw new BadRequestException({ code: 'INVALID_RELATION_CHANGE' });
      const relationId = idField(input, 'relationId');
      const relation: any = tree.relations.find(r => r.id === relationId);
      if (!relation || relation.status !== 'CONFIRMED') throw new NotFoundException({ code: 'CONFIRMED_RELATION_NOT_FOUND' });
      return { status: 'needs_user_action', nextAction: 'Human approval required', output: { kind: 'relation', status: 'PROPOSED', action: 'reject', relationId },
        approval: { kind: 'relation_reject', relationId, baseTreeRevision: tree.revision } };
    }
    if ((input.action !== undefined && input.action !== 'create') || input.relationId !== undefined) throw new BadRequestException({ code: 'UNSUPPORTED_RELATION_CHANGE' });
    const refs: AstraSourceRef[] = [];
    for (const key of ['fromRef', 'toRef']) {
      strictKeys(input[key], ['snapshotId', 'sourceId', 'version', 'hash', 'locator']);
      const ref = input[key] as Record<string, unknown>;
      refs.push((await this.validateSourceRefs(tx, ctx, idField(ref, 'snapshotId'), [ref]))[0]);
    }
    const relation = { fromRef: refs[0], toRef: refs[1], type: textField(input, 'type', 80), basis: textField(input, 'basis', 4000) };
    return { status: 'needs_user_action', nextAction: 'Human approval required; model confidence does not confirm a relation',
      output: { ...relation, status: 'PROPOSED', baseTreeRevision: tree.revision },
      approval: { kind: 'relation', ...relation, baseTreeRevision: tree.revision } };
  }

  async approve(tx: AstraDb, ctx: AstraContext, operation: AstraOperation, _input: Record<string, unknown>): Promise<AstraDomainResult> {
    const proposal = operation.approval as any;
    if (!proposal || !['structure', 'relation', 'relation_reject'].includes(proposal.kind)) throw new BadRequestException({ code: 'UNSUPPORTED_APPROVAL' });
    const tree = await this.liveTree(tx, ctx); assertRevision(tree.revision, proposal.baseTreeRevision);
    if (proposal.kind === 'structure') {
      const validated = this.structureDiff(ctx, tree.entries, proposal.changes);
      for (const change of validated.changes) {
        if (change.action === 'create_folder') await tx.$executeRaw`INSERT INTO docgrid.docgrid_folders(project_id,path) VALUES(${ctx.projectId}::uuid,${change.path!})`;
        else if (change.action === 'remove_empty_folder') await tx.$executeRaw`DELETE FROM docgrid.docgrid_folders WHERE project_id=${ctx.projectId}::uuid AND path=${change.path!}`;
        else {
          const source = tree.entries.find(e => e.id === change.sourceId)!;
          if (source.kind === 'material') {
            if (change.action === 'move_source') await tx.$executeRaw`UPDATE docgrid.docgrid_materials SET path=${change.path!} WHERE id=${change.sourceId!}::uuid AND project_id=${ctx.projectId}::uuid`;
            else await tx.$executeRaw`UPDATE docgrid.docgrid_materials SET title=${change.title!} WHERE id=${change.sourceId!}::uuid AND project_id=${ctx.projectId}::uuid`;
          } else if (source.kind === 'artifact') {
            if (change.action === 'move_source') await tx.$executeRaw`UPDATE docgrid.dg_astra_documents SET path=${change.path!} WHERE document_id=${change.sourceId!}::uuid AND project_id=${ctx.projectId}::uuid`;
            else await tx.$executeRaw`UPDATE docgrid.prepared_legal_documents SET title=${change.title!} WHERE id=${change.sourceId!}::uuid AND EXISTS(SELECT 1 FROM docgrid.dg_astra_documents WHERE document_id=${change.sourceId!}::uuid AND project_id=${ctx.projectId}::uuid)`;
          } else {
            if (change.action === 'move_source') await tx.$executeRaw`UPDATE docgrid.workspace_documents SET path=${change.path!} WHERE id=${change.sourceId!}::uuid AND project_id=${ctx.projectId}::uuid`;
            else await tx.$executeRaw`UPDATE docgrid.workspace_documents SET title=${change.title!} WHERE id=${change.sourceId!}::uuid AND project_id=${ctx.projectId}::uuid`;
          }
        }
      }
      const after = await this.liveTree(tx, ctx);
      await this.event(tx, ctx, 'astra.structure.applied', { operationId: operation.id, diff: proposal.diff, baseTreeRevision: tree.revision, treeRevision: after.revision });
      return { output: { applied: true, diff: proposal.diff, treeRevision: after.revision, rollbackProposal: { baseTreeRevision: after.revision, changes: validated.inverse }, rollbackRequiresApproval: true } };
    }
    if (proposal.kind === 'relation_reject') {
      const relation = tree.relations.find(r => r.id === proposal.relationId);
      if (!relation) throw new NotFoundException({ code: 'RELATION_NOT_FOUND' });
      await tx.$executeRaw`UPDATE docgrid.dg_astra_relations SET status='REJECTED' WHERE id=${proposal.relationId}::uuid AND project_id=${ctx.projectId}::uuid AND status='CONFIRMED'`;
      await this.event(tx, ctx, 'astra.relation.rejected', { relationId: proposal.relationId });
      return { output: { relationId: proposal.relationId, status: 'REJECTED', treeRevision: (await this.liveTree(tx, ctx)).revision } };
    }
    for (const ref of [proposal.fromRef, proposal.toRef]) await this.validateSourceRefs(tx, ctx, ref.snapshotId, [ref]);
    const rows = await tx.$queryRaw<any[]>`INSERT INTO docgrid.dg_astra_relations(project_id,from_ref,to_ref,relation_type,basis,author_id,agent_ref,status,operation_id)
      VALUES(${ctx.projectId}::uuid,${JSON.stringify(proposal.fromRef)}::jsonb,${JSON.stringify(proposal.toRef)}::jsonb,${proposal.type},${proposal.basis},${ctx.humanActorId || ctx.ownerId},${ctx.agentRef},'CONFIRMED',${operation.id}::uuid) RETURNING id`;
    const after = await this.liveTree(tx, ctx);
    await this.event(tx, ctx, 'astra.relation.confirmed', { relationId: rows[0].id, operationId: operation.id });
    return { output: { relationId: rows[0].id, status: 'CONFIRMED', treeRevision: after.revision,
      rollbackProposal: { action: 'reject', relationId: rows[0].id, baseTreeRevision: after.revision }, rollbackRequiresApproval: true } };
  }

  private async calculate(tx: AstraDb, ctx: AstraContext, input: Record<string, unknown>) {
    strictKeys(input, ['rows', 'currency', 'unit', 'period', 'duplicatePolicy']);
    if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 100) throw new BadRequestException({ code: 'INVALID_CALCULATION_ROWS' });
    const currency = textField(input, 'currency', 12), unit = textField(input, 'unit', 50), period = textField(input, 'period', 100);
    const duplicatePolicy = input.duplicatePolicy ?? 'reject';
    if (!['reject', 'include'].includes(duplicatePolicy as string)) throw new BadRequestException({ code: 'INVALID_DUPLICATE_POLICY' });
    const rows: Array<{ sourceRef: AstraSourceRef; value: string }> = [], seen = new Set<string>();
    for (const row of input.rows) {
      strictKeys(row, ['sourceRef']); strictKeys(row.sourceRef, ['snapshotId', 'sourceId', 'version', 'hash', 'locator']);
      const [ref] = await this.validateSourceRefs(tx, ctx, idField(row.sourceRef, 'snapshotId'), [row.sourceRef]);
      if (!ref.locator || ref.locator.end <= ref.locator.start) throw new BadRequestException({ code: 'EXACT_AMOUNT_LOCATOR_REQUIRED' });
      const source = await this.source(tx, ctx, ref.snapshotId, ref.sourceId);
      if (source.status !== 'READY') throw new BadRequestException({ code: 'INCOMPLETE_CALCULATION_SOURCE' });
      const key = JSON.stringify([ref.sourceId, ref.version, ref.hash, ref.locator.start, ref.locator.end]);
      if (seen.has(key) && duplicatePolicy === 'reject') throw new BadRequestException({ code: 'DUPLICATE_SOURCE_ROW' });
      seen.add(key);
      const value = source.content.slice(ref.locator.start, ref.locator.end);
      // No locale guesses, OCR fixes, omitted values, floating point, or implicit zeroes.
      rows.push({ sourceRef: ref, value });
    }
    return { output: { rows, result: sumDecimals(rows.map(r => r.value)), formula: 'SUM(exact located decimal values)', currency, unit, period,
      rounding: 'none; input has at most two fraction digits, output uses two', duplicatePolicy, codeVersion: 'astra-decimal-sum-v1',
      completeness: 'Only the explicitly selected ranges; this tool does not discover table rows or establish currency/period from source text', inputDigest: sha256(JSON.stringify(rows)) } };
  }

  async cancel(_tx: AstraDb, _ctx: AstraContext, _operation: AstraOperation): Promise<void> {
    // Proposals are metadata in dg_astra_operations; no tree/relation mutation exists to undo.
  }

  private async event(tx: AstraDb, ctx: AstraContext, eventType: string, metadata: unknown) {
    await tx.$executeRaw`INSERT INTO docgrid.docgrid_events(project_id,actor_id,event_type,entity_type,entity_id,metadata)
      VALUES(${ctx.projectId}::uuid,${ctx.humanActorId || ctx.ownerId},${eventType},'repository',${ctx.projectId}::uuid,${JSON.stringify({ operationId: ctx.operationId, grantId: ctx.grantId, agentRef: ctx.agentRef, ...metadata as object })}::jsonb)`;
  }
}

const uuidSchema = { type: 'string', format: 'uuid' };
const sourceRefSchema = {
  type: 'object', additionalProperties: false, required: ['snapshotId', 'sourceId', 'version', 'hash'],
  properties: { snapshotId: uuidSchema, sourceId: uuidSchema, version: { type: 'string' }, hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    locator: { type: 'object', additionalProperties: false, required: ['kind', 'unit', 'start', 'end'], properties: {
      kind: { const: 'text_range' }, unit: { const: 'utf16' }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 },
    } } },
};
const sourceSchema = (description: string, properties: Record<string, unknown>, required: string[] = []) => ({ description,
  inputSchema: { type: 'object', additionalProperties: false, properties: { projectId: uuidSchema, ...properties }, required } });
const cursorSchema = { type: 'string', maxLength: 4096 };
const pageSchema = { type: 'integer', minimum: 1, maximum: 200, default: 100 };
export const ASTRA_SOURCE_SCHEMAS: Record<string, { description: string; inputSchema: unknown }> = {
  docgrid_get_project: sourceSchema('Read the current authorized project without creating branches or documents.', {}),
  docgrid_list_tree: sourceSchema('Unified source/document/artifact/folder tree. Supply a snapshotId for stable pagination; live truncated reads require explicit capture.', {
    snapshotId: uuidSchema, path: { type: 'string', maxLength: 500 }, cursor: cursorSchema, limit: pageSchema,
  }),
  docgrid_get_snapshot: sourceSchema('Read an immutable, scope-filtered manifest. To create one explicitly supply capture:true with no snapshotId; captures are audited writes.', {
    snapshotId: uuidSchema, capture: { type: 'boolean' }, cursor: cursorSchema, limit: pageSchema,
  }),
  docgrid_read_source: sourceSchema('Bounded untrusted source text, exact UTF-16 ranges and continuation. READY is extraction status, not model understanding. Native PDF/page and spreadsheet/cell locators are unavailable.', {
    sourceRef: sourceRefSchema, cursor: cursorSchema, maxChars: { type: 'integer', minimum: 2, maximum: 20000, default: 8000 }, start: { type: 'integer', minimum: 0 },
  }, ['sourceRef']),
  docgrid_get_source_original: sourceSchema('Retrieve a protected URL for the exact immutable uploaded original, including UNREAD formats. Original SHA-256 is rechecked; maximum 32 MiB. Canonical documents use version export instead.', { sourceRef: { ...sourceRefSchema, properties: { snapshotId: uuidSchema, sourceId: uuidSchema, version: { type: 'string' }, hash: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } }, ['sourceRef']),
  docgrid_search: sourceSchema('Literal substring search over pinned stored extraction or filenames; one bounded hit per source. Reports incomplete index coverage.', {
    snapshotId: uuidSchema, query: { type: 'string', minLength: 1, maxLength: 200 }, mode: { type: 'string', enum: ['fulltext', 'filename'], default: 'fulltext' },
    sourceIds: { type: 'array', maxItems: 100, items: uuidSchema }, cursor: cursorSchema, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  }, ['snapshotId', 'query']),
  docgrid_get_source_history: sourceSchema('List source versions no newer than the selected snapshot; original materials have one immutable version.', {
    snapshotId: uuidSchema, sourceId: uuidSchema, beforeVersion: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  }, ['snapshotId', 'sourceId']),
  docgrid_compare_source_versions: sourceSchema('Compare two pinned readable snapshots of the same source; bounded single-replacement diff with exact range and changed-text hashes.', {
    beforeRef: sourceRefSchema, afterRef: sourceRefSchema, maxChars: { type: 'integer', minimum: 2, maximum: 20000, default: 8000 },
  }, ['beforeRef', 'afterRef']),
  docgrid_propose_structure: sourceSchema('Prepare a human-approved tree diff and inverse operations. No content edits. Folder mutations require a project-wide grant.', {
    baseTreeRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, changes: { type: 'array', minItems: 1, maxItems: 100, items: {
      type: 'object', additionalProperties: false, required: ['action'], properties: { action: { enum: ['move_source', 'rename_source', 'create_folder', 'remove_empty_folder'] }, sourceId: uuidSchema, path: { type: 'string', maxLength: 500 }, title: { type: 'string', maxLength: 180 } },
    } },
  }, ['baseTreeRevision', 'changes']),
  docgrid_propose_relation: sourceSchema('Propose a version-bound relation with human confirmation; reject reverses a confirmed relation without deleting its history.', {
    baseTreeRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, action: { enum: ['create', 'reject'] }, relationId: uuidSchema,
    fromRef: sourceRefSchema, toRef: sourceRefSchema, type: { type: 'string', minLength: 1, maxLength: 80 }, basis: { type: 'string', minLength: 1, maxLength: 4000 },
  }, ['baseTreeRevision']),
  docgrid_calculate_sum: sourceSchema('Deterministic fixed decimal sum of exact selected source text ranges. Does not parse/discover tables. Rejects unread, unknown and duplicate inputs; outputs all source ranges and assumptions.', {
    rows: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['sourceRef'], properties: { sourceRef: sourceRefSchema } } },
    currency: { type: 'string', minLength: 1, maxLength: 12 }, unit: { type: 'string', minLength: 1, maxLength: 50 }, period: { type: 'string', minLength: 1, maxLength: 100 }, duplicatePolicy: { enum: ['reject', 'include'], default: 'reject' },
  }, ['rows', 'currency', 'unit', 'period']),
};

