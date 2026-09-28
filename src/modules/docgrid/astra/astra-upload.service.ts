import { DocGridMaterialStorageService } from '../docgrid-material-storage.service';
import { BadRequestException, ForbiddenException, Injectable, Optional, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { AstraContext, AstraDb, AstraDomainResult, assertKeys, objectInput, unsupported } from './astra.contracts';

export const ASTRA_UPLOAD_TOOLS = ['docgrid_upload_sources'] as const;
export const ASTRA_UPLOAD_LIMITS = {
  maxDecodedBytes: 600 * 1024, maxFiles: 64, maxFolders: 128,
  maxFolderDepth: 32, maxCreatedFolders: 512, maxExtractedCharacters: 200000,
  maxProjectBytes: 500 * 1024 * 1024, maxProjectEntries: 5000,
} as const;

type ExtractionStatus = 'READY' | 'PARTIAL' | 'UNREAD' | 'FAILED';
type PreparedFile = { index: number; name: string; path: string; mimeType: string; bytes: Buffer; hash: string; text: string; status: ExtractionStatus; warnings: string[] };
type ItemError = { kind: 'file' | 'folder'; index: number; code: string; message: string; name?: string; path?: string };
type Material = { id: string; sha256: string; mimeType: string; extractionStatus: ExtractionStatus; textCharacters: number; byteSize: number };
class UploadInputError extends Error { constructor(readonly code: string, message: string) { super(message); } }

const forbiddenNameCharacters = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\/]/;
function component(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new UploadInputError('INVALID_PATH', `${label} must be a string`);
  const result = value.normalize('NFC').trim();
  // Reject invalid UTF-16 rather than silently changing its bytes during JSON/SQL transport.
  if (!result || result.length > 180 || result === '.' || result === '..' || forbiddenNameCharacters.test(result) || Buffer.from(result).toString('utf8') !== result) {
    throw new UploadInputError('INVALID_PATH', `${label} must contain 1–180 characters without separators, traversal or controls`);
  }
  return result;
}
function uploadPath(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 500 || /\\/.test(value)) throw new UploadInputError('INVALID_PATH', 'path must be a folder path of 1–500 characters');
  const parts = value.split('/').filter(Boolean).map(p => component(p, 'Folder name'));
  if (parts.length > ASTRA_UPLOAD_LIMITS.maxFolderDepth) throw new UploadInputError('PATH_TOO_DEEP', 'At most 32 folder levels are supported');
  const path = '/' + parts.join('/');
  if (path.length > 500) throw new UploadInputError('INVALID_PATH', 'Normalized path exceeds 500 characters');
  return path;
}
function ancestors(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, i) => '/' + parts.slice(0, i + 1).join('/'));
}
function prepareFile(value: unknown, index: number): PreparedFile {
  const row = objectInput(value); assertKeys(row, ['name', 'path', 'mimeType', 'contentBase64']);
  const name = component(row.name, 'File name'), path = uploadPath(row.path);
  if (typeof row.mimeType !== 'string' || row.mimeType.length > 150 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]+)?$/i.test(row.mimeType)) {
    throw new UploadInputError('INVALID_MIME_TYPE', 'mimeType must be a MIME type of at most 150 characters');
  }
  const base64 = row.contentBase64;
  if (typeof base64 !== 'string' || base64.length > 4 * Math.ceil(ASTRA_UPLOAD_LIMITS.maxDecodedBytes / 3) || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new UploadInputError('INVALID_BASE64', 'contentBase64 must be canonical base64 within the 600 KiB decoded batch limit');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) throw new UploadInputError('EMPTY_FILE', 'Empty files cannot provide a readable original');
  if (bytes.toString('base64') !== base64) throw new UploadInputError('INVALID_BASE64', 'contentBase64 is not canonical base64');
  let text = '', status: ExtractionStatus = 'UNREAD'; const warnings: string[] = [];
  if (/\.(txt|md)$/i.test(name)) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
        text = ''; warnings.push('NO_READABLE_TEXT: original retained; text is empty or contains binary controls');
      } else {
        status = 'READY';
        if (text.length > ASTRA_UPLOAD_LIMITS.maxExtractedCharacters) {
          let end = ASTRA_UPLOAD_LIMITS.maxExtractedCharacters;
          if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
          text = text.slice(0, end); status = 'PARTIAL';
          warnings.push('EXTRACTION_TRUNCATED: only the first 200000 UTF-16 characters are available for reading');
        }
      }
    } catch { text = ''; warnings.push('INVALID_UTF8: original retained without a readable extraction'); }
  } else warnings.push('UNSUPPORTED_EXTRACTION: original retained; this upload tool does not parse PDF, DOCX, images, spreadsheets or other formats');
  return { index, name, path, mimeType: row.mimeType, bytes, hash: createHash('sha256').update(bytes).digest('hex'), text, status, warnings };
}

