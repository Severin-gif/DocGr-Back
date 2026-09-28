ALTER TABLE docgrid.docgrid_branch_documents ADD COLUMN base_content TEXT, ADD COLUMN base_branch_id UUID REFERENCES docgrid.docgrid_branches(id);
ALTER TABLE docgrid.workspace_documents ADD COLUMN docgrid_deleted_at TIMESTAMPTZ;
ALTER TABLE docgrid.docgrid_reviews DROP CONSTRAINT docgrid_reviews_status_check;
ALTER TABLE docgrid.docgrid_reviews ADD CONSTRAINT docgrid_reviews_status_check CHECK (status IN ('OPEN','CONFLICT','MERGED','CLOSED'));
CREATE TABLE docgrid.docgrid_materials (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 title VARCHAR(180) NOT NULL, path VARCHAR(500) NOT NULL DEFAULT '/', mime VARCHAR(150) NOT NULL,
 bytes BYTEA NOT NULL, sha256 CHAR(64) NOT NULL, extracted_text TEXT NOT NULL DEFAULT '',
 extraction_status VARCHAR(30) NOT NULL DEFAULT 'UNREAD', created_by TEXT NOT NULL REFERENCES docgrid."User"(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), deleted_at TIMESTAMPTZ,
 CHECK (octet_length(bytes) <= 10485760)
);
CREATE INDEX docgrid_materials_project_idx ON docgrid.docgrid_materials(project_id);
-- Source bytes are immutable even if an application accidentally issues an UPDATE.
CREATE FUNCTION docgrid.docgrid_immutable_material() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.bytes IS DISTINCT FROM OLD.bytes OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
  RAISE EXCEPTION 'DocGrid source material is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER docgrid_material_immutable BEFORE UPDATE ON docgrid.docgrid_materials FOR EACH ROW EXECUTE FUNCTION docgrid.docgrid_immutable_material();
CREATE TABLE docgrid.docgrid_members (
 project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES docgrid."User"(id), role VARCHAR(16) NOT NULL CHECK(role IN ('READER','EDITOR','REVIEWER')),
 PRIMARY KEY(project_id,user_id)
);
CREATE TABLE docgrid.docgrid_folders (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 path VARCHAR(500) NOT NULL, UNIQUE(project_id,path)
);
CREATE TABLE docgrid.docgrid_judgments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 source_branch_id UUID NOT NULL REFERENCES docgrid.docgrid_branches(id), target_branch_id UUID NOT NULL REFERENCES docgrid.docgrid_branches(id),
 actor_id TEXT NOT NULL REFERENCES docgrid."User"(id), fingerprint CHAR(64) NOT NULL, result JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX docgrid_judgments_branch_idx ON docgrid.docgrid_judgments(source_branch_id,created_at DESC);
CREATE TABLE docgrid.docgrid_comments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 document_id UUID NOT NULL REFERENCES docgrid.workspace_documents(id), branch_id UUID NOT NULL REFERENCES docgrid.docgrid_branches(id),
 revision INTEGER NOT NULL, quote TEXT NOT NULL DEFAULT '', body VARCHAR(4000) NOT NULL,
 author_id TEXT NOT NULL REFERENCES docgrid."User"(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

