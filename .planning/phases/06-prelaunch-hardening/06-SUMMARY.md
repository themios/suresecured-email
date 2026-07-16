---
phase: 06-prelaunch-hardening
plan: SUMMARY
subsystem: security, attribution, deliverability, verification
tags: [oauth, hmac, encryption, send-limits, warmup, list-unsubscribe, tests, ci, monitoring]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: multi-tenant schema, clients table
  - phase: 02-commission-engine
    provides: commission calc + attribution base
  - phase: 03-email-deliverability
    provides: open/click/bounce tracking, suppression
  - phase: 05-ai-intelligence
    provides: OpenRouter digest + scoring
provides:
  - Signed OAuth callback state + encrypted OAuth tokens
  - Shopify webhook raw-body HMAC verify (timing-safe + length-guarded)
  - DB TLS toggle (encrypt in prod)
  - Commission anti-theft (unresolved -> pending_review, never guess)
  - Per-identity daily send caps + warmup ramp (migration 008)
  - List-Unsubscribe one-click header
  - npm test (unit + agent) + GitHub Actions CI
  - Monitoring: log prefixes, Telegram error alerts, bounce-rate digest line, RUNBOOK
affects: [07-agent-foundation, production-launch]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "crypto.timingSafeEqual with length guard for HMAC comparison"
    - "signed+expiring OAuth state to prevent account-binding CSRF"
    - "plain-script assert tests wired into a single npm test chain"
    - "fire-and-forget Telegram alerting on cron errors"

key-files:
  created:
    - src/lib/unsubscribe.test.js
    - src/routes/webhook.test.js
    - .github/workflows/test.yml
    - docs/RUNBOOK.md
    - .planning/phases/06-prelaunch-hardening/06-VERIFICATION.md
  modified:
    - src/routes/webhook.js   # export verifyShopifyWebhook + length guard
    - src/routes/cron.js      # bounce-rate calc + cron-error Telegram alerts
    - src/lib/openrouter.js   # bounce-rate line in digest prompt
    - package.json            # test script

key-decisions:
  - "Phase 6 marked conditional-pass: code/tests/monitoring complete; staging E2E (Appendix A) and go/no-go sign-off remain human/ops items."
  - "Closed the 06 documentation gap (no prior SUMMARY/VERIFICATION) on 2026-07-16 alongside starting the v2 agent milestone (Phase 07)."
  - "Hardened Shopify HMAC verify against malformed-header DoS (length guard) while adding its test."

# Status
status: conditional-pass
outstanding:
  - "Staging E2E — PRELAUNCH_AUDIT.md Appendix A (5 flows)"
  - "Go/no-go sign-off — Appendix C (names/dates)"
  - "Operator env: ENCRYPTION_KEY, SEND_WARMUP/DAILY_SEND_LIMIT, Shopify webhook secret, cleaned-CSV import, DNS"
---

# Phase 06 — Prelaunch Hardening: Execution Summary

Security, attribution, and deliverability hardening plans (06-01…06-04) were
implemented previously; this summary and the accompanying 06-VERIFICATION.md were
written on 2026-07-16 to close the missing verification artifacts and finish
06-05 task 1 (tests/CI) and task 3 (monitoring).

**Completed in this closure:** added `unsubscribe.test.js` and `webhook.test.js`,
wired `npm test` + CI, added a length guard to the Shopify HMAC verify, added a
bounce-rate line to the daily digest, added Telegram error alerts to the
`send-sequences` and `run-agents` crons, and wrote `docs/RUNBOOK.md`.

**Still required before production enrollment (human/ops):** the Appendix A
staging E2E run and the Appendix C go/no-go sign-off. See 06-VERIFICATION.md.
