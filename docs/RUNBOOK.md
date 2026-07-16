# SalesPilot Ops Runbook

Operational reference for the production deployment. Covers monitoring, cron,
and where to look when something breaks.

## Environment
- **Host:** Railway — project `Email-Campaign` / service `suresecured-email` / production
- **URL:** https://saleswyze.up.railway.app
- **Health check:** `GET /health` (Railway restarts on failure)
- **DB:** Railway Postgres (`postgres.railway.internal`). Migrations run on boot via
  `src/db.js#initDb` (idempotent). Never run migrations against prod by hand.

## Cron jobs (defined in `railway.toml`)
| Schedule (UTC) | Endpoint | Purpose |
|----------------|----------|---------|
| `*/15 * * * *` | `POST /cron/send-sequences` | Send due sequence steps; reply detection |
| `0 6 * * *`    | `POST /cron/daily-digest`   | Per-tenant AI ops digest (email + Telegram) |
| `30 6 * * *`   | `POST /cron/score-leads`    | Recompute lead engagement scores |
| `0 7 * * 1`    | `POST /cron/run-agents`     | Weekly AI marketing agents (Reporting) |

All require `Authorization: Bearer $CRON_SECRET`.

## Monitoring & alerts
- **Structured logs:** grep Railway logs by prefix — `[cron]`, `[webhook]`,
  `[attribution]`, `[reply-check]`, `[digest]`, `[run-agents]`.
- **Telegram alerts** (via `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`):
  - `send-sequences` posts an alert when a run has `errors > 0`.
  - `run-agents` posts an alert when any agent errors.
  - Hot replies and the daily summary also post to Telegram.
  - Test wiring: `GET /cron/test-telegram` (with CRON_SECRET).
- **Deliverability:** the daily digest reports bounce count **and bounce rate**.
  Investigate if bounce rate trends above ~2%.
- **Optional deeper monitoring:** add a Railway log drain or a `SENTRY_DSN` if/when
  error volume warrants it (not currently wired).

## AI agents (Phase 07+)
- Ship **disabled by default**. A tenant enables per-agent under
  **Settings → AI Agents**. Enablement lives in `client_agent_settings`.
- Run/cost accounting per tenant in `agent_runs` (`cost_usd`). Event bus is
  `agent_events`; approvals queue is `agent_proposals`; reports in `agent_reports`.
- Manual trigger: `POST /cron/run-agents` with CRON_SECRET.

## Common tasks
- **Re-run a cron manually:** `curl -X POST $URL/cron/<name> -H "Authorization: Bearer $CRON_SECRET"`.
- **Check a tenant's agent state:** `SELECT * FROM client_agent_settings WHERE client_id=<id>;`
- **Tests:** `npm test` (runs unit + agent tests; no DB required).
