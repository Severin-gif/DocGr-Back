ALTER TABLE docgrid_live."User" ADD COLUMN access_blocked_at TIMESTAMPTZ;
CREATE TABLE docgrid_live.dg_user_admin_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id TEXT NOT NULL REFERENCES docgrid_live."User"(id),
 actor TEXT NOT NULL,
 blocked BOOLEAN NOT NULL,
 reason VARCHAR(500) NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX dg_user_admin_events_user_idx ON docgrid_live.dg_user_admin_events(user_id, created_at DESC);

