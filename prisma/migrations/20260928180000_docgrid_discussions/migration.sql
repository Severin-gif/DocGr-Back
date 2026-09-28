CREATE TABLE docgrid.dg_discussions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  grant_id uuid NOT NULL REFERENCES docgrid.dg_astra_grants(id),
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dg_discussions_project ON docgrid.dg_discussions(project_id,owner_id,created_at);
CREATE TABLE docgrid.dg_discussion_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discussion_id uuid NOT NULL REFERENCES docgrid.dg_discussions(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  body_digest text NOT NULL,
  instruction text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('advisor','helper','assistant')),
  status text NOT NULL CHECK(status IN ('running','completed','failed')),
  result jsonb,
  context jsonb,
  provider jsonb,
  error text,
  proposal_id uuid REFERENCES docgrid.dg_astra_operations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(discussion_id,request_key)
);
CREATE UNIQUE INDEX dg_discussion_running ON docgrid.dg_discussion_turns(discussion_id) WHERE status='running';
-- One approved package can create several document versions in the same atomic operation.
-- Version identity and the adapter's request-key uniqueness still prevent replay writes.
ALTER TABLE docgrid.dg_astra_document_versions DROP CONSTRAINT dg_astra_document_versions_operation_id_key;
CREATE INDEX dg_astra_document_versions_operation_idx ON docgrid.dg_astra_document_versions(operation_id);
