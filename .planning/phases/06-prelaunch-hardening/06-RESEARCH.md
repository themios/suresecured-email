# Phase 06 Research — Prelaunch Hardening

**Date:** 2026-07-07  
**Source audit:** `PRELAUNCH_AUDIT.md` (PL-001 through PL-065)  
**Trigger:** Phases 1–5 marked complete; prelaunch audit found security, attribution, voice-commission, and deliverability gaps blocking production send.

---

## Why a new phase exists

GSD phases 1–5 delivered feature completeness. Phase 6 closes **production readiness** gaps that verification docs flagged but did not block milestone completion:

| Gap class | Examples from codebase |
|-----------|------------------------|
| Security | Unauthenticated `/api`, unverified webhooks, SQL injection in analytics |
| Attribution | No first-touch owner; voice calls not in order resolution |
| Deliverability | ZeroBounce not enforced; no daily send caps; cron GET/POST mismatch |
| Auth drift | `setup.js` → `admin_users`; login → `users`; change-password broken |

---

## GSD appropriateness

**Yes — GSD is the right workflow for this repo** because:

1. `.planning/` already uses GSD conventions (ROADMAP, RESEARCH, PLAN, SUMMARY, VERIFICATION).
2. Work is **multi-wave** with dependencies (security before attribution before E2E sign-off).
3. `gsd-executor` + `gsd-verifier` match the audit's acceptance criteria model (PL-### checkboxes).
4. Parallelization is possible: Wave 1 security is sequential; Wave 2 attribution + deliverability can run in parallel after 06-01.

**Not ideal for GSD alone:** DNS/Instantly.ai ops tasks (PL-030, PL-034) — assign to human ops with checklist in 06-04.

---

## Phase goal (goal-backward)

**When Phase 6 is done, an operator can:**

1. Run a staged email campaign without exposing customer/commission data publicly.
2. Trust that the rep who **initiated outreach** (email enrollment, click, or voice call) receives commission on Shopify orders.
3. Send only **verified** addresses, within **daily caps**, without risking root domain reputation.
4. Pass Appendix A E2E tests in staging and sign the go/no-go checklist.

---

## Requirements mapped (new v1.1)

| ID | Requirement |
|----|-------------|
| SECU-01 | All mutation/read API routes require auth or signed client API key |
| SECU-02 | All inbound webhooks verify vendor signatures |
| SECU-03 | No SQL string interpolation from user input |
| ATTR-01 | First-touch salesperson attribution with auditable resolution path |
| ATTR-02 | Shopify order credits initiating rep via token → cart → attributed owner |
| ATTR-03 | Voice inbound call sets lead attribution; orders match phone/email |
| DELV-01 | Cron send skips unverified leads |
| DELV-02 | Per-inbox daily send limits with warmup ramp |
| DELV-03 | Cron endpoints accept Railway POST schedule |

---

## Plan decomposition

| Plan | Audit IDs | Wave | Agent focus |
|------|-----------|------|-------------|
| 06-01 | PL-001,002,003,006,007,008 | 1 | security-engineer + gsd-executor |
| 06-02 | PL-010,011,013,014 | 2 | backend-architect + gsd-executor |
| 06-03 | PL-020,021,023 | 2 | api-integration-expert + gsd-executor |
| 06-04 | PL-031,032,033,034,035 | 3 | backend-developer + ops (human) |
| 06-05 | Appendix A, go/no-go | 4 | gsd-integration-checker + gsd-verifier |

---

## Risks if Phase 6 skipped

| Risk | Impact |
|------|--------|
| Public `/api/stats` | Commission data leak |
| No send caps + unverified list | Domain blacklist in days |
| Voice sale without attribution | Rep disputes, revenue loss |
| Cron POST/GET mismatch | Zero emails sent silently |

---

## References

- `PRELAUNCH_AUDIT.md` — full PL-### catalog
- `.planning/phases/01-foundation/01-VERIFICATION.md` — noted admin_users drift (still open)
- `PRD_Email.md` — Instantly warmup strategy (Phase 1 recommendation)
