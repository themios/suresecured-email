---
phase: 04-voice
plan: 04
subsystem: ui
tags: [retell, voice, admin, provisioning, express]

# Dependency graph
requires:
  - phase: 04-01
    provides: voice schema (clients.voice_extension, retell_llm_id, retell_agent_id) + src/lib/retell.js createLlm/createAgent
provides:
  - Client admin form with voice_extension input and read-only retell_agent_id display
  - One-click Retell agent provisioning via POST /admin/clients/:id/provision-voice
  - voice_extension saved to clients table on create and update
affects: [04-voice inbound routing, retell-hooks call-ended webhook]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Provision route fetches brand_config to build LLM prompt — no hardcoded client names"
    - "JS inline provisionVoice() fetch with disabled-button + status span UX pattern"
    - "requireRole('operator', 'owner') multi-arg pattern for admin-only routes"

key-files:
  created: []
  modified:
    - src/routes/admin.js

key-decisions:
  - "escapeHtml() added inline in admin.js — no new dependency, consistent with no-template-engine pattern"
  - "voice_extension added to both INSERT /clients and UPDATE /clients/:id — both paths persist the field"
  - "requireRole('operator', 'owner') matches existing agency dashboard pattern (not array variant)"
  - "APP_BASE_URL env with req.hostname fallback — webhook URL works locally and on Railway without extra config"
  - "provision-voice route placed before Agency Dashboard section — logical grouping with other client routes"

patterns-established:
  - "Inline <script> in clientFormHtml() for client-specific JS — matches existing page pattern"
  - "Provision route returns JSON ({ ok, llmId, agentId } or { error }) — never redirects, JS caller handles display"

# Metrics
duration: 8min
completed: 2026-06-30
---

# Phase 4 Plan 04: Voice Admin Provisioning Summary

**Retell AI LLM + agent one-click provisioning via /admin/clients/:id/provision-voice with voice_extension field in client form**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-30T00:00:00Z
- **Completed:** 2026-06-30T00:08:00Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- Client edit form shows voice_extension input (editable) and retell_agent_id (read-only, shows "Not provisioned" until provisioned)
- "Provision Voice Agent" / "Re-provision Voice Agent" button with inline JS fetch and live status feedback
- POST /admin/clients/:id/provision-voice creates Retell LLM then agent in sequence, saves both IDs to DB
- voice_extension persisted on both client create and update paths

## Task Commits

Each task was committed atomically:

1. **Task 1: Add voice_extension to client form and save on POST** - `fed86e8` (feat)
2. **Task 2: Add POST /admin/clients/:id/provision-voice route** - `6d55803` (feat)

**Plan metadata:** (docs commit to follow)

## Files Created/Modified
- `src/routes/admin.js` - escapeHtml helper, Voice section in clientFormHtml(), voice_extension in POST handlers, provision-voice route

## Decisions Made
- `escapeHtml()` added as simple inline helper — no template engine or new dep needed; matches codebase no-dependency style
- `requireRole('operator', 'owner')` matches the existing multi-arg pattern used on agency dashboard routes
- `APP_BASE_URL` env with `req.hostname` fallback means webhook URL auto-resolves correctly on Railway without extra config step
- provision-voice placed as a named route section before Agency Dashboard for logical client-route grouping

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

To use Retell provisioning:
- Set `RETELL_API_KEY` environment variable
- Optionally set `APP_BASE_URL` (defaults to `https://{req.hostname}` if not set)

## Next Phase Readiness
- Voice admin control plane complete: operators can set voice_extension and provision Retell agents per client
- Ready for 04-02 (IVR inbound routing) and 04-03 (retell-hooks webhook handler) which consume retell_agent_id

---
*Phase: 04-voice*
*Completed: 2026-06-30*
