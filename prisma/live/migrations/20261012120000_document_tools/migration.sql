CREATE TABLE docgrid_live.dg_tool_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES docgrid_live.workspace_projects(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  tool text NOT NULL,
  title text NOT NULL,
  config jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','completed','failed')),
  result jsonb NOT NULL DEFAULT '[]',
  warnings jsonb NOT NULL DEFAULT '[]',
  error text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dg_tool_jobs_queue ON docgrid_live.dg_tool_jobs(state,created_at);
CREATE INDEX dg_tool_jobs_project ON docgrid_live.dg_tool_jobs(project_id,created_at DESC);

