-- Migration 026: verified-recipient flow for the public estimate form
-- (incident 2026-10-10, form relay abuse).
--
-- An estimate (model call + email) is only produced after the submitter proves
-- they own the address by using a single-use token sent to it. Existing rows
-- default to 'pending' because none of them was ever verified.

ALTER TABLE platform_leads
  ADD COLUMN IF NOT EXISTS verify_status       TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS verified_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deal_value          VARCHAR(50),
  ADD COLUMN IF NOT EXISTS confirm_email_status TEXT,
  ADD COLUMN IF NOT EXISTS confirm_email_error  TEXT,
  ADD COLUMN IF NOT EXISTS estimate_narrative   TEXT;   -- stored once so a retry never repeats the model call

ALTER TABLE platform_leads
  DROP CONSTRAINT IF EXISTS platform_leads_verify_status_chk;
ALTER TABLE platform_leads
  ADD CONSTRAINT platform_leads_verify_status_chk CHECK (verify_status IN ('pending', 'verified'));

-- A token is claimed (2 minute lease) while the estimate is built and completed after, so a
-- failure mid-way never strands a verified visitor. Only the SHA-256 of a token is stored, so a database read never yields a usable link.
CREATE TABLE IF NOT EXISTS estimate_verifications (
  id         BIGSERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES platform_leads(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  claim_nonce  TEXT,          -- owner of the live claim, fences complete/release/save
  claimed_at   TIMESTAMPTZ,   -- set when a visitor presses Confirm; expires as a lease
  completed_at TIMESTAMPTZ,   -- set once the estimate was produced; the token is then dead
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS estimate_verifications_lead_idx ON estimate_verifications (lead_id);

-- Fixed-window counters shared by every instance. Keys are hashed, never raw
-- addresses or IPs. alerted_at makes the alert fire once per bucket per window.
CREATE TABLE IF NOT EXISTS form_quota (
  bucket       TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  alerted_at   TIMESTAMPTZ,
  PRIMARY KEY (bucket, window_start)
);
