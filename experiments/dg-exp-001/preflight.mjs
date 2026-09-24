/** DG-EXP-001, phase 0. API readiness only; NOT an MCP server or an LLM run.
 * No writes to DocGrid. Credentials and source text are never included in reports.
 * Uses only /files and /materials/:id/download; /overview can initialize state.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/i;
const MAX_JSON = 4 * 1024 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

export function validateBase(value) {
  let url;
  try { url = new URL(value); } catch { return fail('INVALID_API_BASE'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname.replace(/\/+$/, '') !== '/api') fail('INVALID_API_BASE');
  return url.href.replace(/\/+$/, '');
}

async function readBounded(response, limit) {
  if (!response.body) fail('EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail('RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export async function runPreflight({ baseUrl = 'https://api.docgrid.ru/api', projectId,
  accessToken, fetchImpl = globalThis.fetch } = {}) {
  const report = { experiment: 'DG-EXP-001', phase: 'preflight', runId: randomUUID(),
    at: new Date().toISOString(), status: 'BLOCKED', experimentCompleted: false,
    readinessScope: 'inventory-and-one-original-only', projectId: null,
    credentialScopeVerified: false, requests: [], blockers: [], inventory: null, sample: null };
  try {
    const base = validateBase(baseUrl);
    if (typeof projectId !== 'string' || !UUID.test(projectId)) fail('PROJECT_ID_REQUIRED');
    report.projectId = projectId;
    if (typeof accessToken !== 'string' || !accessToken || /\s/.test(accessToken) ||
        accessToken.length > 16384) fail('USER_ACCESS_TOKEN_REQUIRED');
    // The operator, not an LLM argument or source document, selects the trusted API origin.
    const get = async (operation, suffix, limit, json = false) => {
      const entry = { operation, method: 'GET', status: null, bytes: 0, ms: 0 };
      report.requests.push(entry); const started = Date.now();
      try {
        let response;
        try {
          response = await fetchImpl(base + suffix, { method: 'GET', redirect: 'error',
            signal: AbortSignal.timeout(15000), headers: {
              Authorization: `Bearer ${accessToken}`, 'X-Request-ID': report.runId,
              Accept: json ? 'application/json' : 'application/octet-stream' } });
        } catch { return fail('NETWORK_OR_REDIRECT_FAILED'); }
        entry.status = response.status;
        if (!response.ok) { await response.body?.cancel(); fail(`HTTP_${response.status}`); }
        if (json && !/^application\/(?:[\w.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
          await response.body?.cancel(); fail('EXPECTED_JSON');
        }
        const bytes = await readBounded(response, limit); entry.bytes = bytes.length;
        return bytes;
      } finally { entry.ms = Date.now() - started; }
    };
    const prefix = `/docgrid/repositories/${projectId}`;
    const bytes = await get('inventory', prefix + '/files?trash=false', MAX_JSON, true);
    let files;
    try { files = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_JSON'); }
    if (!files || !['materials','documents','folders'].every(k => Array.isArray(files[k]))) fail('INVALID_INVENTORY');
    if (files.materials.some(m => !m || !UUID.test(m.id) || !HASH.test(m.sha256) ||
        !Number.isSafeInteger(m.size) || m.size < 1 || m.size > MAX_FILE)) fail('INVALID_MATERIAL_METADATA');
    const coverage = { READY: 0, PARTIAL: 0, UNREAD: 0, UNKNOWN: 0 };
    for (const m of files.materials) {
      const status = ['READY','PARTIAL','UNREAD'].includes(m.extractionStatus) ? m.extractionStatus : 'UNKNOWN';
      coverage[status]++;
    }
    report.inventory = { materials: files.materials.length, documents: files.documents.length,
      folders: files.folders.length, extractionStatusReportedByServer: coverage,
      originals: files.materials.map(m => ({ id: m.id, sha256: m.sha256, size: m.size })) };
    if (!files.materials.length && !files.documents.length) fail('EMPTY_CORPUS');
    // Verify ONE original round trip. This is not proof that every source is readable.
    if (files.materials.length) {
      const m = files.materials[0];
      const original = await get('original_sample', `${prefix}/materials/${m.id}/download`, MAX_FILE);
      const hash = createHash('sha256').update(original).digest('hex');
      if (hash !== m.sha256.toLowerCase() || original.length !== m.size) fail('ORIGINAL_INTEGRITY_MISMATCH');
      report.sample = { materialId: m.id, bytes: original.length, sha256Verified: true };
    }
    report.status = 'PREFLIGHT_OK';
  } catch (error) {
    report.blockers.push(typeof error?.code === 'string' && /^[A-Z_0-9]+$/.test(error.code)
      ? error.code : 'UNCLASSIFIED_PREFLIGHT_FAILURE');
  }
  return report;
}

async function main() {
  const report = await runPreflight({ baseUrl: process.env.DOCGRID_API_BASE_URL,
    projectId: process.env.DOCGRID_PROJECT_ID, accessToken: process.env.DOCGRID_ACCESS_TOKEN });
  const output = resolve('.docgrid-experiment-runs', report.runId, 'preflight.json');
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ experiment: report.experiment, status: report.status,
    blockers: report.blockers, report: output, experimentCompleted: false }));
  process.exitCode = report.status === 'PREFLIGHT_OK' ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('PREFLIGHT_REPORT_WRITE_FAILED'); process.exitCode = 2; });
}
