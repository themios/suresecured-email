# Phase 5: AI Intelligence - Research

**Researched:** 2026-06-30
**Domain:** OpenRouter/Gemini AI, lead scoring, cron jobs, digest email
**Confidence:** HIGH (codebase findings), MEDIUM (OpenRouter API pattern)

---

## Summary

Phase 5 adds two features: a daily AI digest email per client, and a 1–100 engagement score per lead. The codebase is well-prepared — reply detection already exists (`checkForReplies` in gmail.js), subjects are stored in `sequence_steps`, and `email_sends` has open_count, click_count, and bounced columns. OpenRouter uses an OpenAI-compatible REST API; a plain `https` call works with no SDK needed (matching the no-devDependencies philosophy). The cron route at `/cron/send-sequences` should be extended with a second endpoint `/cron/daily-digest` rather than a new file — same auth pattern, same module structure. Lead score lives as a new column on `leads` — no new table needed.

**Primary recommendation:** Extend `cron.js` with a second route, call OpenRouter via native `https.request`, add `engagement_score INTEGER` to `leads`, build a separate `buildDigestHtml()` function that skips pixel/unsubscribe.

---

## Standard Stack

### Core (already present — no new installs)
| Component | What Exists | Use For |
|-----------|-------------|---------|
| Node.js native `https` | Built-in | OpenRouter HTTP POST — no axios/node-fetch needed |
| `pool` from `src/db.js` | Existing | All digest and scoring queries |
| `gmail.js` `sendSequenceEmail` | Existing | NOT reused for digest (wrong template) |
| `gmail.js` `buildRawMessage` + `getAuthedClient` | Existing | Reuse internals for digest send |
| `cron.js` router | Existing | Add `/cron/daily-digest` route here |
| `google.gmail` API | Existing via googleapis | Digest send uses same Gmail send path |

### No New Dependencies
Confirm: zero new npm packages. OpenRouter call = native `https`. No template engine.

---

## Architecture Patterns

### Recommended File Changes
```
src/
├── routes/cron.js          # ADD: GET /daily-digest route (second route in same file)
├── lib/gmail.js            # ADD: buildDigestHtml() function, export it
│                           # REUSE: buildRawMessage(), getAuthedClient()
migrations/
└── 005_ai_intelligence.sql # ADD: engagement_score column on leads
                            # ADD: digest_log table (optional — for idempotency)
```

### Pattern 1: OpenRouter HTTP Call (native https)
**What:** POST to OpenRouter using Node's built-in https module
**When to use:** All AI prompt calls — no SDK, matches no-devDependencies rule

```javascript
// Source: https://openrouter.ai/docs/quickstart
const https = require('https');

function callOpenRouter(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.choices[0].message.content);
        } catch (e) {
          reject(new Error('OpenRouter parse error: ' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
```

**Model slug:** `google/gemini-2.5-flash` (confirmed on OpenRouter, cost-effective, fast)
**Fallback slug:** `google/gemini-flash-latest` (always routes to latest Flash)

### Pattern 2: Per-Client Digest Query
**What:** One query per client aggregating last-24h metrics
**Key tables:** `leads`, `contact_enrollments`, `email_sends`, `sequence_steps`

```sql
-- Per-client metrics for digest prompt (last 24h)
SELECT
  COUNT(DISTINCT l.id) FILTER (WHERE l.created_at >= NOW() - INTERVAL '24 hours') AS new_leads_24h,
  COUNT(es.id) FILTER (WHERE es.sent_at >= NOW() - INTERVAL '24 hours') AS emails_sent_24h,
  COALESCE(AVG(es.open_count) FILTER (WHERE es.sent_at >= NOW() - INTERVAL '24 hours'), 0) AS avg_opens,
  COALESCE(AVG(es.click_count) FILTER (WHERE es.sent_at >= NOW() - INTERVAL '24 hours'), 0) AS avg_clicks,
  COUNT(ce.id) FILTER (WHERE ce.status = 'paused' AND ce.paused_reason = 'replied'
                         AND ce.updated_at >= NOW() - INTERVAL '24 hours') AS replies_24h,
  COUNT(es.id) FILTER (WHERE es.bounced = true AND es.sent_at >= NOW() - INTERVAL '24 hours') AS bounces_24h
FROM clients c
LEFT JOIN leads l ON l.client_id = c.id
LEFT JOIN contact_enrollments ce ON ce.client_id = c.id
LEFT JOIN email_sends es ON es.client_id = c.id
WHERE c.id = $1;
```

