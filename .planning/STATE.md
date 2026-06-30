# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-30)

**Core value:** Any business with a contact list and commissioned sales team can hand it to SalesPilot and start generating sales within days
**Current focus:** Phase 2 — Commission Engine

## Current Position

Phase: 1 of 5 (Foundation) — COMPLETE ✓
Plan: 5/5 complete
Status: Ready for Phase 2
Last activity: 2026-06-30 — Phase 01 verified (17/17 must-haves), ready for Commission Engine

Progress: [█████░░░░░] 50%

## Performance Metrics

**Velocity:**
- Total plans completed: 4
- Average duration: 10 min
- Total execution time: 39 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-foundation | 5/5 | 47 min | 9 min |

**Recent Trend:**
- Last 5 plans: 01-01 (15 min), 01-03 (12 min), 01-04 (12 min), 01-05 (8 min)
- Trend: consistent, slight improvement

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

### Pending Todos

- Set real Railway DATABASE_URL in .env before any plan can run live DB verification
- Provision Railway PostgreSQL instance for CommissionTracker

### Blockers/Concerns

- Phase 4 (Voice): Blocked until Twilio number is purchased and provisioned. All other phases are independent.
- Phase 1 complete — Phase 2 can begin. Enable Railway PostgreSQL connection pooler before Phase 2 scale work begins.
- 01-01 verification: DATABASE_URL is placeholder — migration file and db.js are complete but untested against live DB.

## Session Continuity

Last session: 2026-06-30T18:50:00Z
Stopped at: Completed 01-05-PLAN.md — scale-safe cron (SKIP LOCKED), pool tuning, 500k seed script
Resume file: None
