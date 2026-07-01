---
phase: 05-ai-intelligence
verified: 2026-06-30T22:36:18Z
status: gaps_found
score: 14/16 must-haves verified
gaps:
  - truth: "Daily digest email is successfully sent per client"
    status: failed
    reason: "getAuthedClient and buildRawMessage are defined in gmail.js but missing from module.exports; cron.js destructures them and gets undefined, causing TypeError at runtime"
    artifacts:
      - path: "src/lib/gmail.js"
        issue: "module.exports on line 395 omits getAuthedClient and buildRawMessage — both functions exist in the file but are not exported"
    missing:
      - "Add getAuthedClient and buildRawMessage to gmail.js module.exports"
---

# Phase 05: AI Intelligence Verification Report

**Phase Goal:** Each client receives a daily AI-generated performance digest and every lead has a visible engagement score so operators and salespeople can prioritize outreach.
**Verified:** 2026-06-30T22:36:18Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Operator receives daily AI digest email per client | FAILED | Route and logic exist but getAuthedClient/buildRawMessage are not exported from gmail.js — runtime TypeError |
| 2 | Digest includes new leads, reply rate, top subject lines in AI prompt | VERIFIED | buildDigestPrompt() in openrouter.js includes all fields; reply_rate_pct computed in query and null-coalesced |
| 3 | Digest HTML has no pixel and no unsubscribe link | VERIFIED | buildDigestHtml() (lines 328-393) contains no img tag and no unsubscribe reference |
| 4 | Digest is idempotent (no double-send per day per client) | VERIFIED | digest_sends table with UNIQUE(client_id, period) and INSERT ... ON CONFLICT DO NOTHING in route |
| 5 | Leads are scored 0-100 based on engagement signals | VERIFIED | computeScore() in scoring.js; all three test cases confirmed correct |
| 6 | Engagement score badge visible on salesperson portal | VERIFIED | scoreBadge() function renders colored span; top-leads table in portal.js at line 263 |
| 7 | Top-leads query scoped to salesperson via contact_enrollments | VERIFIED | Query joins contact_enrollments ON ce.lead_id = l.id WHERE ce.salesperson_id = $1 (not leads.salesperson_id) |

**Score:** 6/7 truths verified (14/16 individual must-haves — see artifact table)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/routes/cron.js` GET /daily-digest | Route with cronAuth guard | VERIFIED | Lines 231-371 |
| `src/routes/cron.js` POST /score-leads | Route with cronAuth guard | VERIFIED | Lines 379-428 |
| `src/lib/openrouter.js` callOpenRouter() | Exported, native https, gemini-2.5-flash | VERIFIED | Lines 7-48; uses require('https'), model 'google/gemini-2.5-flash', exported |
| `src/lib/openrouter.js` buildDigestPrompt() | Exported, includes reply_rate_pct | VERIFIED | Lines 50-65; reply_rate_pct included, exported |
| `src/lib/gmail.js` buildDigestHtml() | No pixel img, no unsubscribe | VERIFIED | Lines 328-393; neither present; exported |
| `src/lib/gmail.js` getAuthedClient() | Exported for use in cron.js | STUB | Defined at line 40, used internally, NOT in module.exports (line 395) |
| `src/lib/gmail.js` buildRawMessage() | Exported for use in cron.js | STUB | Defined at line 84, used internally, NOT in module.exports (line 395) |
| `migrations/005_ai_intelligence.sql` | engagement_score, scored_at on leads; replied_at on contact_enrollments; digest_sends table | VERIFIED | All four schema changes present and correct |
| `src/db.js` initDb() | Runs 005 migration | VERIFIED | Lines 35-40 read and execute 005_ai_intelligence.sql |
| `src/lib/scoring.js` computeScore() | Exported, correct formula | VERIFIED | computeScore(0,0,false,1)=0; computeScore(2,1,false,2)=45; computeScore(4,3,true,4)=100 — all pass |
| `src/routes/portal.js` scoreBadge | Colored by tier (green/yellow/gray) | VERIFIED | Lines 251-256; three-tier color logic present |
| `src/routes/portal.js` top-leads query | Scoped via contact_enrollments.salesperson_id | VERIFIED | Line 219-220: JOIN contact_enrollments ce ON ce.lead_id = l.id WHERE ce.salesperson_id = $1 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| cron.js /daily-digest | openrouter.js callOpenRouter() | require + call | WIRED | Line 12 import; line 313 call |
| cron.js /daily-digest | gmail.js buildDigestHtml() | require + call | WIRED | Line 11 import; line 349 call |
| cron.js /daily-digest | gmail.js getAuthedClient() | require + call | NOT WIRED | Imported at line 11 but not in gmail.js module.exports — resolves to undefined |
| cron.js /daily-digest | gmail.js buildRawMessage() | require + call | NOT WIRED | Imported at line 11 but not in gmail.js module.exports — resolves to undefined |
| cron.js /score-leads | scoring.js computeScore() | require + call | WIRED | Line 13 import; line 405 call |
| score-leads query | leads via contact_enrollments | ce.lead_id = l.id | WIRED | Line 398: LEFT JOIN contact_enrollments ce ON ce.lead_id = l.id |
| score-leads query | leads via email_sends | es.lead_id = l.id | WIRED | Line 399: LEFT JOIN email_sends es ON es.lead_id = l.id |
| daily-digest metrics query | leads via contact_enrollments | ce.lead_id = l.id | WIRED | Line 280: LEFT JOIN contact_enrollments ce ON ce.lead_id = l.id |
| daily-digest metrics query | leads via email_sends | es.lead_id = l.id | WIRED | Line 281: LEFT JOIN email_sends es ON es.lead_id = l.id |
| portal.js top-leads | leads via contact_enrollments | ce.lead_id = l.id and ce.salesperson_id | WIRED | Lines 219-220 |

### Requirements Coverage

| Requirement | Status | Blocking Issue |
|-------------|--------|----------------|
| AIML-01: Daily email digest per client via OpenRouter/Gemini | BLOCKED | getAuthedClient and buildRawMessage not exported — email send will throw at runtime |
| AIML-02: Lead score 1–100 visible on lead record and commission dashboard | SATISFIED | computeScore correct, portal scoreBadge rendered, top-leads scoped correctly |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/lib/gmail.js` | 395 | getAuthedClient and buildRawMessage defined but omitted from module.exports | BLOCKER | daily-digest route calls getAuthedClient() which resolves to undefined; TypeError thrown for every client; zero digests sent |

### Human Verification Required

None required — gaps are structural and verifiable programmatically.

### Gaps Summary

One gap blocks goal achievement for AIML-01. The daily-digest infrastructure is complete and correct (migration, prompt builder, HTML builder, OpenRouter client, idempotency, metrics queries, per-client loop), but the route fails at runtime because `getAuthedClient` and `buildRawMessage` in `src/lib/gmail.js` are not exported.

The fix is a single line change: add `getAuthedClient` and `buildRawMessage` to the `module.exports` object on line 395 of `src/lib/gmail.js`.

AIML-02 (scoring) is fully achieved: formula is correct, migration adds the columns, the cron route scores all leads, and the portal displays the colored badge scoped to the right salesperson.

---

_Verified: 2026-06-30T22:36:18Z_
_Verifier: Claude (gsd-verifier)_
