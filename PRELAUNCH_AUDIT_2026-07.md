# SalesPilot AI — Prelaunch Audit (Code-Verified)

**Date:** 2026-07-07
**Scope:** Security · Sales/commission attribution · Voice-agent commission · Domain deliverability
**Method:** Direct source review of `src/**`, `migrations/**`, `shopify-handoff/snippet.js`
**Relationship to `PRELAUNCH_AUDIT.md`:** That doc is the original plan (PL-### IDs). This one verifies what is *actually in the code today*, flags what was marked done but isn't, and adds new findings. Where an item maps to an old ID I note it.

---

## Verdict

A lot of the original P0 list is genuinely fixed in code: `/api` and `/admin` now require auth, webhooks reject unsigned requests, analytics uses parameterized queries, cron accepts POST, setup seeds the `users` table. Good.

But **three launch-blocking problems remain**, and two of them go straight to your core goal — paying the right salesperson:

1. **Commission theft via a URL parameter** (attribution integrity) — highest priority.
2. **Gmail OAuth tokens are stored in plaintext** and the OAuth callback has no CSRF/state protection (account-takeover of a rep's sending identity).
3. **No send caps, no warmup, no `List-Unsubscribe` header** — this is how you get `suresecured.com` blacklisted on the first big send.

Do not enroll the pilot list until C1, S1, and D1–D3 below are closed.

---

## Severity key

| Tag | Meaning |
|-----|---------|
| **P0** | Launch blocker — fix before any production send |
| **P1** | Fix before scaling past the 500–1k pilot |
| **P2** | Hardening — soon after launch |

---

# Part 1 — Commission & Attribution Integrity

This is the part that decides whether the right rep gets paid. It has the most serious open issue in the codebase.

### C1 · `ss_salesperson` is attacker-controllable and trusted blindly — commission theft (P0)

**Files:** [src/lib/attribution.js:41-46](src/lib/attribution.js#L41-L46), [shopify-handoff/snippet.js:86-100](shopify-handoff/snippet.js#L86-L100), [src/routes/webhook.js:63-64](src/routes/webhook.js#L63-L64)

**The chain:**
1. The Shopify snippet reads `ss_sp` from the **URL query string** and trusts it verbatim (`var urlSp = params.get('ss_sp')`), writing it into the cart as `ss_salesperson`.
2. That value rides along to the order as a `note_attribute`.
3. `resolveSalespersonForOrder()` checks `cartSalespersonId` **first, before the token and before first-touch**, and credits it with nothing more than `parseInt()` — no check that the salesperson exists, is active, or belongs to the order's client.

**Impact:** Any salesperson (or anyone) can mint links like `https://suresecured.com/?ss_token=x&ss_sp=<their_own_id>` and harvest commission on orders they never sourced. It also lets one tenant's ID be credited on another tenant's order (cross-tenant). This directly defeats "assign the correct commission to the salesperson that initiated the outreach."

**Fix:**
- In `resolveSalespersonForOrder`, treat `cartSalespersonId` as a *hint only*. Validate it: the salesperson must exist, be `active`, and belong to `clientId`. If a `token` is present, the token's salesperson wins over the cart value (token is server-issued; `ss_sp` is not).
- Reorder resolution to match your stated **first-touch** policy (see C2).
- Scope the lookup: `SELECT id FROM salespeople WHERE id=$1 AND client_id=$2 AND active=true`. If it doesn't validate → fall through, don't credit.

```js
// attribution.js — replace step 1
if (cartSalespersonId) {
  const id = parseInt(cartSalespersonId, 10);
  if (!Number.isNaN(id)) {
    const { rows } = await db.query(
      `SELECT id FROM salespeople WHERE id=$1 AND active=true
         AND ($2::int IS NULL OR client_id=$2)`,
      [id, clientId || null]
    );
    if (rows[0]) return { salespersonId: id, path: `cart:validated:${id}`, status: 'credited' };
    // not valid → fall through to token / first-touch, do NOT trust the raw value
  }
}
```

**Acceptance:** Order carrying a forged `ss_salesperson` for an inactive/foreign rep does **not** pay that rep; it falls through to token → first-touch → `pending_review`.

---

### C2 · Resolution order contradicts the "first-touch wins" policy (P0)

**Files:** [src/lib/attribution.js:33-133](src/lib/attribution.js#L33-L133), [DECISIONS.md](DECISIONS.md) D2

Policy (D2) says the salesperson who *initiated* outreach owns the lead. But the resolver credits **cart value → token → lead.attributed → phone → call_logs**. Cart and token are effectively *last-click* signals. So: Rep A enrolls and emails the lead (first-touch recorded on the lead), Rep B's link gets clicked later, and Rep B is credited. That is last-click, not first-touch.

**Decide explicitly and encode it.** Two coherent options — pick one and document it in the admin UI:

- **True first-touch (matches D2):** `leads.attributed_salesperson_id` wins whenever it's set and `attribution_locked` isn't overriding it. Token/cart only fill the gap when the lead has no attribution yet.
- **Token-authoritative:** a server-issued `ss_token` always wins (it's tamper-proof), everything else is first-touch. This is a defensible hybrid, but say so out loud.

Right now the behavior is neither and will produce disputes. **Acceptance:** write `src/lib/attribution.test.js` with the exact scenario in Appendix A Test 1/3 and assert the winner.

---

### C3 · Lead lookup by email/phone isn't strictly tenant-scoped (P1)

**Files:** [src/lib/attribution.js:64-95](src/lib/attribution.js#L64-L95), [src/routes/cron.js:82](src/routes/cron.js#L82), [src/routes/telnyx.js:38-41](src/routes/telnyx.js#L38-L41)

The order resolver matches leads with `(client_id = $2 OR client_id IS NULL)`. Because legacy/imported leads have `client_id IS NULL`, a NULL-client lead can be credited under any store's webhook. The Telnyx inbound handler and the cron inbound-capture lookup (`SELECT id FROM leads WHERE email=$1`) ignore `client_id` entirely. For a single-tenant SureSecured launch this is low blast-radius, but you're building multi-tenant SaaS (per your vision notes), so fix before onboarding a second client.

**Fix:** backfill `client_id` on all existing leads to the SureSecured client, then drop the `OR client_id IS NULL` escape hatch and add `client_id` to the Telnyx/inbound lookups.

---

### C4 · Voice → order commission path is present and reasonable (✅ with one caveat)

**Files:** [src/lib/attribution.js:104-130](src/lib/attribution.js#L104-L130), [src/routes/retell.js:151-159](src/routes/retell.js#L151-L159)

Good news: the gap the old audit flagged (PL-021) is closed. `resolveSalespersonForOrder` now has a `call_logs` phone-match path (90-day window), Retell sets `voice_call` first-touch, and unmatched orders go to `pending_review` instead of a random rep. That satisfies your "voice sale pays the voice rep" requirement.

**Caveat:** phone matching is `regexp_replace(phone,'[^0-9]','')` equality. A lead stored as `8185551234` won't match an order phone of `+18185551234` (leading `1`). Normalize to last-10-digits on both sides, or store E.164 consistently. Otherwise legitimate voice commissions silently fall to `pending_review`.

---

### C5 · Form submissions still aren't auto-ingested (P1)

**Files:** [src/routes/api.js:9-23](src/routes/api.js#L9-L23) (endpoint exists), snippet injects hidden fields only

`POST /api/form-submission` exists and is correctly protected by `X-Client-Api-Key`. But nothing calls it — the snippet only injects `contact[ss_token]` into the native Shopify form, which lands in a notification email, not the DB. So quote/dealer form conversions won't attribute automatically. Wire a **Shopify Flow**: "Customer submits form" → HTTP POST to `/api/form-submission` with the API key and the `ss_token`. Until then, treat form attribution as manual.

---

# Part 2 — Security

### S1 · Gmail OAuth refresh tokens stored in plaintext (P0)

**Files:** [src/routes/gmail-oauth.js:23-37](src/routes/gmail-oauth.js#L23-L37), [src/lib/gmail.js:84-88](src/lib/gmail.js#L84-L88)

You have a working AES-256-GCM helper (`src/lib/crypto.js`) and you *do* use it for SMTP/IMAP passwords in `settings.js`. But the Gmail OAuth callback writes `oauth_refresh_token` / `oauth_access_token` **straight to the DB in cleartext**, and `getAuthedClient` reads them raw. A refresh token is a long-lived key to send mail *as that rep* and read their inbox. A DB dump or read-only leak = full mailbox compromise for every connected rep. DECISIONS D12 claims "OAuth token encryption when ENCRYPTION_KEY set" — that is **not implemented**.

**Fix:** encrypt on write in the callback, decrypt on read in `getAuthedClient`, exactly like the SMTP password path. Migrate existing rows (encrypt-in-place one-off script).

```js
// gmail-oauth.js
const { encrypt } = require('../lib/crypto');
// store: encrypt(tokens.refresh_token), encrypt(tokens.access_token)

// gmail.js getAuthedClient
const { decrypt } = require('./crypto');
refresh_token: decrypt(account.oauth_refresh_token),
```

**Acceptance:** DB dump shows ciphertext in `email_accounts.oauth_refresh_token`; send + reply-check still work end-to-end.

---

### S2 · OAuth callback has no CSRF/state binding — rep identity hijack (P0)

**Files:** [src/lib/gmail.js:50-62](src/lib/gmail.js#L50-L62), [src/routes/gmail-oauth.js:14-45](src/routes/gmail-oauth.js#L14-L45)

`state` is just the plaintext `salespersonId`, and `/gmail/callback` has **no `requireAuth`**. Consequences:
- The callback trusts `state` blindly, so a completed Google auth can be bound to *any* `salespersonId` an attacker names — including overwriting an existing rep's connected account.
- Classic OAuth login-CSRF: an attacker can trick an admin into connecting the attacker's Google account as a rep's sender, so outbound "SureSecured" mail flows through an inbox the attacker controls.

**Fix (PL-004, still open):** make `state` a signed, expiring token: `HMAC(JWT_SECRET, salespersonId|nonce|exp)`. On callback verify the signature + expiry, and confirm the initiating admin's session belongs to the same client as the salesperson. Reject tampered/expired state.

---

### S3 · Retell/Telnyx signature verification is effectively bypassed to a shared secret (P1)

**Files:** [src/lib/webhookVerify.js:23-72](src/lib/webhookVerify.js#L23-L72), [src/index.js:44-99](src/index.js#L44-L99)

Both routers are mounted **after** `express.json()`, and neither captures the raw body. `verifyRetellWebhook` then falls back to `JSON.stringify(req.body)`, and `verifyTelnyxWebhook` does the same for its Ed25519 check. Re-serialized JSON almost never byte-matches the sender's original payload (key order, spacing, unicode escaping), so the real cryptographic verification **cannot pass** — you're relying entirely on the `Bearer <SHARED_SECRET>` fallback. That's acceptable *only* if `RETELL_WEBHOOK_SECRET` / `TELNYX_WEBHOOK_SECRET` are actually set and Retell/Telnyx are configured to send them; if they're not, the handler rejects everything (fails closed — good) or, worse, if someone later removes the secret it silently opens.

**Fix:** capture the raw body for these two routes (like the Shopify route does with `express.raw`) and verify the true signature. Keep the shared-secret path only as an explicit, documented fallback. Confirm the secrets are set in Railway *before* launch.

---

### S4 · Database TLS disables certificate validation (P1)

**File:** [src/db.js:10](src/db.js#L10)

`ssl: { rejectUnauthorized: false }` in production. Traffic is encrypted but unauthenticated — a MITM on the Railway↔Postgres path can present any cert. Set `rejectUnauthorized: true` with the provider CA. On Railway internal networking the exposure is limited, but it's a one-line hardening and auditors will flag it.

### S5 · Smaller items (P2)

- **In-memory rate limiter resets the whole map on an interval** ([rateLimit.js:8](src/middleware/rateLimit.js#L8)) rather than sliding per key, and won't survive multiple instances. Fine for single-instance pilot; revisit if you scale horizontally.
- **Admin JWT TTL is 7 days**, `sameSite: 'lax'`. Consider 24h for admin/operator cookies (PL-008).
- **No CSRF tokens on admin/portal POST forms.** `sameSite=lax` blunts most of it, but state-changing GET-free forms should carry a double-submit token.
- **`helmet` CSP is disabled** ([index.js:37](src/index.js#L37)) because dashboards use inline styles. Acceptable, but you lose XSS defense-in-depth on pages that echo lead/reply data. Worth a scoped CSP later.
- **Error strings echoed to users** in the Gmail callback (`Error: ${err.message}`) can leak internals — render a generic message.

---

# Part 3 — Deliverability (protecting suresecured.com)

This is where the launch is most likely to hurt you, because the damage (domain blacklisting) is slow to detect and slow to reverse. The engagement gate after step 3 is a nice touch, but the fundamentals below are missing.

### D1 · No per-inbox daily send caps or warmup ramp (P0)

**Files:** [src/routes/cron.js:322-596](src/routes/cron.js#L322-L596) — confirmed: no `daily_send_limit` / `sends_today` / `warmup` anywhere in code or migrations.

The cron pulls up to 100 due enrollments **every 15 minutes** and sends with no per-sender ceiling. On a fresh-ish `sales@suresecured.com`, blasting a reactivation list at that rate is a textbook spam-trap/blacklist trigger. DECISIONS D7 acknowledges the ramp is "planned / migration pending" — it isn't in the tree.

**Fix:** add to `email_accounts`: `daily_send_limit`, `sends_today`, `sends_today_date`, `warmup_week`. Before each send, skip if `sends_today >= effectiveLimit(warmup_week)`. Ramp 5→10→20→40→80/day/inbox over ~5 weeks. Cap the SMTP/`SES_FROM` sender the same way, since most sends currently go through the one Ionos identity, not per-rep Gmail.

**Acceptance:** a single sender cannot exceed its daily cap no matter how often cron runs; admin can see sends-today/limit.

### D2 · No `List-Unsubscribe` / one-click unsubscribe header (P0)

**Files:** [src/lib/gmail.js:255-356](src/lib/gmail.js#L255-L356) — confirmed: only a footer HTML link, no headers.

Since Feb 2024, Gmail/Yahoo **require** bulk senders to include `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. You already generate a signed unsubscribe token — just also emit the headers. Missing this materially raises spam placement for exactly the kind of send you're about to do.

```
List-Unsubscribe: <https://TRACKER/unsubscribe?t=TOKEN>, <mailto:unsubscribe@suresecured.com>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Add them in `buildRawMessage`/nodemailer (`headers: { 'List-Unsubscribe': ..., 'List-Unsubscribe-Post': ... }`) and make `GET/POST /unsubscribe` honor the one-click POST (currently GET-only).

### D3 · Bounce handling only catches API-level errors, no circuit breaker (P1)

**Files:** [src/lib/email-tracking.js:40-74](src/lib/email-tracking.js#L40-L74), [src/routes/cron.js:575-594](src/routes/cron.js#L575-L594)

`isPermanentBounce` is honest in its own comments: it only sees errors Gmail/SMTP throws *synchronously*. Real-world 550s arrive later as DSN emails in the sender's inbox and are never processed, so your bounce rate is invisible to the system. There's no rolling bounce-rate check that pauses a sender at ~3% (DECISIONS D8, not implemented).

**Fix:** (a) parse DSN/bounce messages from the inbox during the existing reply-check pass and suppress those addresses; (b) track 24h bounce rate per sender and auto-pause enrollments above 3%, alert ops. Your offline pre-clean (MillionVerifier) mitigates this at launch, but you still need the breaker before scaling.

### D4 · DNS / authentication — ops checklist (P0, not code)

Verify before first send, for the `sales@suresecured.com` sending identity (and any per-rep subdomain):
- [ ] SPF includes Ionos (and Google, if any rep sends via Gmail).
- [ ] DKIM enabled + verified on the sending domain.
- [ ] DMARC `p=quarantine` now → `p=reject` after ~30 days clean.
- [ ] Google Postmaster Tools + Microsoft SNDS registered so you can *see* reputation.
- [ ] `mail-tester.com` ≥ 8/10 on a test send.
- [ ] Suppress existing Shopify customers (upload CSV to Admin → Suppression) before enrolling.

### D5 · Deliverability positives worth keeping (✅)

The step-3 engagement gate (pause zero-open/zero-click leads), the `email_verified`/`preverified` send gate, suppression + unsubscribe pause, and the reply-detected auto-pause are all implemented and correct. These are good. The gaps above are what's missing around them.

---

# Part 4 — Compliance (P1)

- **Consent columns exist** (`consent_email`, `consent_sms`) and Retell auto-enroll correctly requires `consent_email` ([retell.js:173-195](src/routes/retell.js#L173-L195)). Good.
- **SMS is gated by 10DLC** — code comments flag it; don't send outbound SMS until Telnyx Brand+Campaign approved.
- **Aged-list reactivation:** you've decided prior-inquiry is your legal basis (B2). Make sure every email has a physical postal address (it does, in the footer) and a working unsubscribe (it does) — that's the CAN-SPAM floor. Consider a one-time re-permission email for the oldest cohort.

---

# Prioritized action plan

### Before the pilot send (P0 — do all of these)
| # | Item | Effort |
|---|------|--------|
| C1 | Validate/deprioritize `ss_salesperson`; stop trusting the URL param | S |
| C2 | Pick and encode first-touch vs token-authoritative; add attribution test | S |
| S1 | Encrypt Gmail OAuth tokens at rest (reuse `crypto.js`) | S |
| S2 | Signed, expiring OAuth `state` + auth on callback | M |
| D1 | Per-sender daily caps + warmup ramp | M |
| D2 | `List-Unsubscribe` + one-click POST | S |
| D4 | SPF/DKIM/DMARC verified; Postmaster/SNDS; suppress customers | S (ops) |

### Before scaling past pilot (P1)
| # | Item |
|---|------|
| C3 | Tenant-scope all lead lookups; backfill `client_id` |
| C4 | Normalize phone to last-10 (or E.164) on both sides |
| C5 | Shopify Flow → `/api/form-submission` |
| S3 | Raw-body signature verify for Retell/Telnyx; confirm secrets set |
| S4 | DB TLS `rejectUnauthorized: true` |
| D3 | DSN bounce parsing + 3% circuit breaker |

### Hardening (P2)
S5 bundle (JWT TTL, CSRF tokens, scoped CSP, generic error pages) · distributed rate limiter if you scale to multiple instances.

---

# Test before you flip the switch (staging)

1. **Commission theft blocked:** place a test order with a forged `note_attributes.ss_salesperson` pointing at an inactive/foreign rep → confirm they are NOT paid.
2. **First-touch:** Rep A enrolls+emails lead; Rep B link clicked; order placed → confirm the rep your policy says wins is credited, and `commission_events.resolution_path` shows why.
3. **Voice:** call → `call_logs` row + `attributed_salesperson_id` set → later order by same phone (with `+1` prefix variance) → correct rep credited.
4. **Security smoke:** `curl /api/stats` → 401; forged Retell POST with no secret → 401; tampered OAuth `state` → rejected.
5. **Deliverability:** send test to mail-tester.com → ≥8/10, and confirm `List-Unsubscribe` header present in Gmail "Show original" with SPF/DKIM/DMARC = pass.

---
*Verified against the working tree on 2026-07-07. Pair this with the original `PRELAUNCH_AUDIT.md` (plan) and `DECISIONS.md` (business choices).*
