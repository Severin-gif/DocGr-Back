-- Explicit, audited source snapshots. No source parser or model is invoked here.
CREATE TABLE docgrid.dg_astra_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 grant_id UUID NOT NULL,
 tree_revision CHAR(64) NOT NULL,
 manifest JSONB NOT NULL,
 cursor_secret TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dg_astra_snapshots_scope_idx ON docgrid.dg_astra_snapshots(project_id,grant_id);
CREATE TABLE docgrid.dg_astra_snapshot_sources (
 snapshot_id UUID NOT NULL REFERENCES docgrid.dg_astra_snapshots(id) ON DELETE CASCADE,
 source_id UUID NOT NULL,
 kind VARCHAR(16) NOT NULL CHECK(kind IN ('material','document','artifact')),
 version TEXT NOT NULL,
 hash CHAR(64) NOT NULL,
 extraction_revision CHAR(64) NOT NULL,
 status VARCHAR(16) NOT NULL CHECK(status IN ('READY','PARTIAL','UNREAD','FAILED')),
 title TEXT NOT NULL, path TEXT NOT NULL, mime TEXT NOT NULL,
 byte_size BIGINT NOT NULL CHECK(byte_size>=0),
 content TEXT NOT NULL, warnings JSONB NOT NULL DEFAULT '[]',
 PRIMARY KEY(snapshot_id,source_id)
);
CREATE FUNCTION docgrid.dg_astra_immutable_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Astra source snapshots are immutable'; END $$;
CREATE TRIGGER dg_astra_snapshot_no_update BEFORE UPDATE ON docgrid.dg_astra_snapshots FOR EACH ROW EXECUTE FUNCTION docgrid.dg_astra_immutable_snapshot();
CREATE TRIGGER dg_astra_snapshot_source_no_update BEFORE UPDATE ON docgrid.dg_astra_snapshot_sources FOR EACH ROW EXECUTE FUNCTION docgrid.dg_astra_immutable_snapshot();
CREATE TABLE docgrid.dg_astra_relations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 from_ref JSONB NOT NULL, to_ref JSONB NOT NULL,
 relation_type VARCHAR(80) NOT NULL, basis TEXT NOT NULL,
 author_id TEXT NOT NULL REFERENCES docgrid."User"(id), agent_ref TEXT NOT NULL,
 status VARCHAR(16) NOT NULL CHECK(status IN ('PROPOSED','CONFIRMED','REJECTED','STALE')),
 operation_id UUID NOT NULL UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dg_astra_relations_project_idx ON docgrid.dg_astra_relations(project_id);

-- Folder metadata for canonical workflow documents; content stays in document_versions.
ALTER TABLE docgrid.dg_astra_documents ADD COLUMN path VARCHAR(500) NOT NULL DEFAULT '/';

