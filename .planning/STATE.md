# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-30)

**Core value:** Any business with a contact list and commissioned sales team can hand it to SalesPilot and start generating sales within days
**Current focus:** Phase 2 — Commission Engine

## Current Position

Phase: 2 of 5 (Commission Engine) — In progress
Plan: 4/4 complete in current phase
Status: Phase complete
Last activity: 2026-06-30 — Completed 02-04-PLAN.md

Progress: [█████████░] 90%

## Performance Metrics

**Velocity:**
- Total plans completed: 6
- Average duration: 10 min
- Total execution time: 59 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-foundation | 5/5 | 47 min | 9 min |
| 02-commission-engine | 4/4 | ~20 min | ~5 min |

**Recent Trend:**
- Last 5 plans: 01-05 (8 min), 02-01 (12 min), 02-04 (8 min)
- Trend: consistent

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Phase 1: Brownfield evolution — add tenancy around existing 17-table schema, do not rewrite working routes
- Phase 1: JSONB for client config (brand, commission, voice, AI, integrations) — avoids future migrations
- Phase 4: Voice deferred — requires Twilio number purchase before work can begin; (747) 688-9992 is not on Twilio
- 01-01: DO $$ FOREACH loop for client_id addition — more maintainable than 17 separate ALTER TABLE statements
- 01-01: admin_users table kept in place — 01-02 will unify auth; co-existence is safe
- 01-01: client_id nullable initially — backfill and NOT NULL enforcement deferred to application layer
- 01-02: Login route at POST /auth/login (not /login) — GET /login still serves the form; legacy /logout kept
- 01-02: spAuth DB-backed client_id lookup — fetches from salespeople row rather than expanding stale JWT
- 01-02: requireRole uses rest-params with flat() — supports requireRole('op') and requireRole(['op','owner'])
- 01-03: No EJS template engine introduced — inline Tailwind HTML via res.send() matches existing codebase pattern; clientFormHtml() is the "view" equivalent
- 01-03: parseJsonField() helper normalizes JSONB textarea inputs (string → object) before DB storage
- 01-04: SureSecured values kept as brandConfig destructure defaults — backward-compatible; NULL client_id rows render SureSecured branding without backfill
- 01-04: buildHtml() exported from gmail.js — enables direct unit testing; previously unexported
- 01-04: phoneDigits derived via phone.replace(/\D/g,'') — tel: href handles any phone format in brand_config
- 01-05: FOR UPDATE OF ce (not bare FOR UPDATE) — scopes lock to contact_enrollments only; avoids contention on joined tables
- 01-05: All cron loop queries use client not pool — required to stay in transaction; SKIP LOCKED only effective within transaction
- 01-05: Pool max:20 — Railway/Heroku PgBouncer ceiling before connection exhaustion on hobby tiers
- 01-05: Seed uses multi-row INSERT batches not COPY — works with app-level credentials; no superuser required
- 02-01: No test framework introduced — plain node:assert script keeps zero-devDependencies style
- 02-01: tier.to is exclusive upper bound — thisUnit <= t.to means boundary unit stays in current tier
- 02-01: Bonus filter unitsBefore < b.units && thisUnit >= b.units — triggers exactly once at crossing sale
- 02-02: calculateCommission(0, unitsThisMonth, rules, flatRate) called with saleAmount=0 to display current tier rate — earned discarded; same code path as webhook ensures displayed rate matches actual earned rate
- 02-02: nextTier = tiers.find(t => t.from >= unitsThisMonth) — finds first uncrossed threshold for progress indicator; null means top tier reached
- 02-02: req.salesperson.client_id used directly in payout split query param — populated by spAuth middleware, not re-fetched from DB
- 02-03: requireRole imported alongside requireAuth — co-located imports, consistent with middleware/auth.js exports
- 02-03: calculateCommission(0, units, rules, 100) with passAmount=0 in drilldown — gets rate only, avoids double-counting stored commission amounts
- 02-03: Cross-org guard uses !== strict comparison on organization_id — pg driver and JWT both produce number type; safe and explicit
- 02-04: clientId null path records order but skips commission — avoids Shopify retry storm on unknown shop domain
- 02-04: spResult joins on salesperson's own client_id (not webhook-resolved) to fetch commission_rules — multi-client edge case deferred v2
- 02-04: unitsBefore query excludes current orderId to get correct pre-sale unit count for tier lookup

### Pending Todos

- Set real Railway DATABASE_URL in .env before any plan can run live DB verification
- Provision Railway PostgreSQL instance for CommissionTracker

### Blockers/Concerns

- Phase 4 (Voice): Blocked until Twilio number is purchased and provisioned. All other phases are independent.
- Phase 1 complete — Phase 2 can begin. Enable Railway PostgreSQL connection pooler before Phase 2 scale work begins.
- 01-01 verification: DATABASE_URL is placeholder — migration file and db.js are complete but untested against live DB.

## Session Continuity

Last session: 2026-06-30T20:51:00Z
Stopped at: Completed 02-02-PLAN.md — portal dashboard tier context, pending/paid payout split
Resume file: None
