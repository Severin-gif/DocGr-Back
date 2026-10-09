# External read access and corpus preparation

Owners create a folder share in Participants → Shared links. `/` explicitly shares the whole project; a selected folder includes its subfolders and future files. Existing READ/PROPOSE tokens and their expiration are reused. Only token hashes are persisted. Working documents use `main`; prepared document artifacts use their current committed version. Draft branches and other projects are excluded.

The human URL is `/shared/<token>`. The machine URL `/shared/<token>/ai` is a public JSON HTTP reader with no login or JavaScript requirement. An external application must be able to fetch URLs and follow pagination; a link cannot itself force an LLM to read the whole corpus. Existing MCP transport remains available for controlled agent workflows.

## HTTP contract

- Public backend index: `GET /api/docgrid/shared/:token/manifest?offset=0&limit=50`. Limits: 1–200 sources per page. The first response supplies `indexVersion`; further pages require it. A changed index returns 409 instead of silently skipping files. `nextSourceOffset=null` ends the listed index.
- Public text: `GET /api/docgrid/shared/:token/files/:kind/:id/text?version=<source.version>&offset=0&limit=50000`, where kind is material, document or artifact. Limits: 2–50000 UTF-16 code units per chunk. `nextOffset=null` ends the text. Source version binds original hash/revision, extracted-text hash, page metadata, path, title and extraction state. Changed text returns 409. Never replace the version during continuation: restart from a fresh index.
- The frontend machine reader supplies absolute `textUrl`, `nextUrl`, `nextIndexUrl` and original-download URLs for materials/working documents. Prepared artifacts expose canonical text; their existing authenticated binary export is separate.
- Owner coverage: `GET /api/docgrid/repositories/:projectId/ai-corpus?path=/Case`. Includes readiness counts, extraction gaps and approximate token volume without returning full text.
- Owner access counts: `GET /api/docgrid/repositories/:projectId/access-summary`.
- Bulk revocation: `POST /api/docgrid/repositories/:projectId/access/revoke-all` with exactly `{ "scope": "external" }` or `{ "scope": "all" }`. External revokes all existing share tokens and non-builtin agent grants and cancels their pending operations; all additionally removes project memberships except the owner. Builtin owner access, documents, other projects and audit records are retained. The transaction locks the project, so concurrent issuance and membership changes serialize with revocation. Subsequent issuance is allowed. Already downloaded copies cannot be recalled.

Index and text responses use no-store, no-referrer and noindex. All reads revalidate the live share, expiry, project and folder scope. Source contents are untrusted data, not agent instructions. Links provide read access to whoever possesses them. Revocation cannot stop a response already authorized before revocation committed.

## Coverage and limits

The index covers at most 5000 sources and 32 MiB of combined working/prepared document content; materials expose at most 2 million extracted characters each. `total`, `indexed` and `indexComplete` explicitly report omissions. Readiness counts apply to the indexed sources across all index pages. `complete` only describes extraction coverage, not whether a client has consumed every page or whether recognition is accurate. A READY status does not guarantee extraction of layout or every visible character. Empty text is UNREAD; partial sources remain visible.

HTML is extracted in a time/memory-limited subprocess without running scripts or loading resources. TXT/MD/CSV/TSV/JSON/XML are UTF-8 text, capped at 200000 characters. DOC/DOCX/XLS/XLSX/ODT use bounded local conversion; PPTX reads slide text in numeric slide order and reports omitted images, notes and embedded objects as partial. DOCX embedded drawings/objects and XLSX/ODT media also mark partial extraction. Corrupt, encrypted and unsupported formats retain their originals and explicit failure status. Legacy encodings require conversion to UTF-8.

The owner's Prepare missing text action retries supported materials sequentially with cancellation and puts PDF/images into the existing persistent local OCR queue. OCR progress refreshes while jobs are queued/running. Existing text survives failed re-extraction. OCR does not run on images embedded in Word/presentations: export those pages to PDF/images for OCR, or supply a text version. OCR quality, handwriting and complex tables need review against originals. Preparing text does not call a paid LLM.

Token volume is a rough 2–4 characters/token range over available text, not a provider count or an estimate for unread pages. Model billing uses actual input/output tokens, prompts, reasoning and retries; multi-pass analysis and repeated full-corpus reading multiply charges. Use source versions to avoid reprocessing unchanged files and retain citations to originals/pages.

## Validation

`npm test`; `node scripts/docgrid-upload-extraction-test.cjs`; `node scripts/standalone-http-test.cjs --embedded --shares-only` (after build). Acceptance uses synthetic projects and an embedded PostgreSQL-compatible database, never production links. Paired frontend has browser acceptance and HTTP tests for anonymous machine reading, pagination and revocation propagation. Deploy backend before frontend; no new schema migration or LLM credential is required.
