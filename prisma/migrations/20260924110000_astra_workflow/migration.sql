-- Text is persisted before export; READY retains its existing both-files constraint.
ALTER TYPE docgrid."DocumentVersionStatus" ADD VALUE IF NOT EXISTS 'CONTENT_READY';

-- Bind the existing canonical document workflow to project/grant scoped operations.
-- No duplicate document generator or alternate canonical content store is introduced.
CREATE TABLE docgrid.dg_astra_document_tasks (
 task_id UUID PRIMARY KEY REFERENCES docgrid.document_tasks(id) ON DELETE RESTRICT,
 project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE RESTRICT,
 grant_id UUID NOT NULL,
 operation_id UUID NOT NULL,
 plan_digest CHAR(64) NOT NULL,
 scope_digest CHAR(64) NOT NULL,
 plan_revision INTEGER NOT NULL CHECK(plan_revision > 0),
 source_snapshot_id UUID NOT NULL,
 source_refs JSONB NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('AWAITING_CONFIRMATION','APPROVED','SUBMITTED','CANCELLED')),
 approved_by TEXT REFERENCES docgrid."User"(id), approved_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE docgrid.dg_astra_documents (
 document_id UUID PRIMARY KEY REFERENCES docgrid.prepared_legal_documents(id) ON DELETE RESTRICT,
 project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE RESTRICT,
 task_id UUID NOT NULL UNIQUE REFERENCES docgrid.dg_astra_document_tasks(task_id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE docgrid.dg_astra_document_versions (
 version_id UUID PRIMARY KEY REFERENCES docgrid.document_versions(id) ON DELETE RESTRICT,
 operation_id UUID NOT NULL UNIQUE,
 source_snapshot_id UUID NOT NULL,
 source_refs JSONB NOT NULL,
 content_hash CHAR(64) NOT NULL,
 export_status TEXT NOT NULL DEFAULT 'NOT_EXPORTED' CHECK(export_status IN ('NOT_EXPORTED','DOCX_READY','READY','PREVIEW_FAILED')),
 pdf_hash CHAR(64), preview_error VARCHAR(240), agent_ref TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE docgrid.dg_astra_document_proposals (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 operation_id UUID NOT NULL UNIQUE,
 project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id),
 document_id UUID NOT NULL REFERENCES docgrid.dg_astra_documents(document_id),
 base_version INTEGER NOT NULL,
 content JSONB NOT NULL, changes JSONB NOT NULL,
 source_snapshot_id UUID NOT NULL, source_refs JSONB NOT NULL,
 content_hash CHAR(64) NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PROPOSED','ACCEPTED','CANCELLED')),
 accepted_by TEXT REFERENCES docgrid."User"(id), accepted_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dg_astra_documents_project_idx ON docgrid.dg_astra_documents(project_id);
CREATE INDEX dg_astra_document_tasks_project_idx ON docgrid.dg_astra_document_tasks(project_id);
-- Canonical text and provenance cannot be overwritten after an ASTRA version exists.
-- Export fields may advance from absent to present; published bytes are never replaced.
CREATE FUNCTION docgrid.dg_astra_immutable_document_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM docgrid.dg_astra_document_versions WHERE version_id=OLD.id) THEN
  IF NEW.structured_content IS DISTINCT FROM OLD.structured_content OR NEW.plain_text IS DISTINCT FROM OLD.plain_text
   OR NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.version IS DISTINCT FROM OLD.version
   OR NEW.title IS DISTINCT FROM OLD.title OR NEW.source_version_id IS DISTINCT FROM OLD.source_version_id
   OR (OLD.docx_object_key IS NOT NULL AND NEW.docx_object_key IS DISTINCT FROM OLD.docx_object_key)
   OR (OLD.pdf_object_key IS NOT NULL AND NEW.pdf_object_key IS DISTINCT FROM OLD.pdf_object_key)
   OR (OLD.checksum IS NOT NULL AND NEW.checksum IS DISTINCT FROM OLD.checksum)
   OR (OLD.docx_size IS NOT NULL AND NEW.docx_size IS DISTINCT FROM OLD.docx_size)
   OR (OLD.pdf_size IS NOT NULL AND NEW.pdf_size IS DISTINCT FROM OLD.pdf_size) THEN
   RAISE EXCEPTION 'ASTRA document version is immutable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dg_astra_document_version_immutable BEFORE UPDATE ON docgrid.document_versions
 FOR EACH ROW EXECUTE FUNCTION docgrid.dg_astra_immutable_document_version();

