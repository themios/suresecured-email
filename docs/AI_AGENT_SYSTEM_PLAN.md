# AI Agent Marketing System — Plan

Adaptation of the "7 Claude agents run your marketing dept" concept to SalesPilot's
B2B outbound sales + commission-attribution stack (Node/Express + Postgres + node-cron
+ OpenRouter + email/SMS/voice already in place).

## Principle
We are NOT copying the DTC agent set. We orchestrate agents on top of existing services.
Every agent is **draft-and-propose behind a human/approval gate** until trusted — no
autonomous sending or spending on day one.

## Multi-tenancy (foundational, not retrofit)
This is a multi-tenant SaaS feature shipped to ALL tenants (see `migrations/001_add_tenancy.sql`).
Every part of the system is tenant-scoped from Phase 07:
- **Data isolation:** `agent_events`, `agent_proposals`, and segment labels carry `tenant_id`
  (FK); every read/write is filtered by tenant. Reporting agent must never cross tenants.
- **Scheduler fan-out:** cron iterates *enabled* tenants per run, not once globally.
- **Per-tenant config:** settings flag to enable/disable each agent per tenant, plus per-tenant
  brand voice/prompt context so drafts sound like that tenant's brand.
- **Cost & rate control:** OpenRouter usage scales with tenant count — batch/throttle runs and
  track per-tenant AI cost so one tenant can't exhaust the budget.
- **Approvals per tenant:** proposals surface in each tenant's own dashboard/portal, not a
  global admin view. Existing send-limits/warmup/unsubscribe are already per-identity/tenant.

## Architecture (reuse, don't rebuild)
- **Event bus:** new `agent_events` table in Postgres (append-only). Agents write events;
  agents subscribe by polling for unhandled events of types they care about. No new infra.
- **Scheduler:** existing `node-cron` / `routes/cron.js` fires agent runs on intervals.
- **Agent runner:** thin wrapper over `lib/openrouter.js` — takes a role prompt + context,
  returns structured output, logs an event. One module, reused by all agents.
- **State/output:** agents write proposals to DB (e.g. `agent_proposals`) that surface in
  the dashboard for approve/reject; approved items call existing services (sequences, email).
- **Notifications:** existing Telegram lib for "agent needs your attention" pings.

## Agent roster (adapted to B2B outbound) — priority tiers

### Tier 1 — build first (high value, low risk, closest to existing code)
1. **Reporting agent** — reads events + analytics + send/reply/commission data, writes a
   unified "what's working / what's not" summary to the dashboard + Telegram. Read-only.
2. **Email agent** — drafts campaigns and no-reply follow-ups using the sequences engine;
   proposes, human approves, existing send pipeline delivers. (video's "Email agent")
3. **Segmentation agent** — sorts leads/customers into tiers using `scoring.js`; assigns
   segment so different messaging goes to different groups. (video's "Segmentation agent")

### Tier 2 — build after Tier 1 is trusted
4. **Lead Research / Enrichment agent** — B2B equivalent of "Product Research": finds/enriches
   and scores new prospects on a loop, feeds the segmentation + email agents.
5. **Campaign Planning agent** — B2B equivalent of "Content Planning": plans the month's
   outreach/sequences and fans work out to Email + Segmentation agents.

### Tier 3 — low priority for this product (DTC-oriented, weak fit)
6. **SEO agent** — only the landing page, not a catalog. Nice-to-have, not core.
7. **Social repurposing agent** — low fit for B2B outbound; defer.

## Build sequence
- **Phase 0:** `agent_events` table + agent-runner wrapper + one cron entrypoint. (foundation)
- **Phase 1:** Reporting agent end-to-end (proves the whole pattern, read-only, zero risk).
- **Phase 2:** Segmentation agent (writes segment labels; still no sending).
- **Phase 3:** Email agent with approval gate (first agent that can cause a send).
- **Phase 4:** Lead Research + Campaign Planning (the autonomous "loop" layer).
- **Phase 5+:** revisit SEO/social only if warranted.

## Guardrails (non-negotiable)
- No agent sends email/SMS or spends money without an explicit approval step until proven.
- Respects existing send-limits, warmup, unsubscribe, and verification pipelines.
- Every agent action is an event row — full audit trail.

## Recommended starting point
**Phase 0 + Phase 1 (Reporting agent).** Lowest risk, immediate value, and it forces us to
build the event bus + runner that every other agent depends on.
