-- Migration 011: Research (enrichment) + Campaign Planning agents (Phase 10)
-- Additive and idempotent.

-- Enrichment: mark when a lead was last processed so we don't re-spend on it.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;

-- Campaign Planning: one monthly outreach plan per tenant (idempotent by month).
CREATE TABLE IF NOT EXISTS agent_plans (
  id          BIGSERIAL PRIMARY KEY,
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period      TEXT NOT NULL,            -- 'YYYY-MM'
  plan        TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, period)
);
