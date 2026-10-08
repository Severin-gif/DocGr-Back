CREATE TABLE docgrid.dg_folder_shares (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 token_hash CHAR(64) NOT NULL UNIQUE, path VARCHAR(500) NOT NULL, mode VARCHAR(16) NOT NULL CHECK(mode IN ('READ','PROPOSE')),
 expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, created_by TEXT NOT NULL REFERENCES docgrid."User"(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dg_folder_shares_project ON docgrid.dg_folder_shares(project_id);
CREATE TABLE docgrid.dg_shared_proposals (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES docgrid.workspace_projects(id) ON DELETE CASCADE,
 share_id UUID NOT NULL REFERENCES docgrid.dg_folder_shares(id) ON DELETE CASCADE, author_id TEXT NOT NULL REFERENCES docgrid."User"(id),
 title VARCHAR(180) NOT NULL, body VARCHAR(4000) NOT NULL DEFAULT '', kind VARCHAR(16) NOT NULL CHECK(kind IN ('MOVE','EDIT','ADD')),
 status VARCHAR(16) NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','MERGED','CLOSED')),
 payload JSONB NOT NULL, bytes BYTEA, byte_size INTEGER NOT NULL DEFAULT 0 CHECK(byte_size BETWEEN 0 AND 33554432),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_at TIMESTAMPTZ, decided_by TEXT REFERENCES docgrid."User"(id), result_id UUID,
 CHECK ((bytes IS NULL AND byte_size=0) OR octet_length(bytes)=byte_size)
);
CREATE INDEX dg_shared_proposals_project ON docgrid.dg_shared_proposals(project_id,created_at DESC);
