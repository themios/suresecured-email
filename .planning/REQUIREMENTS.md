# Requirements: SalesPilot AI

**Defined:** 2026-06-30
**Core Value:** Any business with a contact list and commissioned sales team can hand it to SalesPilot and start generating sales within days

## v1 Requirements

### Multi-tenant Core

- [ ] **TENT-01**: Operator can add an organization and create client accounts within it, with each client fully isolated from others
- [ ] **TENT-02**: Users can log in with email/password and be scoped to a role (owner, admin, salesperson) that controls what they can see and do
- [ ] **TENT-03**: Operator can create/edit a client record with brand config (colors, logo, name, phone, website), commission rules, and integration settings
- [ ] **TENT-04**: Emails sent for a client use that client's brand colors, name, logo, and contact info — not hardcoded SureSecured values

### Commission Engine

- [ ] **COMM-01**: System calculates commissions using tiered rules (e.g. 0–10 units: 10%, 10–20: 15%, 20+: 20%) with optional bonus thresholds, resetting monthly
- [ ] **COMM-02**: Salesperson can view their own commission dashboard: current tier, units this month, pending payout, paid history — filtered per client
- [ ] **COMM-03**: Operator can view cross-client agency dashboard: all clients in one view, each showing units, revenue, commission owed, with quick-switch navigation
- [ ] **COMM-04**: Shopify order webhook records confirmed orders against the attributed lead, calculates commission, and updates the salesperson's monthly totals

### Email Deliverability

- [ ] **EMAI-01**: Every email sent records an open tracking pixel and rewrites body links as tracked redirects, storing open_count and click_count per send record
- [ ] **EMAI-02**: When a Gmail send returns a permanent bounce, the contact is auto-added to the suppression list and enrollment is paused
- [ ] **EMAI-03**: Enrollment cron uses FOR UPDATE SKIP LOCKED batching and partial indexes so queries stay sub-second at 500k+ active contacts

### Voice

- [ ] **VOIC-01**: Inbound calls to a single Twilio number route to the correct client's Retell AI agent via extension or name selection; post-call, a lead is created and auto-enrolled in the client's appropriate sequence

### AI Intelligence

- [ ] **AIML-01**: Each client receives a daily email digest (via OpenRouter/Gemini) summarizing new leads, sequence performance, reply rate, and top-performing subject lines for the past 24 hours
- [ ] **AIML-02**: Leads are scored 1–100 based on email engagement patterns (opens, clicks, step reached, reply) and score is visible on the lead record and commission dashboard

## v2 Requirements

### SaaS Layer

- **SAAS-01**: Businesses can self-register and subscribe to a monthly plan via Stripe, getting a single-client SalesPilot workspace
- **SAAS-02**: Plan limits enforced: contacts cap, email sends/day, number of salesperson seats
- **SAAS-03**: White-label support — custom domain, branding removal for Agency Pro tier clients

### Voice Expansion

- **VOIC-02**: Outbound AI voice calls triggered by sequence step (day N = call instead of email)
- **VOIC-03**: AI transcript analysis generates summary, action items, and lead qualification notes

### Email Scale

- **EMAI-04**: Second email provider (SES or Resend) as overflow when Gmail daily limit is reached
- **EMAI-05**: A/B subject line testing with auto-winner selection based on open rate

## Out of Scope

| Feature | Reason |
|---------|--------|
| Mobile app | Web-first; mobile is Phase 4+ |
| LinkedIn/social outreach | Email + voice covers the use case in v1 |
| Built-in CRM | Integrate with Shopify/existing tools, not replace them |
| Real-time chat | Not part of outreach model |
| Video email | Storage cost not justified in v1 |
| Client-facing login portal | Agency mode is operator-only in v1 |
| SMS outreach | Twilio SMS possible in Phase 3+ |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TENT-01 | Phase 1 | Pending |
| TENT-02 | Phase 1 | Pending |
| TENT-03 | Phase 1 | Pending |
| TENT-04 | Phase 1 | Pending |
| COMM-01 | Phase 2 | Pending |
| COMM-02 | Phase 2 | Pending |
| COMM-03 | Phase 2 | Pending |
| COMM-04 | Phase 2 | Pending |
| EMAI-01 | Phase 3 | Pending |
| EMAI-02 | Phase 3 | Pending |
| EMAI-03 | Phase 1 | Pending |
| VOIC-01 | Phase 4 | Pending |
| AIML-01 | Phase 5 | Pending |
| AIML-02 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-30*
*Last updated: 2026-06-30 — roadmap finalized, all 14 v1 requirements mapped to phases 1-5*
