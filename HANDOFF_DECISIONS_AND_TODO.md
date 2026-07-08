# Handoff — Decisions & TODO List

**Last updated:** 2026-07-08  
**Canonical decisions:** see **`DECISIONS.md`**

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
| D6 | No git commits unless requested | Deploy via `railway up` |
| D7–D8 | Warmup ramp + 3% bounce breaker | **Partial / pending** |
| D9–D12 | Security secrets, API key, encryption | **Mostly done** — see Railway status |

---

## Progress log

| Area | Status | Notes |
|------|--------|-------|
| 06-01 Security | **Done** | API auth, webhooks, SQL, cron POST, helmet |
| 06-02 Attribution | **Mostly done** | Migration 007 fixed; lib + webhook + clicks |
| 06-03 Voice | **Partial** | Retell/CallRail attribution; order phone match |
| 06-04 Deliverability | **Partial** | `email_verified` gate; preverified CSV import; limits pending |
| 06-05 Verification | **Pending** | Tests + `06-VERIFICATION.md` |
| Railway setup | **Done** | CLI linked; core vars; admin seeded |
| Offline verify workflow | **Done** | Code + docs (`docs/DELIVERABILITY_RUNBOOK.md`) |
| Shopify | **Pending** | Webhook secret placeholder |

---

## Your TODO list

### P0 — Before first pilot send

- [ ] **Shopify webhook** — Settings → Notifications → Order creation → `https://suresecured-email-production.up.railway.app/webhooks/shopify/order` → set real `SHOPIFY_WEBHOOK_SECRET` in Railway
- [ ] **Shopify snippet** — dev pastes `shopify-handoff/snippet.js` into `theme.liquid` before `</body>`
- [ ] **Offline verify full list** — MillionVerifier / Bouncer → import **valid-only** CSV (see runbook)
- [ ] **DNS** — SPF + DKIM + DMARC for `sales@suresecured.com` (Ionos)
- [ ] **Pilot enroll** — 500–1,000 leads only; watch bounce rate 48–72h
- [ ] **Client record** — `integration_settings.shopify_domain` = your `.myshopify.com` store

### P0 — Done ✅

- [x] Railway variables (JWT, CRON, CLIENT_API_KEY, TRACKER_URL, APP_BASE_URL, etc.)
- [x] Admin login created (`kmaautosinc@gmail.com`)
- [x] Sending path: Ionos SMTP (`SES_SMTP_*`) configured
- [x] CSV import marks leads preverified / send-ready
- [x] Railway CLI linked locally

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

### P2 — Engineering (not blocking pilot if security deployed)

- [ ] Daily send limits + warmup ramp (D7)
- [ ] 3% bounce circuit breaker (D8)
- [ ] `06-VERIFICATION.md` + expanded tests
- [ ] Git commit + push when Tim approves diff

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
| Core security deployed | ✅ |
| Offline-cleaned CSV imported | ☐ Tim |
| Shopify webhook + snippet | 🔄 Tim |
| DNS authenticated | ☐ Tim |
| Pilot 500–1k sent + bounce OK | ☐ Tim |
| Full list scale-up | ☐ After pilot |

**Do not scale past pilot until bounce rate is acceptable.**
