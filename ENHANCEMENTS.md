# Enhancements Log

Product and engineering changes beyond routine maintenance. Newest entries first.

---

## 2026-07-09 — Git push + build verification + PII gitignore

- **Category:** DevOps / Documentation
- **Migration:** none
- **Why:** Lock in Phase 6 work on GitHub; verify build before deploy; keep lead CSVs out of repo.
- **What was built:**
  - Commit `fc136bb` — 43 files to `themios/suresecured-email` `master`
  - Build smoke: `npm ci`, all `src/**/*.js` syntax check, `commissions.test.js` pass
  - `.gitignore` — lead CSV patterns, `graphify-out/`, `.claude/`, `.playwright-mcp/`
  - Tracking docs updated (`HANDOFF`, `DECISIONS`, `STATE`, `ENHANCEMENTS`)

---

## 2026-07-08 — Documentation sync (launch decisions)

- **Category:** Documentation
- **Migration:** none
- **Why:** Record Tim's launch decisions (in-house send, offline verify, no ZeroBounce) so nothing is lost across sessions.
- **What was built:**
  - `DECISIONS.md` — canonical decision log (B1–B6, D1–D12, infra status)
  - `HANDOFF_DECISIONS_AND_TODO.md` — updated TODOs and progress
  - `docs/DELIVERABILITY_RUNBOOK.md` — offline list clean + pilot rollout
  - `SETUP_WALKTHROUGH_FOR_TIM.md` — ZeroBounce optional; offline import workflow
  - `YOUR_RAILWAY_VARS.txt` — ZEROBOUNCE marked optional
  - `.planning/STATE.md`, `.planning/REQUIREMENTS.md`, `PRELAUNCH_AUDIT.md` — cross-references

---

## 2026-07-08 — Pre-verified CSV import (offline list cleaning)

- **Category:** Deliverability / Integrations
- **Migration:** none
- **Why:** Operator cleans email lists offline (MillionVerifier, Bouncer, etc.) once before launch — ZeroBounce in-app is optional.
- **What was built:**
  - `src/routes/sequences.js` — CSV import sets `email_verified=true`, `verification_status='preverified'`, `verified_at=NOW()` on insert and re-import; UI notes pre-verified upload workflow

---

## 2026-07-08 — Railway CLI setup & variable push

- **Category:** DevOps / Security
- **Migration:** none
- **Why:** Programmatic Railway management from Tim's machine.
- **What was built:**
  - Railway CLI installed (`~/.railway/bin/railway`); project **Email-Campaign** linked
  - `scripts/push-railway-vars.sh` — bulk set vars from `YOUR_RAILWAY_VARS.txt`
  - Railway vars set: `CLIENT_API_KEY`, `APP_BASE_URL`, `UNSUBSCRIBE_HMAC_SECRET`
  - `railway run node src/setup.js` — admin user seeded
  - `SETUP_WALKTHROUGH_FOR_TIM.md`, `YOUR_RAILWAY_VARS.txt` — operator guides

---

## 2026-07-08 — Attribution migration SQL fix

- **Category:** Database
- **Migration:** `migrations/007_attribution.sql` (fix only)
- **Why:** PostgreSQL rejects multi-column `ADD COLUMN IF NOT EXISTS` in one statement; setup failed on production DB.
- **What was built:**
  - `migrations/007_attribution.sql` — one `ALTER TABLE` per column

---

## 2026-07-07 — Phase 6 prelaunch hardening (partial)

- **Category:** Security / Attribution / Deliverability
- **Migration:** `migrations/007_attribution.sql`
- **Why:** Production-ready gates before first mass send.
- **What was built:**
  - `src/middleware/apiAuth.js` — `requireClientApiKey`, `requireAdminAuth`
  - `src/routes/api.js` — API lockdown; form submissions use client key
  - `src/routes/cron.js` — POST cron, `email_verified` gate, attribution on enroll
  - `src/routes/webhook.js` — attribution resolver, commission events
  - `src/lib/attribution.js`, `src/lib/attributionCookie.js` — first-touch policy
  - `src/routes/admin.js`, `analytics.js`, `retell.js`, `phonecall.js` — security fixes
  - `src/index.js` — helmet, rate limits
  - `.env.example` — Phase 6 variables
  - `PRELAUNCH_AUDIT.md`, `.planning/phases/06-prelaunch-hardening/*` — audit + plans