@Injectable()
export class AstraUploadService {
  constructor(@Optional() private readonly materialStorage?: DocGridMaterialStorageService) {}
  async execute(tx: AstraDb, ctx: AstraContext, tool: string, input: Record<string, unknown>): Promise<AstraDomainResult> {
    if (tool !== 'docgrid_upload_sources') unsupported(tool);
    if (ctx.allowedSourceIds !== null) throw new ForbiddenException({ code: 'PROJECT_WIDE_WRITE_GRANT_REQUIRED' });
    assertKeys(input, ['files', 'folders']);
    if (!Array.isArray(input.files) || input.files.length > ASTRA_UPLOAD_LIMITS.maxFiles) throw new BadRequestException({ code: 'INVALID_FILES', maxFiles: ASTRA_UPLOAD_LIMITS.maxFiles });
    if (input.folders !== undefined && (!Array.isArray(input.folders) || input.folders.length > ASTRA_UPLOAD_LIMITS.maxFolders)) throw new BadRequestException({ code: 'INVALID_FOLDERS', maxFolders: ASTRA_UPLOAD_LIMITS.maxFolders });
    const rawFolders = (input.folders || []) as unknown[];
    if (!input.files.length && !rawFolders.length) throw new BadRequestException({ code: 'EMPTY_UPLOAD' });
    const files: PreparedFile[] = [], errors: ItemError[] = [], requestedFolders: Array<{ index: number; path: string }> = [];
    input.files.forEach((value, index) => {
      try { files.push(prepareFile(value, index)); }
      catch (error) { errors.push({ kind: 'file', index, code: error instanceof UploadInputError ? error.code : 'INVALID_FILE', message: error instanceof Error ? error.message : 'Invalid file' }); }
    });
    rawFolders.forEach((value, index) => {
      try { requestedFolders.push({ index, path: uploadPath(value) }); }
      catch (error) { errors.push({ kind: 'folder', index, code: error instanceof UploadInputError ? error.code : 'INVALID_FOLDER', message: error instanceof Error ? error.message : 'Invalid folder' }); }
    });
    const decodedBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
    if (decodedBytes > ASTRA_UPLOAD_LIMITS.maxDecodedBytes) throw new BadRequestException({ code: 'UPLOAD_LIMIT_EXCEEDED', maxDecodedBytes: ASTRA_UPLOAD_LIMITS.maxDecodedBytes });
    const possibleFolders = new Set([...files, ...requestedFolders].flatMap(file => ancestors(file.path)));
    if (possibleFolders.size > ASTRA_UPLOAD_LIMITS.maxCreatedFolders) throw new BadRequestException({ code: 'FOLDER_LIMIT_EXCEEDED', maxCreatedFolders: ASTRA_UPLOAD_LIMITS.maxCreatedFolders });

    // Uses the caller's existing transaction; the project lock also serializes legacy uploads.
    const project = await tx.$queryRaw<Array<{ id: string }>>`SELECT p.id FROM docgrid.workspace_projects p WHERE p.id=${ctx.projectId}::uuid
      AND (p.owner_id=${ctx.ownerId} OR EXISTS(SELECT 1 FROM docgrid.docgrid_members m WHERE m.project_id=p.id AND m.user_id=${ctx.ownerId} AND m.role IN ('EDITOR','REVIEWER'))) FOR UPDATE OF p`;
    if (!project[0]) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND' });
    const totals = await tx.$queryRaw<Array<{ size: string }>>`SELECT COALESCE(sum(byte_size),0)::text AS size FROM docgrid.docgrid_materials WHERE project_id=${ctx.projectId}::uuid`;
    let projectBytes = Number(totals[0]?.size || 0);
    // Match the source adapter's live-tree bound, including folders and generated artifacts.
    // Reserve missing ancestors with each accepted item so a later bulk insert cannot overflow it.
    const counts = await tx.$queryRaw<Array<{ entries: number }>>`SELECT (
      (SELECT count(*) FROM docgrid.docgrid_materials WHERE project_id=${ctx.projectId}::uuid AND deleted_at IS NULL) +
      (SELECT count(*) FROM docgrid.workspace_documents WHERE project_id=${ctx.projectId}::uuid AND docgrid_deleted_at IS NULL) +
      (SELECT count(*) FROM docgrid.dg_astra_documents WHERE project_id=${ctx.projectId}::uuid) +
      (SELECT count(*) FROM docgrid.docgrid_folders WHERE project_id=${ctx.projectId}::uuid)
      )::int AS entries`;
    let projectEntries = counts[0].entries;
    const knownFolders = new Set((await tx.$queryRaw<Array<{ path: string }>>`SELECT path FROM docgrid.docgrid_folders WHERE project_id=${ctx.projectId}::uuid`).map(folder => folder.path));
    const accepted: Array<{ index: number; sourceId: string; name: string; path: string; mimeType: string; sha256: string; byteSize: number; extractionStatus: ExtractionStatus; textCharacters: number; duplicate: boolean; warnings: string[] }> = [];
    const folderPaths = new Set<string>(), acceptedFolders: typeof requestedFolders = [];
    const reserveFolders = (paths: string[]) => {
      for (const path of paths) {
        if (!knownFolders.has(path)) { knownFolders.add(path); projectEntries++; }
        folderPaths.add(path);
      }
    };
    for (const folder of requestedFolders) {
      const paths = ancestors(folder.path), missing = paths.filter(path => !knownFolders.has(path)).length;
      if (missing && projectEntries + missing > ASTRA_UPLOAD_LIMITS.maxProjectEntries) {
        errors.push({ kind: 'folder', index: folder.index, path: folder.path, code: 'SCOPE_ENTRY_LIMIT', message: 'Project tree is limited to 5000 active sources, artifacts and folders; no part of this folder path was created' }); continue;
      }
      reserveFolders(paths); acceptedFolders.push(folder);
    }
    for (const file of files) {
      const existing = await tx.$queryRaw<Material[]>`SELECT id,sha256,mime AS "mimeType",extraction_status AS "extractionStatus",char_length(extracted_text)::int AS "textCharacters",byte_size::int AS "byteSize"
        FROM docgrid.docgrid_materials WHERE project_id=${ctx.projectId}::uuid AND path=${file.path} AND title=${file.name} AND deleted_at IS NULL ORDER BY created_at,id`;
      if (existing.some(row => row.sha256 !== file.hash)) {
        errors.push({ kind: 'file', index: file.index, name: file.name, path: file.path, code: 'PATH_CONFLICT', message: 'An original with different bytes already exists at this path; choose another name' }); continue;
      }
      let material = existing[0]; const duplicate = Boolean(material);
      const paths = ancestors(file.path), missingFolders = paths.filter(path => !knownFolders.has(path)).length;
      const addedEntries = (duplicate ? 0 : 1) + missingFolders;
      if (addedEntries && projectEntries + addedEntries > ASTRA_UPLOAD_LIMITS.maxProjectEntries) {
        errors.push({ kind: 'file', index: file.index, name: file.name, path: file.path, code: 'SCOPE_ENTRY_LIMIT', message: 'Project tree is limited to 5000 active sources, artifacts and folders; original and required folders were not created' }); continue;
      }
      if (!material) {
        if (projectBytes + file.bytes.length > ASTRA_UPLOAD_LIMITS.maxProjectBytes) {
          errors.push({ kind: 'file', index: file.index, name: file.name, path: file.path, code: 'PROJECT_STORAGE_LIMIT', message: 'Project originals exceed 500 MiB including trash' }); continue;
        }
        const key = this.materialStorage?.enabled ? await this.materialStorage.store(ctx.projectId,file.bytes,file.hash,file.mimeType) : null;
        const rows = await tx.$queryRaw<Material[]>`INSERT INTO docgrid.docgrid_materials(project_id,title,path,mime,bytes,storage_key,byte_size,sha256,extracted_text,extraction_status,created_by)
          VALUES(${ctx.projectId}::uuid,${file.name},${file.path},${file.mimeType},${key ? null : file.bytes}::bytea,${key},${file.bytes.length},${file.hash},${file.text},${file.status},${ctx.ownerId})
          RETURNING id,sha256,mime AS "mimeType",extraction_status AS "extractionStatus",char_length(extracted_text)::int AS "textCharacters",byte_size::int AS "byteSize"`;
        material = rows[0]; projectBytes += file.bytes.length; projectEntries++;
      }
      reserveFolders(paths);
      accepted.push({ index: file.index, sourceId: material.id, name: file.name, path: file.path, mimeType: material.mimeType,
        sha256: material.sha256, byteSize: material.byteSize, extractionStatus: material.extractionStatus, textCharacters: material.textCharacters,
        duplicate, warnings: duplicate ? ['EXISTING_ORIGINAL_REUSED: stored bytes and extraction were not changed', ...(['UNREAD', 'FAILED'].includes(material.extractionStatus) ? ['NO_READABLE_EXTRACTION'] : []), ...(material.extractionStatus === 'PARTIAL' ? ['EXTRACTION_INCOMPLETE'] : [])] : file.warnings });
    }
    let folders: Array<{ id: string; path: string }> = [];
    if (folderPaths.size) {
      const paths = JSON.stringify([...folderPaths].sort());
      await tx.$executeRaw`INSERT INTO docgrid.docgrid_folders(project_id,path) SELECT ${ctx.projectId}::uuid,jsonb_array_elements_text(${paths}::jsonb) ON CONFLICT(project_id,path) DO NOTHING`;
      folders = await tx.$queryRaw<Array<{ id: string; path: string }>>`SELECT id,path FROM docgrid.docgrid_folders WHERE project_id=${ctx.projectId}::uuid AND path IN (SELECT jsonb_array_elements_text(${paths}::jsonb)) ORDER BY path`;
    }
    await tx.$executeRaw`INSERT INTO docgrid.docgrid_events(project_id,actor_id,event_type,entity_type,entity_id,metadata)
      VALUES(${ctx.projectId}::uuid,${ctx.ownerId},'astra.sources.uploaded','astra_operation',${ctx.operationId}::uuid,
      ${JSON.stringify({ grantId: ctx.grantId, agentRef: ctx.agentRef, runId: ctx.runId, traceId: ctx.traceId,
        accepted: accepted.map(file => ({ sourceId: file.sourceId, sha256: file.sha256, byteSize: file.byteSize, duplicate: file.duplicate })), errors: errors.map(error => ({ kind: error.kind, index: error.index, code: error.code })), folders: folders.map(folder => folder.path) })}::jsonb)`;
    return { output: { accepted, errors: errors.sort((a, b) => a.kind.localeCompare(b.kind) || a.index - b.index), folders,
      requestedFolders: acceptedFolders.map(folder => ({ ...folder, folderId: folders.find(item => item.path === folder.path)?.id || null })),
      partialFailure: errors.length > 0, decodedBytes, limits: ASTRA_UPLOAD_LIMITS,
      sourceIntegrity: 'Original bytes retained unchanged; extraction is derived data', documentPlanRequired: false } };
  }
}

