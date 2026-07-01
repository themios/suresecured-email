---
phase: 04-voice
plan: 02
subsystem: api
tags: [retell, voice, webhooks, inbound-routing, call-logs, lead-creation, https]

# Dependency graph
requires:
  - phase: 04-01
    provides: call_logs table, sms_messages table, voice columns on clients, idx_leads_phone unique index
provides:
  - src/lib/retell.js with createLlm() and createAgent() API wrappers
  - POST /retell-hooks/inbound — routes inbound calls to correct client agent
  - POST /retell-hooks/call-ended — creates lead + call_log + sequence enrollment
affects:
  - 04-03 (Telnyx SIP connect and voice configuration)
  - 04-04 (voice provisioning UI and operator controls)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Webhook-safe inbound handler: always returns 200, never 500 (Retell requires response)"
    - "Idempotent call log insert via ON CONFLICT (retell_call_id) DO NOTHING"
    - "Lead upsert: INSERT ... ON CONFLICT (phone) DO NOTHING RETURNING id, then SELECT if no RETURNING row"
    - "Plain https.request API wrapper matching telnyx.js pattern — no SDK, no new npm deps"

key-files:
  created:
    - src/lib/retell.js
    - src/routes/retell.js
  modified:
    - src/index.js

key-decisions:
  - "04-02: /inbound never returns non-200 — Retell requires a valid response on every inbound event or call fails"
  - "04-02: Client lookup by telnyx_phone_number (call.to_number) for MVP — single number maps to single client without extension metadata"
  - "04-02: call_ended idempotent via ON CONFLICT (retell_call_id) DO NOTHING — Retell may retry webhooks"
  - "04-02: Auto-enrollment uses first active sequence ordered by id — deterministic, no config needed for MVP"
  - "04-02: retellRouter mounted after express.json() at line 76 — parsed body required for webhook payloads"

patterns-established:
  - "Webhook router pattern: no auth middleware, always 200 on inbound, idempotent on payload ID"

# Metrics
duration: 8min
completed: 2026-06-30
---

# Phase 4 Plan 02: Retell Webhook Handlers Summary

**Retell AI inbound call router (override_agent_id) and post-call lead upsert + call_log insert + sequence auto-enrollment via two POST handlers at /retell-hooks**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-30T00:00:00Z
- **Completed:** 2026-06-30T00:08:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- createLlm() and createAgent() API wrappers in src/lib/retell.js using plain https.request — no new npm dependencies
- POST /retell-hooks/inbound: looks up client by telnyx_phone_number, returns { call_inbound: { override_agent_id } }; never returns non-200
- POST /retell-hooks/call-ended: upserts lead by phone (idempotent), inserts call_log (idempotent on retell_call_id), auto-enrolls in first active sequence
- index.js updated with retellRouter mounted after express.json(), /webhooks raw-body route unchanged

## Task Commits

Each task was committed atomically:

1. **Task 1: Create src/lib/retell.js** - `15dbb01` (feat)
2. **Task 2: Create src/routes/retell.js and mount in index.js** - `cee8d2a` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `src/lib/retell.js` - Retell API wrapper: retellRequest(), createLlm(), createAgent()
- `src/routes/retell.js` - POST /inbound and POST /call-ended handlers
- `src/index.js` - retellRouter require added at top, mounted at /retell-hooks after express.json()

## Decisions Made
- /inbound always returns 200 — Retell requires a valid HTTP response or the call fails to connect
- Client identified by telnyx_phone_number matching call.to_number — MVP approach for single-number setup; voice_extension metadata path deferred
- call_ended uses ON CONFLICT (retell_call_id) DO NOTHING — Retell may retry webhooks on timeout
- Auto-enrollment targets first active sequence by id — deterministic ordering avoids random assignment
- retellRouter mounted at line 76 of index.js, well after express.json() at line 33

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no new external service configuration required. RETELL_API_KEY env var documented but not new (carried from 04-01 planning).

## Next Phase Readiness
- 04-03 can begin: Telnyx SIP trunk connect and webhook configuration to point inbound calls at /retell-hooks/inbound
- 04-04 can begin: Operator UI to provision Retell LLM + agent per client (calls createLlm/createAgent from retell.js)
- All webhook handlers are in place and idempotent

---
*Phase: 04-voice*
*Completed: 2026-06-30*
