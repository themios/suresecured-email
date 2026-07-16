-- Migration 009: AI Agent System (multi-tenant)
-- Foundation for the agent marketing system: per-tenant enablement, a shared
-- event bus, a run/cost log, an approval queue, and reporting output.
-- All statements are idempotent (IF NOT EXISTS). Ships DISABLED by default —
-- no tenant is affected until they opt an agent in via settings.
-- See docs/AI_AGENT_SYSTEM_PLAN.md.

-- ── Per-tenant, per-agent enablement + config ──────────────────────────────
-- One row per (client, agent). enabled defaults FALSE so the whole system
-- ships dark. config holds per-agent knobs (schedule cadence, tone overrides).
CREATE TABLE IF NOT EXISTS client_agent_settings (
  id          SERIAL PRIMARY KEY,
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  agent       TEXT NOT NULL,          -- 'reporting'|'segmentation'|'email'|'research'|'planning'
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  config      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, agent)
);

-- ── Shared event bus ───────────────────────────────────────────────────────
-- Agents emit events; other agents consume by polling unhandled events of the
-- types they subscribe to. Strictly tenant-scoped via client_id.
CREATE TABLE IF NOT EXISTS agent_events (
  id          BIGSERIAL PRIMARY KEY,
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  agent       TEXT NOT NULL,          -- emitting agent
  type        TEXT NOT NULL,          -- e.g. 'segment.updated', 'email.drafted'
  payload     JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','handled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  handled_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_events_client_status ON agent_events (client_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_client_type   ON agent_events (client_id, type, created_at);

-- ── Run + cost log ─────────────────────────────────────────────────────────
-- One row per agent execution. Tracks tokens/cost per tenant so one tenant
-- can't silently exhaust the AI budget.
CREATE TABLE IF NOT EXISTS agent_runs (
  id           BIGSERIAL PRIMARY KEY,
  client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  agent        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error','skipped')),
  trigger      TEXT,                  -- 'cron'|'manual'|'event'
  tokens_in    INTEGER DEFAULT 0,
  tokens_out   INTEGER DEFAULT 0,
  cost_usd     NUMERIC(10,5) DEFAULT 0,
  detail       JSONB NOT NULL DEFAULT '{}',
  error        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_client_agent ON agent_runs (client_id, agent, started_at DESC);

-- ── Approval queue ─────────────────────────────────────────────────────────
-- Agent outputs that must be reviewed by a human before they act (e.g. email
-- drafts, segment changes). Read-only outputs (reports) do NOT go here.
CREATE TABLE IF NOT EXISTS agent_proposals (
  id           BIGSERIAL PRIMARY KEY,
  client_id    INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  agent        TEXT NOT NULL,
  kind         TEXT NOT NULL,         -- 'email_draft'|'segment_change'|'campaign_plan'|...
  title        TEXT NOT NULL,
  summary      TEXT,
  payload      JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','applied','dismissed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at   TIMESTAMPTZ,
  decided_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_proposals_client_status ON agent_proposals (client_id, status, created_at DESC);

-- ── Reporting output ───────────────────────────────────────────────────────
-- The Reporting agent's weekly cross-agent rollup. UNIQUE(client_id, period)
-- gives idempotency (one report per tenant per period key, e.g. '2026-W29').
CREATE TABLE IF NOT EXISTS agent_reports (
  id          BIGSERIAL PRIMARY KEY,
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period      TEXT NOT NULL,
  summary     TEXT NOT NULL,
  metrics     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, period)
);
