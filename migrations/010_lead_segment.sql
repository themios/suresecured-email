-- Migration 010: lead segmentation (Phase 08)
-- Adds an engagement tier label to leads, written by the Segmentation agent.
-- Idempotent and additive.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS segment       TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS segmented_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_leads_client_segment ON leads (client_id, segment);
