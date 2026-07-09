# Handoff — Decisions & TODO List

**Last updated:** 2026-07-08 (prelaunch audit remediation)  
**Canonical decisions:** see **`DECISIONS.md`**  
**Git:** audit remediation committed + pushed as `359d2b2` on `master` → `github.com/themios/suresecured-email` (prior Phase 6 baseline: `fc136bb`).

---

## Confirmed business decisions (Tim)

| # | Decision | Status |
|---|----------|--------|
| B1 | **In-house sending** via this app (not Mailchimp / Instantly primary) | ✅ Confirmed |
| B2 | **OK to re-contact** prior in-house leads | ✅ Confirmed |
| B3 | **Offline list clean** (MillionVerifier / Bouncer) — no ZeroBounce budget | ✅ Confirmed |
| B4 | **Pilot:** 500–1k leads first; scale if bounce &lt; ~2% | ✅ Confirmed |
| B5 | Post-launch occasional bounces OK (app suppresses) | ✅ Confirmed |
| B6 | **Shopify webhook** — Tim working on it | 🔄 In progress |

---

## Technical decisions (Phase 6)

| # | Decision | Notes |
|---|----------|-------|
| D1 | In-house sender + caps | Aligns with B1 |
| D2 | First-touch attribution wins | `attributed_salesperson_id` |
| D3 | Voice auto-enroll OFF without `consent_email` | |
| D4 | Cron requires `email_verified = true` | **CSV import sets `preverified`** — ZeroBounce optional |
| D5 | Ambiguous orders → `pending_review` | |
| D6 | Git commit when Tim requests | **Done 2026-07-09** — `fc136bb` pushed to `origin/master` |
| D7 | Warmup ramp in daily send limits | **Done 2026-07-08** — migration 008 + `sendLimits.js`; `SEND_WARMUP=off` for established mailbox |
| D8 | 3% bounce circuit breaker | **Pending** — P1 post-launch (offline clean mitigates) |
| D9–D12 | Security secrets, API key, encryption | **Done** — OAuth token encryption implemented 2026-07-08; set `ENCRYPTION_KEY` in Railway |

---

## Progress log

| Area | Status | Notes |
|------|--------|-------|
| 06-01 Security | **Done** | API auth, webhooks, SQL, cron POST, helmet; + audit remediation (OAuth token encryption, signed OAuth state, webhook raw-body verify, DB TLS toggle) |
| 06-02 Attribution | **Done** | Migration 007; commission-theft guard + token/first-touch precedence + phone normalize; `attribution.test.js` |
| 06-03 Voice | **Done** | Retell/CallRail attribution; order phone match (last-10) |
| 06-04 Deliverability | **Done** | `email_verified` gate; preverified CSV import; per-identity daily caps + warmup (migration 008); List-Unsubscribe one-click |
| 06-05 Verification | **Partial** | Unit tests green (`commissions`, `attribution`); staging E2E (Appendix A) pending |
| Railway setup | **Done** | CLI linked; core vars; admin seeded |
| Offline verify workflow | **Done** | Code + docs (`docs/DELIVERABILITY_RUNBOOK.md`) |
| Git commit + push | **Done** | `fc136bb` — 43 files, Phase 6 + docs |
| Build verification | **Done** | `npm ci`, all `src/**/*.js` syntax check, `commissions.test.js` pass |
| Shopify | **Pending** | Webhook secret placeholder |
| Lead CSVs (local) | **Present** | `Cleaned_Leads.csv` etc. gitignored — not in repo |

---

## Your TODO list

### P0 — Before first pilot send

- [ ] **Railway env — send caps:** `SEND_WARMUP=off` + `DAILY_SEND_LIMIT=200` (or chosen cap). Default warmup starts at **5/day**, which throttles a 500–1k pilot. Use `off` for the established `sales@suresecured.com` mailbox; leave `on` only for a cold new inbox.
- [ ] **Railway env — encryption:** `ENCRYPTION_KEY` (64-char hex). Without it, Gmail OAuth tokens + SMTP passwords stay plaintext (no crash). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- [ ] **Railway env — webhook secrets:** confirm `RETELL_WEBHOOK_SECRET` / `TELNYX_WEBHOOK_SECRET` set if voice/SMS webhooks are live (they now fail closed without them).
- [ ] **Shopify webhook** — Settings → Notifications → Order creation → `https://saleswyze.up.railway.app/webhooks/shopify/order` → set real `SHOPIFY_WEBHOOK_SECRET` in Railway
- [ ] **Shopify snippet** — dev pastes `shopify-handoff/snippet.js` into `theme.liquid` before `</body>`
- [ ] **Offline verify full list** — MillionVerifier / Bouncer → import **valid-only** CSV (see runbook)
- [ ] **DNS** — SPF + DKIM + DMARC for `sales@suresecured.com` (Ionos)
- [ ] **Test send** — one email → Gmail "Show original" → confirm `List-Unsubscribe` header + SPF/DKIM/DMARC pass
- [ ] **Pilot enroll** — 500–1,000 leads only; watch bounce rate 48–72h
- [ ] **Client record** — `integration_settings.shopify_domain` = your `.myshopify.com` store

