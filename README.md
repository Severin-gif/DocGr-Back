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
