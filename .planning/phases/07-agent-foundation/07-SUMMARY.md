---
phase: 07-agent-foundation
plan: SUMMARY
subsystem: agents
tags: [multi-tenant, event-bus, openrouter, cron, cost-accounting, reporting]
status: deployed
commit: 6051455
completed: 2026-07-16

requires:
  - phase: 01-foundation (clients/tenancy)
  - phase: 05-ai-intelligence (OpenRouter)
provides:
  - agent event bus (agent_events) + poll/emit/markHandled
  - cost-metered agent runner + per-tenant enablement (client_agent_settings)
  - run/cost log (agent_runs), approval queue (agent_proposals), reports (agent_reports)
  - Reporting agent (weekly cross-agent rollup) + /cron/run-agents fan-out
affects: [08, 09, 10]

key-files:
  created:
    - migrations/009_agent_system.sql
    - src/lib/agents/eventBus.js
    - src/lib/agents/runner.js
    - src/lib/agents/costs.js
    - src/lib/agents/reporting.js
    - src/lib/agents/scheduler.js
    - src/lib/agents/agents.test.js
  modified:
    - src/db.js (register migration 009)
    - src/lib/openrouter.js (callOpenRouterRaw returns usage)
    - src/routes/cron.js (/cron/run-agents + error alerts)
    - src/routes/settings.js (AI Agents tab + enable toggle)
    - src/routes/dashboard.js (weekly report card)
    - railway.toml (weekly cron Mon 07:00 UTC)
---

# Phase 07 — Agent Foundation + Reporting: Summary

Built the multi-tenant spine every later agent reuses. Migration 009 adds five
tenant-scoped, idempotent tables. The runner opens an `agent_runs` row, provides
a cost-metered `llm()` helper (via new `callOpenRouterRaw` usage), and records
status/tokens/cost. Enablement is per-tenant in `client_agent_settings`, OFF by
default. The Reporting agent produces a weekly cross-agent rollup (idempotent per
ISO week) to `agent_reports`, the dashboard card, and Telegram.

**Verified:** unit tests (isoWeek, prompt, cost) + local-Postgres integration
(tenant isolation, cost accounting, cross-agent event read, weekly idempotency).
Prod `/cron/run-agents` returns reporting at `tenants:0`. Bug fixed during build:
`isoWeekKey` timezone dependence (now UTC-consistent).
