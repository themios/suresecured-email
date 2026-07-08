# SalesPilot AI — Prelaunch Security, Attribution & Deliverability Audit

**Product:** SureSecured Commission Tracker / SalesPilot AI  
**Audit date:** 2026-07-07  
**Audience:** Engineering + ops before first production send to dormant lead list  
**Goal:** Secure platform, end-to-end salesperson attribution, voice-agent commission path, domain-safe mass outreach

> **Operator decisions (2026-07-08):** See **`DECISIONS.md`** — in-house sending, offline list verify (no ZeroBounce), pilot 500–1k leads, OK to re-contact prior leads.

---

## How to use this document

Each item has:

| Field | Meaning |
|-------|---------|
| **ID** | Track in issues/PRs (e.g. `PL-001`) |
| **Priority** | P0 = launch blocker · P1 = before 40k send · P2 = post-launch hardening |
| **Effort** | S (<4h) · M (1–2d) · L (3–5d) |
| **Owner** | Suggested role |
| **Acceptance** | Definition of done — check box when verified |

**Prelaunch gate:** Do not enroll production leads until all **P0** items are closed and the **Attribution E2E Test** (Appendix A) passes.

---

## Executive summary

### What works today

| Capability | Status |
|------------|--------|
| Email sequence engine (Gmail OAuth per rep) | Built |
| Click/open tracking (`/pixel`, `/e`, `/r`) | Built |
| Shopify order webhook → commission (tiered rules) | Built (with gaps) |
| Reply detection → pause sequence + AI classify | Built |
| ZeroBounce batch verify UI | Built (optional — not used for launch; offline CSV + `preverified` import) |
| Unsubscribe + suppression list | Built |
| Retell voice inbound + call logging | Built (no order commission link) |
| Multi-tenant schema (`clients`, `client_id`) | Partially wired |

### Launch blockers (must fix)

1. **Public `/api` routes** — unauthenticated data read/write  
2. **Unverified webhooks** — CallRail, Retell, Telnyx accept forged payloads  
3. **SQL injection** — analytics + landing-page API  
4. **Cron HTTP mismatch** — Railway POST vs route GET may prevent all sends  
5. **Gmail OAuth callback** — no CSRF; tokens bindable to wrong rep  
6. **No send gates** — unverified emails can be mailed; no daily caps/warmup  

### Strategic recommendation (deliverability)

**Updated 2026-07-08 per `DECISIONS.md` (B1, B3, B4):**

- **Sending:** In-house via SalesPilot (Ionos SMTP / optional Gmail per rep) — not Instantly.ai for launch.
- **List hygiene:** One-time offline bulk verification (MillionVerifier, Bouncer, etc.) → import valid-only CSV → `preverified` flag.
- **Rollout:** Pilot 500–1,000 leads; scale if bounce rate &lt; ~2%.
- **ZeroBounce:** Optional in-app; not required if list cleaned offline.

Original PRD note still applies: do not cold-blast an entire stale list on day one without cleaning or pilot metrics.

```
Offline verify → Import valid CSV → Pilot 500–1k → Monitor bounces → Scale
```

Legacy alternative (not chosen for SureSecured launch):

```
Week 1–4   Instantly.ai warmup on per-rep subdomains
Week 4+    Gradual migration to custom send engine with enforced caps
```

If you launch the **built-in Gmail cron sender** without warmup, expect spam-folder placement or domain blacklisting within days—not weeks.

---

## Part 1 — Security (P0)

### PL-001 · Lock down `/api` router

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | S |
| **Owner** | Backend |
| **Files** | `src/routes/api.js`, `src/index.js` |

**Problem:** All routes under `/api` are public—no auth.

Exposed today:
- `POST /api/generate-links`, `/api/leads`, `/api/salespeople`
- `GET /api/stats` (full revenue/commission dump)
- `PUT /api/landing-page/:id`
- `POST /api/suppression`

**Implementation:**

1. Add `requireAuth` + `requireRole('operator','owner','admin')` on admin/mutation routes.
2. For Shopify/form integrations, create **scoped API keys** per client:
   - Header: `Authorization: Bearer <client_api_key>`
   - Store hashed keys in `clients.integration_settings`
3. Remove or deprecate duplicate unauthenticated endpoints; use authenticated `/sequences/api/*` instead.

