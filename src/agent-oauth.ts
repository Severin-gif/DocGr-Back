import express, { Router } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readAgentToken } from './astra-proxy.js';
import { AgentTransportOptions, agentJson, hash, record, seal, unseal, UUID } from './agent-transport.js';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const text = (v: unknown, max = 8192) => { if (typeof v !== 'string' || !v || v.length > max) throw Error('Invalid value'); return v; };
const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const validRedirect = (s: string) => {
  const u = new URL(s);
  return !u.hostname.includes('*') && !u.username && !u.password && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
};
type Consent = { clientId: string; redirect: string; resource: string; projectId: string; challenge: string; state: string; name: string; nonce: string; exp: number };
export function createAgentOAuthRouter(options: AgentTransportOptions): Router {
  const router = Router(); const base = options.publicOrigin, oauth = `${base}/api/docgrid/oauth`;
  const resourcePattern = new RegExp(`^/api/docgrid/mcp/(${UUID})$`);
  const projectOf = (raw: unknown) => {
    const resource = text(raw, 2048), url = new URL(resource);
    const match = resourcePattern.exec(url.pathname);
    if (url.origin !== base || url.search || url.hash || !match || url.username || url.password) throw Error('Invalid resource');
    return { resource, projectId: match[1]! };
  };
  router.use((req, res, next) => {
    if (req.path.includes('/oauth') || req.path.startsWith('/.well-known/')) {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    }
    next();
  });
  router.get('/.well-known/oauth-protected-resource/api/docgrid/mcp/:projectId', (req, res) => {
    try { const { resource } = projectOf(`${base}/api/docgrid/mcp/${req.params.projectId}`);
      return res.json({ resource, authorization_servers: [oauth], scopes_supported: ['docgrid'], bearer_methods_supported: ['header'] });
    } catch { return res.status(404).json({ error: 'Unknown resource' }); }
  });
  const metadata = { issuer: oauth, authorization_endpoint: `${oauth}/authorize`, token_endpoint: `${oauth}/token`, registration_endpoint: `${oauth}/register`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['docgrid'] };
  router.get('/.well-known/oauth-authorization-server/api/docgrid/oauth', (_req, res) => res.json(metadata));
  router.get('/api/docgrid/oauth/.well-known/oauth-authorization-server', (_req, res) => res.json(metadata));
  router.post('/api/docgrid/oauth/register', (req, res) => {
    try {
      const b = req.body;
      if (!record(b) || !Array.isArray(b.redirect_uris) || !b.redirect_uris.length || b.redirect_uris.length > 5 ||
        !b.redirect_uris.every((u: unknown) => validRedirect(text(u, 2048))) ||
        (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none') ||
        (b.grant_types && JSON.stringify(b.grant_types) !== '["authorization_code"]') ||
        (b.response_types && JSON.stringify(b.response_types) !== '["code"]')) throw Error();
      const name = typeof b.client_name === 'string' ? b.client_name.slice(0, 120) : 'MCP client';
      const clientId = seal(options.serviceToken, 'client', { redirects: b.redirect_uris, name });
      if (clientId.length > 2048) throw Error();
      return res.status(201).json({ client_id: clientId, client_name: name, redirect_uris: b.redirect_uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] });
    } catch { return res.status(400).json({ error: 'invalid_client_metadata' }); }
  });
  router.get('/api/docgrid/oauth/authorize', (req, res) => {
    try {
      const q = req.query;
      const clientId = text(q.client_id), client = unseal(options.serviceToken, 'client', clientId);
      const redirect = text(q.redirect_uri, 2048);
      const { resource, projectId } = projectOf(q.resource);
      if (!client.redirects.includes(redirect) || q.response_type !== 'code' || q.code_challenge_method !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(text(q.code_challenge, 43)) || (q.scope && q.scope !== 'docgrid')) throw Error();
      const nonce = randomBytes(24).toString('base64url');
      const consent: Consent = { clientId, redirect, resource, projectId, challenge: String(q.code_challenge), state: q.state ? text(q.state, 2048) : '', name: String(client.name), nonce, exp: Date.now() + 600000 };
      const ticket = seal(options.serviceToken, 'consent', consent);
      res.cookie('dg_oauth_csrf', nonce, { httpOnly: true, secure: base.startsWith('https:'), sameSite: 'lax', path: '/api/docgrid/oauth', maxAge: 600000 });
      return res.type('html').send(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Подключение к DocGrid</title><main><h1>Подключение к DocGrid</h1><p>Приложение: <strong>${esc(consent.name)}</strong></p><p>Адрес возврата: <strong>${esc(new URL(redirect).origin)}</strong></p><p>Проект: ${esc(projectId)}</p><p>В DocGrid откройте проект → Доступ → Подключения LLM. Создайте подключение с нужными правами и введите его ключ ниже. Приложение получит только уже разрешённые этому ключу действия и документы.</p><form method="post" action="${oauth}/authorize"><input type="hidden" name="ticket" value="${esc(ticket)}"><label>Ключ подключения DocGrid <input name="grant" type="password" required autocomplete="off" maxlength="47"></label><p><button name="decision" value="allow">Подключить приложение</button> <button name="decision" value="deny" formnovalidate>Отмена</button></p></form><p>Доступ можно отозвать в проекте. Имя приложения сообщено самим приложением: проверьте адрес возврата.</p></main></html>`);
    } catch { return res.status(400).json({ error: 'invalid_request' }); }
  });
  router.post('/api/docgrid/oauth/authorize', express.urlencoded({ extended: false, limit: '24kb' }), async (req, res) => {
    try {
      if (req.header('origin') && req.header('origin') !== base) throw Error();
      const consent = unseal(options.serviceToken, 'consent', text(req.body.ticket)) as Consent;
      const cookie = req.header('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('dg_oauth_csrf='))?.slice(14) || '';
      if (Buffer.byteLength(cookie) !== Buffer.byteLength(consent.nonce) || !timingSafeEqual(Buffer.from(cookie), Buffer.from(consent.nonce))) throw Error();
      const redirect = new URL(consent.redirect);
      if (consent.state) redirect.searchParams.set('state', consent.state);
      if (req.body.decision === 'deny') { redirect.searchParams.set('error', 'access_denied'); return res.redirect(303, redirect.toString()); }
      if (req.body.decision !== 'allow') throw Error();
      const grant = readAgentToken(`Bearer ${text(req.body.grant, 47)}`);
      if (!grant) throw Error();
      const catalog = await agentJson(options, `/api/docgrid/agents/catalog?projectId=${consent.projectId}`, grant);
      const expiry = new Date(catalog.grant?.expiresAt).getTime();
      if (!Number.isFinite(expiry) || expiry <= Date.now() || catalog.grant.remainingOperations <= 0) throw Error();
      const code = randomBytes(32).toString('base64url');
      const sealedToken = seal(options.serviceToken, 'access', { grant, resource: consent.resource, projectId: consent.projectId, clientId: consent.clientId, exp: expiry });
      const bindingHash = hash(JSON.stringify([consent.clientId, consent.redirect, consent.resource, consent.challenge]));
      await agentJson(options, '/api/docgrid/internal/agent-oauth/codes', undefined, { codeHash: hash(code), bindingHash, sealedToken });
      res.clearCookie('dg_oauth_csrf', { path: '/api/docgrid/oauth' });
      redirect.searchParams.set('code', code);
      return res.redirect(303, redirect.toString());
    } catch { return res.status(400).type('html').send('<h1>Подключение не выполнено</h1><p>Проверьте ключ, проект и срок доступа. Запустите подключение заново в приложении.</p>'); }
  });
  router.post('/api/docgrid/oauth/token', express.urlencoded({ extended: false, limit: '24kb' }), async (req, res) => {
    try {
      const b = req.body;
      if (b.grant_type !== 'authorization_code') throw Error();
      const clientId = text(b.client_id), client = unseal(options.serviceToken, 'client', clientId);
      const redirect = text(b.redirect_uri, 2048), verifier = text(b.code_verifier, 128), code = text(b.code, 43);
      const { resource, projectId } = projectOf(b.resource);
      if (!client.redirects.includes(redirect) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw Error();
      const bindingHash = hash(JSON.stringify([clientId, redirect, resource, challenge(verifier)]));
      const stored = await agentJson(options, '/api/docgrid/internal/agent-oauth/exchange', undefined, { codeHash: hash(code), bindingHash });
      const access = unseal(options.serviceToken, 'access', stored.sealedToken);
      if (access.resource !== resource || access.clientId !== clientId) throw Error();
      await agentJson(options, `/api/docgrid/agents/catalog?projectId=${projectId}`, access.grant);
      return res.json({ access_token: `dgmc_${stored.sealedToken}`, token_type: 'Bearer', expires_in: Math.max(0, Math.floor((access.exp - Date.now()) / 1000)), scope: 'docgrid' });
    } catch { return res.status(400).json({ error: 'invalid_grant' }); }
  });
  return router;
}
