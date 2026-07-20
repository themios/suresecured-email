-- Migration 016: delivery feedback loop. Additive and idempotent.
--
-- Problem this solves: sendSequenceEmail() caught every send error but only
-- persisted the reason when isPermanentBounce(msg) was true. Every other class
-- of failure — SMTP auth rejected, host unreachable, TLS failure, quota,
-- recipient refused — was written as status='failed' with no reason attached.
-- The operator saw a send that "happened" and a customer who never replied,
-- with nothing connecting the two.
--
-- Real incident that motivated this: IONOS returned "535 Authentication
-- credentials invalid" on every send for days. Ten preview sends recorded
-- status='failed', bounce_error NULL, and nobody could tell why without
-- opening a psql shell.

-- ── email_sends: why did this specific message not arrive? ─────────────────
ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS failure_class  VARCHAR(32);
ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS failed_at      TIMESTAMPTZ;

COMMENT ON COLUMN email_sends.failure_class IS
  'auth | connection | recipient | bounce | quota | config | unknown. '
  'auth/connection/config are OPERATOR problems (nothing will send until fixed). '
  'recipient/bounce are per-lead. quota is transient.';

-- Operator-facing query is always "what failed recently, for this tenant".
CREATE INDEX IF NOT EXISTS idx_email_sends_failures
  ON email_sends (client_id, failed_at DESC)
  WHERE status = 'failed';

-- ── Backfill the incident that prompted this ──────────────────────────────
-- Rows that failed before this migration have no reason recorded and never will.
-- Label them so the new UI doesn't show a wall of blank "unknown" rows implying
-- the feature is broken.
UPDATE email_sends
SET failure_class = 'unknown',
    failure_reason = 'Failed before delivery diagnostics existed (migration 016). Reason was not recorded.',
    failed_at = COALESCE(failed_at, sent_at)
WHERE status = 'failed' AND failure_class IS NULL;

-- ── Config-level health: is the whole sending identity broken? ────────────
-- client_email_config already had last_error/last_tested_at but nothing ever
-- wrote to them (last_tested_at was NULL in production while every send failed).
-- consecutive_failures drives the operator alert: one failure is noise, ten in
-- a row means the mailbox is misconfigured and no mail is going out at all.
ALTER TABLE client_email_config ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE client_email_config ADD COLUMN IF NOT EXISTS last_success_at      TIMESTAMPTZ;
ALTER TABLE client_email_config ADD COLUMN IF NOT EXISTS last_error_class     VARCHAR(32);
ALTER TABLE client_email_config ADD COLUMN IF NOT EXISTS alerted_at           TIMESTAMPTZ;

COMMENT ON COLUMN client_email_config.alerted_at IS
  'When the operator was last told this identity is failing. Gates re-alerting '
  'so a broken mailbox notifies once, not once per queued message.';