```sql
-- Top subject lines by open rate (last 7 days) — subjects live in sequence_steps
SELECT ss.subject,
       SUM(es.open_count) AS total_opens,
       COUNT(es.id) AS sends,
       ROUND(SUM(es.open_count)::numeric / NULLIF(COUNT(es.id), 0), 2) AS open_rate
FROM email_sends es
JOIN sequence_steps ss ON ss.id = es.step_id
WHERE es.client_id = $1
  AND es.sent_at >= NOW() - INTERVAL '7 days'
GROUP BY ss.subject
ORDER BY open_rate DESC
LIMIT 3;
```

### Pattern 3: Lead Engagement Score (batch)
**Formula — additive scoring to 100:**

| Signal | Points | Rationale |
|--------|--------|-----------|
| open_count >= 1 | +20 | Confirmed active |
| open_count >= 3 | +10 (bonus) | Repeated engagement |
| click_count >= 1 | +25 | High intent signal |
| click_count >= 3 | +10 (bonus) | Very high intent |
| ce.status = 'paused', paused_reason = 'replied' | +25 | Strongest signal |
| ce.current_step >= 3 | +10 | Survived multi-step |
| NOT bounced | +0 (bounced = -50 effective, cap at 0) | Undeliverable |

**Implementation:** LEAST(100, GREATEST(0, computed_score)) — cap at both ends

```sql
-- Batch score update per client
UPDATE leads l
SET engagement_score = LEAST(100, GREATEST(0,
  COALESCE((
    SELECT
      (CASE WHEN SUM(es.open_count) >= 1 THEN 20 ELSE 0 END) +
      (CASE WHEN SUM(es.open_count) >= 3 THEN 10 ELSE 0 END) +
      (CASE WHEN SUM(es.click_count) >= 1 THEN 25 ELSE 0 END) +
      (CASE WHEN SUM(es.click_count) >= 3 THEN 10 ELSE 0 END) +
      (CASE WHEN MAX(ce.current_step) >= 3 THEN 10 ELSE 0 END) +
      (CASE WHEN bool_or(ce.paused_reason = 'replied') THEN 25 ELSE 0 END)
    FROM contact_enrollments ce
    JOIN email_sends es ON es.enrollment_id = ce.id
    WHERE ce.lead_id = l.id AND ce.client_id = $1
  ), 0)
))
WHERE l.client_id = $1;
```

### Pattern 4: Digest Email (operator-facing, no tracking)
**Key difference from sequence emails:**
- No pixel token — operator is the recipient, not a tracked lead
- No unsubscribe link — internal operational email
- No `email_sends` row insertion needed (not a lead outreach)
- Use `buildRawMessage()` directly + `getAuthedClient()` for the operator's salesperson Gmail
- Need a new `buildDigestHtml(bodyText, brandConfig)` that omits pixel/unsubscribe sections

**Who sends it:** Use the operator's own Gmail OAuth account (salesperson with role='operator'). Query: `SELECT s.id FROM salespeople s JOIN users u ON u.email = s.email WHERE u.role IN ('operator','owner') AND u.client_id = $1 LIMIT 1`

**Who receives it:** Operator email from `users` table where role IN ('operator', 'owner') for the client.

