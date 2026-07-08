# Project State

## Project Reference

See: `.planning/PROJECT.md` · **Decisions:** `DECISIONS.md`

**Core value:** Any business with a contact list and commissioned sales team can hand it to SalesPilot and start generating sales within days  
**Current focus:** Pilot launch — Shopify + offline-cleaned CSV import + 500–1k send

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
| 06-01 Security | **Done** — shipped in `fc136bb` |
| 06-02 Attribution | **Mostly done** — migration 007, lib, webhook, clicks |
| 06-03 Voice commission | **Partial** |
| 06-04 Deliverability | **Partial** — gate + preverified import; limits pending |
| 06-05 Verification | **Pending** — `06-VERIFICATION.md`, more tests |

## Infrastructure

| Item | Status |
|------|--------|
| GitHub | `fc136bb` on `master` (`themios/suresecured-email`) |
| Railway | Email-Campaign / suresecured-email / production |
| URL | https://suresecured-email-production.up.railway.app |
| Admin | kmaautosinc@gmail.com |
| Build | `npm ci` + syntax check + `commissions.test.js` ✅ |
| Blocking (Tim) | Shopify webhook secret; import cleaned CSV; DNS |

## Next actions (Tim)

1. Finish Shopify webhook + snippet  
2. Offline-verify list → import `Cleaned_Leads.csv` (or valid export)  
3. DNS for `sales@suresecured.com`  
4. Pilot enroll 500–1k leads  

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
*Last updated: 2026-07-09*
