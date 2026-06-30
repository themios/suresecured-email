# Phase 03: Email Deliverability - Research

**Researched:** 2026-06-30
**Domain:** Email tracking (pixel + link rewriting), bounce suppression, per-sequence reporting
**Confidence:** HIGH (verified against live codebase) / MEDIUM (Gmail API error detection)

---

## Summary

Phase 03 adds three orthogonal capabilities to the existing email send pipeline:
(1) open tracking via pixel injection, (2) click tracking via link rewriting in the email body,
and (3) hard-bounce suppression. All three touch `sendSequenceEmail()` in `src/lib/gmail.js` but
in different ways, making them implementable in parallel with a careful shared-column dependency.

The `email_sends` table currently has `opened_at TIMESTAMPTZ` (single timestamp) but no
`open_count`, `click_count`, or `bounced` columns. A migration is required before any task
routes can function. The `suppression_list` table and the `paused_reason` column on
`contact_enrollments` both exist — only the cron error-handling path is missing.

The existing `/r/:token` redirect route is for Shopify/landing-page attribution and uses the
`tracking_tokens` table. Email body links need a separate token table scoped to `email_sends`
to avoid coupling email click analytics to Shopify attribution.

**Primary recommendation:** Ship migration 003 first, then tasks 03-01/03-02/03-03 can proceed
in any order. None of the three tracking sub-features depends on another at runtime.

---

## 1. Schema Changes Required

### Migration 003 — add to `email_sends`

```sql
-- 003_email_deliverability.sql
ALTER TABLE email_sends
  ADD COLUMN IF NOT EXISTS open_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS click_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bounced      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bounce_error TEXT;
```

`opened_at` already exists and tracks first-open timestamp. Keep it. `open_count` counts
subsequent re-opens (Apple Mail prefetch means the count is approximate anyway — still useful
for engagement signals). Set `opened_at` on the first pixel hit if currently NULL; always
increment `open_count`.

### New table: `email_tracking_tokens`

The existing `tracking_tokens` table is specifically for Shopify attribution (sets cookies,
appends `?ss_token` to destination URL). Email body click tokens are a different concern:
they must resolve back to `email_sends.id` and increment `click_count` there. A separate
table avoids schema collision and keeps the attribution system clean.

```sql
CREATE TABLE IF NOT EXISTS email_tracking_tokens (
  id          SERIAL PRIMARY KEY,
  token       UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  email_send_id INTEGER NOT NULL REFERENCES email_sends(id) ON DELETE CASCADE,
  destination_url TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ett_token ON email_tracking_tokens(token);
```

No `client_id` column needed here — scoping is inherited through `email_send_id → enrollment_id → client_id`.

### No new table for pixel tokens

Pixel tokens can be the `email_sends.id` itself encoded as a URL-safe HMAC (same pattern as
unsubscribe tokens in `src/lib/unsubscribe.js`). This avoids a lookup table for a high-frequency
path. Alternatively use a UUID column on `email_sends` directly:

```sql
ALTER TABLE email_sends
  ADD COLUMN IF NOT EXISTS pixel_token UUID UNIQUE DEFAULT gen_random_uuid();
CREATE INDEX IF NOT EXISTS idx_email_sends_pixel_token ON email_sends(pixel_token);
```

A dedicated UUID column on `email_sends` is simpler than computing an HMAC at pixel-hit time
and avoids a join on the hot pixel route. Recommended.

---

## 2. Open Pixel Design

### Token strategy

Use `email_sends.pixel_token` (UUID, generated at INSERT time in `sendSequenceEmail()`).
This is unique per send (not per lead), satisfying the requirement.

### Pixel injection in `buildHtml()`

Append to the HTML body before `</body>`:

```html
<img src="https://your-app.railway.app/pixel/{token}"
     width="1" height="1" style="display:none;border:0"
     alt="" aria-hidden="true">
```

`buildHtml()` must accept `pixelUrl` as a new parameter. The pixel URL is built in
`sendSequenceEmail()` after the `INSERT INTO email_sends` (so the token is known) — or
the token is pre-generated and passed in before the insert.

