-- Additive: old text projections remain readable; new revisions store actual DOCX.
ALTER TABLE docgrid.docgrid_branch_documents
  ADD COLUMN docx_bytes BYTEA,
  ADD COLUMN docx_sha256 CHAR(64),
  ADD COLUMN format_version TEXT;
ALTER TABLE docgrid.docgrid_commits
  ADD COLUMN docx_bytes BYTEA,
  ADD COLUMN docx_sha256 CHAR(64),
  ADD COLUMN format_version TEXT;
ALTER TABLE docgrid.docgrid_branch_documents ADD CONSTRAINT dg_branch_docx_snapshot
  CHECK ((docx_bytes IS NULL AND docx_sha256 IS NULL AND format_version IS NULL)
    OR (docx_bytes IS NOT NULL AND docx_sha256 IS NOT NULL AND format_version IS NOT NULL));
ALTER TABLE docgrid.docgrid_commits ADD CONSTRAINT dg_commit_docx_snapshot
  CHECK ((docx_bytes IS NULL AND docx_sha256 IS NULL AND format_version IS NULL)
    OR (docx_bytes IS NOT NULL AND docx_sha256 IS NOT NULL AND format_version IS NOT NULL));
