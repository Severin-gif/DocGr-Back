import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { readAgentToken } from './astra-proxy.js';
import { AgentTransportOptions, agentJson, record, unseal, UpstreamError, UUID } from './agent-transport.js';

const VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25'];
export function createAgentMcpRouter(options: AgentTransportOptions): Router {
  const router = Router();
  router.use(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const path = new URL(req.originalUrl, options.publicOrigin).pathname;
    const match = new RegExp(`^/api/docgrid/mcp/(${UUID})$`).exec(path);
    if (!match || Object.keys(req.query).length) return res.status(404).json({ error: 'Unknown MCP resource' });
    const projectId = match[1]!, resource = options.publicOrigin + path;
    const origin = req.header('origin');
    if (origin && !options.allowedOrigins.includes(origin)) return res.status(403).json({ error: 'Origin is not allowed' });
    let token = readAgentToken(req.header('authorization'));
    if (!token && req.header('authorization')?.startsWith('Bearer dgmc_')) {
      try {
        const access = unseal(options.serviceToken, 'access', req.header('authorization')!.slice('Bearer dgmc_'.length));
        if (access.resource === resource && access.projectId === projectId) token = readAgentToken(`Bearer ${access.grant}`);
      } catch { /* handled as an unauthenticated request below */ }
    }
    const unauthorized = () => {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${options.publicOrigin}/.well-known/oauth-protected-resource${path}"`);
      return res.status(401).json({ error: 'invalid_token' });
    };
    if (!token) return unauthorized();
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    try {
      // Never cache a grant: revocation, expiry and project ownership are checked
      // even for initialize, ping and tools/list. Discovery consumes no quota.
      const catalog = await agentJson(options, `/api/docgrid/agents/catalog?projectId=${projectId}`, token, undefined, controller.signal);
      if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
      if (!req.is('application/json')) return res.status(415).json({ error: 'Expected application/json' });
      const version = req.header('mcp-protocol-version');
      if (version && !VERSIONS.includes(version)) return res.status(400).json({ error: 'Unsupported MCP-Protocol-Version' });
      const body = req.body;
      const validId = record(body) && (typeof body.id === 'string' || (typeof body.id === 'number' && Number.isFinite(body.id)));
      const id = validId ? body.id : null;
      const error = (code: number, message: string, status = 200) => res.status(status).json({ jsonrpc: '2.0', id, error: { code, message } });
      const result = (value: unknown) => res.json({ jsonrpc: '2.0', id, result: value });
      if (!record(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || (body.id !== undefined && !validId)) return error(-32600, 'Invalid JSON-RPC request', 400);
      if (!validId) return body.method.startsWith('notifications/') ? res.status(202).end() : error(-32600, 'Request id required', 400);
      if (body.method === 'initialize') {
        if (!record(body.params) || typeof body.params.protocolVersion !== 'string') return error(-32602, 'protocolVersion is required');
        return result({ protocolVersion: VERSIONS.includes(body.params.protocolVersion) ? body.params.protocolVersion : '2025-11-25',
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'DocGrid', version: '1.0.0' },
          instructions: 'Work only in this project and granted source scope. Preserve originals. Reuse requestKey and runId when retrying a mutation. A human approves proposals in DocGrid. Report failed or incomplete operations accurately.' });
      }
      if (body.method === 'ping') return result({});
      const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
      if (body.method === 'tools/list') return result({ tools: tools.map((tool: any) => ({
        name: tool.name, description: tool.description,
        inputSchema: { type: 'object', additionalProperties: false, required: ['runId', 'requestKey', 'input'], properties: {
          runId: { type: 'string', minLength: 1, maxLength: 120, description: 'Stable identifier for this task.' },
          requestKey: { type: 'string', minLength: 1, maxLength: 120, description: 'Unique operation key. Reuse only for an exact retry with the same runId and input.' },
          input: tool.inputSchema,
        } }, annotations: { readOnlyHint: !tool.mutating && !tool.mutationCondition, destructiveHint: !!tool.mutating, openWorldHint: false },
      })) });
      if (body.method !== 'tools/call') return error(-32601, 'Method not supported');
      const params = body.params;
      if (!record(params) || typeof params.name !== 'string' || !tools.some((tool: any) => tool.name === params.name)) return error(-32602, 'Tool is not granted');
      const args = params.arguments;
      if (!record(args) || Object.keys(args).some(key => !['runId', 'requestKey', 'input'].includes(key)) ||
        !['runId', 'requestKey'].every(key => typeof args[key] === 'string' && args[key].length > 0 && args[key].length <= 120) || !record(args.input)) return error(-32602, 'Expected runId, requestKey and input; project is fixed by this connection');
      const output = await agentJson(options, `/api/docgrid/agents/tools/${params.name}`, token,
        { projectId, runId: args.runId, requestKey: args.requestKey, traceId: randomUUID(), input: args.input }, controller.signal);
      return result({ content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output, isError: output.status === 'failed' });
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 401) return unauthorized();
      if (err instanceof UpstreamError && err.status === 403) return res.status(403).json({ error: 'Grant is expired, revoked, exhausted or outside scope' });
      if (record(req.body) && req.body.method === 'tools/call') return res.json({ jsonrpc: '2.0', id: req.body.id ?? null,
        result: { isError: true, content: [{ type: 'text', text: err instanceof UpstreamError && err.status === 409 ? 'Conflict: refresh the base version or check the existing operation. Do not change requestKey merely to retry.' : 'DocGrid did not complete the request. Check operation status before retrying.' }] } });
      return res.status(502).json({ error: 'DocGrid adapter unavailable' });
    } finally { res.off('close', disconnect); }
  });
  return router;
}
