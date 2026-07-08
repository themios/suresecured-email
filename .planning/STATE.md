# Project State

## Project Reference

See: `.planning/PROJECT.md` · **Decisions:** `DECISIONS.md`

**Core value:** Any business with a contact list and commissioned sales team can hand it to SalesPilot and start generating sales within days  
**Current focus:** Pilot launch — Shopify + offline-cleaned CSV + 500–1k send

## Current Position

Phase: 6 of 6 (Prelaunch Hardening) — **partial execution**  
Status: **Pilot-ready** pending Shopify webhook + list import  
Last activity: 2026-07-08 — decisions documented; preverified CSV import; Railway linked  
Prelaunch gate: Pilot send only after offline-cleaned import + Shopify attribution wired

Progress: [█████████████████████░] ~95% (hardening partial; launch ops in Tim's hands)

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
| 06-01 Security | **Done** |
| 06-02 Attribution | **Mostly done** (007 migration fixed) |
| 06-03 Voice commission | **Partial** |
| 06-04 Deliverability | **Partial** — `email_verified` gate + preverified import; warmup/limits pending |
| 06-05 Verification | **Pending** |

## Infrastructure

- **Railway:** Email-Campaign / suresecured-email / production  
- **URL:** https://suresecured-email-production.up.railway.app  
- **Admin:** kmaautosinc@gmail.com  
- **Blocking:** `SHOPIFY_WEBHOOK_SECRET` placeholder; cleaned CSV not imported yet

## Key Documents

| Document | Purpose |
|----------|---------|
| `DECISIONS.md` | Canonical decision log |
| `HANDOFF_DECISIONS_AND_TODO.md` | TODO checklist |
| `docs/DELIVERABILITY_RUNBOOK.md` | Offline verify + pilot rollout |
| `SETUP_WALKTHROUGH_FOR_TIM.md` | Operator setup |
| `ENHANCEMENTS.md` | Code change log |
| `PRELAUNCH_AUDIT.md` | PL-### audit catalog |

---
*Last updated: 2026-07-08*
