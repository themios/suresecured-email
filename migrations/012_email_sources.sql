-- Migration 012: multiple email intake sources + sender rules (per tenant)
-- Lets each tenant connect several inboxes (Gmail OAuth or IMAP) as lead
-- sources, and define sender rules that decide what to capture, ignore, or
-- route. Additive and idempotent. No hard cap on sources; a per-tenant limit
-- can be layered on later as a plan lever.

CREATE TABLE IF NOT EXISTS email_sources (
  id                     SERIAL PRIMARY KEY,
  client_id              INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label                  TEXT NOT NULL,
  type                   TEXT NOT NULL CHECK (type IN ('gmail','imap')),
  enabled                BOOLEAN NOT NULL DEFAULT TRUE,
  -- 'all'       = any new sender becomes a lead (minus 'ignore' rules)
  -- 'allowlist' = only senders matched by a 'capture' rule become leads
  capture_policy         TEXT NOT NULL DEFAULT 'allowlist'
                           CHECK (capture_policy IN ('all','allowlist')),
  email_address          TEXT,                 -- the connected mailbox address
  -- gmail (OAuth) connection — tokens stored encrypted
  oauth_refresh_enc      TEXT,
  oauth_access_enc       TEXT,
  oauth_expiry           TIMESTAMPTZ,
  -- imap connection — password stored encrypted
  imap_host              TEXT,
  imap_port              INTEGER DEFAULT 993,
  imap_user              TEXT,
  imap_pass_enc          TEXT,
  -- default routing applied when a matched rule doesn't specify its own
  default_sequence_id    INTEGER,
  default_salesperson_id INTEGER REFERENCES salespeople(id) ON DELETE SET NULL,
  last_polled_at         TIMESTAMPTZ,
  last_error             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_sources_client ON email_sources (client_id, enabled);

CREATE TABLE IF NOT EXISTS email_source_rules (
  id                     SERIAL PRIMARY KEY,
  client_id              INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- NULL source_id = rule applies to all of this tenant's sources
  source_id              INTEGER REFERENCES email_sources(id) ON DELETE CASCADE,
  match_type             TEXT NOT NULL CHECK (match_type IN ('email','domain')),
  match_value            TEXT NOT NULL,        -- lowercased email or bare domain
  action                 TEXT NOT NULL DEFAULT 'capture'
                           CHECK (action IN ('capture','ignore')),
  -- optional routing for captured leads
  sequence_id            INTEGER,
  assign_salesperson_id  INTEGER REFERENCES salespeople(id) ON DELETE SET NULL,
  tag                    TEXT,
  priority               INTEGER NOT NULL DEFAULT 100,  -- lower evaluated first
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_source_rules_lookup
  ON email_source_rules (client_id, source_id, priority);
