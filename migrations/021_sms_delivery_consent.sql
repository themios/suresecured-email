-- Migration 021: SMS delivery tracking + consent/opt-out support.
-- Phase 1.5 (SMS campaigns). consent_sms / consent_sms_at already exist
-- (migration 007) and are reused for opt-out: a STOP reply flips consent_sms
-- back to false and updates consent_sms_at, rather than adding a parallel
-- opted_out column that could drift out of sync with the consent flag.
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS error_reason TEXT;
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sms_messages_telnyx_id ON sms_messages (telnyx_message_id);
