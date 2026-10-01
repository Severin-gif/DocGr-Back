CREATE TABLE docgrid.dg_court_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
  group_id uuid NOT NULL,
  version int NOT NULL CHECK(version>0),
  title text NOT NULL,
  metadata jsonb NOT NULL,
  items jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(group_id,version)
);
CREATE INDEX dg_court_packages_project ON docgrid.dg_court_packages(project_id,created_at DESC);
