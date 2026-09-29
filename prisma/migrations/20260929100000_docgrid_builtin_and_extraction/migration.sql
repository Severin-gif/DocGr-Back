ALTER TABLE docgrid.docgrid_materials ADD COLUMN extraction_reason text;
ALTER TABLE docgrid.dg_astra_grants ADD COLUMN builtin boolean NOT NULL DEFAULT false;
CREATE TABLE docgrid.dg_ai_settings (
  project_id uuid PRIMARY KEY REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
  builtin_enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE docgrid.dg_ai_daily_usage (
  user_id text NOT NULL,
  day date NOT NULL,
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  PRIMARY KEY (user_id, day)
);
