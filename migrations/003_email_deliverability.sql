-- 003_email_deliverability.sql
-- Phase 03: open/click tracking columns, bounce columns, pixel token, click token table

ALTER TABLE email_sends
  ADD COLUMN IF NOT EXISTS open_count    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS click_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bounced       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bounce_error  TEXT,
  ADD COLUMN IF NOT EXISTS pixel_token   UUID UNIQUE DEFAULT gen_random_uuid();

CREATE INDEX IF NOT EXISTS idx_email_sends_pixel_token ON email_sends(pixel_token);

CREATE TABLE IF NOT EXISTS email_tracking_tokens (
  id              SERIAL PRIMARY KEY,
  token           UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  email_send_id   INTEGER NOT NULL REFERENCES email_sends(id) ON DELETE CASCADE,
  destination_url TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ett_token ON email_tracking_tokens(token);