### Pattern 5: Cron Route Extension (not a new file)
```javascript
// In src/routes/cron.js — add second route
router.get('/daily-digest', cronAuth, async (req, res) => {
  // 1. Get all active clients
  // 2. For each client:
  //    a. Query 24h metrics
  //    b. Query top subjects
  //    c. Build prompt string
  //    d. Call OpenRouter
  //    e. Send via Gmail to operator
  // 3. Return summary { ok, processed, errors }
});
```

### Anti-Patterns to Avoid
- **Creating a new cron file:** The cronAuth middleware and pattern already exist in cron.js — add the route there
- **Using sendSequenceEmail for digest:** It inserts email_sends rows, adds tracking pixel, adds unsubscribe — all wrong for operator-facing digest
- **Calling OpenRouter with axios/fetch:** Plain https.request works and requires zero dependencies
- **Storing score in a separate table:** A column on leads (`engagement_score INTEGER DEFAULT 0`) is sufficient — the score is a property of the lead, not a time-series

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| AI model call | Custom HTTP client | Native `https.request` pattern above |
| Reply detection | Gmail inbox polling | `checkForReplies()` already in gmail.js |
| Digest HTML email | New template engine | New `buildDigestHtml()` in gmail.js (stripped-down version of `buildHtml()`) |
| OAuth Gmail send | Re-implement auth | `getAuthedClient()` + `buildRawMessage()` already in gmail.js |

---

## Common Pitfalls

### Pitfall 1: Reply Detection Gap
**What goes wrong:** `checkForReplies()` returns true only if a Gmail thread has >1 message. But `contact_enrollments.paused_reason = 'replied'` is only set if the cron already ran and detected the reply. So the digest may not count replies that happened after the last cron run.
**How to avoid:** For the scoring batch, use `ce.paused_reason = 'replied'` from the DB (written by cron) rather than live Gmail API calls. This is fast and consistent.

### Pitfall 2: Missing `updated_at` on contact_enrollments
**What goes wrong:** The schema has no `updated_at` on `contact_enrollments` — you can't filter "replied in last 24h" by timestamp.
**How to avoid:** For digest, count all-time replies vs the enrollment count, or add `replied_at TIMESTAMPTZ` column in migration 005. For initial implementation, report total active reply-paused enrollments per client.

### Pitfall 3: subject stored on sequence_steps, not email_sends
**What goes wrong:** `email_sends.subject` is a TEXT column (confirmed in db.js) that stores the resolved (variable-substituted) subject. `sequence_steps.subject` is the template. For "top performing subject lines," join `email_sends` to `sequence_steps` via `step_id` to get the canonical template subject, not the per-lead variation.
**How to avoid:** Always JOIN `email_sends es JOIN sequence_steps ss ON ss.id = es.step_id` for subject analytics.

### Pitfall 4: OpenRouter timeout on slow models
**What goes wrong:** Gemini Flash is fast, but network timeouts on `https.request` default to none — a stalled AI call hangs the cron response forever.
**How to avoid:** Set a request timeout: `req.setTimeout(30000, () => { req.destroy(); reject(new Error('OpenRouter timeout')); })`. Wrap per-client AI call in try/catch so one failure doesn't block other clients.

### Pitfall 5: Digest sent from wrong Gmail account
**What goes wrong:** Each salesperson has their own OAuth token. Digest must send from an operator-owned Gmail, not a salesperson's. If no operator has Gmail connected, digest fails silently.
**How to avoid:** Fall back to a `DIGEST_FROM_EMAIL` env var using nodemailer SMTP (or check `email_accounts` for any enabled account tied to an operator-role user).

### Pitfall 6: Scoring batch runs on all leads, not just client-scoped
**What goes wrong:** Forgetting `WHERE l.client_id = $1` on the UPDATE statement updates all leads across all clients.
**How to avoid:** Always scope UPDATE to client_id. Loop over clients explicitly in the cron route.

---

## DB Schema Changes (Migration 005)