### P0 — Code (audit remediation, done 2026-07-08)

- [x] C1 commission-theft guard · C2 token/first-touch precedence · C4 phone normalize
- [x] S1 OAuth token encryption · S2 signed OAuth state · S3 webhook raw-body verify · S4 DB TLS toggle
- [x] D1 per-identity send caps + warmup ramp · D2 List-Unsubscribe one-click
- [x] Unit tests: `attribution.test.js` + `commissions.test.js` green; full `src` syntax check

### P0 — Done ✅

- [x] Railway variables (JWT, CRON, CLIENT_API_KEY, TRACKER_URL, APP_BASE_URL, etc.)
- [x] Admin login created (`kmaautosinc@gmail.com`)
- [x] Sending path: Ionos SMTP (`SES_SMTP_*`) configured
- [x] CSV import marks leads preverified / send-ready
- [x] Railway CLI linked locally
- [x] Phase 6 code + docs committed and pushed (`fc136bb`)
- [x] Build verified (`npm ci`, syntax check, `commissions.test.js`)

### P1 — Before scaling past pilot

- [ ] Bounce rate &lt; ~2% on pilot → enroll next batch
- [ ] Suppress existing Shopify customers (Admin → Suppression CSV)
- [ ] `mail-tester.com` test send ≥ 8/10
- [ ] Appendix A E2E (`PRELAUNCH_AUDIT.md`) — click → order attribution
- [ ] Telnyx 10DLC if using SMS

### P1 — Optional

- [ ] Per-rep Gmail connect (`/sequences` → Connect Gmail)
- [ ] `ZEROBOUNCE_API_KEY` — only if you want in-app verify later
- [ ] Webhook secrets: CallRail, Retell, Telnyx (when those channels go live)

### P2 — Engineering (not blocking pilot)

- [x] Daily send limits + warmup ramp (D7) — done 2026-07-08 (migration 008 + `sendLimits.js`)
- [ ] 3% bounce circuit breaker (D8) + DSN parsing
- [ ] `06-VERIFICATION.md` + staging E2E (unit tests done)
- [ ] Backfill `client_id` on legacy `NULL` leads (C3); Shopify Flow → `/api/form-submission` (C5)
- [ ] S2 extra hardening: add `requireAuth` on `/gmail/callback` (optional — signed state already closes the hijack vector)
- [ ] S5 hardening: shorten admin JWT TTL, CSRF tokens on admin/portal forms, generic error pages
- [x] Git commit + push (`fc136bb`, 2026-07-09; audit remediation `359d2b2`, 2026-07-08)

---

## Production env vars

**Required for pilot:**

| Variable | Status |
|----------|--------|
| `DATABASE_URL` | ✅ Auto |
| `JWT_SECRET`, `CRON_SECRET` | ✅ Set |
| `CLIENT_API_KEY` | ✅ Set |
| `TRACKER_URL`, `APP_BASE_URL` | ✅ Set |
| `SITE_URL`, `COOKIE_DOMAIN` | ✅ Set |
| `SES_SMTP_*`, `SES_FROM_*` | ✅ Set |
| `SHOPIFY_WEBHOOK_SECRET` | ⚠️ Placeholder — **fix** |
| `ZEROBOUNCE_API_KEY` | ⏭️ **Not needed** (offline verify) |

**Optional:** `GMAIL_*`, `UNSUBSCRIBE_HMAC_SECRET`, `ENCRYPTION_KEY`, voice webhook secrets.

Full copy-paste reference: `YOUR_RAILWAY_VARS.txt` (local, gitignored).

---

## Where to find things

| Artifact | Path |
|----------|------|
| **Decision log** | `DECISIONS.md` |
| Setup steps | `SETUP_WALKTHROUGH_FOR_TIM.md` |
| List clean + pilot send | `docs/DELIVERABILITY_RUNBOOK.md` |
| Code changes | `ENHANCEMENTS.md` |
| Security audit | `PRELAUNCH_AUDIT.md` |
| Phase 6 plans | `.planning/phases/06-prelaunch-hardening/` |
| GSD state | `.planning/STATE.md` |

---

## Launch gates (pilot)

| Gate | Status |
|------|--------|
| Core security deployed | ✅ Shipped `fc136bb` |
| Code on GitHub | ✅ `master` pushed |
| Offline-cleaned CSV imported | ☐ Tim |
| Shopify webhook + snippet | 🔄 Tim |
| DNS authenticated | ☐ Tim |
| Pilot 500–1k sent + bounce OK | ☐ Tim |
| Full list scale-up | ☐ After pilot |

**Do not scale past pilot until bounce rate is acceptable.**
