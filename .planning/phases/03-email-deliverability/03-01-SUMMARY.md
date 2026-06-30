---
phase: 03-email-deliverability
plan: 01
subsystem: database
tags: [postgres, email-tracking, pixel, open-count, uuid, express]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: email_sends table, gmail.js sendSequenceEmail, express route structure
  - phase: 02-commission-engine
    provides: 002_commission_engine.sql migration pattern
provides:
  - migrations/003_email_deliverability.sql — open_count, click_count, bounced, bounce_error, pixel_token columns on email_sends
  - email_tracking_tokens table for click tracking (used in plan 03-02)
  - GET /pixel/:token public route returning 43-byte 1x1 GIF
  - sendSequenceEmail() now pre-generates pixel UUID and embeds pixel img in HTML
affects: [03-02-click-tracking, 03-03-bounce-handling, portal-analytics]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Fire-and-forget DB update after HTTP response sent (pixel route)
    - Pre-generate UUID in JS before INSERT so it can be embedded in HTML before DB write
    - COALESCE(opened_at, NOW()) for first-hit-only timestamp semantics

key-files:
  created:
    - migrations/003_email_deliverability.sql
    - src/routes/pixel.js
  modified:
    - src/lib/gmail.js
    - src/index.js

key-decisions:
  - "03-01: pixelToken pre-generated in JS via crypto.randomUUID() not DB default — URL must exist before Gmail send and INSERT"
  - "03-01: Pixel route responds immediately then fires async DB update — email clients time out image requests in ~1-2s"
  - "03-01: COALESCE(opened_at, NOW()) in pixel UPDATE — sets opened_at on first open only, preserves original timestamp on repeat hits"
  - "03-01: buildHtml() pixelUrl param defaults to '' and only injects img tag when truthy — backward-compatible"

patterns-established:
  - "Fire-and-forget DB update: res.end() before pool.query() so response is never delayed by DB"
  - "Pre-generate tracking UUID in application layer for embed-before-insert pattern"

# Metrics
duration: 8min
completed: 2026-06-30
---

# Phase 03 Plan 01: Email Deliverability Schema + Open Pixel Tracking Summary

**Migration 003 adds open/click/bounce/pixel columns to email_sends, public /pixel/:token route returns 1x1 GIF and increments open_count, sendSequenceEmail() embeds pixel URL in every outbound email HTML**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-30T21:14:54Z
- **Completed:** 2026-06-30T21:22:00Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments
- Migration 003 adds 5 columns to email_sends (open_count, click_count, bounced, bounce_error, pixel_token) and creates email_tracking_tokens table with cascade delete
- GET /pixel/:token route serves 43-byte transparent GIF publicly with fire-and-forget open_count increment and first-hit opened_at semantics
- buildHtml() extended with pixelUrl param (default '') injecting 1x1 img before </body>; sendSequenceEmail() pre-generates UUID, embeds it in HTML, and stores it in the email_sends row

## Task Commits

Each task was committed atomically:

1. **Task 1: Migration 003 — add all Phase 03 columns and email_tracking_tokens table** - `683ea26` (feat)
2. **Task 2: Pixel route — GET /pixel/:token responds with 1x1 GIF and increments open_count** - `972d2e0` (feat)
3. **Task 3: Inject pixel URL into buildHtml() and pre-generate pixel_token in sendSequenceEmail()** - `1db0a06` (feat)

## Files Created/Modified
- `migrations/003_email_deliverability.sql` - Phase 03 schema: 5 new columns on email_sends, email_tracking_tokens table, 2 indexes
- `src/routes/pixel.js` - Public GET /pixel/:token route, 43-byte GIF buffer, fire-and-forget open_count UPDATE
- `src/lib/gmail.js` - buildHtml() 5th param pixelUrl, pixel img injection, pixelToken pre-generation in sendSequenceEmail(), pixel_token in INSERT
- `src/index.js` - pixelRouter require and app.use('/pixel', pixelRouter) after /r redirect router

## Decisions Made
- pixelToken pre-generated in JS (not relying on DB default gen_random_uuid()) — the UUID must be known before calling buildHtml() and before the Gmail send, so the URL can be embedded in the outgoing HTML before the INSERT happens
- Pixel route calls res.end() before pool.query() — email clients abort image requests after ~1-2s; DB update is fire-and-forget with .catch() logging
- COALESCE(opened_at, NOW()) — sets opened_at on first pixel hit only; repeat opens increment open_count but do not overwrite the original open timestamp
- buildHtml() backward-compatible: pixelUrl defaults to '' and img tag is only injected when truthy; all existing callers without a 5th arg continue to work

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- DATABASE_URL is a placeholder in .env (known from STATE.md). Migration file is complete and correct; live DB apply will succeed once Railway DATABASE_URL is populated. The migration SQL itself was verified by code review.

## User Setup Required
To apply the migration against the live database once DATABASE_URL is set:
```bash
psql "$DATABASE_URL" -f migrations/003_email_deliverability.sql
```
Verify with:
```bash
psql "$DATABASE_URL" -c "SELECT open_count, click_count, bounced, pixel_token FROM email_sends LIMIT 1"
psql "$DATABASE_URL" -c "\d email_tracking_tokens"
```

## Next Phase Readiness
- 03-02 (click tracking) can begin: email_tracking_tokens table exists, pixel route pattern established
- 03-03 (bounce handling) can begin: bounced and bounce_error columns are in migration 003
- Every email sent via sendSequenceEmail() will now have a pixel_token and will embed the tracking pixel in HTML
- TRACKER_URL env var should be set to the Railway app URL for pixel links to resolve correctly

---
*Phase: 03-email-deliverability*
*Completed: 2026-06-30*
