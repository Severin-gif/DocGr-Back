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

The browser obtains a short-lived `docgrid_access` token from AI-Orchestra. This BFF forwards that Bearer token only to the allowlisted `/api/docgrid/*` routes in legal-core.

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
