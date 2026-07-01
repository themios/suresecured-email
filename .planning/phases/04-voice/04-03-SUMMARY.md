---
phase: 04-voice
plan: 03
subsystem: api
tags: [telnyx, sms, webhooks, inbound-sms, sms-messages, cron, 10dlc, sequence-dispatch]

# Dependency graph
requires:
  - phase: 04-01
    provides: sms_messages table, sequence_steps.channel column, leads.phone unique index
  - phase: 04-02
    provides: retell webhook pattern (always 200, idempotent inserts)
provides:
  - src/routes/telnyx.js — POST /telnyx-hooks/sms inbound SMS webhook
  - cron.js SMS dispatch branch — step.channel='sms' fires sendSms(), no-phone guard pauses enrollment
  - sms_messages outbound rows logged from cron
affects:
  - 04-04 (voice admin — no SMS-specific UI, but telnyx.js lib is now exercised end-to-end)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SMS webhook mirror of Retell webhook: always 200, ignore unknown event types"
    - "Channel dispatch branch in cron loop: if (step.channel === 'sms') else email — symmetric addition"
    - "No-phone guard: pauses enrollment with paused_reason='no_phone' before attempting sendSms()"
    - "Outbound SMS logged to sms_messages mirroring email_sends pattern for email"

key-files:
  created:
    - src/routes/telnyx.js
  modified:
    - src/routes/cron.js
    - src/index.js

key-decisions:
  - "04-03: telnyxRouter always returns 200 — Telnyx retries on 5xx, same pattern as retellRouter"
  - "04-03: sms_messages INSERT runs even when lead is not found (leadId=null) — preserves unknown-sender records"
  - "04-03: paused_reason='sms_reply' mirrors paused_reason='replied' from email path — same semantic"
  - "04-03: SMS channel branch in cron else-falls to email path — preserves all existing enrollment logic"
  - "04-03: 10DLC gate comment retained in both telnyx.js route and cron.js dispatch block"

patterns-established:
  - "Inbound webhook pattern: always 200, guard on event_type, idempotent side effects"
  - "Outbound channel dispatch: step.channel branch in cron loop, SMS and email share enrollment advance logic"

# Metrics
duration: 6min
completed: 2026-06-30
---

# Phase 4 Plan 03: Telnyx SMS Inbound + Cron SMS Dispatch Summary

**Inbound SMS webhook (POST /telnyx-hooks/sms) closes the reply loop via sms_messages + enrollment pause; cron send-sequences dispatches outbound SMS when step.channel='sms' with 10DLC gate comment**

## Performance

- **Duration:** 6 min
- **Started:** 2026-06-30T00:00:00Z
- **Completed:** 2026-06-30T00:06:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- src/routes/telnyx.js created: handles message.received events, inserts sms_messages row (inbound), pauses active enrollment with paused_reason='sms_reply' when lead found by phone
- cron.js: sendSms imported, lead_phone added to enrollment SELECT, SMS dispatch branch added before email path — no-phone guard pauses with paused_reason='no_phone', outbound SMS logged to sms_messages
- index.js: telnyxRouter required and mounted at /telnyx-hooks after express.json()

## Task Commits

Each task was committed atomically:

1. **Task 1: Create src/routes/telnyx.js (inbound SMS webhook)** - `1e5d832` (feat)
2. **Task 2: Add SMS branch to cron.js and mount telnyx router in index.js** - `be8b2a9` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `src/routes/telnyx.js` — POST /sms inbound handler: event filter, lead lookup by phone, sms_messages INSERT, enrollment pause
- `src/routes/cron.js` — sendSms import, lead_phone in SELECT, SMS channel branch replacing bare sendSequenceEmail call
- `src/index.js` — telnyxRouter require + mount at /telnyx-hooks

## Decisions Made
- telnyxRouter always returns 200: Telnyx retries on 5xx; same pattern established by retellRouter in 04-02
- sms_messages INSERT runs even for unknown senders (leadId=null): preserves inbound records for debugging without requiring lead match
- paused_reason='sms_reply': mirrors 'replied' semantics from email; distinguishes channel in paused_reason column
- SMS channel branch uses else: email path is the default, SMS is explicit opt-in per step; avoids breaking existing email-only sequences
- 10DLC gate comment kept in both files: outbound SMS will be silently blocked by carriers without Brand+Campaign registration

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no new env vars needed beyond TELNYX_API_KEY and TELNYX_PHONE_NUMBER (documented in 04-01).

10DLC registration in Telnyx portal (Messaging > Brands & Campaigns) is required before outbound SMS delivers to US numbers. 3-7 day approval window. Inbound webhook works immediately.

## Next Phase Readiness
- 04-04 (voice admin) can proceed: telnyx SMS path is end-to-end wired
- All SMS infrastructure (inbound webhook + outbound cron dispatch + sms_messages logging) is complete
- 10DLC registration is the only remaining gate for live outbound SMS

---
*Phase: 04-voice*
*Completed: 2026-06-30*
