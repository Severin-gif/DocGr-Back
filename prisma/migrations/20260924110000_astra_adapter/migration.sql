CREATE TABLE docgrid.dg_astra_grants (
 id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL REFERENCES docgrid."User"(id), agent_ref VARCHAR(120) NOT NULL,
 token_hash CHAR(64) NOT NULL UNIQUE, actions JSONB NOT NULL, allowed_source_ids JSONB,
 expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ,
 max_operations INTEGER NOT NULL CHECK(max_operations BETWEEN 1 AND 10000),
 used_operations INTEGER NOT NULL DEFAULT 0 CHECK(used_operations >= 0 AND used_operations <= max_operations),
 request_key VARCHAR(120) NOT NULL, body_digest CHAR(64) NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(project_id, owner_id, request_key), CHECK(jsonb_typeof(actions)='array'),
 CHECK(allowed_source_ids IS NULL OR jsonb_typeof(allowed_source_ids)='array')
);
CREATE INDEX dg_astra_grants_project_idx ON docgrid.dg_astra_grants(project_id,created_at DESC);
CREATE TABLE docgrid.dg_astra_operations (
 id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 grant_id UUID NOT NULL REFERENCES docgrid.dg_astra_grants(id), tool VARCHAR(100) NOT NULL,
 run_id VARCHAR(120) NOT NULL, request_key VARCHAR(120) NOT NULL, trace_id VARCHAR(120) NOT NULL,
 body_digest CHAR(64) NOT NULL, input JSONB NOT NULL,
 status VARCHAR(30) NOT NULL CHECK(status IN ('running','completed','needs_user_action','cancelled','failed')),
 result JSONB, approval JSONB, approval_digest CHAR(64), error JSONB, passport JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(grant_id, request_key)
);
CREATE INDEX dg_astra_operations_project_idx ON docgrid.dg_astra_operations(project_id,created_at DESC);
CREATE TABLE docgrid.dg_astra_decisions (
 id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES docgrid."User"(id), request_key VARCHAR(120) NOT NULL,
 action VARCHAR(30) NOT NULL, target_id UUID NOT NULL, body_digest CHAR(64) NOT NULL,
 result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(project_id,actor_id,request_key)
);

