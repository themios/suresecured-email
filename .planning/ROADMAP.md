# Roadmap: SalesPilot AI

## Overview

SalesPilot AI evolves an existing single-tenant CommissionTracker into a multi-tenant agency platform. The build is purely evolutionary — add tenancy and features around working infrastructure rather than rewriting it. Phase 1 installs the foundational layer that every subsequent phase gates on: tenant schema, user auth, client management, dynamic branding, and scale-ready cron. Phases 2-5 layer commission calculation, email deliverability intelligence, voice handling, and AI-generated insights on top of that foundation.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Foundation** - Multi-tenancy DB, user auth, client config, dynamic branding, scale-ready cron ✓ 2026-06-30
- [x] **Phase 2: Commission Engine** - Tiered commission calculation, salesperson + agency dashboards, Shopify webhook ✓ 2026-06-30
- [x] **Phase 3: Email Deliverability** - Open/click tracking pixels, bounce suppression ✓ 2026-06-30
- [x] **Phase 4: Voice** - Telnyx SMS + Retell AI inbound voice with post-call lead creation ✓ 2026-06-30
- [x] **Phase 5: AI Intelligence** - Daily digest emails, lead engagement scoring ✓ 2026-06-30
- [ ] **Phase 6: Prelaunch Hardening** - Security, attribution integrity, voice commission, deliverability gates (pilot launch — see `DECISIONS.md`)

## Phase Details

### Phase 1: Foundation
**Goal**: The platform supports multiple isolated clients, users log in with scoped roles, operator can configure any client's brand and rules, and the cron engine handles 500k+ contacts without degradation
**Depends on**: Nothing (brownfield — existing codebase is the starting point)
**Requirements**: TENT-01, TENT-02, TENT-03, TENT-04, EMAI-03
**Success Criteria** (what must be TRUE):
  1. Operator can create an organization, add a client to it, and that client's data is fully isolated — no query returns another client's leads, sends, or commissions
  2. A user can log in with email/password and sees only the UI and data permitted by their role (owner, admin, salesperson)
  3. Operator can create or edit a client record and save brand config (colors, logo, name, phone), commission rules, and integration settings in a single form
  4. An email sent for SureSecured uses SureSecured's brand colors and logo; an email sent for a second test client uses that client's brand — no hardcoded values remain
  5. Enrollment cron processes a seeded 500k-contact table and completes each run in under 5 seconds with no row contention errors (SKIP LOCKED verified)
**Plans**: TBD

Plans:
- [ ] 01-01: Database migration — add organizations, update users table, add client_id FK to all 17 existing tables, create partial indexes
- [ ] 01-02: User auth system — replace single admin JWT with multi-user login, role middleware, session scoping
- [ ] 01-03: Client management UI — create/edit client record with JSONB brand_config, commission_rules, integration_settings
- [ ] 01-04: Dynamic email branding — update buildHtml() to pull brand_config from client record, remove all hardcoded SureSecured values
- [ ] 01-05: Scale-ready cron — FOR UPDATE SKIP LOCKED on enrollment cron, batched CSV import, connection pool tuning

### Phase 2: Commission Engine
**Goal**: The system calculates commissions accurately using configurable tiered rules, salespeople can see their own earnings, and confirmed Shopify orders automatically post to commission totals
**Depends on**: Phase 1
**Requirements**: COMM-01, COMM-02, COMM-03, COMM-04
**Success Criteria** (what must be TRUE):
  1. When a salesperson hits a new unit tier (e.g. sale 11 of the month), the commission rate for subsequent sales updates automatically and bonus thresholds trigger when crossed
  2. Salesperson can open their dashboard and see current tier, units sold this month, pending payout amount, and paid history — all filtered to their assigned client
  3. Operator can open the agency dashboard and see all clients in a single view with units, revenue, and commission owed per client, and can click into any client without re-logging in
  4. When a Shopify order webhook fires with a recognized attribution token, the order is recorded against the lead, commission is calculated, and the salesperson's monthly total updates within 30 seconds
**Plans**: 4 plans

Plans:
- [x] 02-01: Tiered commission engine — configurable rules from client.commission_rules, monthly reset logic, bonus threshold detection ✓ 2026-06-30
- [ ] 02-02: Salesperson commission dashboard — per-client view, tier progress, pending/paid history
- [ ] 02-03: Agency cross-client dashboard — all clients in one view, quick-switch navigation
- [ ] 02-04: Shopify webhook wiring — parse inbound order, match attribution token, post commission, update monthly totals

### Phase 3: Email Deliverability
**Goal**: Every email send is fully tracked (opens and clicks) and permanent bounces are automatically suppressed so deliverability stays clean without operator intervention
**Depends on**: Phase 1
**Requirements**: EMAI-01, EMAI-02
**Success Criteria** (what must be TRUE):
  1. After an email is sent, the send record shows open_count incrementing when the recipient opens the email and click_count incrementing when they click any body link
  2. When a Gmail send returns a permanent failure code, the contact address appears in the suppression list and that contact's enrollment is paused — no manual action required
  3. Operator can view a per-sequence report showing open rate, click rate, and bounce rate across all sends
**Plans**: 4 plans

Plans:
- [x] 03-01-PLAN.md — Schema migration (003) + open pixel route + buildHtml pixelUrl injection ✓
- [x] 03-02-PLAN.md — Link rewriting (rewriteLinks helper, /e/:token route, INSERT-before-send refactor) ✓
- [x] 03-03-PLAN.md — Bounce suppression (isPermanentBounce, catch block, cron auto-suppress + pause) ✓
- [x] 03-04-PLAN.md — Deliverability report (per-sequence open/click/bounce rates, sequences page table) ✓

