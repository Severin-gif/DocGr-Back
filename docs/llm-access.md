# External LLM connections

Each connection uses a project-owner-issued DocGrid grant. There is no privileged
model name. Canonical REST namespaces are `/api/docgrid/agents` and
`/api/docgrid/repositories/:projectId/agents`; legacy `astra` paths remain valid.

Add `https://api.docgrid.ru/api/docgrid/mcp/<projectId>` to a compatible MCP client.
Streamable HTTP supports JSON responses and protocol versions 2025-03-26,
2025-06-18 and 2025-11-25; GET streaming and server-initiated requests are not used.
Requests include bearer authorization; keys never belong in URLs. The MCP URL
fixes the project, and domain scope checks run for discovery and every tool call.

For clients supporting custom headers, use the project's `dga_...` grant as Bearer.
OAuth clients discover protected-resource and authorization-server metadata, then
register with HTTPS (or local loopback HTTP) redirect URIs. Public clients use
Authorization Code with PKCE S256 and `token_endpoint_auth_method=none`.
The consent page asks the user for an existing scoped DocGrid connection key from
the project's Access section. It does not accept a platform password or create
broader permissions. No provider/model API key is needed by DocGrid.

OAuth codes are stored in Legal Core and consumed atomically once. Code payloads
and issued access tokens are encrypted with purpose-separated keys derived from
the existing server secret. Codes bind client, redirect, resource and PKCE.
The original grant remains authoritative for expiry, revocation and scope.
Refresh grants are not advertised or supported in this version. Reauthorization
is needed on expiry. Rotating `DOCGRID_SERVICE_TOKEN` invalidates OAuth client
registrations and access tokens; direct project grants remain in the domain DB.

Deploy Legal Core's common routes and `20260925121500_docgrid_agent_oauth`
migration before this gateway, and the updated frontend last. The public origin
defaults to the existing `https://api.docgrid.ru`, configurable with
`DOCGRID_PUBLIC_ORIGIN`. Do not expose the internal code-store routes through
the general proxy. No new database is created in Doc-Back.

`npm test` checks a complete synthetic OAuth exchange, wrong PKCE/resource,
replayed code, forged consent, revoked grant, filtered discovery, project binding,
unchanged retry keys and isolation from human approval. Actual client registration
and a production operation are separate release checks.
