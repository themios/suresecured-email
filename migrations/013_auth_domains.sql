-- Migration 013: per-tenant Google sign-in domains (auto-join)
-- Lets a tenant allow anyone with an email on their domain to sign in with
-- Google and be auto-provisioned into THAT tenant. UNIQUE(domain) guarantees a
-- domain maps to exactly one tenant, so auto-join can never be ambiguous.
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS client_auth_domains (
  id            SERIAL PRIMARY KEY,
  client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  domain        TEXT NOT NULL UNIQUE,   -- lowercased bare domain, e.g. "acme.com"
  default_role  TEXT NOT NULL DEFAULT 'salesperson'
                  CHECK (default_role IN ('operator','owner','admin','salesperson')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_auth_domains_client ON client_auth_domains (client_id);
