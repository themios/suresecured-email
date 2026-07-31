-- Migration 024: explicit inbound lead capture source, decoupled from Gmail.
--
-- Before this, inbound lead capture always scanned whichever Gmail account
-- happened to be OAuth-connected for a salesperson -- which is the SENDING
-- identity, not necessarily a dedicated lead inbox. A tenant whose Gmail
-- connection is their personal daily-driver (used only to authenticate
-- sending) had no way to point capture at their real business mailbox
-- instead. 'gmail' is the default so existing tenants see no behavior change
-- until they explicitly switch.
ALTER TABLE client_email_config ADD COLUMN IF NOT EXISTS inbound_source VARCHAR(20) NOT NULL DEFAULT 'gmail';