**Correct call order:**
1. Generate `pixelToken = require('crypto').randomUUID()` before sending
2. Pass pixel URL to `buildHtml()`
3. Include `pixel_token` in the `INSERT INTO email_sends`

### Pixel route

```
GET /pixel/:token
```

Response: 1x1 transparent GIF buffer, no redirect.

```javascript
const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'
);

router.get('/:token', async (req, res) => {
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': PIXEL_GIF.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
  });
  res.end(PIXEL_GIF);   // respond immediately — user experience first

  // fire-and-forget DB update
  pool.query(
    `UPDATE email_sends
     SET open_count = open_count + 1,
         opened_at  = COALESCE(opened_at, NOW())
     WHERE pixel_token = $1`,
    [req.params.token]
  ).catch(err => console.error('[pixel] db error:', err));
});
```

**Critical:** Respond with the GIF before touching the DB. Email clients time out image
requests in ~1-2 seconds. The fire-and-forget pattern prevents a slow DB from causing
the pixel to 404/timeout and spooking spam filters.

Route is registered in `src/index.js` as `app.use('/pixel', pixelRouter)` — no auth needed
(must be publicly accessible like `/unsubscribe`).

### open_count vs opened_at

Keep both. `opened_at` = first open timestamp (existing column, already in schema). `open_count`
= total open events including re-opens. Apple Mail Privacy Protection will inflate both but
the ratio across sends is still useful.

---

## 3. Link Rewriting Design

### Where rewriting happens

In `buildHtml()`, the current URL auto-linker regex:

```javascript
line.replace(/(https?:\/\/[^\s<>"]+)/g, `<a href="$1" ...>$1</a>`)
```

This must be replaced with a two-pass approach:
1. Detect all URLs in `resolvedBody`
2. For each URL, create a row in `email_tracking_tokens` → get UUID token
3. Substitute the original URL with `https://your-app.railway.app/e/:token`
4. Pass the rewritten body to `buildHtml()`

**Rewriting must happen in `sendSequenceEmail()`, not in `buildHtml()`**, because it needs
DB access (to insert tokens) and `buildHtml()` is a pure function. Keep `buildHtml()` pure.

### Token insert pattern

```javascript
async function rewriteLinks(body, emailSendId) {
  const urlRegex = /(https?:\/\/[^\s<>"]+)/g;
  const urls = [...new Set(body.match(urlRegex) || [])];
  const tokenMap = {};

  for (const url of urls) {
    const { rows } = await pool.query(
      `INSERT INTO email_tracking_tokens (email_send_id, destination_url)
       VALUES ($1, $2) RETURNING token`,
      [emailSendId, url]
    );
    tokenMap[url] = rows[0].token;
  }

  return body.replace(urlRegex, url => {
    const tok = tokenMap[url];
    return tok
      ? `${process.env.TRACKER_URL}/e/${tok}`
      : url;
  });
}
```

Call after `INSERT INTO email_sends` (so `emailSendId` is known), then pass rewritten body
into `buildHtml()`.

### Click redirect route

```
GET /e/:token
```