export const ASTRA_UPLOAD_SCHEMAS: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  docgrid_upload_sources: {
    description: 'Upload immutable user-supplied originals and preserve nested/empty folders. Project-wide write grant and requestKey required; no document plan. At most 64 files, 128 explicit folders, 600 KiB TOTAL decoded bytes within the existing 1 MiB JSON envelope. Project tree limit: 5000 active sources, artifacts and folders; per-item SCOPE_ENTRY_LIMIT when full. Per-item accepted/errors; same path/hash reuses the ID, different bytes conflict. UTF-8 .txt/.md extracted up to 200000 characters; other formats remain UNREAD, including PDF/DOCX.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['files'], properties: {
      files: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['name', 'path', 'mimeType', 'contentBase64'], properties: {
        name: { type: 'string', minLength: 1, maxLength: 180 }, path: { type: 'string', minLength: 1, maxLength: 500, description: 'Containing folder path, not the filename; / is the project root. NFC-normalized, no traversal, at most 32 levels.' },
        mimeType: { type: 'string', minLength: 3, maxLength: 150 }, contentBase64: { type: 'string', minLength: 4, maxLength: 819200, description: 'Canonical padded base64; sum of decoded file bytes must not exceed 614400.' },
      } } }, folders: { type: 'array', maxItems: 128, items: { type: 'string', minLength: 1, maxLength: 500 }, description: 'Optional empty folder paths; ancestor folders are retained too, at most 512 total paths.' },
    } },
  },
};