**Acceptance:**
- [ ] Unauthenticated request to `/api/stats` returns 401
- [ ] Valid JWT or client API key succeeds on intended routes only
- [ ] Pen test: cannot create salespeople or read commissions without credentials

---

### PL-002 · Webhook signature verification

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | M |
| **Owner** | Backend |
| **Files** | `src/routes/webhook.js` (reference), `phonecall.js`, `retell.js`, `telnyx.js` |

**Problem:** Shopify webhook verifies HMAC; CallRail, Retell, Telnyx do not.

**Implementation:**

| Webhook | Verification method |
|---------|---------------------|
| Shopify | ✅ Already implemented |
| CallRail | Verify signing secret / POST signature per CallRail docs |
| Retell | Verify `x-retell-signature` with `RETELL_API_KEY` |
| Telnyx | Verify `telnyx-signature-ed25519` with public key |

Add env vars to `.env.example`: `CALLRAIL_WEBHOOK_SECRET`, `RETELL_WEBHOOK_SECRET`, `TELNYX_PUBLIC_KEY`.

**Acceptance:**
- [ ] Request without valid signature returns 401
- [ ] Valid signed test payload from vendor sandbox succeeds
- [ ] Forged `salesperson_id` in body cannot create commission-affecting records

---

### PL-003 · Fix SQL injection

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | S |
| **Owner** | Backend |
| **Files** | `src/routes/analytics.js`, `src/routes/api.js` |

**Problem:** User input interpolated into SQL (`days`, `spFilter`, landing-page query params).

**Implementation:** Replace string interpolation with parameterized queries:

```javascript
// analytics.js — use $1, $2 for days and salesperson_id
pool.query(`... WHERE ordered_at >= NOW() - ($1 || ' days')::INTERVAL AND ($2::int IS NULL OR salesperson_id = $2)`, [days, spFilter])
```

**Acceptance:**
- [ ] `?days=30; DROP TABLE orders;--` returns 400 or safe result, no SQL execution
- [ ] Static analysis / grep shows no `${userInput}` in pool.query strings

---

### PL-004 · Harden Gmail OAuth

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | M |
| **Owner** | Backend |
| **Files** | `src/routes/gmail-oauth.js`, `src/lib/gmail.js` |

**Problem:** OAuth `state` is plain salesperson ID; callback has no session check.

**Implementation:**

1. On `/gmail/connect/:salespersonId` (authenticated admin):
   - Generate `state = base64url({ salespersonId, nonce, exp, sig })`
   - `sig = HMAC(JWT_SECRET, salespersonId + nonce + exp)`
2. On callback: verify sig, exp, and that initiating admin belongs to same client as salesperson.
3. Reject if salesperson already connected unless admin confirms reconnect.

**Acceptance:**
- [ ] Callback with tampered `state` fails
- [ ] Callback without admin session fails (or requires one-time connect token)
- [ ] Cannot bind OAuth to arbitrary salesperson ID via URL alone

---

### PL-005 · Encrypt OAuth tokens at rest

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | M |
| **Owner** | Backend / DevOps |
| **Files** | `src/lib/gmail.js`, `src/db.js` |

**Problem:** `email_accounts.oauth_refresh_token` stored plaintext.

**Implementation:** AES-256-GCM encrypt before INSERT; decrypt on read. Key from `TOKEN_ENCRYPTION_KEY` env (32 bytes, never in repo).

**Acceptance:**
- [ ] DB dump shows ciphertext only for token columns
- [ ] Send flow still works after encrypt/decrypt round-trip

---

### PL-006 · Admin auth consistency

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | S |
| **Owner** | Backend |
| **Files** | `src/setup.js`, `src/routes/admin.js`, `src/routes/auth.js` |

**Problems:**
- Login uses `users` table; `setup.js` seeds `admin_users`
- Change-password queries `admin_users` with `req.user.id` from `users` — broken
- Most `/admin/*` routes lack `requireRole`

**Implementation:**

1. Update `setup.js` to insert into `users` with role `owner`.
2. Fix change-password to update `users`.
3. Add `requireRole('operator','owner','admin')` on all admin POST/PUT/DELETE routes.
4. Remove or gate `SEED_OPERATOR=1` behind `NODE_ENV=development` only.

