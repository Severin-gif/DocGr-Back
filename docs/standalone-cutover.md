# Standalone DocGrid cutover — 2026-09-28

The owner authorized retiring the old projects and journals. New DocGrid storage starts empty.

1. Merge/deploy Doc-Back and the paired Legal Core retirement change. The public API origin remains `https://api.docgrid.ru`; frontend routes do not change.
2. In the next configuration phase, supply DATABASE_URL to Doc-Back. The runtime account needs DDL rights only on schema `docgrid` (or on a dedicated DocGrid database). The migration runner sets `schema=docgrid`, including its migration ledger. It never applies Legal Core migrations.
3. Retain AI-Orchestra's existing DOCGRID_IDENTITY_* values in Doc-Back. The signing key and `legal-core-docgrid` audience still need to match the issuer. The audience is a compatibility string, not a service location. Retain DOCGRID_SERVICE_TOKEN for OAuth encryption and optional review integration.
4. Move DOCGRID_S3_* settings to Doc-Back and select DOCGRID_MATERIAL_STORAGE=s3 after a verified upload/download. Do not paste secrets into issues or PRs.
5. Verify `/ready`, login, create a project, upload a nested folder, download an original, grant/revoke an LLM connection and check human-only approval. Legal Core must not receive any DocGrid traffic. Its `/api/docgrid/*` routes are removed.

Until the database/settings phase, `/health` only confirms a running process; `/ready` must remain 503. Do not report the production migration complete based on a successful build.

The paired Core migration deletes only projects identified by old DocGrid branches and documents/tasks linked by its adapter tables, then removes DocGrid-owned tables. Shared CODEX accounts, corpus and unrelated workspace/documents remain. Migration history stays immutable. S3 object deletion is not part of deployment; orphaned immutable objects can be removed separately after storage configuration is checked.
