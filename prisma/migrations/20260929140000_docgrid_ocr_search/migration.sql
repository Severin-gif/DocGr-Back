ALTER TABLE docgrid.docgrid_materials ADD COLUMN extracted_pages jsonb NOT NULL DEFAULT '[]';
ALTER TABLE docgrid.dg_astra_snapshot_sources ADD COLUMN pages jsonb NOT NULL DEFAULT '[]';
CREATE TABLE docgrid.dg_ocr_jobs (
 material_id uuid PRIMARY KEY REFERENCES docgrid.docgrid_materials(id) ON DELETE CASCADE,
 sha256 text NOT NULL, state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','partial','failed')),
 attempts int NOT NULL DEFAULT 0, lease_token uuid, lease_until timestamptz,
 total_pages int, reason text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE docgrid.dg_ocr_pages (
 material_id uuid NOT NULL REFERENCES docgrid.dg_ocr_jobs(material_id) ON DELETE CASCADE,
 page int NOT NULL, text text NOT NULL, method text NOT NULL, status text NOT NULL,
 PRIMARY KEY(material_id,page)
);
CREATE INDEX dg_ocr_jobs_pending ON docgrid.dg_ocr_jobs(state,updated_at);
CREATE TABLE docgrid.dg_search_passages (
 snapshot_id uuid NOT NULL, source_id uuid NOT NULL, ordinal int NOT NULL,
 start_offset int NOT NULL, end_offset int NOT NULL, page int,
 content text NOT NULL,
 search_vector tsvector GENERATED ALWAYS AS (to_tsvector('russian',content) || to_tsvector('simple',content)) STORED,
 PRIMARY KEY(snapshot_id,source_id,ordinal),
 FOREIGN KEY(snapshot_id,source_id) REFERENCES docgrid.dg_astra_snapshot_sources(snapshot_id,source_id) ON DELETE CASCADE
);
CREATE INDEX dg_search_passages_fts ON docgrid.dg_search_passages USING gin(search_vector);