**Acceptance:**
- [ ] Fresh deploy: `node src/setup.js` → login works
- [ ] Password change works for logged-in user
- [ ] User with role `salesperson` gets 403 on `/admin/salespeople`

---

### PL-007 · Fix cron HTTP method mismatch

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | S |
| **Owner** | DevOps |
| **Files** | `src/routes/cron.js`, `railway.toml` |

**Problem:** `router.get('/send-sequences')` but Railway cron uses `POST`.

**Implementation:** Support both methods on all cron routes:

```javascript
router.all('/send-sequences', cronAuth, handler);
```

**Acceptance:**
- [ ] `curl -X POST .../cron/send-sequences -H "Authorization: Bearer $CRON_SECRET"` returns `{ ok: true, ... }`
- [ ] Railway cron logs show sends processing (not 404/405)

---

### PL-008 · Platform hardening (P1 but quick wins)

| | |
|---|---|
| **Priority** | P1 |
| **Effort** | M |
| **Owner** | Backend |

| Item | Action |
|------|--------|
| Rate limiting | `express-rate-limit` on `/login`, `/portal/login`, `/api`, webhooks |
| Security headers | `helmet` middleware |
| CSRF | CSRF tokens on admin/portal forms OR SameSite=Strict + double-submit cookie |
| JWT | Separate secrets: `JWT_SECRET` vs `UNSUBSCRIBE_HMAC_SECRET`; shorten cookie TTL to 24h for admin |
| DB SSL | Set `rejectUnauthorized: true` with Railway CA cert |
| Open redirect | Allowlist redirect destinations in `/e/:token` and `/r/:token` to client domains |
| Logging | Never log full webhook bodies or OAuth tokens |

**Acceptance:**
- [ ] Security headers present on `/health` response
- [ ] 10 failed logins/min triggers 429

---

## Part 2 — Sales attribution & commission integrity

### Design principle (recommended policy)

> **First-touch wins:** The salesperson who first initiated outreach (email enrollment, tracked click, or voice call) owns the lead until admin override.

Document this in admin UI and enforce in code—not last-click cookie overwrite.

---

### PL-010 · Canonical attribution model

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | M |
| **Owner** | Backend + Product |
| **Files** | New migration, `src/lib/attribution.js`, `webhook.js`, `redirect.js`, `retell.js`, `cron.js` |

**Problem:** Salesperson resolution is inconsistent across channels; no immutable “owner” record.

**Implementation:**

Add `lead_attribution` table (or columns on `leads`):

```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS
  attributed_salesperson_id INTEGER REFERENCES salespeople(id),
  attributed_at TIMESTAMPTZ,
  attribution_source VARCHAR(50), -- 'email_enrollment' | 'tracking_click' | 'voice_call' | 'manual'
  attribution_locked BOOLEAN DEFAULT false;
```

**Rules:**

| Event | Action |
|-------|--------|
| First enrollment in sequence | Set `attributed_salesperson_id` if NULL |
| First tracked click (`/r` or `/e`) | Set if NULL; log in `clicks` |
| Inbound voice call (Retell) | Set if NULL; use extension routing |
| Shopify order | Commission to: token → cart attr → `attributed_salesperson_id` → lead.salesperson_id |
| Admin reassignment | Sets `attribution_locked = true` + audit log |

**Never:** `UPDATE leads SET salesperson_id = X WHERE salesperson_id IS NULL` on every send (current cron behavior overwrites weakly).

**Acceptance:**
- [ ] Lead enrolled by Rep A, clicked by Rep B link → order credits Rep A (first-touch)
- [ ] Order with valid `ss_token` always credits token's salesperson (overrides only if policy says so)
- [ ] Attribution source visible in admin lead detail

---

### PL-011 · Shopify attribution chain hardening

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | M |
| **Owner** | Backend + Shopify dev |
| **Files** | `shopify-handoff/snippet.js`, `src/routes/webhook.js`, `src/routes/redirect.js` |

**Problems:**

