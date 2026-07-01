---
phase: 04-voice
plan: 01
subsystem: database
tags: [postgres, telnyx, sms, retell, voice, migrations]

# Dependency graph
requires:
  - phase: 05-ai-intelligence
    provides: migration 005_ai_intelligence.sql pattern used in db.js initDb()
provides:
  - migrations/006_voice.sql — idempotent voice schema additions (call_logs, sms_messages, clients voice cols, leads.phone, sequence_steps.channel)
  - src/lib/telnyx.js — sendSms(to, body) via plain https.request
affects: [04-02, 04-03, 04-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Plain Node https.request for external REST APIs — no SDK, zero new dependencies"
    - "Idempotent migration blocks in initDb() using readFileSync + pool.query pattern"

key-files:
  created:
    - migrations/006_voice.sql
    - src/lib/telnyx.js
  modified:
    - src/db.js

key-decisions:
  - "No Telnyx SDK — plain https.request, same pattern as OpenRouter in 05-01"
  - "006_voice.sql covers all voice schema in one file — call_logs, sms_messages, clients cols, sequence_steps.channel, leads.phone, contact_enrollments additions"
  - "sequence_steps.channel defaults to 'email' — preserves all existing email-only steps without backfill"
  - "leads.phone gets UNIQUE index — prevents duplicate phone lookups in call-ended webhook upsert"
  - "contact_enrollments client_id and replied_at added here — were referenced in later plans but not in a prior migration"

patterns-established:
  - "telnyx.js: module-level https wrapper (telnyxRequest) + exported async function (sendSms) — mirrors gmail.js structure"
  - "Migration numbering: 006 for voice, leaving 004 gap (reserved/unused)"

# Metrics
duration: 5min
completed: 2026-06-30
---

# Phase 4 Plan 1: Voice Schema and Telnyx SMS Helper Summary

**Idempotent migration 006 adding call_logs, sms_messages, voice columns on clients/leads/sequence_steps, plus sendSms() via plain https.request to Telnyx API**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-06-30T00:00:04Z
- **Completed:** 2026-06-30T00:05:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Migration 006 adds all voice schema in one idempotent file — call_logs with retell_call_id UNIQUE, sms_messages with direction col, clients voice columns, sequence_steps.channel defaulting to 'email', leads.phone with UNIQUE index
- db.js initDb() wired to run migration 006 after 005, before legacy CREATE TABLE blocks
- src/lib/telnyx.js exports sendSms(to, body) using Node core https — no npm install, returns `{ ok, messageId }` on 200 or `{ ok: false, error }` on failure

## Task Commits

Each task was committed atomically:

1. **Task 1: Create migration 006_voice.sql** - `109b891` (feat)
2. **Task 2: Wire migration 006 into initDb() and create src/lib/telnyx.js** - `02eee8c` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `migrations/006_voice.sql` — All voice schema additions, idempotent, single file
- `src/lib/telnyx.js` — sendSms() Telnyx wrapper using plain https
- `src/db.js` — Migration 006 block added to initDb()

## Decisions Made

- No Telnyx SDK — plain https.request matches codebase style (same as OpenRouter in 05-01); zero new npm dependencies
- sequence_steps.channel NOT NULL DEFAULT 'email' — preserves all existing steps without any backfill query
- leads.phone gets UNIQUE index — enables call-ended webhook to upsert lead by phone number safely
- All schema changes in 006_voice.sql (not split across files) — simpler ordering, single re-run target

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

Before SMS or voice routes can go live, add to `.env`:

```
TELNYX_API_KEY=your_telnyx_api_key
TELNYX_PHONE_NUMBER=+1XXXXXXXXXX
```

10DLC Brand + Campaign registration in Telnyx portal is required before SMS delivers to US numbers (3-7 business days for approval).

## Next Phase Readiness

- Migration 006 ready — all subsequent plans in Phase 4 can reference call_logs, sms_messages, and sequence_steps.channel
- telnyx.js sendSms() available for import in SMS dispatch cron (04-02)
- Retell webhook handler (04-03) can reference call_logs table and leads.phone UNIQUE index
- No blockers — schema and library layer are complete

---
*Phase: 04-voice*
*Completed: 2026-06-30*