```javascript
router.get('/:token', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ett.destination_url, es.id AS email_send_id
     FROM email_tracking_tokens ett
     JOIN email_sends es ON es.id = ett.email_send_id
     WHERE ett.token = $1`,
    [req.params.token]
  );

  if (!rows[0]) return res.redirect(process.env.SITE_URL || 'https://suresecured.com');

  // Redirect immediately, update async
  res.redirect(302, rows[0].destination_url);

  pool.query(
    `UPDATE email_sends SET click_count = click_count + 1 WHERE id = $1`,
    [rows[0].email_send_id]
  ).catch(err => console.error('[email-click] db error:', err));
});
```

Route registered in `src/index.js` as `app.use('/e', emailClickRouter)`. No auth.

### Distinction from existing /r/:token route

`/r/:token` sets cookies, appends UTM params, tracks Shopify attribution → DO NOT reuse.
`/e/:token` only increments `email_sends.click_count` and redirects. Keep them separate.

---

## 4. Bounce Detection

### How Gmail API errors surface in Node.js

The existing catch block in `sendSequenceEmail()` catches errors thrown by
`gmail.users.messages.send()`. The googleapis Node.js client throws an error with:
- `err.code` — HTTP status code (integer: 400, 403, 429, 500, etc.)
- `err.message` — string containing the error description
- `err.errors` — array of error objects (sometimes present)
- `err.response.data` — full Google API error body (if available)

### What indicates a permanent address failure

Google does NOT return a standard 550 SMTP code to the API caller. When Gmail rejects
because the recipient address does not exist or the recipient's server issued a 550 permanent
refusal, Gmail itself processes this as a background DSN (Delivery Status Notification). The
`gmail.users.messages.send` call **succeeds with HTTP 200** and the bounce comes back as a
bounce email to the sender's inbox. This is the core difficulty.

**What does throw in the API call:**
- `err.code === 400` with message containing `"invalid"` — malformed address (local problem)
- `err.code === 403` — quota exceeded or policy block
- `err.code === 429` — rate limit (transient, retry)
- `err.code >= 500` — transient server error

**The actual 550 hard-bounce path:** Gmail delivers, then sends a "Mail Delivery Subsystem"
(MAILER-DAEMON) bounce email to the from-address inbox. This arrives as a new message in the
salesperson's Gmail thread, not as an API error. To detect it programmatically: poll for
undeliverable bounce messages in the Gmail inbox using `gmail.users.messages.list` with
`q: "from:mailer-daemon OR from:postmaster subject:delivery failed"` and parse the NDR.

**Practical approach for this phase (EMAI-02):** Given the pre-planned task description
("catch Gmail permanent failure on send"), the realistic scope is:

1. Detect **API-level rejections** that are unambiguously permanent:
   - `err.code === 400` AND message contains `"invalid"` or `"Recipient address required"`
   - This catches malformed `to` addresses (local validation failure)

2. String-match the error message for known permanent patterns:
   ```javascript
   const PERM_PATTERNS = [
     /550/,
     /permanent.{0,20}fail/i,
     /address.{0,20}not.{0,10}found/i,
     /no such user/i,
     /user unknown/i,
     /invalid recipient/i,
     /does not exist/i,
   ];
   function isPermanentBounce(errMsg) {
     return PERM_PATTERNS.some(p => p.test(errMsg));
   }
   ```
   
   Confidence for this string-matching approach: MEDIUM. Gmail sometimes surfaces the
   recipient server's SMTP message in `err.message`, but this is not guaranteed.

3. For actual DSN bounce emails (the most reliable signal): this requires a second
   `checkForReplies`-style check that reads the inbox for MAILER-DAEMON messages. This is
   a fuller implementation than the pre-planned task describes. The planner should decide
   whether 03-03 covers API-error suppression only (simpler) or also inbox DSN polling
   (complete but more complex). Flag this as an open question.

### Suppression and enrollment pause logic

This pattern already exists for `replied` and `suppressed` cases in `cron.js`. For bounce,
mirror it in `sendSequenceEmail()` return value and then apply in cron:

```javascript
// in sendSequenceEmail() catch block
if (isPermanentBounce(msg)) {
  return { ok: false, error: msg, permanentBounce: true };
}
return { ok: false, error: msg };
```

```javascript
// in cron.js after sendResult
if (!sendResult.ok && sendResult.permanentBounce) {
  await client.query(
    `INSERT INTO suppression_list (email, reason, client_id)
     VALUES ($1, 'bounced', $2) ON CONFLICT (email) DO NOTHING`,
    [row.lead_email, row.client_id]
  );
  await client.query(
    `UPDATE contact_enrollments SET status = 'paused', paused_reason = 'bounced'
     WHERE id = $1`,
    [row.enrollment_id]
  );
  skipped++;
  continue;
}
```

Note: `suppression_list` has a UNIQUE constraint on `email` — the `ON CONFLICT DO NOTHING`
is required (already present in the existing pattern).

---

## 5. Reporting Query Design

The per-sequence report needs: total sends, unique openers, total clicks, bounces.

```sql
-- Per-sequence engagement report
SELECT
  seq.id          AS sequence_id,
  seq.name        AS sequence_name,
  COUNT(es.id)                                          AS total_sends,
  COUNT(es.id) FILTER (WHERE es.open_count > 0)         AS opened_sends,
  COUNT(es.id) FILTER (WHERE es.click_count > 0)        AS clicked_sends,
  COUNT(es.id) FILTER (WHERE es.bounced = TRUE)         AS bounced_sends,
  ROUND(
    100.0 * COUNT(es.id) FILTER (WHERE es.open_count > 0)
    / NULLIF(COUNT(es.id), 0), 1
  ) AS open_rate_pct,
  ROUND(
    100.0 * COUNT(es.id) FILTER (WHERE es.click_count > 0)
    / NULLIF(COUNT(es.id), 0), 1
  ) AS click_rate_pct,
  ROUND(
    100.0 * COUNT(es.id) FILTER (WHERE es.bounced = TRUE)
    / NULLIF(COUNT(es.id), 0), 1
  ) AS bounce_rate_pct
