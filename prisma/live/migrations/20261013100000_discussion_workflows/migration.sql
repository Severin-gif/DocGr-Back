-- Orchestration metadata only. All permissions and human decisions remain in Astra.
CREATE TABLE docgrid_live.dg_discussion_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discussion_id uuid NOT NULL REFERENCES docgrid_live.dg_discussions(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  body_digest text NOT NULL,
  goal text NOT NULL,
  model text NOT NULL,
  environment jsonb NOT NULL,
  title text,
  steps jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL CHECK (status IN ('planning','awaiting_approval','ready','running','needs_user_action','completed','failed','cancelling','cancelled')),
  plan_operation_id uuid REFERENCES docgrid_live.dg_astra_operations(id),
  events jsonb NOT NULL DEFAULT '[]',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(discussion_id, request_key)
);
CREATE UNIQUE INDEX dg_discussion_workflow_active ON docgrid_live.dg_discussion_workflows(discussion_id)
  WHERE status NOT IN ('completed','cancelled');
-- Existing internal grants gain only the metadata planning capability; submission is not granted.
UPDATE docgrid_live.dg_astra_grants SET actions=actions || '["docgrid_plan_document"]'::jsonb
WHERE builtin AND NOT actions ? 'docgrid_plan_document';

