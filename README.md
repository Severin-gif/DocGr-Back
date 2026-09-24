# DocGrid Back / BFF

Repository name is historical: `dochub-back`. Its production role is now the public API gateway for **DocGrid**.

## Architecture

```
docgrid.ru
   |
   v
api.docgrid.ru
DocGrid BFF (this repository)
   |
   v
legal-core /api/docgrid/*
   |
   +--> PostgreSQL (GitLaw data)
   |
   +--> AI-Orchestra for AI review
```

This service intentionally has **no database and no user table**.

It does not:
- run SQL migrations;
- accept `X-User-Email` demo authentication;
- store projects/documents;
- expose the rest of legal-core;
- expose legal-core internal/admin routes;
- call OpenRouter directly.

The browser obtains a short-lived `docgrid_access` token from AI-Orchestra. This BFF verifies its HS256 signature, issuer, audience, type and expiry. The browser token terminates here and is never forwarded to legal-core.

After verification the BFF sends normalized identity headers to legal-core together with the independent server-only `DOCGRID_SERVICE_TOKEN`.

## TimeWeb

Existing application and domain remain:

- app: **Doc-Back**
- domain: **https://api.docgrid.ru**
- container port: **4000**
- health: **GET /health**
- readiness: **GET /ready**

Required environment:

```env
NODE_ENV=production
PORT=4000
LEGAL_CORE_URL=https://sps.codex-chat.ru
CORS_ORIGINS=https://docgrid.ru,https://www.docgrid.ru
UPSTREAM_TIMEOUT_MS=90000
UPSTREAM_READY_TIMEOUT_MS=5000
MAX_RESPONSE_BYTES=32000000

DOCGRID_IDENTITY_JWT_SECRET=<same as AI-Orchestra>
DOCGRID_IDENTITY_ISSUER=ai-orchestra
DOCGRID_IDENTITY_AUDIENCE=legal-core-docgrid
DOCGRID_SERVICE_TOKEN=<same as legal-core>
```

There is **no DATABASE_URL** in this service anymore.

## Frontend

Build the DocGrid frontend with:

```env
NEXT_PUBLIC_API_URL=https://api.docgrid.ru/api
NEXT_PUBLIC_IDENTITY_API_URL=https://<AI-Orchestra public origin>
NEXT_PUBLIC_PRODUCT_NAME=DocGrid
```

The first value is a build-time Next.js public variable. Rebuild the frontend after changing it.

## Security boundary

The route policy is explicit and method-specific. Requests outside the current GitLaw API are returned as 404. Cookies, provider keys, internal service tokens and arbitrary client headers are not forwarded.

Technical logs include request ID, method, path, upstream status and latency. They do not include document bodies or Bearer tokens.

## Astra direct document adapter (ASTRA-DG-001)

The matching `legal-core` Astra migrations and controller must be released before
enabling the frontend control page. No new secrets, databases, model providers or
CODEX Chat transport are introduced in this BFF.

- Agent: `POST /api/docgrid/astra/tools/docgrid_<operation>` with an opaque
  `Bearer dga_…` grant issued by the project owner. JSON envelope contains
  `projectId`, `runId`, `traceId`, `requestKey` (mandatory for mutations), and
  `input`. Discover actual tools and input schemas with `docgrid_get_capabilities`.
- Owner: `/api/docgrid/repositories/:projectId/astra/catalog`, `/grants`,
  `/operations` and per-operation `/approve` or `/cancel`, using the existing
  human DocGrid identity. Approval cannot be performed with an agent credential.
- Exact agent download: `GET /api/docgrid/astra/artifacts/:artifactId/versions/:version/:format?projectId=:projectId`,
  where format is `docx` or `pdf`. Bearer is required; tokens are never put in URLs.
- Verified original: `GET /api/docgrid/astra/sources/:sourceId/original?projectId=:projectId&snapshotId=:snapshotId&hash=:sha256`.
  This also supports an unread original; it never claims successful extraction.
- Exact human article/history/download paths remain under the project-scoped
  `/repositories/:projectId/astra/artifacts/` namespace.

The agent route forwards only the independently configured server token and the
opaque grant to the domain adapter. The domain checks live grant revocation,
project/source scope, expiry, idempotency and operation caps on every request.
Client cookies, human identity headers and arbitrary URLs never reach this lane.
Responses are bounded and `no-store`; errors do not include upstream bodies.

`npm test` covers credential separation and the HTTP adapter with a synthetic
upstream. Production rollout and a real project run remain separate steps.
