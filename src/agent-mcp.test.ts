import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createAgentMcpRouter } from './agent-mcp.js';
import { createAgentOAuthRouter } from './agent-oauth.js';
import { AgentTransportOptions } from './agent-transport.js';
import { isAllowedDocGridRequest } from './proxy-policy.js';

const project = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const grant = 'dga_' + 'a'.repeat(43), secret = 'server-only-'.repeat(4);
test('generic MCP + OAuth: scoped discovery, bound single-use codes, revocation and stable retries', async () => {
  const codes = new Map<string, any>(); const calls: any[] = []; let revoked = false;
  const options: AgentTransportOptions = {
    upstream: 'https://core.invalid', serviceToken: secret, timeoutMs: 1000, maxResponseBytes: 100000,
    publicOrigin: '', allowedOrigins: [],
    fetcher: (async (url: any, init: any) => {
      const path = new URL(String(url)).pathname, headers = new Headers(init.headers), body = init.body ? JSON.parse(init.body) : null;
      assert.equal(headers.get('x-docgrid-service-token'), secret);
      for (const name of ['authorization', 'cookie', 'x-docgrid-subject']) assert.equal(headers.get(name), null);
      if (path.endsWith('/internal/agent-oauth/codes')) { codes.set(body.codeHash, body); return Response.json({ saved: true }); }
      if (path.endsWith('/internal/agent-oauth/exchange')) {
        const stored = codes.get(body.codeHash);
        if (!stored || stored.bindingHash !== body.bindingHash) return Response.json({}, { status: 401 });
        codes.delete(body.codeHash); return Response.json({ sealedToken: stored.sealedToken });
      }
      assert.equal(headers.get('x-docgrid-agent-token'), grant);
      if (revoked || new URL(String(url)).searchParams.get('projectId') === other) return Response.json({}, { status: 403 });
      if (path.endsWith('/catalog')) return Response.json({ grant: { agentRef: 'Any model', expiresAt: new Date(Date.now() + 3600000).toISOString(), remainingOperations: 100 },
        tools: [{ name: 'docgrid_list_tree', description: 'Read tree', inputSchema: { type: 'object', properties: {} }, mutating: false }] });
      calls.push({ path, body }); return Response.json({ status: 'completed', output: { tree: [] } });
    }) as typeof fetch,
  };
  const app = express(); app.use(express.json());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  options.publicOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = options.publicOrigin;
  app.use(createAgentOAuthRouter(options));
  app.use('/api/docgrid/mcp', createAgentMcpRouter(options));
  const resource = `${base}/api/docgrid/mcp/${project}`;
  const rpc = (method: string, params: any = {}, bearer = grant, extra: any = {}) => fetch(resource, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const jsonPost = (path: string, body: any) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
  try {
    assert.equal((await rpc('initialize', { protocolVersion: '2025-11-25' }, 'human.jwt')).status, 401);
    assert.equal((await rpc('ping', {}, grant, { Origin: 'https://untrusted.test' })).status, 403);
    assert.equal((await rpc('ping', {}, grant, { 'MCP-Protocol-Version': 'unknown' })).status, 400);
    assert.equal((await (await rpc('initialize', { protocolVersion: '2025-11-25' })).json()).result.serverInfo.name, 'DocGrid');
    const listed = await (await rpc('tools/list')).json();
    assert.deepEqual(listed.result.tools.map((t: any) => t.name), ['docgrid_list_tree']);
    assert.equal(calls.length, 0, 'discovery does not execute an operation or spend quota');
    const args = { runId: 'stable-run', requestKey: 'stable-op', input: {} };
    assert.equal((await (await rpc('tools/call', { name: 'docgrid_list_tree', arguments: { ...args, projectId: other } })).json()).error.code, -32602);
    assert.equal((await (await rpc('tools/call', { name: 'docgrid_approve', arguments: args })).json()).error.code, -32602);
    await rpc('tools/call', { name: 'docgrid_list_tree', arguments: args });
    await rpc('tools/call', { name: 'docgrid_list_tree', arguments: args });
    assert.equal(calls[0].body.projectId, project); assert.equal(calls[0].body.requestKey, calls[1].body.requestKey); assert.equal(calls[0].body.runId, calls[1].body.runId);

    const registration = await (await jsonPost('/api/docgrid/oauth/register', { client_name: 'Test client', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none' })).json();
    const verifier = 'v'.repeat(64), pkce = createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({ client_id: registration.client_id, redirect_uri: 'https://client.example/callback', response_type: 'code', resource, code_challenge_method: 'S256', code_challenge: pkce, state: 'preserve-state', scope: 'docgrid' });
    const consentPage = await fetch(`${base}/api/docgrid/oauth/authorize?${query}`);
    assert.equal(consentPage.status, 200);
    const html = await consentPage.text(), ticket = /name="ticket" value="([^"]+)"/.exec(html)![1]!;
    const cookie = consentPage.headers.get('set-cookie')!.split(';')[0]!;
    assert.doesNotMatch(html, new RegExp(grant));
    const form = new URLSearchParams({ ticket, grant, decision: 'allow' });
    const postConsent = (csrf: string) => fetch(`${base}/api/docgrid/oauth/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: csrf }, body: form, redirect: 'manual' });
    assert.equal((await postConsent('')).status, 400, 'cross-site forged consent rejected');
    const consent = await postConsent(cookie); assert.equal(consent.status, 303);
    const callback = new URL(consent.headers.get('location')!);
    assert.equal(callback.searchParams.get('state'), 'preserve-state'); assert.ok(!callback.href.includes(grant));
    assert.ok(!JSON.stringify([...codes.values()]).includes(grant), 'durable store contains encrypted credentials only');
    const exchange = { grant_type: 'authorization_code', client_id: registration.client_id, redirect_uri: 'https://client.example/callback', resource, code: callback.searchParams.get('code'), code_verifier: verifier };
    assert.equal((await jsonPost('/api/docgrid/oauth/token', { ...exchange, code_verifier: 'x'.repeat(64) })).status, 400);
    assert.equal((await jsonPost('/api/docgrid/oauth/token', { ...exchange, resource: `${base}/api/docgrid/mcp/${other}` })).status, 400);
    const tokenResponse = await jsonPost('/api/docgrid/oauth/token', exchange); assert.equal(tokenResponse.status, 200);
    const access = await tokenResponse.json(); assert.ok(access.access_token.startsWith('dgmc_')); assert.ok(!access.access_token.includes(grant));
    assert.equal((await jsonPost('/api/docgrid/oauth/token', exchange)).status, 400, 'code is consumed once');
    assert.equal((await rpc('tools/list', {}, access.access_token)).status, 200);
    assert.equal((await fetch(`${base}/api/docgrid/mcp/${other}`, { method: 'POST', headers: { Authorization: `Bearer ${access.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status, 401, 'OAuth resource cannot be changed');
    revoked = true;
    assert.equal((await rpc('tools/list', {}, access.access_token)).status, 403, 'revoked grant blocks an existing OAuth access token');
    assert.equal((await rpc('tools/list')).status, 403, 'direct bearer follows the same policy');
    assert.equal(isAllowedDocGridRequest('POST', '/api/docgrid/internal/agent-oauth/exchange', new URLSearchParams()), false);
    assert.equal(isAllowedDocGridRequest('POST', `/api/docgrid/repositories/${project}/agents/grants`, new URLSearchParams()), true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
