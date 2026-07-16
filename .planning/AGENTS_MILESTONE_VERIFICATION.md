---
milestone: v2-ai-agent-system
verified: 2026-07-16
status: passed
score: 4/4 success criteria verified (code + deploy)
scope: phases 07-10
---

# v2 AI Agent System — Milestone Verification

**Goal:** Multi-tenant AI marketing agent framework, disabled-by-default per
tenant, with a shared event bus, per-tenant cost accounting, and a human approval
gate on any send.
**Verified:** 2026-07-16 · **Status:** passed (code + deployment). Enabling agents
per tenant and Phase 6 staging E2E/sign-off remain human/ops.

---

## Success Criteria — Goal Achievement

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Tenant-scoped + off by default | VERIFIED | `migrations/009` all tables carry `client_id` FK; `client_agent_settings.enabled` DEFAULT FALSE; `runner.enabledClientsForAgent` filters `enabled=true AND active=true`; prod `/cron/run-agents` returns every agent at `tenants:0` |
| 2 | No send without human approval; guards at send | VERIFIED | `email.js runEmailForClient` only INSERTs `agent_proposals` status `pending`; `sendApprovedDraft` re-checks suppression_list + `leads.unsubscribed` before send; approve/reject are `requireAuth` POST routes in `settings.js` |
| 3 | Per-tenant token/cost accounting | VERIFIED | `runner.runAgent` meters `llm()` via `callOpenRouterRaw` usage → `costs.estimateCost` → `agent_runs.tokens_in/out/cost_usd` |
| 4 | Each phase built, tested, deployed (additive/idempotent) | VERIFIED | migrations 009/010/011 use `IF NOT EXISTS`, registered in `db.js`; `npm test` green (17 agent units + 4 prelaunch suites); commits `6051455`/`b675b9e`/`31ccf39`/`f995c13` deployed; run-agents shows all 5 agents live |

**Score:** 4/4.

---

## Agent-by-agent (deployed + verified)

| Agent | Sends? | Idempotency | Key guard/behavior | Evidence |
|-------|--------|-------------|--------------------|----------|
| Reporting | no | per ISO week (`agent_reports` UNIQUE) | read-only rollup | `reporting.js` |
| Segmentation | no | update-only-on-change | zero-LLM, event only when moved | `segmentation.js` |
| Email | yes, gated | no dup while pending draft exists | human approval + send-time suppression/unsub | `email.js` |
| Research | no | `enriched_at` stamp | bounded per run, never re-spend | `research.js` |
| Planning | no | per calendar month (`agent_plans` UNIQUE) | recommendation only | `planning.js` |

Each agent verified end-to-end against an ephemeral local Postgres (never the
Railway DB). Integration proofs: tenant isolation, cost accounting, approval gate,
suppression guard, and idempotency for every agent.

---

## Anti-Patterns Found

One latent bug found and fixed during the build: `reporting.isoWeekKey` read local
date components while building a UTC date (timezone-dependent week key). Fixed to
use UTC components consistently; covered by unit tests.

---

## Human Verification Required (out of scope for autonomous work)

1. **Enable agents per tenant** — Settings → AI Agents (start with Reporting).
2. **Live send smoke** — after enabling Email for a pilot tenant, approve one
   draft and confirm delivery + `email_sent` event.
3. **Telegram** — set `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` in Railway for pushes.
4. Carried from Phase 6: Appendix A staging E2E + go/no-go sign-off.

---

## Summary

All four milestone success criteria pass with file-level evidence and live prod
confirmation. The framework is tenant-isolated and dark by default; the only agent
that can send is human-gated with defense-in-depth deliverability guards; costs are
metered per tenant per run. The remaining items are inherently human/ops.

_Verified: 2026-07-16 · Verifier: Claude (acting lead architect / gsd-verifier)_
