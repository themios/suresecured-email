# Deliverability Runbook — SureSecured Launch

**Aligned with decisions in `DECISIONS.md` (B1, B3, B4, B5, D4).**  
**Last updated:** 2026-07-08

---

## Strategy summary

| Topic | Decision |
|-------|----------|
| Sending | **In-house** via SalesPilot (Ionos SMTP / optional Gmail per rep) |
| List hygiene | **One-time offline** bulk verification — **not** ZeroBounce in-app |
| ZeroBounce | **Optional** — only if you add `ZEROBOUNCE_API_KEY` later |
| Launch size | **500–1,000** leads first; scale if bounce rate &lt; **~2%** |
| After launch | Occasional bounces → app auto-suppresses + pauses enrollment |

---

## Platform protections now in code (2026-07-08)

The app enforces these automatically — you don't configure them per send:

| Protection | Behavior | Your knob |
|-----------|----------|-----------|
| **Per-identity daily send cap** | No sending identity exceeds its daily cap no matter how often the 15-min cron runs. Capped enrollments defer to the next window. | `DAILY_SEND_LIMIT` (e.g. 200) |
| **Warmup ramp** | New identity ramps 5→10→20→40→cap over ~4 weeks | `SEND_WARMUP=on`/`off` — **`off` for the established `sales@suresecured.com` mailbox** |
| **One-click unsubscribe** | RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post` headers on every send (Gmail/Yahoo bulk-sender requirement) | none — automatic |
| **Verified-only send** | Cron skips `email_verified IS NOT TRUE` | offline CSV import sets `preverified` |
| **Engagement gate** | After step 3, leads with zero opens/clicks are paused | none — automatic |
| **Permanent-bounce suppression** | API-level 550/invalid-recipient → address suppressed + enrollment paused | none — automatic |

> ⚠️ **Still manual / P1:** delayed DSN bounces (the "couldn't deliver" emails that arrive *after* acceptance) are **not** parsed yet, and there's no automatic 3% bounce circuit breaker. The offline pre-clean covers the pilot; watch your bounce rate manually for the first batches and pause via Admin if it climbs.

**Pilot env checklist (Railway):** `SEND_WARMUP=off` · `DAILY_SEND_LIMIT=200` · `ENCRYPTION_KEY` (64-char hex) · verify DNS SPF/DKIM/DMARC · send one test → Gmail "Show original" → confirm `List-Unsubscribe` present and SPF/DKIM pass.

---

## Phase 1 — Clean the list offline (one time)

### Recommended services (~10,000 emails)

| Service | Rough cost | URL |
|---------|------------|-----|
| MillionVerifier | ~$37–50 | millionverifier.com |
| Bouncer | ~$50 | usebouncer.com |
| NeverBounce | ~$80 | neverbounce.com |
| ZeroBounce (offline upload) | ~$129 | zerobounce.net |

**You do not need** ZeroBounce integrated in Railway for this workflow.

### Steps

1. Export leads to CSV with an **`email`** column (plus optional name, phone, city).
2. Upload full list to chosen verifier.
3. Download **Valid / Deliverable only**.
4. **Do not import:** invalid, risky, spam-trap, disposable (per tool labels).
5. Keep the invalid export for your records.

### Cost tip

- Many tools offer **100–500 free** trial credits — test workflow on a slice first.
- Minimum paid packs are often **2,000 credits (~$39)** even if you only need 1,000 checks.

---

## Phase 2 — Import into SalesPilot

1. Log in: `https://suresecured-email-production.up.railway.app`
2. **Sequences** → **Import Contacts (CSV)**
3. Upload cleaned CSV only.

**What the app does:**

- Sets `email_verified = true`
- Sets `verification_status = preverified`
- Sets `verified_at` to import time
- Leads are **send-ready** for cron (no ZeroBounce step)

Re-importing the same email updates fields and re-marks as preverified.

---

## Phase 3 — Pilot send

| Day | Action |
|-----|--------|
| 1 | Enroll **500–1,000** leads (not full list) |
| 1–3 | Let step 1 send (cron every 15 min) |
| 3 | Check **Sequences** report → **bounce rate** |
| 3+ | If bounce &lt; **~2%**, enroll next batch (2k, then remainder) |
| 3+ | If bounce ≥ **~2%**, pause, re-clean segment or reduce volume |

### What counts as a bounce in-app

- **Immediate** permanent send failure (bad address at SMTP/API layer)
- Enrollment paused + email on **suppression list**
- True mailbox bounces (550 DSN) may arrive later in inbox — **not auto-parsed yet**; watch Ionos bounces manually if needed

---

## Phase 4 — DNS (before / during pilot)

Work with whoever manages **suresecured.com** DNS:

- **SPF** — include your sending host (Ionos / SES)
- **DKIM** — from email provider admin
- **DMARC** — start with `p=none`, move to `quarantine` when stable

Send from **`sales@suresecured.com`** (already in Railway) — must be authorized in Ionos.

**Google Postmaster Tools** — register domain after first sends.

---

## Phase 5 — Ongoing (post-launch)

| Event | App behavior |
|-------|----------------|
| Hard bounce on send | Suppress email, pause enrollment |
| Unsubscribe click | Suppress, pause |
| Reply | Pause sequence, classify (OpenRouter) |
| New bad address | Add to suppression manually in Admin |

Optional later: add `ZEROBOUNCE_API_KEY` and use **Verify Emails (50)** for new imports only.

---

## What NOT to do

- ❌ Blast 10k+ on day one without pilot metrics
- ❌ Import unverified raw export
- ❌ Skip Shopify snippet + webhook (commissions won't attribute)
- ❌ Send from root domain without SPF/DKIM

---

## Quick reference

| Check | Where |
|-------|-------|
| Bounce rate | Sequences → deliverability table |
| Suppressed emails | Admin → Suppression list |
| Cron running | Railway cron + `CRON_SECRET` set |
| Send blocked? | Lead `email_verified` must be `true` |

See also: `SETUP_WALKTHROUGH_FOR_TIM.md`, `DECISIONS.md`
