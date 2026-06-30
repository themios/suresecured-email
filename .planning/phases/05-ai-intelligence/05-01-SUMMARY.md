---
phase: 05-ai-intelligence
plan: "01"
subsystem: api
tags: [openrouter, gemini, gmail, postgresql, cron, ai, digest]

# Dependency graph
requires:
  - phase: 03-email-deliverability
    provides: email_sends, email_tracking_tokens, open_count, click_count, bounced columns used in metrics query
  - phase: 01-foundation
    provides: clients, salespeople, users tables and multi-tenant structure
provides:
  - migrations/005_ai_intelligence.sql: engagement_score/scored_at on leads, replied_at on contact_enrollments, digest_sends idempotency table
  - src/lib/openrouter.js: callOpenRouter(prompt) + buildDigestPrompt(metrics) for Gemini 2.5 Flash via OpenRouter
  - buildDigestHtml() in src/lib/gmail.js: operator-facing digest HTML (no pixel, no unsubscribe)
  - GET /cron/daily-digest route: per-client AI digest loop with idempotency, fallback, and operator Gmail send
affects:
  - 05-02 (engagement scoring — uses engagement_score/scored_at columns from migration 005)
  - any future reporting phase that references digest_sends

# Tech tracking
tech-stack:
  added: [openrouter API (native https, no SDK), google/gemini-2.5-flash]
  patterns:
    - native https.request for external API calls — zero new dependencies
    - graceful AI fallback: plain-text summary when OpenRouter fails
    - digest idempotency via INSERT ... ON CONFLICT DO NOTHING + RETURNING id check
    - per-client error isolation: catch per iteration, never crash the full response loop

key-files:
  created:
    - migrations/005_ai_intelligence.sql
    - src/lib/openrouter.js
  modified:
    - src/lib/gmail.js
    - src/routes/cron.js
    - src/db.js

key-decisions:
  - "Native https for OpenRouter — no axios/node-fetch, zero new dependencies, consistent with codebase style"
  - "Digest sent FROM and TO operator's own connected Gmail — no OPENROUTER_DIGEST_EMAIL env var needed, resolved at runtime from DB"
  - "Migration 003 (email deliverability) wired into initDb() in this plan — was missing despite file existing"
  - "reply_rate_pct computed in SQL with ROUND(..., 1) and NULLIF; JS defaults null to '0.0' before AI prompt"
  - "digest_sends UNIQUE(client_id, period) with ON CONFLICT DO NOTHING + RETURNING id empty check = idempotency without extra SELECT"
  - "OpenRouter timeout set to 30s via req.setTimeout(); on timeout req.destroy() + reject with Error"

patterns-established:
  - "AI fallback pattern: try callOpenRouter, catch aiErr, log and use plain-text summary — route never fails due to AI"
  - "Per-client loop: individual try/catch, errors push to errorDetails[], loop continues to next client"
  - "Metrics joins through leads: email_sends and contact_enrollments join on lead_id, not client_id directly"

# Metrics
duration: 12min
completed: 2026-06-30
---

# Phase 5 Plan 01: AI Intelligence Daily Digest Summary

**Gemini 2.5 Flash digest engine via OpenRouter: migration 005 with engagement scoring schema, native-https OpenRouter client, operator-facing digest HTML builder, and /cron/daily-digest route with per-client metrics, AI fallback, and idempotent Gmail send**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-06-30T00:00:00Z
- **Completed:** 2026-06-30T00:12:00Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments
- Migration 005 adds engagement scoring columns and digest_sends idempotency table — all idempotent via IF NOT EXISTS
- OpenRouter client wraps Gemini 2.5 Flash with native https, 30s timeout, error/parse handling, and graceful AI fallback in the route
- GET /cron/daily-digest loops active clients, queries 24h metrics (joins through leads), builds AI prompt, sends operator digest via their own Gmail, records in digest_sends to prevent duplicate sends

## Task Commits

Each task was committed atomically:

1. **Task 1: Migration 005 + db.js wiring** - `47ca404` (feat)
2. **Task 2: src/lib/openrouter.js + buildDigestHtml() in gmail.js** - `d2a1221` (feat)
3. **Task 3: GET /cron/daily-digest route in cron.js** - `8a071cc` (feat)

## Files Created/Modified
- `migrations/005_ai_intelligence.sql` - engagement_score INTEGER / scored_at TIMESTAMPTZ on leads; replied_at TIMESTAMPTZ on contact_enrollments; digest_sends table with UNIQUE(client_id, period)
- `src/lib/openrouter.js` - callOpenRouter(prompt) via native https + buildDigestPrompt(metrics) with all 24h metric fields
- `src/lib/gmail.js` - buildDigestHtml() added; no pixel, no unsubscribe, no CTA — internal operator email only
- `src/routes/cron.js` - GET /cron/daily-digest route with full per-client loop, idempotency, AI fallback, Gmail send
- `src/db.js` - migration 003 and 005 wired into initDb() in correct order

## Decisions Made
- **Native https for OpenRouter:** No new dependencies (axios/node-fetch not introduced). Matches zero-devDependencies style.
- **Recipient from DB at runtime:** Digest sent FROM and TO operator's connected Gmail. No OPENROUTER_DIGEST_EMAIL env var needed.
- **Migration 003 wired here:** File existed (03-email-deliverability) but was never wired into initDb(). Fixed in this plan's Task 1.
- **reply_rate_pct null safety:** NULLIF in SQL produces null when no emails sent; JS defaults to '0.0' before passing to AI prompt to avoid interpolating "null%" in the LLM prompt.
- **Idempotency via RETURNING:** INSERT ... ON CONFLICT DO NOTHING RETURNING id — if rows is empty, skip without extra SELECT round-trip.
- **30s OpenRouter timeout:** Destroys request on timeout; rejects with Error. Route falls back to plain-text summary so cron never stalls.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Wired migration 003 into initDb() — was missing**
- **Found during:** Task 1 (db.js wiring)
- **Issue:** Plan instructed to check if 003 was already wired — it was not. The file existed but initDb() never ran it, meaning email deliverability schema (pixel_token, open_count, click_count, bounced, etc.) was never applied on fresh deployments.
- **Fix:** Added migration003 load block between 002 and 005 in initDb()
- **Files modified:** src/db.js
- **Verification:** `node -e "require('./src/db'); console.log('ok')"` exits 0
- **Committed in:** 47ca404 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 - blocking)
**Impact on plan:** Required fix — without 003 wired, engagement columns on email_sends (open_count, click_count, bounced) would be missing on fresh DB, breaking the digest metrics query. No scope creep.

## Issues Encountered
None — plan executed cleanly. All three verification checks passed.

## User Setup Required

**External service requires manual configuration before /cron/daily-digest will generate AI copy:**

1. **OPENROUTER_API_KEY** — Create API key at https://openrouter.ai/settings/keys and add to .env / Railway environment variables.
   - If key is missing or invalid, route falls back to plain-text metrics summary (no crash).
2. **Ensure operator salesperson has Gmail connected** — digest send skips clients with no operator row or no OAuth tokens in email_accounts.

No new env vars are required for recipients (resolved from DB at runtime).

## Next Phase Readiness
- Plan 05-01 complete: digest engine is live, idempotent, AI-powered with graceful fallback
- Plan 05-02 (engagement scoring) can begin — engagement_score and scored_at columns are already present from migration 005
- No blockers for 05-02

---
*Phase: 05-ai-intelligence*
*Completed: 2026-06-30*