FROM sequences seq
LEFT JOIN contact_enrollments ce ON ce.sequence_id = seq.id
LEFT JOIN email_sends es ON es.enrollment_id = ce.id
WHERE seq.client_id = $1          -- multi-tenant scoping
GROUP BY seq.id, seq.name
ORDER BY seq.created_at DESC;
```

This query joins through `contact_enrollments` to get `email_sends` scoped to a sequence.
No direct FK from `email_sends` to `sequences` exists — the join path is
`sequences → contact_enrollments → email_sends`. This is already the pattern used in the
existing enrollment count query in `sequences.js`.

For the report route: add a GET endpoint in `sequences.js` (e.g., `GET /api/sequences/report`
or `GET /api/sequences/:id/report` for per-sequence drill-down). Render as inline HTML table
using the established no-template-engine pattern.

---

## 6. Plan Dependency Analysis

### Inter-task dependencies

| Task | Depends On | Reason |
|------|-----------|--------|
| 03-01 open pixel | Migration 003 (pixel_token column, open_count column) | pixel route needs these columns |
| 03-02 link rewriting | Migration 003 (click_count), new `email_tracking_tokens` table | click route needs email_send_id FK |
| 03-03 bounce suppression | Migration 003 (bounced, bounce_error columns) | cron needs these columns |
| Reporting (03-01 SC#3) | Migration 003, open_count + click_count + bounced columns | all three tracking columns |

**Conclusion:** All three tasks depend on migration 003 (a single SQL file). Once migration 003
is applied, tasks 03-01, 03-02, and 03-03 are independent and can be implemented in any order
or in parallel. No task depends on another task's runtime behavior.

### Shared code touch point

All three tasks modify `sendSequenceEmail()` in `src/lib/gmail.js`:
- 03-01: add pixel_token generation, pass pixelUrl to buildHtml
- 03-02: add rewriteLinks() call after INSERT
- 03-03: add permanentBounce detection in catch block, update cron.js

If implementing in sequence (recommended for a single developer), the order
03-03 → 03-01 → 03-02 minimizes the number of times `sendSequenceEmail()` is opened and
re-edited. But any order works — there are no runtime conflicts.

---

## Architecture Patterns

### Recommended structure additions

```
src/
├── lib/
│   ├── gmail.js          # modified: pixel injection, link rewriting, bounce detection
│   └── email-tracking.js # new: rewriteLinks(), isPermanentBounce() helper functions
├── routes/
│   ├── pixel.js          # new: GET /pixel/:token
│   └── email-click.js    # new: GET /e/:token
migrations/
└── 003_email_deliverability.sql   # new
```

Extract `rewriteLinks()` and `isPermanentBounce()` into `src/lib/email-tracking.js` to keep
`gmail.js` from growing unwieldy. `buildHtml()` stays pure (no DB calls).

### Fire-and-forget DB update pattern

Both pixel and click routes should return the HTTP response immediately, then update the DB
asynchronously. This is safe here because the DB update is not load-bearing for the user
(they just need the GIF or redirect). Use `.catch(console.error)` to surface failures without
crashing the process.

### No new npm packages needed

- GIF buffer: hardcoded base64 constant (no `sharp` or `canvas`)
- UUID generation: `require('crypto').randomUUID()` — Node 14.17+ built-in (matches existing use of `gen_random_uuid()` in Postgres)
- URL regex: already exists in `buildHtml()`

---

## Common Pitfalls

### Pitfall 1: Inserting email_tracking_tokens before email_sends INSERT

`email_tracking_tokens.email_send_id` is a NOT NULL FK. The `email_sends` row must exist
before tokens are inserted. `rewriteLinks()` must be called **after** the INSERT, not before.
This means the raw (unrewritten) body is passed to `buildHtml()` initially, then replaced
with rewritten body. The send must use the rewritten body — sequence matters.

**Correct order in `sendSequenceEmail()`:**
1. INSERT email_sends row (get `emailSendId`)
2. Call `rewriteLinks(resolvedBody, emailSendId)` → `rewrittenBody`
3. Call `buildHtml(rewrittenBody, ...)` → `html`
4. Send via Gmail API

Wait — this creates a problem: the email is already inserted as 'sent' status before it's
actually sent. Current code inserts after `gmail.users.messages.send()` succeeds.

**Resolution:** Insert the email_sends row with `status = 'pending'` before sending, generate
the pixel token and rewrite links using that row's ID, send the email, then UPDATE status to
`'sent'`. Or: pre-generate the pixel_token UUID in application code (before any DB insert),
insert with `pixel_token` included, then rewrite links using the inserted row ID.

The cleanest approach: pre-generate `pixel_token` UUID before the send. Insert email_sends
with `pixel_token` after send succeeds (as today). For link rewriting, insert email_sends row
first as `status = 'sending'`, get the ID, rewrite links, send via Gmail, then update status.
This is a small but important refactor of the INSERT order.

### Pitfall 2: TRACKER_URL env var missing

Pixel URLs and email click URLs use `process.env.TRACKER_URL`. This env var already exists
(used in `buildUnsubscribeUrl()`). Confirm it is set correctly in Railway before testing.

### Pitfall 3: Gmail 200 response ≠ delivered

`gmail.users.messages.send()` returning HTTP 200 does not mean the email was delivered to
the recipient. Permanent bounces arrive as DSN emails to the sender's inbox, not as API
errors. The API-level bounce detection in 03-03 only catches cases where Gmail itself rejects
the request (malformed address, quota exceeded). True 550 bounces from recipient servers
require inbox polling (not in scope for this phase).

### Pitfall 4: pixel_token column in send flow timing

If pixel_token is generated in app code and inserted with the email_sends row, `buildHtml()`
needs the pixel URL before the INSERT. The flow is: generate UUID → build HTML with pixel →
send email → INSERT email_sends with the pre-generated UUID. This is safe because
`gen_random_uuid()` in Postgres is just a UUID generator — using `crypto.randomUUID()` in
Node.js produces the same format.

### Pitfall 5: suppression_list UNIQUE constraint on email only

The current UNIQUE constraint is `UNIQUE(email)` with no `client_id` scoping. This means
a bounce in one client's campaign suppresses the email globally. This is correct for
deliverability (you don't want to re-send to a bounced address from any client), but confirm
this is the intended behavior. The existing cron suppression check also has no client_id
filter: `WHERE LOWER(email) = LOWER($1)`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Transparent GIF | Image library | Hardcoded base64 constant | 43-byte GIF; no dependency needed |
| UUID generation | Custom token | `crypto.randomUUID()` built-in | Already available in Node 14.17+ |
| Token signing for pixel | HMAC signing | UUID column on email_sends | Simpler, faster lookup, no timing attacks on open pixel |
| Bounce classification | External bounce API | String regex on err.message | Within scope; full DSN parsing is overengineering for Gmail API |

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| `opened_at` only (single timestamp) | `opened_at` + `open_count` | Rate calculations become possible |
| No body link tracking | `email_tracking_tokens` table per send | Separates email analytics from Shopify attribution |
| Manual bounce management | Auto-suppress on permanent send failure | Operator intervention eliminated |

---

## Open Questions

1. **True 550 DSN bounce detection**
   - What we know: `gmail.users.messages.send` HTTP 200 for recipient-server 550 bounces; DSN arrives as inbox email
   - What's unclear: Is 03-03 scoped to API-level rejections only, or does it require inbox DSN polling?
   - Recommendation: Implement API-level detection now (simpler). Add a note in the plan to revisit inbox DSN polling in a future phase if bounce rates are causing deliverability issues.

2. **Pixel token — pre-generate UUID vs UUID column default**
   - What we know: Both work; pre-generating in app code enables pixel URL in HTML before INSERT
   - What's unclear: Whether the refactored INSERT-before-send order (for link rewriting) is acceptable
   - Recommendation: Use a `pixel_token UUID DEFAULT gen_random_uuid()` column, pre-generate in JS using `crypto.randomUUID()`, pass it explicitly in the INSERT. Avoids re-reading the row.

3. **Reporting page location**
   - What we know: Sequences page (`/sequences`) already exists with enrollment counts
   - What's unclear: Does the report live at `/sequences/:id/report` (per-sequence detail) or on the main sequences page as a summary table?
   - Recommendation: Add a summary stats row to the existing sequences list table (zero new routes needed for SC#3 minimum).

---

## Sources

### Primary (HIGH confidence — live codebase inspection)
- `/home/tim/Applications/Suresecured/CommissionTracker/src/lib/gmail.js` — `sendSequenceEmail()`, `buildHtml()`, existing catch block
- `/home/tim/Applications/Suresecured/CommissionTracker/src/db.js` — `email_sends` schema, `suppression_list`, `contact_enrollments.paused_reason`
- `/home/tim/Applications/Suresecured/CommissionTracker/src/routes/cron.js` — bounce/suppression handling pattern
- `/home/tim/Applications/Suresecured/CommissionTracker/src/routes/redirect.js` — existing `/r/:token` pattern
- `/home/tim/Applications/Suresecured/CommissionTracker/migrations/001_add_tenancy.sql` — client_id column presence confirmed

### Secondary (MEDIUM confidence)
- [Gmail API error handling guide](https://developers.google.com/workspace/gmail/api/guides/handle-errors) — HTTP code meanings confirmed; 200 ≠ delivered confirmed
- [EmailEngine bounce docs](https://learn.emailengine.app/docs/advanced/bounces) — SMTP 5.x.x permanent vs 4.x.x transient classification
- [Email tracking pixel implementation](https://dev.to/mrrishimeena/building-a-simple-email-open-tracking-system-for-your-gmail-5d22) — GIF base64 constant, fire-and-forget pattern

### Tertiary (LOW confidence — not verified against official Gmail API docs)
- Gmail API 200 response for later-bounced mail: described in multiple community sources but not explicitly documented in official API reference
- String patterns in `err.message` for permanent failures: no official spec; patterns derived from community reports

---

## Metadata

**Confidence breakdown:**
- Schema changes: HIGH — verified against live db.js
- Pixel implementation: HIGH — well-established pattern, no new packages
- Link rewriting design: HIGH — based on existing URL regex in buildHtml()
- Bounce detection (API errors): MEDIUM — error structure confirmed; string patterns LOW confidence
- Bounce detection (DSN emails): LOW — not researched in depth; flagged as open question
- Reporting SQL: HIGH — schema fully known, query pattern matches existing enrollment count queries

**Research date:** 2026-06-30
**Valid until:** 2026-07-30 (stable Node/Postgres; Gmail API error behavior may shift)
