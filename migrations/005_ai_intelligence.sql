-- 005_ai_intelligence.sql
-- Phase 05: lead engagement scoring + digest email idempotency

-- Lead engagement score (0-100)
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS engagement_score INTEGER NOT NULL DEFAULT 0;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS scored_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_leads_engagement_score ON leads(engagement_score);

-- Reply timestamp on enrollments (for 24h reply filtering in digest)
ALTER TABLE contact_enrollments
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;

-- Digest send log — prevents double-digest per client per day
CREATE TABLE IF NOT EXISTS digest_sends (
  id        SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period    DATE NOT NULL,
  UNIQUE(client_id, period)
);
