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

OAuth codes are stored in the Doc-Back database and consumed atomically once. Code payloads
and issued access tokens are encrypted with purpose-separated keys derived from
the existing server secret. Codes bind client, redirect, resource and PKCE.
The original grant remains authoritative for expiry, revocation and scope.
Refresh grants are not advertised or supported in this version. Reauthorization
is needed on expiry. Rotating `DOCGRID_SERVICE_TOKEN` invalidates OAuth client
registrations and access tokens; direct project grants remain in the domain DB.

Deploy the standalone Doc-Back routes and `20260925121500_docgrid_agent_oauth`
migration before this gateway, and the updated frontend last. The public origin
defaults to the existing `https://api.docgrid.ru`, configurable with
`DOCGRID_PUBLIC_ORIGIN`. Do not expose the internal code-store routes through
the general proxy. No new database is created in Doc-Back.

`npm test` checks a complete synthetic OAuth exchange, wrong PKCE/resource,
replayed code, forged consent, revoked grant, filtered discovery, project binding,
unchanged retry keys and isolation from human approval. Actual client registration
and a production operation are separate release checks.


## Universal endpoint and integration dashboard (v1.2)

The canonical MCP resource is now `/api/docgrid/mcp`; project-specific URLs remain
compatible. A key still covers exactly one project. The universal route resolves
the project from the key hash and then runs the same live ACL, action, expiry,
revocation and quota checks. OAuth tokens bind the exact resource and project;
a token for one MCP URL is not accepted at another URL. No key is sent in a URL.

`GET /api/docgrid/integrations` requires a human identity, lists owned projects
with UUID pagination, and provides configured MCP/API/OpenAPI URLs. Key creation
and revocation reuse the existing project human control plane. Any signed-in
user with an owned project can create a connection, independently of model brand.
The frontend is `/workspace/integrations`.

Direct API alias: `/api/docgrid/v1`. `GET /catalog` discovers the permitted tools
and project without a projectId parameter. `POST /tools/{toolName}` accepts the
existing operation envelope, with projectId optional; a supplied projectId must
still match the key. `GET /api/docgrid/openapi.json` is a public OpenAPI 3.1 schema
containing tool metadata only. POST responses use 201 and durable operation IDs.
Use the same requestKey/runId/input for retries. Inspect failed/approval states.

Example (the key comes from a protected environment variable):

```sh
curl https://api.docgrid.ru/api/docgrid/v1/catalog \
  -H "Authorization: Bearer $DOCGRID_KEY"
curl https://api.docgrid.ru/api/docgrid/v1/tools/docgrid_get_project \
  -H "Authorization: Bearer $DOCGRID_KEY" -H 'Content-Type: application/json' \
  -d '{"runId":"case-review","traceId":"case-review","requestKey":"project-1","input":{}}'
```

### Chat quality tools

Explicit grants may include `docgrid_list_discussions`, `docgrid_read_chat_turn`,
and `docgrid_submit_chat_review`. They expose only the grant owner's own chat in
that project. Source-restricted grants cannot include chat tools: derived memory
and history may refer to sources outside the answer's visible citations.
Operations from a chat-enabled grant are also private in human ledger views,
including operations wrapping `get_operation` results.

New turns persist `context.modelInput`, the exact bounded request sent from
DocGrid to Orchestra. The final provider prompt/system instructions are not
captured here. Legacy turns return `legacy_request_not_recorded` rather than
inventing historic evidence. Snapshot references pin document versions and OCR
text. Source freshness checks compare current versions/extraction with the saved
snapshot. They do not detect documents added later or verify current law.

A review requires the answerDigest returned by read_chat_turn. Changes to the
answer/context/provider invalidate that digest. Quotes and source references are
verified against the answer snapshot; supported/contradicted findings require
quotes. Reviews remain external model assessments, not proof of semantic/legal
correctness. They are stored in the existing durable operation ledger and do not
change the original answer. Human review reads return currentReviewStatus so
later edits mark the assessment stale. No new migration, model call or secret is
required by these additions.

### Deployment and verification

Deploy backend first, frontend second. The current OAuth flow asks for a scoped
key on the DocGrid consent page; account-login OAuth and refresh tokens are not
implemented. This is a custom MCP integration, not a listing in any public app
store. Each AI client must support the advertised transport/authentication.

`npm run test:integrations` checks real HTTP routes against isolated embedded
PostgreSQL: personal/project isolation, universal API/MCP, explicit chat scope,
quote validation, immutable evidence, stale reviews, idempotency and revocation.
It is included in the normal domain test chain. OAuth tests exercise both MCP
resources. `--discussions-only` additionally verifies captured model requests.
