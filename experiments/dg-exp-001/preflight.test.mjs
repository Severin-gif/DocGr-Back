import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runPreflight, validateBase } from './preflight.mjs';
const projectId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const original = Buffer.from('synthetic source - not client data');
const accessToken = 'fixture.user.token';
const base = 'https://api.docgrid.ru/api';
const material = { id, title: 'PRIVATE_TITLE', path: '/PRIVATE_PATH', size: original.length,
  sha256: createHash('sha256').update(original).digest('hex'), extractionStatus: 'READY' };
const inventory = (materials = [material], documents = []) => ({ materials, documents, folders: [] });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const run = (fetchImpl, extra = {}) => runPreflight({ baseUrl: base, projectId, accessToken, fetchImpl, ...extra });

test('rejects untrusted URL forms and requires HTTPS', () => {
  for (const url of ['http://host/api','https://user:password@host/api','https://host/api?key=1','https://host/api#x','https://host/not-api','broken']) {
    assert.throws(() => validateBase(url), /INVALID_API_BASE/);
  }
  assert.equal(validateBase(base + '/'), base);
});
test('missing project or token makes no network call', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; throw new Error(); };
  assert.deepEqual((await run(fetchImpl, { projectId: '' })).blockers, ['PROJECT_ID_REQUIRED']);
  assert.deepEqual((await run(fetchImpl, { accessToken: '' })).blockers, ['USER_ACCESS_TOKEN_REQUIRED']);
  assert.equal(calls, 0);
});
test('reads exactly one project and one original; never reports legal task complete', async () => {
  const calls = [];
  const report = await run(async (url, init) => {
    calls.push(url); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${accessToken}`);
    return url.endsWith('/files?trash=false') ? json(inventory()) : new Response(original);
  });
  assert.deepEqual(calls, [`${base}/docgrid/repositories/${projectId}/files?trash=false`, `${base}/docgrid/repositories/${projectId}/materials/${id}/download`]);
  assert.equal(report.status, 'PREFLIGHT_OK'); assert.equal(report.sample.sha256Verified, true);
  assert.equal(report.experimentCompleted, false); assert.equal(report.credentialScopeVerified, false);
  const text = JSON.stringify(report);
  for (const secret of [accessToken, 'PRIVATE_TITLE', 'PRIVATE_PATH', original.toString()]) assert.ok(!text.includes(secret));
});
test('HTTP errors are not masked by successful empty results or reflected bodies', async () => {
  for (const status of [401,403,404,500]) {
    const report = await run(async () => json({ error: accessToken }, status));
    assert.equal(report.status, 'BLOCKED'); assert.deepEqual(report.blockers, [`HTTP_${status}`]);
    assert.ok(!JSON.stringify(report).includes(accessToken));
  }
});
test('network/redirect errors never reflect secrets', async () => {
  const report = await run(async () => { throw new Error(accessToken); });
  assert.deepEqual(report.blockers, ['NETWORK_OR_REDIRECT_FAILED']);
});
test('invalid JSON and HTML cannot pass as inventory', async () => {
  assert.deepEqual((await run(async () => new Response('<html>'))).blockers, ['EXPECTED_JSON']);
  assert.deepEqual((await run(async () => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).blockers, ['INVALID_JSON']);
  assert.deepEqual((await run(async () => json({}))).blockers, ['INVALID_INVENTORY']);
});
test('empty corpus is blocked', async () => {
  assert.deepEqual((await run(async () => json(inventory([])))).blockers, ['EMPTY_CORPUS']);
});
test('editable-only inventory is not claimed to have verified originals or revisions', async () => {
  const report = await run(async () => json(inventory([], [{id}])));
  assert.equal(report.status, 'PREFLIGHT_OK'); assert.equal(report.sample, null);
  assert.equal(report.experimentCompleted, false);
});
test('unread and partial sources stay explicit; no fabricated reading success', async () => {
  const mats = ['UNREAD','PARTIAL','invented'].map((extractionStatus, i) => ({ ...material,
    id: `${i + 3}2222222-2222-4222-8222-222222222222`, extractionStatus }));
  const report = await run(async url => url.endsWith('/files?trash=false') ? json(inventory(mats)) : new Response(original));
  assert.deepEqual(report.inventory.extractionStatusReportedByServer, {READY:0,PARTIAL:1,UNREAD:1,UNKNOWN:1});
});
test('unsafe material IDs stop before a second network call', async () => {
  let calls = 0;
  const report = await run(async () => { calls++; return json(inventory([{...material, id:'../other-project'}])); });
  assert.deepEqual(report.blockers, ['INVALID_MATERIAL_METADATA']); assert.equal(calls, 1);
});
test('changed original fails integrity check', async () => {
  const report = await run(async url => url.endsWith('/files?trash=false') ? json(inventory()) : new Response('changed'));
  assert.deepEqual(report.blockers, ['ORIGINAL_INTEGRITY_MISMATCH']);
});
test('response byte limit applies even without Content-Length', async () => {
  const report = await run(async () => new Response('x'.repeat(4*1024*1024+1), { headers: { 'Content-Type': 'application/json' } }));
  assert.deepEqual(report.blockers, ['RESPONSE_TOO_LARGE']);
});
