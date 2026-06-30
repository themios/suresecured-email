---
phase: 03-email-deliverability
plan: 03
subsystem: email
tags: [gmail, bounce-detection, suppression-list, email-tracking, postgres]

# Dependency graph
requires:
  - phase: 03-02
    provides: rewriteLinks(), email_sends INSERT-before-send, email_sends.bounced/bounce_error columns
provides:
  - isPermanentBounce(errMsg) helper — classifies Gmail API errors as permanent vs transient
  - sendSequenceEmail() catch block marks email_sends.bounced=TRUE and returns permanentBounce:true
  - cron.js auto-suppresses bounced email addresses and pauses enrollment on permanent failure
affects:
  - 03-04
  - any future DSN/inbox polling phase

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Error classification via regex pattern array — isPermanentBounce uses PERM_BOUNCE_PATTERNS.some()"
    - "Bounce propagation: gmail.js classifies, returns flag, cron.js acts on flag — no shared state"
    - "suppression_list INSERT ON CONFLICT DO NOTHING — idempotent, global email-level suppression"

key-files:
  created: []
  modified:
    - src/lib/email-tracking.js
    - src/lib/gmail.js
    - src/routes/cron.js

key-decisions:
  - "isPermanentBounce() added to email-tracking.js (not a separate file) — colocated with other email-send helpers"
  - "Bounce scope is API-level errors only — true 550 DSN bounces (Gmail 200, inbox NDR) are explicitly out of scope and documented"
  - "suppression_list UNIQUE(email) has no client_id scoping — bounce in any client suppresses globally; ON CONFLICT DO NOTHING is required"
  - "Bounce DB update in gmail.js uses .catch(err2 => ...) not .catch(() => {}) — logs secondary failure for observability"
  - "permanentBounce:false returned for transient failures — cron.js only acts when flag is true, no behavior change for existing error path"

patterns-established:
  - "Error classification: regex pattern array with .some() — easy to extend with new patterns"
  - "Two-layer bounce handling: classify in lib (gmail.js) → act in route (cron.js)"

# Metrics
duration: 8min
completed: 2026-06-30
---

# Phase 3 Plan 03: Permanent Bounce Detection Summary

**API-level Gmail bounce classification via isPermanentBounce(), email_sends row marking, and automatic suppression_list insertion + enrollment pause in cron.js**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-30T21:07:00Z
- **Completed:** 2026-06-30T21:15:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- `isPermanentBounce(errMsg)` added to `email-tracking.js` — 8 regex patterns covering SMTP 550/553, invalid recipient, user not found, does not exist, mailbox unavailable, no such user, user unknown
- `sendSequenceEmail()` catch block extended: sets `bounced=TRUE` and `bounce_error` on `email_sends`, returns `{ permanentBounce: true }` for permanent failures
- `cron.js` else branch extended: on `permanentBounce`, inserts into `suppression_list` with `ON CONFLICT DO NOTHING` and pauses enrollment with `paused_reason='bounced'`

## Task Commits

Each task was committed atomically:

1. **Task 1: isPermanentBounce() helper in email-tracking.js** - `aabc5ea` (feat)
2. **Task 2: Bounce handling in sendSequenceEmail() catch block and cron.js** - `46463d5` (feat)

## Files Created/Modified
- `src/lib/email-tracking.js` - Added PERM_BOUNCE_PATTERNS array and isPermanentBounce(); updated module.exports
- `src/lib/gmail.js` - Added isPermanentBounce import; extended catch block with bounce detection and DB update; updated return value
- `src/routes/cron.js` - Extended else branch to handle permanentBounce flag — suppression_list INSERT and enrollment pause

## Decisions Made
- `isPermanentBounce()` placed in `email-tracking.js` (not a new file) — all email-send helpers colocated in one module
- Bounce scope explicitly limited to Gmail API-level errors; DSN polling (true 550 where Gmail returns HTTP 200) is documented as future-phase work
- `suppression_list` INSERT uses `ON CONFLICT DO NOTHING` — the table has UNIQUE(email) with no client_id scoping; a bounce in one client's campaign suppresses the address globally, matching existing suppression check behavior
- Secondary bounce DB failure logs via `console.error` rather than silent `.catch(() => {})` — preserves observability for a new code path

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Bounce detection complete and integrated into the send/cron loop
- 03-04 can proceed — email deliverability infrastructure (pixel, click tracking, bounce suppression) is now in place
- Future phase: inbox DSN polling for true 550 hard bounces (where Gmail API returns HTTP 200 but later sends MAILER-DAEMON NDR) — documented in code comments and explicitly out of scope for phase 3

---
*Phase: 03-email-deliverability*
*Completed: 2026-06-30*
