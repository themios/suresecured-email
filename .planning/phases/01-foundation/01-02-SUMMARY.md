---
phase: 01-foundation
plan: "02"
subsystem: auth
tags: [jwt, bcrypt, express, middleware, multi-role, cookies]

requires:
  - phase: 01-01
    provides: users table with email, password_hash, role, client_id, organization_id columns

provides:
  - Unified POST /auth/login endpoint reading from users table
  - Scoped JWT with id, email, role, client_id, organization_id in payload
  - requireAuth middleware attaching req.user from cookie
  - requireRole(...roles) factory for route-level role guards
  - requireSpAuth async middleware populating req.salesperson.client_id from DB

affects:
  - 01-03 (admin routes can now use requireRole('operator'))
  - 01-04 (all protected routes use req.user.client_id for query scoping)
  - 01-05 (salesperson portal uses req.salesperson.client_id)

tech-stack:
  added: []
  patterns:
    - "Unified login: all roles (operator/owner/admin/salesperson) authenticate via same endpoint"
    - "JWT payload carries client_id for all downstream query scoping"
    - "requireRole factory: pass one or multiple roles as args or array"
    - "spAuth DB-backed: client_id fetched from salespeople row on each request"

key-files:
  created: []
  modified:
    - src/routes/auth.js
    - src/middleware/auth.js
    - src/middleware/spAuth.js
    - src/index.js

key-decisions:
  - "Auth route changed from POST /login to POST /auth/login — kept GET /login for browser form compatibility"
  - "spAuth fetches salesperson row from DB on each request rather than expanding JWT — ensures client_id is always current"
  - "requireRole accepts rest params so requireRole('op') and requireRole(['op','owner']) both work"
  - "Legacy GET /logout kept alongside GET /auth/logout for backward compat"

patterns-established:
  - "req.user shape: { id, email, role, client_id, organization_id } — all protected routes can depend on this"
  - "req.salesperson shape: { id, name, email, client_id } — salesperson portal routes use this"

duration: 8min
completed: 2026-06-30
---

# Phase 01 Plan 02: Unified Multi-Role Auth Summary

**Replaced single admin_users JWT with users-table login issuing scoped JWTs carrying role and client_id for all route types**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-30T18:37:16Z
- **Completed:** 2026-06-30T18:45:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- POST /auth/login unified for all roles — queries users table, issues JWT with full scope payload
- requireAuth and requireRole middleware complete — req.user always carries { id, email, role, client_id, organization_id }
- requireSpAuth made async with DB lookup — req.salesperson.client_id now populated on every portal request

## Task Commits

1. **Task 1: Update /auth/login to query users table and issue scoped JWT** - `f2dd172` (feat)
2. **Task 2: Update requireAuth and add requireRole middleware** - `de3f760` (feat)

**Plan metadata:** (committed with this summary)

## Files Created/Modified

- `src/routes/auth.js` - Rewritten to query users table; supports JSON + form-encoded login; scoped JWT; SEED_OPERATOR flag
- `src/middleware/auth.js` - requireAuth populates req.user from token; added requireRole factory
- `src/middleware/spAuth.js` - Now async; fetches salesperson from DB to populate req.salesperson.client_id
- `src/index.js` - Imports requireAuth and requireRole at top level for use in later plans

## Decisions Made

- **Login route path changed to /auth/login:** The old form posted to `/login`. Changed to `/auth/login` to match the plan spec. The GET /login page is still served at `/login` (router mounted at `/`). Legacy `/logout` kept for backward compat.
- **spAuth DB-backed lookup:** The sp_token JWT only carries `{ id, name, email }` (issued in portal.js). Rather than reissue tokens or change portal.js, requireSpAuth does a lightweight DB SELECT on each request to get client_id. This is more reliable (stale JWT tokens won't have wrong client_id).
- **requireRole rest-params:** `requireRole('operator')` and `requireRole(['operator', 'owner'])` both work via `roles.flat()`. Matches plan spec exactly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added JSON + form-encoded dual support to POST /auth/login**

- **Found during:** Task 1 (auth route rewrite)
- **Issue:** Plan spec shows JSON API response `{"role":"operator"}` but existing route was form-only with redirect on success. Both login styles need to work.
- **Fix:** Applied `express.urlencoded()` and `express.json()` middleware to POST handler; detected content-type to choose response (JSON 200 vs redirect to /dashboard)
- **Files modified:** src/routes/auth.js
- **Verification:** Test curl with `Content-Type: application/json` returns `{"role":"operator"}`, form POST redirects to /dashboard
- **Committed in:** f2dd172 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (missing critical — dual content-type handling)
**Impact on plan:** Essential for plan's verification test (curl with JSON header). No scope creep.

## Issues Encountered

None.

## Next Phase Readiness

- All protected routes now receive `req.user.client_id` — 01-03 admin routes can scope queries immediately
- `requireRole` available via `require('./middleware/auth')` — use in 01-03 for operator-only routes
- Portal salesperson routes now have `req.salesperson.client_id` — 01-05 can scope salesperson queries
- No blockers for 01-03 or 01-04

---
*Phase: 01-foundation*
*Completed: 2026-06-30*
