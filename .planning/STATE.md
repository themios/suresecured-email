# Project State

## Project Reference

See: `.planning/PROJECT.md` · **Decisions:** `DECISIONS.md`

**Core value:** Any business with a contact list and commissioned sales team can hand it to SalesPilot and start generating sales within days  
**Current focus:** v2 AI Agent System shipped (phases 07–10, deployed dark 2026-07-16). Pilot launch prerequisites (Phase 6 staging E2E + go/no-go) still pending human/ops.

## v2 Milestone — AI Agent System (shipped 2026-07-16)
Multi-tenant agent framework, disabled by default per tenant (Settings → AI Agents).
- **07** Foundation (event bus, runner, cost log, approvals) + Reporting — deployed
- **08** Segmentation (engagement tiers) — deployed
- **09** Email (draft → human approval → send, with suppression guards) — deployed
- **10** Research (lead enrichment) + Planning (monthly plan) — deployed
Migrations 009–011 (additive/idempotent). Weekly cron Mon 07:00 UTC (`/cron/run-agents`).
See `docs/AI_AGENT_SYSTEM_PLAN.md`.

## Current Position

Phase: 6 of 6 (Prelaunch Hardening) — **partial execution**  
Status: **Pilot-ready** — code on GitHub; Tim ops remaining  
Last activity: 2026-07-09 — `fc136bb` pushed; build verified; tracking docs updated  
Prelaunch gate: Pilot send after offline-cleaned import + Shopify webhook

Progress: [█████████████████████░] ~95%

## Launch decisions (Tim — 2026-07-08)

| Topic | Choice |
|-------|--------|
| Sending | In-house (Ionos SMTP / optional Gmail) |
| Re-contact leads | Yes — prior in-house list |
| List hygiene | Offline bulk verify → CSV import (`preverified`) |
| ZeroBounce | Not used / not in budget |
| Rollout | 500–1k pilot → scale if bounce &lt; ~2% |

## Phase 6 Execution Status

| Plan | Status |
|------|--------|
| 06-01 Security | **Done** — + audit remediation (OAuth token encryption, signed OAuth state, webhook raw-body verify, DB TLS toggle) |
| 06-02 Attribution | **Done** — commission-theft guard, token/first-touch precedence, phone normalize; `attribution.test.js` |
| 06-03 Voice commission | **Done** — order phone-match (last-10) + voice first-touch |
| 06-04 Deliverability | **Done** — per-identity daily caps + warmup ramp (migration 008), List-Unsubscribe one-click |
| 06-05 Verification | **Conditional-pass** (2026-07-16) — tests+CI+monitoring done; `06-VERIFICATION.md`/`06-SUMMARY.md` written. Pending human/ops: staging E2E (Appendix A) + go/no-go sign-off. |

## Infrastructure

| Item | Status |
|------|--------|
| GitHub | `fc136bb` on `master` (`themios/suresecured-email`) |
| Railway | Email-Campaign / suresecured-email / production |
| URL | https://saleswyze.up.railway.app |
| Admin | kmaautosinc@gmail.com |
| Build | syntax check + `commissions.test.js` + `attribution.test.js` ✅ |
| Blocking (Tim) | `ENCRYPTION_KEY` + `SEND_WARMUP`/`DAILY_SEND_LIMIT` in Railway; Shopify webhook secret; import cleaned CSV; DNS |

## Next actions (Tim)

1. **Set Railway env vars** for the audit fixes:
   - `ENCRYPTION_KEY` (64-char hex) — was mis-named `TOKEN_ENCRYPTION_KEY` in old docs; code uses `ENCRYPTION_KEY`. Without it, OAuth tokens/SMTP passwords stay plaintext (no crash).
   - `SEND_WARMUP=off` + `DAILY_SEND_LIMIT=200` (or chosen cap) so the 500–1k pilot isn't throttled to 5/day. Leave `SEND_WARMUP=on` only for a brand-new cold mailbox.
   - Confirm `RETELL_WEBHOOK_SECRET` / `TELNYX_WEBHOOK_SECRET` are set (webhooks fail closed without them).
2. Finish Shopify webhook + snippet
3. Offline-verify list → import `Cleaned_Leads.csv` (or valid export)
4. DNS for `sales@suresecured.com` (SPF/DKIM/DMARC) + confirm `List-Unsubscribe` shows in Gmail "Show original"
5. Pilot enroll 500–1k leads
6. Post-launch (P1): DSN bounce parsing + 3% circuit breaker; backfill `client_id` on legacy leads; Shopify Flow → `/api/form-submission`

## Key Documents

| Document | Purpose |
|----------|---------|
| `HANDOFF_DECISIONS_AND_TODO.md` | **Active TODO checklist** |
| `DECISIONS.md` | Canonical decision log |
| `ENHANCEMENTS.md` | Code change log |
| `docs/DELIVERABILITY_RUNBOOK.md` | List clean + pilot rollout |
| `SETUP_WALKTHROUGH_FOR_TIM.md` | Operator setup |
| `PRELAUNCH_AUDIT.md` | PL-### audit catalog |

---
*Last updated: 2026-07-08 — prelaunch audit remediation (see `PRELAUNCH_AUDIT_2026-07.md`)*
