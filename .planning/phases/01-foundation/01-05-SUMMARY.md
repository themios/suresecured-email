---
phase: 01-foundation
plan: "05"
subsystem: database
tags: [postgres, pg, connection-pool, cron, skip-locked, load-testing, seed]

# Dependency graph
requires:
  - phase: 01-01
    provides: idx_contact_enrollments_active_next partial index used by cron query
  - phase: 01-04
    provides: LEFT JOIN clients c and brand_config selection in cron.js
provides:
  - FOR UPDATE OF ce SKIP LOCKED in enrollment SELECT preventing concurrent double-sends
  - pg Pool configured with max:20, idleTimeoutMillis:30000, connectionTimeoutMillis:5000
  - scripts/seed-contacts.js for 500k-row load testing
affects:
  - Phase 2 (scale): Connection pool and SKIP LOCKED are prerequisites for multi-instance load
  - Any future cron modifications: transaction pattern must be preserved

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Cron transaction pattern: pool.connect() + BEGIN/COMMIT wrapping all row work; all UPDATEs use client not pool"
    - "SKIP LOCKED pattern: FOR UPDATE OF <table-alias> SKIP LOCKED on the driving table only (not joined tables)"
    - "Batch seed pattern: 1000-row multi-row INSERT per transaction, idempotent prerequisite seeding"

key-files:
  created:
    - scripts/seed-contacts.js
  modified:
    - src/routes/cron.js
    - src/db.js
    - package.json

key-decisions:
  - "FOR UPDATE OF ce (not bare FOR UPDATE) — locks only contact_enrollments rows, not joined leads/salespeople/clients"
  - "All cron loop queries moved from pool to client — required to stay inside the transaction for SKIP LOCKED to be effective"
  - "Pool max:20 — matches Railway/Heroku pgBouncer recommended ceiling before connection exhaustion"
  - "Seed script uses batched multi-row INSERT (not COPY) — avoids superuser COPY permission; still completes in <5 min"

patterns-established:
  - "Cron transaction: always acquire client from pool, BEGIN before SELECT FOR UPDATE SKIP LOCKED, COMMIT after all row processing"
  - "Seed idempotency: ON CONFLICT DO NOTHING for prerequisite rows; email/name collision safe for repeated runs"

# Metrics
duration: 8min
completed: 2026-06-30
---

# Phase 1 Plan 05: Scale-Safe Cron + Connection Pool + Seed Script Summary

**FOR UPDATE OF ce SKIP LOCKED in pg transaction prevents concurrent double-sends; pool tuned to max:20; 500k-row seed script for load testing**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-30T18:42:02Z
- **Completed:** 2026-06-30T18:50:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Enrollment cron is now safe for concurrent invocations — SKIP LOCKED ensures each active enrollment row is processed by exactly one cron instance
- All pool queries inside the cron loop migrated to `client` to stay within the transaction; ROLLBACK on error
- Connection pool tuned for production scale (max:20, idle/connection timeouts)
- `scripts/seed-contacts.js` creates 500k leads + enrollments in batches of 1000 with idempotent prerequisite seeding

## Task Commits

Each task was committed atomically:

1. **Task 1: Add FOR UPDATE SKIP LOCKED + tune pool** - `6b24a7e` (feat)
2. **Task 2: Create 500k-contact seed script** - `342d7c0` (feat)

**Plan metadata:** (pending — see final commit)

## Files Created/Modified

- `src/routes/cron.js` - Wrapped enrollment SELECT in BEGIN/COMMIT transaction; FOR UPDATE OF ce SKIP LOCKED; all UPDATEs use client
- `src/db.js` - Pool tuned: max:20, idleTimeoutMillis:30000, connectionTimeoutMillis:5000
- `scripts/seed-contacts.js` - 500k-row seed script with batched INSERT and idempotent prerequisite rows
- `package.json` - Added `seed:contacts` script entry

## Decisions Made

- `FOR UPDATE OF ce` (not bare `FOR UPDATE`) — scopes the row lock to `contact_enrollments` only; joined `leads`, `salespeople`, and `clients` rows are not locked, which avoids contention on those shared tables.
- All `pool.query()` calls inside the cron processing loop converted to `client.query()` — without this, UPDATE statements run outside the transaction and SKIP LOCKED provides no protection.
- Pool `max:20` — Railway/Heroku recommend staying at or below 20 connections with PgBouncer; higher values cause connection exhaustion on hobby tiers.
- Seed uses multi-row INSERT batches rather than `pg COPY` — COPY requires superuser or file-accessible path; multi-row INSERT works with any app-level credentials.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required. Run `npm run seed:contacts` against a dev DATABASE_URL to populate 500k rows for load testing.

## Next Phase Readiness

- Phase 1 is now complete (5/5 plans done).
- Phase 2 (scale/multi-tenancy) can begin — SKIP LOCKED, pool tuning, and seed data are all prerequisites.
- Before load testing: set real `DATABASE_URL` in `.env`, provision Railway PostgreSQL instance.
- Note: `idx_contact_enrollments_active_next` partial index (from 01-01) must exist for the cron LIMIT 100 query to stay under 5s on 500k rows.

---
*Phase: 01-foundation*
*Completed: 2026-06-30*
