---
phase: 06-prelaunch-hardening
verified: 2026-07-16
status: conditional-pass
score: 4/4 code plans verified; 2 items pending human/ops (staging E2E, go/no-go sign-off)
---

# Phase 06: Prelaunch Hardening Verification Report

**Phase Goal:** Harden the system for production launch — security, correct
commission attribution, deliverability controls — with evidence (tests +
verification) before any production enrollment.
**Verified:** 2026-07-16
**Status:** conditional-pass — all code/test must-haves met; staging E2E (Appendix A)
and go/no-go sign-off remain pending and require the live environment + operator.

> Note: this report was written on 2026-07-16 to close the Phase 6 documentation
> gap. 06-05 task 1 (tests) was completed as part of this closure: the missing
> `unsubscribe.test.js` and `webhook.test.js`, the `npm test` script, and a CI
> workflow were added, and a length-guard hardening was applied to the Shopify
> HMAC verify.

---

## Goal Achievement — Observable Truths

| # | Truth (from 06-01…06-04) | Status | Evidence |
|---|--------------------------|--------|----------|
| 1 | OAuth refresh/access tokens encrypted at rest | VERIFIED | `src/lib/crypto.js` encrypt/decrypt; tokens stored via `email_accounts` (encrypted) |
| 2 | OAuth callback state is signed + expiry-checked (CSRF/account-binding guard) | VERIFIED | `src/routes/gmail-oauth.js:21-23` verifies signed, unexpired state via `verifyOAuthState` |
| 3 | Shopify webhook verified against raw body HMAC | VERIFIED | `src/routes/webhook.js:9-24` `verifyShopifyWebhook`, `express.raw` at `:27`; timing-safe + length guard |
| 4 | DB TLS configurable (encrypt in prod; strict opt-in) | VERIFIED | `src/db.js:9-15` `dbSsl()` — encrypts in production, `DB_SSL_REJECT_UNAUTHORIZED` strict toggle |
| 5 | Commission attribution never guesses a rep (anti-theft) | VERIFIED | `src/lib/attribution.js:38,54,62,170` — resolution order; unresolved → `pending_review` |
| 6 | Attribution resolution order enforced + tested | VERIFIED | `src/lib/attribution.js` precedence; `src/lib/attribution.test.js` (passes) |
| 7 | Voice order phone-match (last-10) + voice first-touch | VERIFIED | 06-03 order phone-match; `phone_calls` join; first-touch attribution path |
| 8 | Per-identity daily send caps + warmup ramp | VERIFIED | `migrations/008_send_limits.sql`; `src/lib/sendLimits.js:17-81` (`effectiveLimit`, `reserveSend`, warmup) |
| 9 | List-Unsubscribe one-click header on sends | VERIFIED | `src/lib/gmail.js:338-339` `List-Unsubscribe` + `List-Unsubscribe-Post: One-Click` |
| 10 | Unsubscribe token signed + verifiable round-trip | VERIFIED | `src/lib/unsubscribe.js` sign/verify; `src/lib/unsubscribe.test.js` (passes) |

**Score:** 10/10 code truths verified.

---

## 06-05 Task Status

| Task | Description | Status |
|------|-------------|--------|
| 1 | Automated tests + `npm test` + CI | **DONE** — `commissions`, `attribution`, `unsubscribe`, `webhook` tests + agent tests; `package.json` `test` script; `.github/workflows/test.yml` |
| 2 | Staging E2E (Appendix A: click→commission, reply-pause, voice→commission, unsubscribe, security smoke) | **PENDING (human/ops)** — requires live staging + real Shopify/email/voice |
| 3 | Monitoring minimum | **DONE** — `[cron]`/`[webhook]`/… log prefixes; Telegram alerts on `send-sequences`/`run-agents` errors; bounce-rate line in digest; `docs/RUNBOOK.md` |
| 4 | 06-VERIFICATION.md (this doc) | **DONE** |
| 5 | Go/no-go sign-off (Appendix C, names/dates) | **PENDING (human)** |

---

## Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `src/lib/attribution.test.js` | VERIFIED | passes via `npm test` |
| `src/lib/unsubscribe.test.js` | ADDED | token round-trip, tamper, case-insensitivity, wrong-secret |
| `src/routes/webhook.test.js` | ADDED | valid/invalid/tampered/missing/wrong-length/no-secret HMAC cases |
| `package.json` test script | ADDED | runs all unit + agent tests, no DB required |
| `.github/workflows/test.yml` | ADDED | runs `npm test` on push/PR |
| `docs/RUNBOOK.md` | ADDED | cron, alerts, monitoring, common ops tasks |

---

## Anti-Patterns Found

One latent issue found and fixed during closure: `verifyShopifyWebhook` called
`crypto.timingSafeEqual` without a length check, which throws on a malformed
`x-shopify-hmac-sha256` header. Added a length guard so it returns `false`
instead of throwing. Covered by `webhook.test.js`.

---

## Human Verification Required (blocks final PASS)

1. **Staging E2E — Appendix A (5 flows).** Run against live staging with a real
   Shopify order, email reply, voice call, and unsubscribe. Record results here.
2. **Go/no-go sign-off — Appendix C.** Check all boxes with names/dates.
3. **Operator env (blocking, from STATE.md):** `ENCRYPTION_KEY`,
   `SEND_WARMUP`/`DAILY_SEND_LIMIT`, Shopify webhook secret, cleaned-CSV import, DNS.

---

## Summary

All Phase 6 code and test must-haves are verified with file:line evidence, and
the 06-05 documentation/test/monitoring gaps are now closed. Two items remain and
are inherently human/ops: the staging E2E run (Appendix A) and the go/no-go
sign-off (Appendix C). Phase 6 is therefore **conditional-pass**: code-complete
and verifiable, pending live-environment sign-off before production enrollment.

---

_Verified: 2026-07-16_
_Verifier: Claude (acting gsd-verifier), during Phase 6 closure_
