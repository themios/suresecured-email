-- Migration 020: seed canary. Each tenant connects one monitored inbox (their
-- "seed"), which receives a copy of real campaign sends. A daily job checks
-- that inbox via the Gmail API and records which folder Gmail filed the
-- message into (Primary, Promotions, Spam) -- the proof, per campaign, that
-- mail is actually landing, not just "was sent".
--
-- Deliberately its own table rather than reusing email_accounts: email_accounts
-- is keyed to salesperson_id (a sender identity); a seed inbox is a per-TENANT
-- monitoring target, not a sender, and one tenant has exactly one.
CREATE TABLE IF NOT EXISTS seed_accounts (
  id                   SERIAL PRIMARY KEY,
  client_id            INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE UNIQUE,
  email                VARCHAR(255) NOT NULL,
  oauth_refresh_token  TEXT,
  oauth_access_token   TEXT,
  oauth_token_expiry   TIMESTAMPTZ,
  enabled              BOOLEAN NOT NULL DEFAULT true,
  last_error           TEXT,
  connected_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per daily check per tenant. Kept as history (not just "latest"), so
-- the health view can show a trend ("landed in spam 3 of the last 5 checks")
-- rather than a single point-in-time read that could be a fluke.
CREATE TABLE IF NOT EXISTS seed_checks (
  id           SERIAL PRIMARY KEY,
  client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  folder       VARCHAR(20) NOT NULL, -- 'inbox' | 'promotions' | 'spam' | 'not_found' | 'error'
  subject      TEXT,
  detail       TEXT
);

CREATE INDEX IF NOT EXISTS idx_seed_checks_client_time ON seed_checks (client_id, checked_at DESC);
