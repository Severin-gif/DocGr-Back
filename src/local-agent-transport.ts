import { HttpException } from '@nestjs/common';
import { AstraService } from './modules/docgrid/astra/astra.service';
import { AgentOAuthCodeStore } from './modules/docgrid/agent-oauth.controller';

/** Existing OAuth/MCP wire protocol, dispatched in-process. No upstream server. */
export function localAgentTransport(agents: AstraService, codes: AgentOAuthCodeStore): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const token = headers.get('X-DocGrid-Agent-Token') || '';
    try {
      init?.signal?.throwIfAborted();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      let result: unknown;
      if (init?.method === 'GET' && url.pathname === '/api/docgrid/agents/catalog') {
        result = await agents.describeGrant(token, url.searchParams.get('projectId') || '');
      } else if (init?.method === 'POST' && /^\/api\/docgrid\/agents\/tools\/docgrid_[a-z_]+$/.test(url.pathname)) {
        result = await agents.execute(token, url.pathname.split('/').pop()!, body);
      } else if (init?.method === 'POST' && url.pathname === '/api/docgrid/internal/agent-oauth/codes') {
        result = await codes.save(body);
      } else if (init?.method === 'POST' && url.pathname === '/api/docgrid/internal/agent-oauth/exchange') {
        result = await codes.consume(body);
      } else return Response.json({ error: 'Unknown internal operation' }, { status: 404 });
      return Response.json(result);
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 500;
      return Response.json({ error: 'DocGrid operation failed' }, { status });
    }
  }) as typeof fetch;
}
