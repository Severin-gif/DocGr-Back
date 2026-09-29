CREATE TABLE docgrid.dg_project_context (
 project_id uuid PRIMARY KEY REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 revision int NOT NULL DEFAULT 1, checked_revision int NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'queued', reason text, summary text NOT NULL DEFAULT '',
 coverage jsonb NOT NULL DEFAULT '{}', lease_token uuid, lease_until timestamptz,
 retry_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE docgrid.dg_context_notes (
 project_id uuid NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 source_id text NOT NULL, fingerprint text NOT NULL, chunk int NOT NULL,
 note jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,source_id,fingerprint,chunk)
);
CREATE TABLE docgrid.dg_ai_time_usage (
 owner_id text NOT NULL, month date NOT NULL, milliseconds bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(owner_id,month), CHECK(milliseconds>=0)
);
CREATE TABLE docgrid.dg_ai_time_calls (
 id uuid PRIMARY KEY, owner_id text NOT NULL, month date NOT NULL, reserved int NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE FUNCTION docgrid.invalidate_project_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p uuid;
BEGIN
 p=COALESCE(NEW.project_id,OLD.project_id);
 INSERT INTO docgrid.dg_project_context(project_id) SELECT id FROM docgrid.workspace_projects WHERE id=p
 ON CONFLICT(project_id) DO UPDATE SET revision=docgrid.dg_project_context.revision+1,state='queued',reason=NULL,retry_at=now(),updated_at=now();
 RETURN NULL;
END $$;
CREATE TRIGGER context_material AFTER INSERT OR DELETE OR UPDATE OF extracted_text,extraction_status,title,path,deleted_at ON docgrid.docgrid_materials FOR EACH ROW EXECUTE FUNCTION docgrid.invalidate_project_context();
CREATE TRIGGER context_document AFTER INSERT OR DELETE OR UPDATE OF content,title,path,docgrid_deleted_at ON docgrid.workspace_documents FOR EACH ROW EXECUTE FUNCTION docgrid.invalidate_project_context();
CREATE TRIGGER context_review AFTER INSERT OR DELETE OR UPDATE OF source_snapshot,target_snapshot,status ON docgrid.docgrid_reviews FOR EACH ROW EXECUTE FUNCTION docgrid.invalidate_project_context();
CREATE TRIGGER context_artifact AFTER INSERT OR DELETE OR UPDATE ON docgrid.dg_astra_documents FOR EACH ROW EXECUTE FUNCTION docgrid.invalidate_project_context();
CREATE TRIGGER context_settings AFTER INSERT OR UPDATE ON docgrid.dg_ai_settings FOR EACH ROW EXECUTE FUNCTION docgrid.invalidate_project_context();
INSERT INTO docgrid.dg_project_context(project_id) SELECT id FROM docgrid.workspace_projects;
CREATE FUNCTION docgrid.invalidate_context_branch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p uuid;
BEGIN
 SELECT project_id INTO p FROM docgrid.docgrid_branches WHERE id=COALESCE(NEW.branch_id,OLD.branch_id);
 IF p IS NOT NULL THEN UPDATE docgrid.dg_project_context SET revision=revision+1,state='queued',retry_at=now(),updated_at=now() WHERE project_id=p; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER context_branch_document AFTER INSERT OR DELETE OR UPDATE OF content ON docgrid.docgrid_branch_documents FOR EACH ROW EXECUTE FUNCTION docgrid.invalidate_context_branch();
CREATE FUNCTION docgrid.invalidate_context_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE docgrid.dg_project_context SET revision=revision+1,state='queued',retry_at=now(),updated_at=now() WHERE project_id IN(SELECT project_id FROM docgrid.dg_astra_documents WHERE document_id=NEW.id);
 RETURN NULL;
END $$;
CREATE TRIGGER context_version AFTER UPDATE OF current_version ON docgrid.prepared_legal_documents FOR EACH ROW EXECUTE FUNCTION docgrid.invalidate_context_version();
CREATE TRIGGER context_proposal_insert AFTER INSERT ON docgrid.dg_astra_operations FOR EACH ROW WHEN(NEW.status='needs_user_action') EXECUTE FUNCTION docgrid.invalidate_project_context();
CREATE TRIGGER context_proposal_update AFTER UPDATE OF status ON docgrid.dg_astra_operations FOR EACH ROW WHEN(NEW.status='needs_user_action' OR OLD.status='needs_user_action') EXECUTE FUNCTION docgrid.invalidate_project_context();
CREATE VIEW docgrid.dg_context_sources AS
 SELECT project_id,id::text AS source_id,title,path,extracted_text AS content,extraction_status AS status,'material'::text AS kind,md5(extracted_text||title||path||extraction_status) AS fingerprint FROM docgrid.docgrid_materials WHERE deleted_at IS NULL
 UNION ALL SELECT project_id,id::text,title,path,content,'READY','document',md5(content||title||path) FROM docgrid.workspace_documents WHERE docgrid_deleted_at IS NULL
 UNION ALL SELECT project_id,'review:'||id::text,title,'/Согласование',source_snapshot::text||E'\nБазовая версия:\n'||target_snapshot::text,'READY','review',md5(source_snapshot::text||target_snapshot::text||status) FROM docgrid.docgrid_reviews WHERE status IN ('OPEN','CONFLICT')
 UNION ALL SELECT b.project_id,d.id::text,d.title,b.path,v.plain_text,'READY','artifact',md5(v.plain_text||d.title||b.path) FROM docgrid.dg_astra_documents b JOIN docgrid.prepared_legal_documents d ON d.id=b.document_id JOIN docgrid.document_versions v ON v.document_id=d.id AND v.version=d.current_version
 UNION ALL SELECT project_id,'proposal:'||id::text,'Предложение на согласование','/Согласование',input::text,'READY','review',md5(input::text||status) FROM docgrid.dg_astra_operations WHERE status='needs_user_action';
