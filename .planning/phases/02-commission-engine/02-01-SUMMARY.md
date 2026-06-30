---
phase: 02-commission-engine
plan: "01"
subsystem: api
tags: [commission, tiers, bonuses, migration, postgresql]

requires:
  - phase: 01-foundation
    provides: clients table with commission_rules JSONB column, multi-tenant schema, migrations pattern

provides:
  - calculateCommission(saleAmount, unitsBefore, rules, flatRate) pure function
  - Tier boundary-aware commission rate lookup
  - One-time bonus threshold crossing detection
  - Flat rate fallback for clients without tiers
  - migrations/002_commission_engine.sql idempotent schema safety net
  - Performance indexes for monthly commission queries

affects:
  - 02-02 (webhook commission attribution)
  - 02-03 (salesperson portal commission display)
  - 02-04 (admin commission dashboard)

tech-stack:
  added: []
  patterns:
    - "Pure function module with no DB dependency — unit testable, reusable by any route"
    - "node:assert test script (no framework) matching existing no-framework pattern"
    - "Idempotent migration pattern matching 001_add_tenancy.sql style"

key-files:
  created:
    - src/lib/commissions.js
    - src/lib/commissions.test.js
    - migrations/002_commission_engine.sql
  modified:
    - src/db.js

key-decisions:
  - "No test framework introduced — plain node:assert script matches zero-dependency project style"
  - "tier.to is exclusive upper bound — thisUnit <= t.to means boundary unit stays in current tier"
  - "Bonus filter uses unitsBefore < b.units && thisUnit >= b.units — triggers exactly at crossing, never repeats"

patterns-established:
  - "Commission logic lives in src/lib/ as pure shared module required by routes"
  - "Migration 002 wired after 001 but before CREATE TABLE blocks in initDb()"

duration: 12min
completed: 2026-06-30
---

# Phase 2 Plan 01: Commission Engine Foundation Summary

**Tiered commission calculation as a pure shared module (calculateCommission) with boundary-accurate tier lookup, one-time bonus crossing, flat rate fallback, and idempotent schema migration with monthly-query indexes**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-06-30T20:16:00Z
- **Completed:** 2026-06-30T20:28:10Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Created `src/lib/commissions.js` as a pure, zero-dependency function ready for reuse by webhook.js, portal.js, and admin.js
- Wrote 10 unit test assertions covering tier boundaries, bonus crossing (trigger once only), flat rate fallback (empty and null rules), and non-round earned amounts — all pass
- Created `migrations/002_commission_engine.sql` with idempotent client_id safety-net columns and composite performance indexes; wired into `src/db.js` initDb() in correct order

## Task Commits

Each task was committed atomically:

1. **Task 1: Create commissions.js module** - `eb2a1fd` (feat)
2. **Task 2: Write unit tests** - `b74cf90` (test)
3. **Task 3: Migration file and db.js wiring** - `c30b4be` (feat)

## Files Created/Modified

- `src/lib/commissions.js` - Pure calculateCommission function; no DB dependency
- `src/lib/commissions.test.js` - 10 assertions via node:assert, exits 0
- `migrations/002_commission_engine.sql` - Idempotent client_id columns + composite indexes on commissions and orders
- `src/db.js` - Added 002 migration block after 001, before table creation

## Decisions Made

- No test framework introduced — plain `node:assert` script keeps zero-devDependencies project style; runnable with `node src/lib/commissions.test.js`
- `tier.to` is an exclusive upper bound per spec: `thisUnit <= t.to` means the boundary unit (e.g. 10th) stays in the lower tier
- Bonus filter `unitsBefore < b.units && thisUnit >= b.units` ensures exactly one trigger at the crossing sale, never before or after

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `calculateCommission` is ready to `require('../lib/commissions')` from webhook.js (02-04)
- Schema migration is idempotent; runs safely on next `initDb()` call against live DB
- All other Phase 2 plans can now build on this foundation

---
*Phase: 02-commission-engine*
*Completed: 2026-06-30*
