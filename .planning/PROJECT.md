# SalesPilot AI

## What This Is

SalesPilot AI is a multi-tenant sales automation platform that turns dormant contact lists into active commission-generating revenue streams. It operates in two modes: Agency Mode (operator manages multiple client businesses, runs outreach on their behalf, earns commissions per sale) and SaaS Mode (businesses subscribe and run the platform for their own sales team). The platform handles email sequences, AI voice handling, attribution tracking, and tiered commission calculation — all from a single codebase.

## Core Value

Any business with an old contact list and a commissioned sales team can hand it to SalesPilot and start generating sales within days, with zero upfront cost and zero technical knowledge required.

## Requirements

### Validated

- ✓ Gmail OAuth per salesperson — send from real inbox, auto-refresh tokens — existing
- ✓ Email sequence engine — step-based delays, cron execution, variable substitution — existing
- ✓ Unsubscribe system — HMAC-signed tokens, suppression list, one-click — existing
- ✓ Attribution redirect — /r/:token tracking links, cookie-based attribution — existing
- ✓ Contact enrollment — bulk enroll leads into sequences, pause/resume — existing
- ✓ Reply detection — Gmail thread API, auto-pause on customer reply — existing
- ✓ Lead CSV import — email, name, phone, city, audience_type, product_interest — existing
- ✓ Admin auth — JWT cookie, requireAuth middleware — existing
- ✓ Shopify webhook endpoint — inbound order events — existing (needs wiring)
- ✓ Branded email template — SureSecured colors, CTA buttons, signature, footer — existing (hardcoded, needs dynamic)

### Active

- [ ] Multi-tenant schema — organizations, clients, client_id scoping on all tables
- [ ] User auth system — replace single admin with users table, role-based access
- [ ] Client management UI — add/edit clients with brand, commission, voice, AI config
- [ ] Dynamic email branding — buildHtml() uses client brand_config, not hardcoded values
- [ ] Tiered commission engine — rules by units/revenue, bonuses, monthly reset
- [ ] Commission dashboard — per-client and cross-client, tier progress, pending/paid
- [ ] Cross-client agency dashboard — all clients in one view, quick-switch
- [ ] Scale-ready DB — partial indexes, FOR UPDATE SKIP LOCKED cron, batched CSV import
- [ ] Open/click tracking — pixel per email, link rewriting, open_count/click_count
- [ ] Bounce handling — auto-suppress on Gmail send failure
- [ ] Retell AI voice — single Twilio number, client extensions, post-call lead ingest
- [ ] AI intelligence layer — OpenRouter/Gemini daily reports, lead scoring, transcript analysis
- [ ] SaaS billing — Stripe subscriptions, plan limits, self-serve onboarding
- [ ] White-label support — custom domain, branding removal for Agency Pro tier

### Out of Scope

- Mobile app — web-first, SaaS Phase 4+ consideration
- LinkedIn/social outreach — email + voice covers the use case in v1
- Built-in CRM — integration with Shopify/existing CRM, not a replacement
- Real-time chat — not part of the outreach model
- Video email — storage/complexity cost not justified in v1

## Context

**Existing codebase:** CommissionTracker at `/home/tim/Applications/Suresecured/CommissionTracker` — Node.js/Express, PostgreSQL on Railway, server-rendered HTML + Tailwind CSS. Single-tenant, hardcoded for SureSecured. All routes functional, Gmail OAuth working, sequence engine built.

**Parallel reference app:** DealerWyze at `/home/tim/Applications/Wyze/wyze-app` — Next.js/Supabase, has complete Retell AI voice integration (retell-callback, provision.ts, ingest.ts) that maps directly to our voice needs. Port logic from there, not rewrite.

**First client:** SureSecured — marine-grade security screen doors/windows, Simi Valley CA. Brand: near-black #030302, red #E91111, warm gray #EDEBE7, light blue #CBDEE8. Commission: tiered by monthly units (0–10: 10%, 10–20: 15%, 20+: 20%), $500 sprint bonus at 25 units.

**Sequences built:** 4 sequences seeded (20-email door, 20-email window, 20-email general, 12-email dealer). Triune brain arc (reptilian → limbic → neocortex), no AI verbiage, no em dashes. Bodies are plain text; buildHtml() wraps at send time.

**Voice situation:** (747) 688-9992 is SureSecured's direct line, not on Twilio. Retell integration requires a Twilio number. Plan: provision new Twilio number for AI agent, keep direct line for human contact. Voice deferred to Phase 2.

**AI provider:** OpenRouter key available. Model: `google/gemini-2.0-flash-lite-001`. Use for daily reports, lead scoring batch, transcript extraction, sequence optimization suggestions.

**Scale target:** Hundreds of thousands of contacts across all clients. Must handle without degradation: partial indexes on enrollment/send tables, batched cron with SKIP LOCKED, chunked CSV import, connection pooling.

## Constraints

- **Tech stack:** Node.js/Express/PostgreSQL — no framework migration, brownfield evolution only
- **Deployment:** Railway — single service, environment variables for all secrets
- **Gmail limits:** 500/day free, 2,000/day Workspace. Add SES/Resend as second provider in Phase 2 for large lists
- **Voice:** Retell requires Twilio number ownership. Direct line (747) 688-9992 cannot be used until ported
- **Database:** PostgreSQL on Railway — enable connection pooler before Phase 2 scale work
- **No client logins in Phase 1:** Agency mode is operator-only. Client-facing dashboards are Phase 4 (SaaS)
- **OpenRouter model:** `google/gemini-2.0-flash-lite-001` — cost-efficient for batch AI tasks

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Brownfield evolution, not rewrite | Working email system, sequences, OAuth — rebuild around it | — Pending |
| JSONB for client config (brand, commission, voice, AI, integrations) | Flexible schema for varied client needs without migrations | — Pending |
| Single Retell number + client extensions | Cheaper than per-client numbers, cleaner for multi-tenant | — Pending |
| Tiered commission by units with bonus thresholds | Matches SureSecured structure, flexible for all clients | — Pending |
| Agency mode first, SaaS second | Revenue from commissions validates product before monetizing platform | — Pending |
| Server-rendered HTML + Tailwind (no React) | Existing pattern, fast to build, no build tooling overhead | — Pending |
| PostgreSQL partial indexes from day one | Cron query at 500k contacts must be sub-second | — Pending |
| OpenRouter/Gemini for AI (not OpenAI) | Cost efficiency for batch processing (daily reports, scoring) | — Pending |

---
*Last updated: 2026-06-30 after initial project initialization*