1. Cookie name mismatch: redirect sets `ss_attribution`; snippet reads `ss_attr` (mitigated by URL params + localStorage).
2. Email click tracking uses `/e/:token` but Shopify snippet only handles `ss_token` from `/r/:token` redirects—not pixel/email click tokens on site.
3. Webhook lead lookup: `WHERE email = $1 LIMIT 1` ignores `client_id` (cross-tenant risk).
4. `integration_settings.shopify_domain` must match `x-shopify-shop-domain` or commission skipped.

**Implementation:**

1. **Unify cookie name** to `ss_attr` in `redirect.js` OR update snippet to read both.
2. **On email link click (`/e/:token`):** also set attribution cookie + redirect with `?ss_token=&ss_sp=` query params (mirror `/r` behavior).
3. **Webhook:** scope lead lookup: `WHERE email = $1 AND client_id = $2`.
4. **Verify Shopify setup checklist:**
   - [ ] Snippet in `theme.liquid` before `</body>`
   - [ ] Webhook registered: `orders/create` → `/webhooks/shopify/order`
   - [ ] `SHOPIFY_WEBHOOK_SECRET` set
   - [ ] Client record has `"shopify_domain": "suresecured.myshopify.com"` in integration_settings
   - [ ] Test order shows `ss_token` in order note attributes

**Acceptance:**
- [ ] Appendix A Test 1 passes (click → cart → order → commission)
- [ ] Order without cookie but with cart attributes still attributes correctly

---

### PL-012 · Form submission → commission path

| | |
|---|---|
| **Priority** | P1 |
| **Effort** | M |
| **Owner** | Backend |
| **Files** | `src/routes/api.js`, new Shopify Flow or form webhook |

**Problem:** Quote/dealer forms get hidden fields via snippet, but submissions are **not** auto-ingested into `form_submissions` unless something POSTs to `/api/form-submission`.

**Implementation options:**

| Option | Pros |
|--------|------|
| A. Shopify Flow → HTTP POST to authenticated endpoint | Native, reliable |
| B. Parse Shopify contact notification emails | Fragile |
| C. Client-side form POST to SalesPilot on submit | Requires JS on form |

Recommended: **Option A** — Shopify Flow on contact form submit → `POST /api/form-submission` with API key.

Also: when form submission recorded with token, update `attributed_salesperson_id`.

**Acceptance:**
- [ ] Quote form submit creates `form_submissions` row with correct salesperson
- [ ] Subsequent order from same email credits same rep (via lead attribution)

---

### PL-013 · Commission audit trail

| | |
|---|---|
| **Priority** | P1 |
| **Effort** | M |
| **Owner** | Backend |

**Implementation:**

Add `commission_events` log:

```sql
CREATE TABLE commission_events (
  id SERIAL PRIMARY KEY,
  order_id INTEGER,
  salesperson_id INTEGER,
  client_id INTEGER,
  resolution_path TEXT, -- 'token:uuid' | 'cart:ss_salesperson' | 'lead:attributed' | 'fallback:email'
  sale_amount NUMERIC,
  commission_earned NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Populate from `webhook.js` on every commission insert.

**Acceptance:**
- [ ] Disputed commission can be traced to exact resolution path in admin UI
- [ ] Portal shows “Attributed via email click on DATE” for rep transparency

---

### PL-014 · Multi-tenant query scoping

| | |
|---|---|
| **Priority** | P1 |
| **Effort** | L |
| **Owner** | Backend |

**Problem:** Dashboard, admin, sequences list global data; lead import omits `client_id`.

**Implementation:**

1. Middleware: `req.clientId = req.user.client_id` (null for agency owner = explicit client picker).
2. Helper: `scopedQuery(baseSql, clientId)` appends `AND client_id = $n`.
3. Apply to: dashboard, sequences CRUD, lead import, enrollments, stats APIs.

**Acceptance:**
- [ ] Client A admin cannot see Client B leads in any UI or API
- [ ] CSV import tags all rows with importer's `client_id`

---

## Part 3 — Voice agent & voice commission

### Current voice flow

```
Inbound call → Telnyx number → Retell AI agent
  → POST /retell-hooks/call-ended
  → Upsert lead by phone
  → Assign salesperson via voice_extension or first active rep
  → Auto-enroll in first active sequence
  → call_logs row created