### Phase 4: Voice
**Goal**: Inbound calls to the Telnyx number (+18183810202) route to the correct client's Retell AI agent; post-call lead data and transcripts land in the platform automatically; and outbound SMS fires from sequence steps as a channel alongside email
**Depends on**: Phase 1
**Requirements**: VOIC-01
**Note**: Carrier switched from Twilio to Telnyx. Number +18183810202 already owned. 10DLC Brand+Campaign registration required in Telnyx portal before SMS goes live (3-7 day approval). Telnyx elastic SIP trunk -> sip.retellai.com for call routing.
**Success Criteria** (what must be TRUE):
  1. Caller dials +18183810202 and is connected to the correct client's Retell AI agent; call transcript and duration appear in call_logs after call ends
  2. After a call ends, a new lead record appears in the client's lead list and the lead is auto-enrolled in the client's active sequence
  3. A sequence step with channel='sms' sends a Telnyx SMS to the lead's phone number; inbound SMS reply pauses the enrollment with paused_reason='sms_reply'
  4. Operator can set voice_extension per client and click "Provision Voice Agent" to create the Retell LLM + agent and store the IDs
**Plans**: 4 plans

Plans:
- [x] 04-01-PLAN.md — Schema migration 006 (voice columns + call_logs + sms_messages tables) + src/lib/telnyx.js sendSms() ✓
- [x] 04-02-PLAN.md — Retell voice routing: src/lib/retell.js + /retell-hooks/inbound + /retell-hooks/call-ended + index.js mount ✓
- [x] 04-03-PLAN.md — SMS dispatch + inbound: /telnyx-hooks/sms + cron.js SMS branch + index.js mount ✓
- [x] 04-04-PLAN.md — Client UI: voice_extension field + POST /admin/clients/:id/provision-voice (Retell LLM + agent creation) ✓

### Phase 5: AI Intelligence
**Goal**: Each client receives a daily AI-generated performance digest and every lead has a visible engagement score so operators and salespeople can prioritize outreach
**Depends on**: Phase 1, Phase 3 (needs open/click data for scoring)
**Requirements**: AIML-01, AIML-02
**Success Criteria** (what must be TRUE):
  1. Each morning, each active client's operator receives an email digest summarizing new leads, reply rate, sequence step performance, and top subject lines from the prior 24 hours — generated by Gemini via OpenRouter
  2. Every lead record displays an engagement score from 1–100 that reflects that lead's email open history, click history, step reached, and whether they have replied
  3. The commission dashboard surface area shows lead scores alongside salesperson activity so high-engagement leads are visually prioritized
**Plans**: 2 plans

Plans:
- [x] 05-01-PLAN.md — Daily digest engine: migration 005, openrouter.js, buildDigestHtml(), POST /cron/daily-digest route ✓
- [x] 05-02-PLAN.md — Lead scoring: computeScore() pure function, POST /cron/score-leads batch route, score badge on portal ✓

### Phase 6: Prelaunch Hardening
**Goal**: Platform is secure, attributes sales to the initiating rep across email and voice, and cannot blacklist domains during staged mass outreach
**Depends on**: Phases 1–5 (feature-complete baseline)
**Source audit**: `PRELAUNCH_AUDIT.md` (2026-07-07)
**Launch decisions (2026-07-08):** `DECISIONS.md` — in-house send, offline list verify + `preverified` CSV import, pilot 500–1k, no ZeroBounce requirement.
**Requirements**: SECU-01, SECU-02, SECU-03, ATTR-01, ATTR-02, ATTR-03, DELV-01, DELV-01b, DELV-02, DELV-03
**Success Criteria** (what must be TRUE):
  1. No unauthenticated access to commission data or lead mutation APIs; all vendor webhooks verify signatures
  2. Shopify order credits the salesperson who initiated outreach (email enrollment, click, or voice call) with auditable resolution path
  3. Cron sends only to verified leads (`email_verified` via offline-cleaned CSV import or optional ZeroBounce), within per-inbox daily caps, with bounce circuit breaker
  4. Appendix A E2E tests pass in staging; pilot send signed off before full list scale-up
**Plans**: 5 plans

Plans:
- [ ] 06-01-PLAN.md — Security lockdown: API auth, webhook signatures, SQL injection fix, cron method, auth consistency, helmet/rate-limit
- [ ] 06-02-PLAN.md — Attribution engine: first-touch model, Shopify chain, OAuth hardening, token encryption, tenant scoping
- [ ] 06-03-PLAN.md — Voice commission: Retell/CallRail → attribution → order resolution → portal
- [ ] 06-04-PLAN.md — Deliverability gates: verification enforcement, daily limits, circuit breaker, List-Unsubscribe, ops runbook
- [ ] 06-05-PLAN.md — Verification: unit tests, Appendix A E2E, monitoring, gsd-verifier sign-off

## Progress

**Execution Order:**
Phases 1–5 complete. **Phase 6 is mandatory before production send.**
Phase 6 waves: 06-01 → (06-02 ∥ 06-04) → 06-03 → 06-05

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 5/5 | ✓ Complete | 2026-06-30 |
| 2. Commission Engine | 4/4 | ✓ Complete | 2026-06-30 |
| 3. Email Deliverability | 4/4 | ✓ Complete | 2026-06-30 |
| 4. Voice | 4/4 | ✓ Complete | 2026-06-30 |
| 5. AI Intelligence | 2/2 | ✓ Complete | 2026-06-30 |
| 6. Prelaunch Hardening | 3/5 | In progress (pilot-ready) | — |

*Phase 6: 06-01 done; 06-02/06-04 partial; launch ops per `DECISIONS.md`*
