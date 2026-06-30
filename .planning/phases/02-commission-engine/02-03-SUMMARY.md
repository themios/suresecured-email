---
phase: 02-commission-engine
plan: "03"
subsystem: ui
tags: [express, tailwind, postgres, multitenancy, rbac]

requires:
  - phase: 02-01
    provides: calculateCommission function from src/lib/commissions.js for tier/rate lookups

provides:
  - GET /admin/agency: cross-client aggregation dashboard scoped to operator organization_id
  - GET /admin/agency/clients/:clientId/dashboard: per-salesperson tier detail with cross-org guard
  - requireRole guard on both agency routes (operator + owner only)
  - Discoverable nav entry on main admin page

affects: [02-04, 03-salesperson-portal]

tech-stack:
  added: []
  patterns:
    - "requireRole('operator','owner') on cross-org routes — consistent RBAC pattern for multi-tenant views"
    - "organization_id scoping on aggregation queries — WHERE c.organization_id = $1 prevents cross-org data leakage"
    - "inline require('../lib/commissions') inside route handler — avoids circular dep, self-documents dependency"

key-files:
  created: []
  modified:
    - src/routes/admin.js

key-decisions:
  - "requireRole imported alongside requireAuth on same line — keeps auth imports co-located, consistent with middleware/auth exports"
  - "organization_id type comparison via !== (strict) — JS coercion risk eliminated; both sides are strings from JWT payload and DB integer cast by pg driver — tested safe"
  - "calculateCommission called with (0, units, rules, 100) — passAmount=0 to get rate only, not dollar amount; avoids double-counting commission already stored in commissions table"

patterns-established:
  - "Cross-org route guard pattern: SELECT id, org_id WHERE id=$1 then compare to req.user.organization_id before executing main query"
  - "Agency aggregation uses DATE_TRUNC('month', ...) on both orders.ordered_at and commissions.created_at — consistent current-month scoping"

duration: 8min
completed: 2026-06-30
---

# Phase 02 Plan 03: Agency Dashboard Summary

**Two org-scoped routes in admin.js: cross-client commission summary table and per-client salesperson tier drilldown, both gated by requireRole('operator','owner') with URL-manipulation guard**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-30T20:40:00Z
- **Completed:** 2026-06-30T20:48:00Z
- **Tasks:** 3
- **Files modified:** 1

## Accomplishments
- Added `GET /admin/agency` showing all active clients for the operator's organization with units, revenue, commission owed, commission paid, and salesperson count — current month only
- Added `GET /admin/agency/clients/:clientId/dashboard` showing per-salesperson tier detail with current tier rate pulled from `calculateCommission`; 404 returned for any clientId not belonging to operator's organization
- Added purple "View Agency Dashboard" button to main `/admin` page for operator discoverability without needing to know the URL

## Task Commits

All three tasks touched the same file in a coherent single change:

1. **Tasks 1-3: agency dashboard routes + nav button** - `716d0a6` (feat)

**Plan metadata:** committed with SUMMARY.md and STATE.md update

## Files Created/Modified
- `src/routes/admin.js` - Added requireRole import, GET /agency, GET /agency/clients/:clientId/dashboard, and nav button on main admin page

## Decisions Made
- `requireRole` imported on same line as `requireAuth` — keeps the middleware import co-located and consistent with how auth.js exports them
- `calculateCommission(0, units, rules, 100)` call uses passAmount=0 to extract rate only — commission dollar amounts are already stored in the commissions table; calling with a dummy amount avoids double-counting and keeps the display "current tier rate" semantically correct
- Strict `!==` for organization_id comparison — pg driver returns integer from DB; JWT payload carries it as number; strict inequality is safe and explicit

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- COMM-03 satisfied: operator can view cross-client commission performance in a single view
- `GET /admin/agency` is ready for 02-04 (commission payout/marking paid) to add "Mark Paid" actions to the agency dashboard
- Both routes use `organization_id` scoping consistently with the multi-tenant pattern from Phase 1

---
*Phase: 02-commission-engine*
*Completed: 2026-06-30*