```

**Gap:** Voice creates leads and sequences but **does not connect to Shopify commission**. Order webhook never reads `call_logs` or phone-based attribution.

---

### PL-020 · Voice → lead attribution

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | M |
| **Owner** | Backend |
| **Files** | `src/routes/retell.js`, `src/lib/attribution.js` |

**Implementation:**

1. On `call-ended`, after resolving `salespersonId`:
   ```sql
   UPDATE leads SET
     attributed_salesperson_id = COALESCE(attributed_salesperson_id, $1),
     attributed_at = COALESCE(attributed_at, NOW()),
     attribution_source = COALESCE(attribution_source, 'voice_call'),
     salesperson_id = COALESCE(salesperson_id, $1)
   WHERE id = $2 AND (attributed_salesperson_id IS NULL OR NOT attribution_locked)
   ```
2. Store Retell `call_id` on lead for debugging: `last_voice_call_id`.

3. **Retell webhook verification** (PL-002) — mandatory before production.

4. **Provision checklist per client:**
   - [ ] `clients.telnyx_phone_number` set
   - [ ] Retell agent provisioned (`retell_agent_id`)
   - [ ] Each rep has unique `voice_extension`
   - [ ] Retell webhook URL → `{APP_BASE_URL}/retell-hooks/call-ended`

**Acceptance:**
- [ ] Caller with no prior email history → assigned to extension-matched rep
- [ ] `attributed_salesperson_id` set on lead after call

---

### PL-021 · Voice → order commission resolution

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | M |
| **Owner** | Backend |
| **Files** | `src/routes/webhook.js` |

**Implementation:** Extend Shopify order resolution order:

```
1. ss_token / ss_salesperson in order note_attributes (email click path)
2. tracking_tokens lookup by token
3. leads.attributed_salesperson_id (email OR voice first-touch)
4. Match order phone/email to lead → attributed_salesperson_id
5. call_logs: most recent inbound call within 90 days for matching phone
6. NULL → flag order for manual commission review (do NOT guess wrong rep)
```

Add `orders.commission_status`: `credited` | `pending_review` | `no_attribution`.

**Acceptance:**
- [ ] Appendix A Test 3 passes (voice call → later Shopify order by phone/email → correct rep)
- [ ] Order with no attribution → `pending_review`, no auto-commission to random rep

---

### PL-022 · Voice agent quality & handoff

| | |
|---|---|
| **Priority** | P1 |
| **Effort** | M |
| **Owner** | Product + Voice |

**Enhancements:**

1. Retell LLM prompt: collect name, email, product interest, callback number; write to `call_analysis.custom_analysis_data`.
2. On call end, if `hot_lead` signals in transcript → SMS/email alert to assigned rep within 60s.
3. Display call transcript + recording link in salesperson portal.
4. Do **not** auto-enroll every inbound caller in email sequence without consent flag—TCPA/CAN-SPAM risk for SMS/email follow-up.

**Acceptance:**
- [ ] Rep sees inbound call in portal within 5 minutes
- [ ] Auto-enroll requires `leads.consent_email = true` OR manual enroll

---

### PL-023 · CallRail integration alignment

| | |
|---|---|
| **Priority** | P1 |
| **Effort** | S |
| **Owner** | Backend |
| **Files** | `src/routes/phonecall.js` |

**Problem:** Duplicate call tracking (`phone_calls` vs `call_logs`); CallRail webhook unverified; doesn't set lead attribution.

**Implementation:** Merge into single call model OR sync CallRail → `call_logs` with same attribution logic as Retell. Add webhook signature verification.

---

## Part 4 — Domain reputation & safe mass outreach

### PL-030 · Prelaunch deliverability strategy (decision required)

| | |
|---|---|
| **Priority** | P0 (business) |
| **Effort** | Planning |
| **Owner** | Leadership + Marketing ops |

**Choose one path before first send:**

| Path | When to use | SalesPilot role |
|------|-------------|-----------------|
| **A. Instantly.ai first (PRD Phase 1)** | Recommended for 40k dormant list | Attribution + commission only; Instantly sends |
| **B. Built-in Gmail sender** | Only after 3–4 weeks warmup per inbox | Full stack; strict caps required |
| **C. Hybrid** | Instantly warmup + SalesPilot for verified engaged leads | Best of both |

**Non-negotiables (any path):**

- Never send marketing from `suresecured.com` root domain
- Use per-rep subdomains: `john@mail.suresecured.com` (ideal; SureSecured launch uses `sales@suresecured.com` via Ionos — ensure SPF/DKIM)
- **Offline-verify entire list** before import (MillionVerifier/Bouncer) OR optional ZeroBounce — see `DECISIONS.md` B3
- Suppress existing Shopify customers (upload CSV to admin)

---

### PL-031 · Enforce verification before send

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | S |
| **Owner** | Backend |
| **Files** | `src/routes/cron.js` |

**Problem:** Cron sends to leads where `email_verified IS NOT TRUE`.

**Implementation:** In send-sequences loop, before send:

```javascript
if (!row.email_verified) { skipped++; continue; } // or queue for verification batch
```

Add admin dashboard: “X leads unverified — cannot send until verified.”

Optional: auto-run verification cron (batch 50/hour) until backlog clear.

**Acceptance:**
- [ ] Unverified lead in active enrollment is skipped (not sent)
- [ ] Verified invalid/spamtrap addresses on suppression list

---

### PL-032 · Per-inbox daily send limits & warmup ramp

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | M |
| **Owner** | Backend |
| **Files** | `src/routes/cron.js`, migration, `email_accounts` table |

**Problem:** No daily cap—cron can send 100/enrollment batch × N reps = spam trigger.

**Implementation:**

Add to `email_accounts`:

```sql
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS
  daily_send_limit INTEGER DEFAULT 20,
  sends_today INTEGER DEFAULT 0,
  sends_today_date DATE,
  warmup_start_date DATE,
  warmup_week INTEGER DEFAULT 1;
