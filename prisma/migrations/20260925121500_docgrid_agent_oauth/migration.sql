-- One-use OAuth authorization codes. Credentials are encrypted by Doc-Back.
CREATE TABLE docgrid.dg_agent_oauth_codes (
  code_hash TEXT PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  binding_hash TEXT NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  sealed_token TEXT NOT NULL CHECK (length(sealed_token) <= 8192),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX dg_agent_oauth_codes_expiry ON docgrid.dg_agent_oauth_codes(expires_at);

