# OCR and project-wide retrieval

DocGr-Back owns OCR, searchable extraction and project authorization. AI Orchestra (Timeweb app **235989**, `https://ai.codex-sps.ru`) receives selected evidence for generation through the existing authenticated `/internal/docgrid/discussion` route. Legal Core is not involved.

## Deployment

1. Deploy DocGr-Back with the migration `20260929140000_docgrid_ocr_search` and its Dockerfile. The image installs Poppler and Tesseract with Russian and English language data. Production OCR is enabled by default; `DOCGRID_OCR_ENABLED=false` pauses the background worker without deleting progress.
2. Existing and new PDF, PNG, JPEG, BMP and WebP materials are queued automatically. No re-upload or new storage service is necessary. One OCR worker runs across replicas. Progress and per-page checkpoints live in PostgreSQL; originals remain in the existing private S3/database storage.
3. Deploy DocGr-fr. “Поиск по содержимому” sits beside the file tree. Project information shows queue progress and unread pages. Search itself works when built-in LLM is disabled.
4. In Doc-Back, set `DOCGRID_ORCHESTRA_URL=https://ai.codex-sps.ru`. Keep the same existing `DOCGRID_SERVICE_TOKEN` (at least 32 characters) in Doc-Back and AI Orchestra. Do not put credentials in the frontend.
5. In AI Orchestra app 235989, set `DOCGRID_ENABLED=true`, configure the existing OpenRouter key, and choose `DOCGRID_MODEL` / `DOCGRID_DISCUSSION_MODELS`. These variables affect DocGrid; do not change CODEX CHAT routing. A non-empty model list is connectivity evidence only; a successful message is needed to verify generation.

Timeweb runtime variables are not changed by these PRs.

## Behavior and limits

- OCR tries native PDF text per page first; sparse/image-only pages use local Tesseract `rus+eng`. Blank or unreadable pages remain explicitly unread. OCR is not handwriting recognition or verification of amounts, names or legal facts. Images embedded inside Office files and multipage TIFF are not OCRed in this version.
- A file is bounded to 64 MiB, 1,000 pages and approximately 2 million extracted characters. Subprocesses have 512 MiB address space, one OCR thread, 45 CPU seconds, 60-second wall time and bounded output. Page-level failures yield partial coverage. Failed extraction does not replace longer existing text.
- Expired leases resume persisted pages, with at most three job attempts. A manual retry keeps successful page checkpoints and retries unread pages. No original is overwritten, moved or deleted.
- Russian stemming plus literal Latin/numeric tokens searches overlapping 2,400-character passages across **all authorized stored text**, including later parts of documents. Results include immutable source revision, exact UTF-16 range and PDF/image page where available. This is lexical retrieval, not semantic/vector search.
- Human search has stable pagination. Agent `docgrid_search` adds `mode: "ranked"`; `fulltext` and `filename` remain compatible. Project ACL, grant scopes, revocation and cursor bindings still apply. Agent source reads accept the located source reference returned by search.
- Chat automatically retrieves by the question (or an explicit search query). Up to 150 ranked passages are considered for a bounded evidence bundle of up to 20 distinct sources / 95,000 characters. This limits the model context, **not the searched corpus**. Broad questions without hits use a labelled initial sample; sorting without a query still processes batches. UI coverage distinguishes retrieval from reading the complete case.
- Snapshot capture pins extraction revisions without re-downloading the whole case from S3. Original checksums are verified on upload, OCR and original download. Search does not claim a fresh original-byte verification. Snapshots are limited to 5,000 sources / 128 MiB text, with existing retention safeguards (64 snapshots / 512 MiB text per project); exceeding these produces an explicit error, never silent omission. Old snapshots and proposals are not rewritten after OCR.

## Verification

`npm run test:embedded` exercises real Prisma/PostgreSQL SQL and Tesseract: Russian PNG, two-page scanned PDF, expired-lease resume, preserved original hashes and previous text, evidence beyond source 20 / character 5,000, page locators, scoped grants, immutable snapshots, pagination and revoked access. CI installs the same language data. No production documents or paid LLM calls are used by the tests.