```

Warmup schedule (PRD-aligned):

| Week | Max sends/inbox/day |
|------|---------------------|
| 1 | 5 |
| 2 | 10 |
| 3 | 20 |
| 4 | 40 |
| 5+ | 80 (or workspace limit) |

Before each send:

```javascript
if (account.sends_today >= effectiveLimit) { skip; log; }
```

Reset `sends_today` at midnight per rep timezone (default US/Pacific).

**Acceptance:**
- [ ] Single inbox cannot exceed daily limit even if cron runs every 15 min
- [ ] Admin UI shows sends today / limit per connected Gmail

---

### PL-033 · Bounce & complaint circuit breaker

| | |
|---|---|
| **Priority** | P1 |
| **Effort** | M |
| **Owner** | Backend |

**Implementation:**

1. Track rolling 24h bounce rate per `email_accounts` row.
2. If bounce rate > 3%: pause all enrollments for that inbox automatically.
3. Process Gmail bounce DSN messages (IMAP or Gmail API watch)—current code only catches API-level errors, not recipient 550 bounces after accept.
4. If unsubscribe rate > 0.5% in 24h: alert ops.

**Acceptance:**
- [ ] Simulated bounce spike pauses sending for affected inbox
- [ ] Admin notification email/Slack on circuit break

---

### PL-034 · DNS & authentication checklist (ops)

| | |
|---|---|
| **Priority** | P0 |
| **Effort** | S (per subdomain) |
| **Owner** | DevOps |

For **each** sending subdomain (`mail.suresecured.com`, etc.):

- [ ] SPF record includes Google Workspace / SES / Instantly as appropriate
- [ ] DKIM enabled and verified
- [ ] DMARC: `p=quarantine` initially → `p=reject` after 30 days stable sending
- [ ] Custom tracking domain (optional): CNAME `track.suresecured.com` → Railway app
- [ ] Postmaster tools: Google Postmaster + Microsoft SNDS registered
- [ ] One-click unsubscribe header (Gmail/Yahoo 2024 bulk sender rules):

```
List-Unsubscribe: <https://tracker/unsubscribe?t=...>, <mailto:unsubscribe@mail.suresecured.com>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

**Acceptance:**
- [ ] mail-tester.com score ≥ 8/10 on test send
- [ ] Gmail “Show original” shows SPF pass, DKIM pass, DMARC pass

---

### PL-035 · List hygiene & enrollment controls

| | |
|---|---|
| **Priority** | P1 |
| **Effort** | S |
| **Owner** | Ops + Backend |

**Before first campaign:**

