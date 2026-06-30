---
phase: 02-commission-engine
plan: "02"
subsystem: ui
tags: [portal, commissions, tiered-rates, dashboard, postgres, express]

# Dependency graph
requires:
  - phase: 02-01
    provides: calculateCommission() function with tier lookup and rate extraction
  - phase: 01-02
    provides: requireSpAuth middleware populating req.salesperson (id, client_id)
provides:
  - Portal dashboard with live current tier rate (not static commission_rate)
  - Units-this-month count with tier progress bar and next-tier indicator
  - Pending payout and paid-to-date shown as separate stat cards
  - All new queries scoped by client_id (no cross-client data leakage)
affects:
  - 02-03 (commission webhook — displays same tier context salesperson sees)
  - 02-04 (operator payout view — complements pending/paid split shown here)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - calculateCommission called with saleAmount=0 to extract rate for display — reuses exact tier logic without side effects
    - FILTER (WHERE status = ...) aggregate for pending/paid split — single-pass SQL instead of two queries
    - nextTier = tiers.find(t => t.from >= unitsThisMonth) — finds the next uncrossed threshold for progress indicator

key-files:
  created: []
  modified:
    - src/routes/portal.js

key-decisions:
  - "calculateCommission(0, unitsThisMonth, rules, flatRate) called with saleAmount=0 to extract current tier rate — earned=0 is discarded; guarantees displayed rate matches what the next sale would actually earn"
  - "nextTier found via tiers.find(t => t.from >= unitsThisMonth) — finds first tier threshold not yet crossed; unitsToNextTier = null when on top tier"
  - "req.salesperson.client_id used directly in payout split query params — populated by spAuth middleware, not duplicated from DB"

patterns-established:
  - "Reuse calculateCommission for display-only rate extraction by passing saleAmount=0"
  - "All salesperson-scoped queries must include client_id in JOIN or WHERE to prevent cross-client leakage"

# Metrics
duration: 8min
completed: 2026-06-30
---

# Phase 2 Plan 02: Commission Portal Dashboard Summary

**Portal dashboard upgraded with live tier rate, units-this-month count, tier progress bar, and pending/paid payout split — all scoped by client_id**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-30T20:35:00Z
- **Completed:** 2026-06-30T20:43:00Z
- **Tasks:** 3
- **Files modified:** 1

## Accomplishments
- Salesperson sees their actual current tier rate (computed from commission_rules) instead of the static salespeople.commission_rate value
- Units this month displayed with tier progress bar and "N more units to reach X% tier" indicator
- Pending payout and paid-to-date shown as separate colored stat cards (yellow/green)
- Two new DB queries added to existing Promise.all — no extra round-trips, client_id scoped throughout

## Task Commits

Each task was committed atomically:

1. **Tasks 1-3: add tiered commission context to salesperson portal dashboard** - `e956dfb` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `src/routes/portal.js` - Added calculateCommission import, two new queries (tier context + payout split), tier computation logic, updated header rate display, new Commission Tier card section

## Decisions Made
- `calculateCommission(0, unitsThisMonth, rules, flatRate)` called with saleAmount=0 purely to extract the rate field — earned value discarded; guarantees the displayed rate exactly matches what the next sale would earn (same code path as the webhook)
- `nextTier = tiers.find(t => t.from >= unitsThisMonth)` finds first threshold not yet crossed; when null, "Top tier reached" message shown
- `req.salesperson.client_id` passed directly as query param for payout split — populated by spAuth middleware on every request

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Portal now shows complete commission context salesperson needs to self-monitor performance
- Ready for 02-03: commission calculation webhook (orders trigger → commission record creation)
- Ready for 02-04: operator payout management view (marks pending → paid, complements what salesperson sees here)

---
*Phase: 02-commission-engine*
*Completed: 2026-06-30*
