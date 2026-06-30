# Roadmap: SalesPilot AI

## Overview

SalesPilot AI evolves an existing single-tenant CommissionTracker into a multi-tenant agency platform. The build is purely evolutionary — add tenancy and features around working infrastructure rather than rewriting it. Phase 1 installs the foundational layer that every subsequent phase gates on: tenant schema, user auth, client management, dynamic branding, and scale-ready cron. Phases 2-5 layer commission calculation, email deliverability intelligence, voice handling, and AI-generated insights on top of that foundation.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Foundation** - Multi-tenancy DB, user auth, client config, dynamic branding, scale-ready cron ✓ 2026-06-30
- [ ] **Phase 2: Commission Engine** - Tiered commission calculation, salesperson + agency dashboards, Shopify webhook
- [ ] **Phase 3: Email Deliverability** - Open/click tracking pixels, bounce suppression
- [ ] **Phase 4: Voice** - Retell AI via single Twilio number with client extensions (deferrable until Twilio number acquired)
- [ ] **Phase 5: AI Intelligence** - Daily digest emails, lead engagement scoring

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
**Plans**: TBD

Plans:
- [ ] 03-01: Open tracking pixel — inject 1x1 pixel per send, /pixel/:token route, increment open_count
- [ ] 03-02: Link rewriting — rewrite body links as tracked redirects at send time, increment click_count on redirect
- [ ] 03-03: Bounce suppression — catch Gmail permanent failure on send, auto-add to suppression_list, pause enrollment

### Phase 4: Voice
**Goal**: Inbound calls to a single Twilio number route to the correct client's Retell AI agent and post-call lead data lands in the platform automatically
**Depends on**: Phase 1
**Requirements**: VOIC-01
**Note**: This phase is deferrable. It cannot begin until a Twilio number is purchased and provisioned. All other phases are independent of this one.
**Success Criteria** (what must be TRUE):
  1. Caller dials the Twilio number, selects a client via extension or name prompt, and is connected to that client's Retell AI agent without reaching a dead end or wrong client
  2. After a call ends, a new lead record appears in the correct client's lead list with call transcript metadata and the lead is enrolled in the appropriate sequence automatically
**Plans**: TBD

Plans:
- [ ] 04-01: Twilio + Retell integration — provision number, configure routing logic, client extension map in JSONB config
- [ ] 04-02: Post-call lead ingest — parse Retell callback, create lead, auto-enroll in client sequence (port from DealerWyze retell-callback/ingest.ts)

### Phase 5: AI Intelligence
**Goal**: Each client receives a daily AI-generated performance digest and every lead has a visible engagement score so operators and salespeople can prioritize outreach
**Depends on**: Phase 1, Phase 3 (needs open/click data for scoring)
**Requirements**: AIML-01, AIML-02
**Success Criteria** (what must be TRUE):
  1. Each morning, each active client's operator receives an email digest summarizing new leads, reply rate, sequence step performance, and top subject lines from the prior 24 hours — generated by Gemini via OpenRouter
  2. Every lead record displays an engagement score from 1–100 that reflects that lead's email open history, click history, step reached, and whether they have replied
  3. The commission dashboard surface area shows lead scores alongside salesperson activity so high-engagement leads are visually prioritized
**Plans**: TBD

Plans:
- [ ] 05-01: Daily digest engine — nightly cron queries per-client metrics, sends structured prompt to OpenRouter/Gemini, emails formatted report to operator
- [ ] 05-02: Lead scoring — batch job scores leads 1–100 from engagement signals (opens, clicks, step, reply), writes score to lead record, surfaces on lead detail and dashboard

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5
Phase 4 (Voice) can be deferred without blocking Phase 5.

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 5/5 | ✓ Complete | 2026-06-30 |
| 2. Commission Engine | 0/4 | Not started | - |
| 3. Email Deliverability | 0/3 | Not started | - |
| 4. Voice | 0/2 | Not started | - |
| 5. AI Intelligence | 0/2 | Not started | - |