1. Export Shopify customers → Admin suppression upload
2. **Offline bulk verify** full list (~$40–65 for 10k via MillionVerifier/Bouncer) → import valid-only CSV (`preverified`). ZeroBounce optional.
3. **Do not** use “Auto-Enroll all B2C” until cleaned CSV imported
4. Staged rollout: **500–1,000 pilot** → 2,000 → 10,000 with 48h deliverability review between stages
5. Segment: LA County (install) vs national (DIY) separate sequences

**Acceptance:**
- [ ] Zero unverified sends in production
- [ ] Staged rollout documented with go/no-go metrics

---

## Part 5 — Compliance (CAN-SPAM / TCPA)

### PL-040 · Consent & opt-out

| | |
|---|---|
| **Priority** | P1 |
| **Effort** | M |
| **Owner** | Legal + Backend |

**Implementation:**

Add to `leads`:

```sql
consent_email BOOLEAN DEFAULT false,
consent_email_at TIMESTAMPTZ,
consent_sms BOOLEAN DEFAULT false,
consent_sms_at TIMESTAMPTZ,
consent_source VARCHAR(100)
```

- Historical list: document “prior inquiry” basis; consider one-time re-permission email before full sequence
- SMS: require explicit `consent_sms` before Telnyx outbound (10DLC registration mandatory)
- Unsubscribe: already works; add List-Unsubscribe header (PL-034)

**Acceptance:**
- [ ] SMS steps skipped unless `consent_sms = true`
- [ ] Privacy policy linked in email footer

---

## Part 6 — Testing & observability

### PL-050 · Automated test suite

| | |
|---|---|
| **Priority** | P1 |
| **Effort** | L |
| **Owner** | Backend |

**Minimum tests before launch:**

| Test | File |
|------|------|
| Commission tiers | ✅ `src/lib/commissions.test.js` |
| Attribution resolution | New: `src/lib/attribution.test.js` |
| Unsubscribe token | New: `src/lib/unsubscribe.test.js` |
| Shopify HMAC | New: `src/routes/webhook.test.js` |
| E2E attribution | Appendix A (manual + later Playwright) |

**Acceptance:**
- [ ] `npm test` runs all unit tests in CI
- [ ] CI fails on PR if tests fail

---

### PL-051 · Monitoring & alerts

| | |
|---|---|
| **Priority** | P1 |
| **Effort** | M |
| **Owner** | DevOps |

**Implement:**

- Structured JSON logging (request ID, client_id, enrollment_id)
- Alert on: cron errors > 0, webhook 401 spike, bounce rate > 3%, zero sends in 24h when enrollments active
- Sentry or Railway log drains

**Acceptance:**
- [ ] Failed Shopify webhook visible in alert channel within 5 min
- [ ] Daily digest of sends/bounces/replies to ops email

---

## Part 7 — Product enhancements (post-P0)

| ID | Enhancement | Value |
|----|-------------|-------|
| PL-060 | Hot-lead alert when AI classifies `hot_lead` | Faster close rate |
| PL-061 | Use `engagement_score` to pick landing page matrix `intent_level` | Better CTAs |
| PL-062 | Commission payout export (CSV) + `status=paid` workflow | Finance ops |
| PL-063 | A/B subject lines per sequence step | Deliverability + conversion |
| PL-064 | Rep-facing “my leads” pipeline in portal | Adoption |
| PL-065 | Instantly.ai API sync (Phase 2 PRD) | Safe scale without custom send risk |

---

## Implementation roadmap

### Sprint 0 — Launch blockers (1 week)

| Day | Items |
|-----|-------|
| 1 | PL-007 cron fix, PL-006 auth/setup, PL-001 API lockdown |
| 2 | PL-002 webhooks, PL-003 SQL injection |
| 3 | PL-004 OAuth, PL-010 attribution model (schema) |
| 4 | PL-011 Shopify chain, PL-020 voice attribution |
| 5 | PL-021 voice commission, Appendix A testing |

### Sprint 1 — Safe sending (1 week)

| Items |
|-------|
| PL-031 verification gate, PL-032 daily limits, PL-034 DNS |
| PL-035 staged rollout plan, PL-014 tenant scoping (start) |
| PL-030 decision: Instantly vs built-in sender |

### Sprint 2 — Hardening (1 week)

