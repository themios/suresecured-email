---
phase: 03-email-deliverability
plan: 02
subsystem: email
tags: [email-tracking, click-tracking, link-rewriting, gmail, postgres, express]

# Dependency graph
requires:
  - phase: 03-01
    provides: email_sends table with pixel_token column, email_tracking_tokens table with NOT NULL FK to email_sends.id

provides:
  - rewriteLinks(body, emailSendId) — inserts email_tracking_tokens rows per unique URL, returns body with /e/:token URLs
  - GET /e/:token route — public redirect with async click_count increment
  - sendSequenceEmail() refactored to INSERT-before-send ordering (status='sending' → send → 'sent'/'failed')

affects:
  - 03-03-open-tracking
  - 03-04-analytics-dashboard
  - phase 05 (any feature reading click_count from email_sends)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - INSERT-before-send: DB row created before external API call so FK constraints on child rows are satisfiable
    - Fire-and-forget DB update after redirect: res.redirect() called first, pool.query() runs async to minimize redirect latency
    - URL de-duplication: unique URL set extracted before token INSERT loop to avoid duplicate tracking tokens per send

key-files:
  created:
    - src/lib/email-tracking.js
    - src/routes/email-click.js
  modified:
    - src/lib/gmail.js
    - src/index.js

key-decisions:
  - "INSERT email_sends with status='sending' BEFORE Gmail API call — required because email_tracking_tokens.email_send_id is NOT NULL FK"
  - "rewriteLinks() called outside try/catch — DB failures on INSERT surface as thrown errors, not silent ok:false"
  - "Click count increment is fire-and-forget after res.redirect() — minimizes redirect latency for email recipients"
  - "URL de-duplication via Set before INSERT loop — one token per unique URL per send, not per occurrence"

patterns-established:
  - "INSERT-before-send: Always insert the parent row before calling external APIs that require the FK to exist"
  - "Fire-and-forget after response: For non-critical async DB updates, call res.redirect() first then pool.query().catch()"

# Metrics
duration: 8min
completed: 2026-06-30
---

# Phase 3 Plan 02: Email Click Tracking Summary

**Link rewriting with /e/:token redirect route and INSERT-before-send ordering in sendSequenceEmail() using email_tracking_tokens FK constraint**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-06-30T20:51:00Z
- **Completed:** 2026-06-30T20:59:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Created rewriteLinks() that de-duplicates URLs, inserts email_tracking_tokens rows, and returns body with all HTTP/HTTPS URLs replaced by /e/:token tracked redirect URLs
- Created GET /e/:token route (public, no auth) that does 302 redirect to destination_url and increments click_count asynchronously
- Refactored sendSequenceEmail() so email_sends row is inserted with status='sending' before Gmail API call, then updated to 'sent' or 'failed' after — satisfying the email_tracking_tokens NOT NULL FK constraint

## Task Commits

1. **Task 1: email-tracking.js — rewriteLinks() helper** - `316e59c` (feat)
2. **Task 2: email-click route and INSERT-before-send ordering** - `0265473` (feat)

**Plan metadata:** (pending docs commit)

## Files Created/Modified

- `src/lib/email-tracking.js` - rewriteLinks(body, emailSendId) — inserts tracking tokens, returns rewritten body
- `src/routes/email-click.js` - GET /e/:token redirect route with async click_count increment
- `src/lib/gmail.js` - sendSequenceEmail() refactored with INSERT-before-send, rewriteLinks() call, status lifecycle
- `src/index.js` - Registered app.use('/e', emailClickRouter) in public routes section

## Decisions Made

- **INSERT-before-send ordering:** email_sends must be inserted (status='sending') before rewriteLinks() is called because email_tracking_tokens.email_send_id is a NOT NULL FK. The old code did INSERT after send — this would have crashed on any email with links.
- **rewriteLinks() outside try/catch:** If the DB insert fails, the error surfaces as a thrown exception (not ok:false). This is intentional — a send with broken tracking is worse than a visible error.
- **Fire-and-forget click increment:** res.redirect(302, destination) is called before pool.query() for click_count. Email recipients experience minimal redirect latency regardless of DB speed.
- **URL de-duplication via Set:** One token per unique URL per email send. If the same URL appears 3 times in a body, one token row is inserted and all 3 occurrences get the same tracked URL.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. TRACKER_URL and SITE_URL env vars are already documented from 03-01.

## Next Phase Readiness

- Click tracking is complete (click_count increments on redirect)
- Open tracking was completed in 03-01 (pixel route + open_count)
- email_sends rows now have full status lifecycle: sending → sent/failed
- 03-03 can build on this foundation for analytics or additional tracking features
- 03-04 analytics dashboard can query email_sends for open_count, click_count, bounced, status

---
*Phase: 03-email-deliverability*
*Completed: 2026-06-30*
