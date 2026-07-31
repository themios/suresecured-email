-- Migration 025: explicit, tenant-editable sender-match rules for inbound
-- lead capture ("only treat mail from these senders as a lead"). An empty
-- list (the default) keeps today's behavior -- capture anything that isn't
-- obviously bulk/automated mail. A non-empty list switches that tenant into
-- allowlist mode: only a matching sender is ever captured.
ALTER TABLE client_email_config ADD COLUMN IF NOT EXISTS lead_sender_matchers JSONB NOT NULL DEFAULT '[]';
