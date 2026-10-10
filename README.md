# DocGrid Back

Independent backend for https://api.docgrid.ru. Owns projects, folders, immutable originals, branches, reviews, conflict handling, journal, access grants, OAuth/MCP and approved document exports. There are no runtime requests to Legal Core and no LEGAL_CORE_URL setting.

## Runtime

Node 24 / Nest / Express / PostgreSQL / private S3. Existing `/api/docgrid/*`, OAuth and MCP URLs are preserved. Human JWTs are verified directly; user-controlled identity headers are ignored. Agent bearer grants remain scoped to projects and allowed actions. Only authenticated humans can approve plans and proposals.

AI-Orchestra remains the identity issuer and optional review service. It is not the document database. The historical JWT audience `legal-core-docgrid` is retained for issuer compatibility; it does not indicate a Legal Core dependency.

## Database and deployment

Copy `.env.example` into the deployment settings in the next configuration step. `DATABASE_URL` is now required for project operations. All DocGrid tables, mirrored identities, document versions and Prisma migration history use schema `docgrid`. A dedicated database/role is preferred; sharing a PostgreSQL server does not share table ownership. Do not run `prisma db push` against a shared database.

`npm run db:migrate` applies migrations using `schema=docgrid` in the connection URL. The container runs it before startup when DATABASE_URL is present. Without a database the process exposes `/health` but `/ready` returns 503. Failed migrations stop startup. `/ready` checks a real DocGrid table, not another service's homepage.

The September 2026 cutover intentionally starts with empty DocGrid projects, as authorized by the owner. It does not copy old Legal Core data. The paired Core PR removes its DocGrid module and dedicated data; shared CODEX users, corpus and unrelated documents remain.

For originals select `DOCGRID_MATERIAL_STORAGE=s3` and supply all `DOCGRID_S3_*` settings in **Doc-Back**. Generated DOCX/PDF exports use the same dedicated storage credentials. Upload limits and immutable-byte checks remain in place. Changing storage configuration alone does not migrate old database originals.

Docker includes Poppler and resource limits for isolated PDF extraction, LibreOffice for PDF exports and pg_dump for optional schema-only backups. Mount DOCGRID_BACKUP_DIR on durable storage before enabling backups.

## Checks

- `npm ci && npm run check && npm test`: protocol tests, real SQL domain tests, file integrity and isolated extraction.
- `DATABASE_URL=postgresql://.../docgrid_test npm run db:migrate && npm run test:postgres`: full HTTP/Prisma acceptance against an isolated database. The acceptance script refuses non-test remote databases.
- `npm run test:embedded`: same HTTP acceptance through a local PGlite PostgreSQL wire server; real PostgreSQL CI remains authoritative for concurrency.

See [cutover](docs/standalone-cutover.md) for the deployment sequence and checks.

## Product access contract (10 October 2026)

AI-Orchestra remains the shared identity and CODEX billing authority. The
legacy `plan` claim / mirrored `User.plan` describe CODEX, not a DocGrid paid
plan. Verified dedicated tokens can additionally carry `docgridAccess`.
The guard puts separate `codexPlan` and `docgridAccess` in `request.user` while
keeping old fields and project membership/ownership checks unchanged.

Sources compose independently: CODEX Pro, a standalone DocGrid period and
legacy Business. Early workspace access remains available. Period ends are
rechecked on every token verification; early access does not invent paid
rights from a missing claim or an old global plan. Revocations are reflected
at token re-exchange, bounded by the existing 60–900-second JWT TTL (normally
300 seconds); immediate online revocation is a prerequisite decision before
paid-only gates are launched.

No new paid quotas or checkout are enabled here. Licensed document products
are separate SKU/terms-version grants in AI-Orchestra, not CODEX upgrades or
DocGrid membership. Buying a product must never bypass project ACLs. License
content delivery requires a fresh server check and remains a later phase.

Deploy the additive AI-Orchestra migration and issuer first, then this API,
then the frontend. Existing accounts, projects, source files, versions, roles
and current storage/AI limits remain intact. See
https://github.com/Severin-gif/AI-Orchestra/blob/main/docs/product-tariff-architecture.md
for the capability matrix, pending prices/license terms and payment rollout.
