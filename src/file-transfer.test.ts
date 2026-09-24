import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { byteLimit, uploadStream, MAX_MATERIAL_BYTES } from './file-transfer.js';
import { resolveDocGridRoute } from './proxy-policy.js';

test('authenticated human relocation is explicitly allowlisted and project-scoped', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const path = `/api/docgrid/repositories/${id}/materials/${id}/relocate`;
  assert.equal(resolveDocGridRoute('POST', path, new URLSearchParams())?.body, 'json');
  assert.equal(resolveDocGridRoute('GET', path, new URLSearchParams()), null);
  assert.equal(resolveDocGridRoute('POST', path, new URLSearchParams('project=other')), null);
});

test('streams a 40 MiB original beyond the JSON ceiling with bounded chunks', async () => {
  let received = 0, largest = 0;
  const chunk = Buffer.alloc(64 * 1024, 7);
  const source = Readable.from((function* () { for (let i = 0; i < 640; i++) yield chunk; })());
  await pipeline(uploadStream(source), byteLimit(MAX_MATERIAL_BYTES), new Writable({ write(data, _encoding, done) { received += data.length; largest = Math.max(largest, data.length); done(); } }));
  assert.equal(received, 40 * 1024 * 1024);
  assert.equal(largest, chunk.length);
});

test('unknown-length uploads exceeding their limit abort instead of buffering', async () => {
  const source = Readable.from([Buffer.alloc(5), Buffer.alloc(6)]);
  await assert.rejects(() => pipeline(uploadStream(source, 10), new Writable({ write(_chunk, _encoding, done) { done(); } })), (error: unknown) => (error as { status: number }).status === 413);
});
