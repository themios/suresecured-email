-- Migration 023: Twilio as an alternate SMS provider, per tenant. Some
-- customers already have a Twilio account and number; rather than force
-- everyone onto the platform's shared Telnyx account, a tenant can pick
-- either provider. Telnyx stays the default (existing behavior unchanged for
-- every tenant that doesn't touch this).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sms_provider VARCHAR(20) NOT NULL DEFAULT 'telnyx';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS twilio_account_sid VARCHAR(255);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS twilio_auth_token_enc TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS twilio_phone_number VARCHAR(50);

-- Track which provider actually sent/received each message, and Twilio's own
-- message id (Telnyx's is already in telnyx_message_id) so delivery-status
-- webhooks from either provider can find the right row.
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS provider VARCHAR(20) NOT NULL DEFAULT 'telnyx';
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS twilio_message_sid VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_sms_messages_twilio_sid ON sms_messages (twilio_message_sid);
