-- Migration 017: retire sequence steps without deleting them. Additive, idempotent.
--
-- Shortening a sequence (e.g. 20 emails down to 10) cannot delete the old steps
-- once they have been sent: email_sends.step_id references sequence_steps, so a
-- delete either violates the FK or orphans send history. An `active` flag lets a
-- step be retired while its send history stays intact. Cron only sends and only
-- advances past active steps.
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_sequence_steps_active
  ON sequence_steps (sequence_id, step_number) WHERE active = TRUE;