| Items |
|-------|
| PL-005 token encryption, PL-008 platform hardening |
| PL-012 form path, PL-013 audit trail |
| PL-033 circuit breaker, PL-050 tests, PL-051 monitoring |

---

## Appendix A — Prelaunch E2E test script

Run in **staging** with test Shopify order. Check each box.

### Test 1 — Email click → purchase → commission

1. [ ] Create lead assigned to Salesperson A; verify via offline clean + CSV import (`preverified`) or optional ZeroBounce
2. [ ] Enroll in 1-step test sequence; connect A's Gmail
3. [ ] Receive email; click CTA link (`/e/` or `/r/` tracked URL)
4. [ ] Confirm browser cookie/localStorage + cart attributes (`ss_token`, `ss_salesperson`)
5. [ ] Complete test Shopify checkout with same browser session
6. [ ] Webhook fires: order row created with `salesperson_id = A`
7. [ ] Commission row created with correct tier calculation
8. [ ] Portal for A shows order + commission

### Test 2 — Reply pauses sequence

1. [ ] Reply to sequence email from lead mailbox
2. [ ] Cron detects reply; enrollment status = `paused`, reason = `replied`
3. [ ] AI classification stored on lead
4. [ ] No further steps sent to that lead

### Test 3 — Voice call → purchase → commission

1. [ ] Call client Telnyx number; speak extension for Salesperson B
2. [ ] `call_logs` row created; lead phone upserted
3. [ ] `attributed_salesperson_id = B`
4. [ ] Place Shopify order using same phone/email (no email click)
5. [ ] Commission credits Salesperson B via phone/email attribution path

### Test 4 — Unsubscribe

1. [ ] Click unsubscribe link in email
2. [ ] Lead on suppression list; enrollments paused
3. [ ] Cron does not send to that address

### Test 5 — Security smoke

1. [ ] `curl /api/stats` without auth → 401
2. [ ] Forged CallRail POST without signature → 401
3. [ ] SQL injection in analytics → no error / safe rejection

---

## Appendix B — Environment variables checklist

Ensure production `.env` includes:

```bash
# Core
DATABASE_URL=
JWT_SECRET=                    # 32+ random bytes
UNSUBSCRIBE_HMAC_SECRET=       # separate from JWT (recommended)
TOKEN_ENCRYPTION_KEY=          # 32 bytes for OAuth encryption
TRACKER_URL=
SITE_URL=
COOKIE_DOMAIN=.suresecured.com
NODE_ENV=production

# Shopify
SHOPIFY_WEBHOOK_SECRET=
# Client integration_settings: {"shopify_domain":"store.myshopify.com"}

# Gmail OAuth
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REDIRECT_URI=

# Cron
CRON_SECRET=

# Verification
ZEROBOUNCE_API_KEY=

# Voice
RETELL_API_KEY=
RETELL_WEBHOOK_SECRET=
TELNYX_PUBLIC_KEY=
TELNYX_PHONE_NUMBER=

# Calls
CALLRAIL_WEBHOOK_SECRET=

# AI (optional)
OPENROUTER_API_KEY=

# App
APP_BASE_URL=
```

**Remove from production:** `SEED_OPERATOR=1`, default passwords in `setup.js`

---

## Appendix C — Go / no-go checklist

| # | Gate | Status |
|---|------|--------|
| 1 | All P0 security items closed | ☐ |
| 2 | Appendix A Tests 1–5 pass in staging | ☐ |
| 3 | DNS SPF/DKIM/DMARC verified per sending subdomain | ☐ |
| 4 | Full list offline-verified + imported + customers suppressed | ☐ |
| 5 | Daily send limits active OR pilot volume manually capped | ☐ |
| 6 | Warmup plan documented (min 3 weeks if self-send) | ☐ |
| 7 | Voice webhooks verified + extension routing tested | ☐ |
| 8 | Commission dispute audit trail in place | ☐ |
| 9 | Legal review of consent for aged lead reactivation | ☐ |
| 10 | Rollback plan: pause all enrollments + disable cron | ☐ |

**Sign-off:**

| Role | Name | Date |
|------|------|------|
| Engineering | | |
| Ops / Deliverability | | |
| Sales leadership | | |
| Legal (if applicable) | | |

---

*Generated from codebase audit 2026-07-07. Update this document as items close; link PRs to PL-### IDs.*
