# Enhancements Log

Product and engineering changes beyond routine maintenance. Newest entries first.

---

## 2026-07-08 — Prelaunch audit remediation (security · attribution · deliverability)

- **Category:** Security / Attribution / Deliverability
- **Migration:** `migrations/008_send_limits.sql` (send caps + warmup ramp)
- **Why:** Close the code-side P0/P1 findings from `PRELAUNCH_AUDIT_2026-07.md` before the pilot send — commission integrity, mailbox-token security, and domain reputation.
- **What was built:**
  - **C1 commission-theft guard** — `src/lib/attribution.js`: `ss_salesperson` cart value is now validated (active + belongs to the order's client) via `validateSalesperson()` and used only as a last-resort hint; forged/foreign ids fall through to `pending_review`.
  - **C2 first-touch ordering** — resolver reordered to: server token → lead first-touch (email/phone) → recent voice call → validated cart hint → `pending_review`. Server-issued token and lead first-touch now beat the URL-derived cart value.
  - **C4 phone normalization** — last-10-digit match on both sides (`RIGHT(...,10)`) in `attribution.js` + `phonecall.js` so `+1` prefixes match.
  - **S1 OAuth token encryption** — `src/lib/crypto.js` gains `maybeEncrypt`/`safeDecrypt`/`encryptionEnabled`; `gmail-oauth.js` encrypts refresh/access tokens on write; `gmail.js` decrypts on read + on refresh write. Backward-compatible with existing plaintext rows.
  - **S2 OAuth CSRF** — `gmail.js` `signOAuthState`/`verifyOAuthState` (HMAC, 10-min expiry); callback rejects tampered/expired state and verifies the salesperson exists.
  - **S3 webhook signatures** — `index.js` captures `req.rawBody` in the JSON parser; `webhookVerify.js` verifies Retell HMAC + Telnyx Ed25519 against the exact bytes.
  - **S4 DB TLS** — `db.js` `DB_SSL_REJECT_UNAUTHORIZED` / `DB_SSL_CA` opt-in strict verification.
  - **D1 send caps + warmup** — `src/lib/sendLimits.js` (`reserveSend`) enforces an atomic per-identity daily cap with a 5→10→20→40→`DAILY_SEND_LIMIT` ramp; wired into `gmail.js` before the send; `cron.js` defers (not errors) capped enrollments.
  - **D2 List-Unsubscribe** — RFC 8058 one-click header on all three send paths (`buildRawMessage`, SES, client SMTP) + `POST /unsubscribe` one-click handler.
  - **Tests** — `src/lib/attribution.test.js` (theft guard, token/first-touch precedence, phone normalization); existing `commissions.test.js` still green.
  - **Docs** — `.env.example` (`ENCRYPTION_KEY` fix, `DAILY_SEND_LIMIT`, `SES_FROM_*`, DB TLS vars); `PRELAUNCH_AUDIT_2026-07.md` status table.

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
