-- Migration 019: append-only audit log. Records auth events (login success /
-- failure) and sensitive state changes (portal password set, commission
-- credit, tenant edits) for dispute investigation and security questionnaires.
-- Insert-only by convention (no UPDATE/DELETE path exists in the app) so it
-- stays a trustworthy record; nothing here enforces that at the DB level
-- because a superuser can always bypass it, but the app never issues one.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  client_id   INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      JSONB NOT NULL DEFAULT '{}',
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_client_created ON audit_log (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, created_at DESC);