```sql
-- 005_ai_intelligence.sql

-- Lead engagement score
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS engagement_score INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_leads_engagement_score ON leads(engagement_score);

-- Optional: track when leads were last scored
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS scored_at TIMESTAMPTZ;

-- Optional: track reply timestamps on enrollments
ALTER TABLE contact_enrollments
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;

-- Optional: digest send log for idempotency (prevent double-sends)
CREATE TABLE IF NOT EXISTS digest_sends (
  id         SERIAL PRIMARY KEY,
  client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period     DATE NOT NULL,           -- the date being summarized
  UNIQUE(client_id, period)           -- prevents double-digest for same day
);
```

---

## Prompt Template

Keep prompts small and structured — Gemini Flash is good at JSON output:

```javascript
function buildDigestPrompt(metrics) {
  return `You are a sales analytics assistant. Summarize the following 24-hour email campaign metrics for an operator.
Write 3-4 plain English sentences. Be direct and actionable. No bullet lists.

Metrics:
- New leads: ${metrics.new_leads_24h}
- Emails sent: ${metrics.emails_sent_24h}
- Replies received: ${metrics.replies_24h}
- Bounces: ${metrics.bounces_24h}
- Average opens per email: ${metrics.avg_opens}
- Average clicks per email: ${metrics.avg_clicks}
- Top subject lines this week: ${metrics.top_subjects.join(', ')}

Write the summary now:`;
}
```

---

## Cron Timing

- **Trigger:** Same cron-job.org setup as `/cron/send-sequences`
- **Schedule:** Once daily, e.g., 7:00 AM operator's timezone (or just UTC 6am for simplicity)
- **Endpoint:** `GET /cron/daily-digest` with same `Authorization: Bearer <CRON_SECRET>` header
- **Idempotency:** Check `digest_sends` table before processing — skip if already sent today for this client

---

## Open Questions

1. **Operator email target:** No `users.role` query in current code exists yet (Phase 1 tables exist but routing may not be complete). May need to fall back to `clients.brand_config.operator_email` JSONB field, or add it.
   - Recommendation: Add `operator_email` to `brand_config` JSONB for each client as the digest recipient.

2. **What Gmail account sends the digest?** Operator may not have Gmail OAuth connected. 
   - Recommendation: Use any `email_accounts` row linked to the client's salesperson pool. Document as a config requirement. Or: add a `DIGEST_SENDER_SALESPERSON_ID` env var.

3. **contact_enrollments has no `updated_at`:** Can't filter "replied in last 24h."
   - Recommendation: Add `replied_at TIMESTAMPTZ` in migration 005 and set it in cron.js when `paused_reason = 'replied'` is written.

---

## Sources

### Primary (HIGH confidence)
- Codebase: `src/lib/gmail.js` — reply detection, buildHtml, sendSequenceEmail, buildRawMessage patterns
- Codebase: `src/routes/cron.js` — existing cron auth pattern, route structure
- Codebase: `src/db.js` — full table schemas for leads, email_sends, contact_enrollments, sequence_steps
- Codebase: `migrations/001_add_tenancy.sql` — client_id scoping on all tables
- Codebase: `migrations/003_email_deliverability.sql` — open_count, click_count, bounced, pixel_token columns

### Secondary (MEDIUM confidence)
- https://openrouter.ai/docs/quickstart — API endpoint, headers, request body format
- https://openrouter.ai/google/gemini-2.5-flash — Model slug `google/gemini-2.5-flash` confirmed active

---

## Metadata

**Confidence breakdown:**
- Codebase analysis (gmail.js, cron.js, schema): HIGH — read directly
- OpenRouter API call pattern: MEDIUM — verified from official docs
- Gemini model slug: MEDIUM — confirmed via OpenRouter model page
- Lead scoring formula: MEDIUM — derived from available columns, no prior art in codebase
- Digest prompt template: LOW — reasonable starting point, will need tuning

**Research date:** 2026-06-30
**Valid until:** 2026-07-30 (OpenRouter model slugs may change)
