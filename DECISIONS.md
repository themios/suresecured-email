# SureSecured SalesPilot — Decision Log

**Canonical record of product and launch decisions.** Update this file when choices change.  
**Last updated:** 2026-07-09

---

## Business & launch decisions (Tim — confirmed)

| ID | Decision | Date | Notes |
|----|----------|------|-------|
| **B1** | **In-house sending** — use this app (not Mailchimp / Instantly as primary) | 2026-07-07 | Sends via global SMTP/SES (`SES_SMTP_*` on Ionos) or per-rep Gmail OAuth when connected |
| **B2** | **OK to re-contact prior leads** | 2026-07-07 | In-house list of old quote requests / CRM leads; legal basis = prior inquiry |
| **B3** | **No ZeroBounce budget** — one-time offline list clean instead | 2026-07-08 | MillionVerifier, Bouncer, or similar (~$40–65 for ~10k); import **valid-only** CSV |
| **B4** | **Pilot rollout** — 500–1,000 leads first, then scale if bounce &lt; ~2% | 2026-07-08 | Not 10k day one |
| **B5** | **Post-launch bounces** — handle one-by-one via app suppression | 2026-07-08 | Acceptable after offline pre-clean |
| **B6** | **Shopify webhook** — in progress (Tim) | 2026-07-08 | `SHOPIFY_WEBHOOK_SECRET` still `placeholder_for_now` until Shopify admin done |

---

## Technical decisions (architecture / Phase 6)

| ID | Decision | Date | Notes |
|----|----------|------|-------|
| **D1** | In-house sender with caps (see B1) | 2026-07-07 | Instantly.ai deferred; not integrated in code |
| **D2** | First-touch attribution wins | 2026-07-07 | `attributed_salesperson_id` on lead |
| **D3** | Voice auto-enroll OFF unless `consent_email` | 2026-07-07 | Retell inbound still attributes |
| **D4** | **Send gate:** `email_verified = true` required | 2026-07-07 | **Updated 2026-07-08:** satisfied by **CSV import** (`verification_status = preverified`) OR in-app ZeroBounce batch — **not** ZeroBounce-only |
| **D5** | Ambiguous orders → `commission_status = pending_review` | 2026-07-07 | No random rep assignment |
| **D6** | Git commit when Tim requests | 2026-07-07 | **Done 2026-07-09:** `fc136bb` pushed to `origin/master` |
| **D7** | Warmup ramp in daily limits (**implemented 2026-07-08**) | 2026-07-07 | `migrations/008_send_limits.sql` + `src/lib/sendLimits.js`; per-identity 5→10→20→40→`DAILY_SEND_LIMIT`. Set `SEND_WARMUP=off` for an established mailbox |
| **D8** | Bounce circuit breaker at 3% (**still pending**) | 2026-07-07 | Not implemented — P1 post-launch; offline list clean mitigates for pilot |
| **D9** | `UNSUBSCRIBE_HMAC_SECRET` separate from JWT | 2026-07-08 | Set in Railway |
| **D10** | `X-Client-Api-Key` for server-to-server forms | 2026-07-07 | `CLIENT_API_KEY` set in Railway |
| **D11** | E2E tests on staging before full send | 2026-07-07 | Appendix A in `PRELAUNCH_AUDIT.md`; unit tests done (`attribution.test.js`), staging run pending |
| **D12** | OAuth token encryption when `ENCRYPTION_KEY` set (**implemented 2026-07-08**) | 2026-07-07 | `maybeEncrypt`/`safeDecrypt` in `crypto.js`, wired in `gmail-oauth.js` + `gmail.js`; set 64-char hex `ENCRYPTION_KEY` in Railway or tokens stay plaintext |

---

## Infrastructure status (2026-07-08)

| Item | Status |
|------|--------|
| Railway project | **Email-Campaign** / service **suresecured-email** / **production** |
| Public URL | `https://suresecured-email-production.up.railway.app` |
| Railway CLI | Installed; repo linked on Tim's machine |
| Admin user | `kmaautosinc@gmail.com` (`node src/setup.js` run) |
| Health | `/health` → OK |
| Vars added (session) | `CLIENT_API_KEY`, `APP_BASE_URL`, `UNSUBSCRIBE_HMAC_SECRET` |
| Vars still needed | `SHOPIFY_WEBHOOK_SECRET` (real value) |
| Vars **not** required | `ZEROBOUNCE_API_KEY` (offline verify workflow) |
| Sending path | Ionos SMTP via `SES_SMTP_*` + `SES_FROM_EMAIL=sales@suresecured.com` |
| Code on GitHub | ✅ `fc136bb` on `master` |
| Railway auto-deploy | Confirm in Railway dashboard (repo: `themios/suresecured-email`) |

## Email verification workflow (effective 2026-07-08)

```
Export CRM → Offline verifier (MillionVerifier / Bouncer) → Download "Valid" CSV
    → Import in Sequences → email_verified=true, status=preverified
    → Enroll pilot batch (500–1k) → Monitor bounce rate → Scale
```

- In-app **Verify Emails (50)** button = optional ZeroBounce; requires `ZEROBOUNCE_API_KEY`.
- Cron **skips** leads where `email_verified IS NOT TRUE`.

---

## Document index

| Doc | Purpose |
|-----|---------|
| `DECISIONS.md` | **This file** — decisions |
| `HANDOFF_DECISIONS_AND_TODO.md` | TODO checklist + progress |
| `SETUP_WALKTHROUGH_FOR_TIM.md` | Step-by-step Railway / Shopify / import |
| `ENHANCEMENTS.md` | Code changes log |
| `docs/DELIVERABILITY_RUNBOOK.md` | List cleaning + send rollout |
| `PRELAUNCH_AUDIT.md` | Security/attribution audit (PL-###) |
| `YOUR_RAILWAY_VARS.txt` | Copy-paste secrets (gitignored) |

---

## Superseded / reversed

| Old assumption | Superseded by |
|----------------|---------------|
| ZeroBounce required before every send | B3 + D4 update — offline preverify + CSV import |
| Verify full 40k via ZeroBounce (~$400) | B3 — one-time offline ~$40–65 for full list |
| Instantly.ai recommended for first blast | B1 — in-house sending confirmed |
| `ADMIN_EMAIL=tim@suresecured.com` in setup doc | Railway uses `kmaautosinc@gmail.com` |
| Deploy only via `railway up` (no git) | `fc136bb` committed + pushed 2026-07-09 |
