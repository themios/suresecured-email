---
phase: 05-ai-intelligence
plan: "02"
subsystem: api
tags: [scoring, engagement, cron, portal, leads, postgres]

# Dependency graph
requires:
  - phase: 05-01
    provides: cron infrastructure, cronAuth middleware, pool, active clients loop pattern
  - phase: 03-email-deliverability
    provides: email_sends.open_count, email_sends.click_count, contact_enrollments.paused_reason
  - phase: 01-foundation
    provides: leads table with client_id, contact_enrollments with salesperson_id

provides:
  - computeScore(openCount, clickCount, replied, stepReached) pure function in src/lib/scoring.js
  - POST /cron/score-leads — batch-updates leads.engagement_score and scored_at for all active clients
  - Top Leads by Engagement Score section on salesperson portal dashboard

affects: [portal, leads prioritization, future AI recommendations]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Pure scoring function in src/lib/ — isolated from DB, fully unit-testable
    - Per-client aggregation loop matching daily-digest pattern in cron.js
    - Engagement badge colored green/yellow/grey by tier thresholds (60/30)

key-files:
  created:
    - src/lib/scoring.js
  modified:
    - src/routes/cron.js
    - src/routes/portal.js

key-decisions:
  - "computeScore() is a pure function with no DB dependency — fully unit-testable in isolation"
  - "score-leads aggregates via JOIN query per client (not per lead globally) — client-scoped, safe for multi-tenant"
  - "Portal top-5 query scopes to salesperson via contact_enrollments.salesperson_id (not leads.salesperson_id which does not exist)"
  - "Score UPDATE is idempotent — always sets current computed value, safe to run repeatedly"
  - "engagement_score and scored_at columns added by migration 005 (05-01) — no new migration needed"

patterns-established:
  - "Pure scoring functions in src/lib/ — zero side effects, unit-testable with node -e"
  - "Cron batch loop: get active clients, aggregate signals per client, update leads — matches digest pattern"

# Metrics
duration: 12min
completed: 2026-06-30
---

# Phase 5 Plan 02: Lead Engagement Scoring Summary

**computeScore() additive formula (0-100) + POST /cron/score-leads batch updater + portal score badge via contact_enrollments join**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-06-30T00:00:00Z
- **Completed:** 2026-06-30T00:12:00Z
- **Tasks:** 2
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments
- Pure `computeScore()` function with 5/5 unit test cases passing (0, 45, 100, 30, 25)
- POST /cron/score-leads endpoint that aggregates per-lead signals via JOIN, calls computeScore(), and batch-updates leads.engagement_score + scored_at — client-scoped, idempotent
- Salesperson portal "Top Leads by Engagement Score" section with colored badge (green/yellow/grey) scoped via contact_enrollments

## Task Commits

Each task was committed atomically:

1. **Task 1: computeScore() pure function** - `19da12b` (feat)
2. **Task 2: POST /cron/score-leads + portal score badge** - `5fe5011` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `src/lib/scoring.js` - computeScore(openCount, clickCount, replied, stepReached) -> integer 0-100
- `src/routes/cron.js` - Added POST /cron/score-leads route and computeScore import
- `src/routes/portal.js` - Added top-5 leads query via contact_enrollments, scoreBadge helper, Top Leads section

## Decisions Made
- computeScore() is a pure function with no DB dependency — isolated in src/lib/, fully unit-testable
- Top-5 leads query scopes to salesperson via `contact_enrollments.salesperson_id` — leads table has no direct salesperson_id column
- Score UPDATE is idempotent: always sets the current computed value, safe to run multiple times
- engagement_score and scored_at columns already exist from migration 005 (added in 05-01) — no new migration needed
- Client-scoped aggregation loop per active client matches the daily-digest pattern established in 05-01

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required. The /cron/score-leads route uses the existing CRON_SECRET Bearer token auth identical to other cron routes.

## Next Phase Readiness
- Phase 5 complete — all 2 AI Intelligence plans done
- leads.engagement_score is populated by /cron/score-leads; recommend scheduling alongside send-sequences (every 6h or nightly)
- Portal displays engagement scores — sales team can prioritize outreach by lead hotness
- No blockers for production deployment beyond existing DATABASE_URL and CRON_SECRET env vars

---
*Phase: 05-ai-intelligence*
*Completed: 2026-06-30*
