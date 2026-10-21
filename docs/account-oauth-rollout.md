# Account OAuth for external AI

## Contract

One connection authorizes one owner-selected project. No administrative key is
issued. The user signs in through the existing DocGrid identity service; the
Nest identity guard rejects MCP/project credentials on consent endpoints.
The existing grant service checks ownership, current account block and live ACL,
hashes the underlying credential, logs creation/revocation and enforces actions,
expiry, operation quota, private-chat isolation and human approvals.

Authorization code + S256 PKCE, exact registered redirect URI, resource binding,
DCR public clients (`none`), discovery and RFC 9207 issuer responses are supported.
Requested tool-name scopes limit the consent choices. Legacy `docgrid` scope
allows the user to choose a subset of tools. Nothing is checked by default.
Consent includes current/future project documents; individual-source restrictions
remain available through the existing manually created project-key workflow.
Account grants last seven days / 10,000 operations. There are no refresh tokens:
renewal and switching projects require fresh consent. There is no OIDC UserInfo,
CIMD or Enterprise verified-domain linking support in this release.

The initial encrypted ticket is transported in a fragment, removed by the UI,
and submitted with the account bearer token. The approval receipt is bound to
that account, atomically single-use and expires after 120 seconds. Authorization
codes expire after 120 seconds and bind client, redirect, resource and PKCE.
Grant issuance failures after creation attempt immediate revocation.

## Deploy without breaking existing connections

1. Deploy backend with `DOCGRID_ACCOUNT_OAUTH_ENABLED=false` (default). No new
   migration or secret is needed. Keep the existing service encryption key stable
   across replicas; rotating it invalidates registered clients and tokens.
2. Deploy frontend containing `/oauth/consent`. Keep identity/API origins configured
   as before. `DOCGRID_CONSENT_URL` defaults to `https://docgrid.ru/oauth/consent`.
   Ensure that frontend origin is in backend `CORS_ORIGINS`.
3. Verify frontend route and backend health/readiness; enable
   `DOCGRID_ACCOUNT_OAUTH_ENABLED=true` on every backend replica.
4. Discover `/.well-known/oauth-authorization-server/api/docgrid/oauth`; register
   a client; confirm authorize redirects to the consent page. Check correct issuer,
   HTTPS origin and per-tool scopes. Never log bearer tokens, codes or tickets.
5. Connect a test account in ChatGPT custom MCP using
   `https://api.docgrid.ru/api/docgrid/mcp`, OAuth/DCR. Use the redirect URI shown
   by its management screen. Choose one project and one read tool, call it, then
   revoke in Integrations and verify access fails. Repeat with a second account.
6. Before broader rollout, test another supported remote MCP client. A local SDK
   pass does not certify ChatGPT UI, proxy routing or production identity exchange.

Rollback: disable the flag on all replicas. Existing grants still require live
authorization and can be revoked. Keep the new frontend during rollback; it
reads `accountOAuthEnabled` and explains the legacy key flow when disabled.

## Reproducible checks

`npm test` includes `scripts/account-oauth-acceptance.cjs` through the isolated
PostgreSQL/HTTP suite. It tests DCR, PKCE, exact audience, account/project/action
isolation, consent rejection, one-use receipts/codes and revocation. The actual
`@modelcontextprotocol/sdk` Streamable HTTP client initializes, lists and invokes
tools over HTTP. Account authentication uses synthetic test identities, not
production credentials. Frontend: typecheck, build, unit tests and
`node tests/account-oauth-browser.cjs` with Playwright/Chromium available.

## Public ChatGPT distribution — remaining owner steps

Public distribution is separate from private custom MCP connections. OpenAI
requires a verified publisher, submission permissions, a reachable production
server, a usable demo account, privacy/company URLs, branding, test prompts and
accurate tool metadata. Submit, pass review, then publish in the submission portal.
The code adds tool OAuth security schemes and issuer identification; it does not
verify a publisher, create a demo identity, publish legal policies or submit an app.
No account or production test is claimed by the automated suite.

Sources checked 2026-10-20:
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/plugins/deploy/app-review
- https://developers.openai.com/plugins/deploy/submission

OAuth discovery advertises the legacy `docgrid` scope alongside tool-specific
scopes in both authorization-server and protected-resource metadata. Legacy
`docgrid` requests still require explicit project/tool consent; discovery does
not grant any permission. Prefer tool-specific scopes for least privilege.
