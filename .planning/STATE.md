# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-30)

**Core value:** Any business with a contact list and commissioned sales team can hand it to SalesPilot and start generating sales within days
**Current focus:** MILESTONE COMPLETE — all 5 phases done ✓

## Current Position

Phase: 4 of 5 (Voice)
Plan: 4/4 complete (04-03 done — Telnyx SMS inbound webhook + cron SMS dispatch branch)
Status: Phase 4 in progress (04-03 complete; 04-04 pending)
Last activity: 2026-06-30 — Completed 04-03-PLAN.md — POST /telnyx-hooks/sms + cron SMS channel branch

Progress: [████████████████████] ~100% (all 04-voice plans complete)

## Performance Metrics

**Velocity:**
- Total plans completed: 6
- Average duration: 10 min
- Total execution time: 59 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-foundation | 5/5 | 47 min | 9 min |
| 02-commission-engine | 4/4 | ~20 min | ~5 min |
| 03-email-deliverability | 4/4 | ~32 min | ~8 min |
| 05-ai-intelligence | 1/2 | ~12 min | ~12 min |

**Recent Trend:**
- Last 5 plans: 01-05 (8 min), 02-01 (12 min), 02-04 (8 min)
- Trend: consistent

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Phase 1: Brownfield evolution — add tenancy around existing 17-table schema, do not rewrite working routes
- Phase 1: JSONB for client config (brand, commission, voice, AI, integrations) — avoids future migrations
- Phase 4: Voice deferred — requires Twilio number purchase before work can begin; (747) 688-9992 is not on Twilio
- 01-01: DO $$ FOREACH loop for client_id addition — more maintainable than 17 separate ALTER TABLE statements
- 01-01: admin_users table kept in place — 01-02 will unify auth; co-existence is safe
- 01-01: client_id nullable initially — backfill and NOT NULL enforcement deferred to application layer
- 01-02: Login route at POST /auth/login (not /login) — GET /login still serves the form; legacy /logout kept
- 01-02: spAuth DB-backed client_id lookup — fetches from salespeople row rather than expanding stale JWT
- 01-02: requireRole uses rest-params with flat() — supports requireRole('op') and requireRole(['op','owner'])
- 01-03: No EJS template engine introduced — inline Tailwind HTML via res.send() matches existing codebase pattern; clientFormHtml() is the "view" equivalent
- 01-03: parseJsonField() helper normalizes JSONB textarea inputs (string → object) before DB storage
- 01-04: SureSecured values kept as brandConfig destructure defaults — backward-compatible; NULL client_id rows render SureSecured branding without backfill
- 01-04: buildHtml() exported from gmail.js — enables direct unit testing; previously unexported
- 01-04: phoneDigits derived via phone.replace(/\D/g,'') — tel: href handles any phone format in brand_config
- 01-05: FOR UPDATE OF ce (not bare FOR UPDATE) — scopes lock to contact_enrollments only; avoids contention on joined tables
- 01-05: All cron loop queries use client not pool — required to stay in transaction; SKIP LOCKED only effective within transaction
- 01-05: Pool max:20 — Railway/Heroku PgBouncer ceiling before connection exhaustion on hobby tiers
- 01-05: Seed uses multi-row INSERT batches not COPY — works with app-level credentials; no superuser required
- 02-01: No test framework introduced — plain node:assert script keeps zero-devDependencies style
- 02-01: tier.to is exclusive upper bound — thisUnit <= t.to means boundary unit stays in current tier
- 02-01: Bonus filter unitsBefore < b.units && thisUnit >= b.units — triggers exactly once at crossing sale
- 02-02: calculateCommission(0, unitsThisMonth, rules, flatRate) called with saleAmount=0 to display current tier rate — earned discarded; same code path as webhook ensures displayed rate matches actual earned rate
- 02-02: nextTier = tiers.find(t => t.from >= unitsThisMonth) — finds first uncrossed threshold for progress indicator; null means top tier reached
- 02-02: req.salesperson.client_id used directly in payout split query param — populated by spAuth middleware, not re-fetched from DB
- 02-03: requireRole imported alongside requireAuth — co-located imports, consistent with middleware/auth.js exports
- 02-03: calculateCommission(0, units, rules, 100) with passAmount=0 in drilldown — gets rate only, avoids double-counting stored commission amounts
- 02-03: Cross-org guard uses !== strict comparison on organization_id — pg driver and JWT both produce number type; safe and explicit
- 02-04: clientId null path records order but skips commission — avoids Shopify retry storm on unknown shop domain
- 02-04: spResult joins on salesperson's own client_id (not webhook-resolved) to fetch commission_rules — multi-client edge case deferred v2
- 02-04: unitsBefore query excludes current orderId to get correct pre-sale unit count for tier lookup
- 03-01: pixelToken pre-generated in JS via crypto.randomUUID() — URL must be known before Gmail send and INSERT
- 03-01: Pixel route responds immediately then fires async DB update — email clients time out image requests in ~1-2s
- 03-01: COALESCE(opened_at, NOW()) in pixel UPDATE — sets opened_at on first open only, preserves original timestamp on repeat hits
- 03-01: buildHtml() pixelUrl param defaults to '' and only injects img tag when truthy — backward-compatible
- 03-02: INSERT email_sends with status='sending' before Gmail API call — email_tracking_tokens.email_send_id is NOT NULL FK, must insert parent first
- 03-02: rewriteLinks() outside try/catch — DB failures on token INSERT surface as thrown errors, not silent ok:false
- 03-02: Click count increment is fire-and-forget after res.redirect() — minimizes redirect latency for email recipients
- 03-02: URL de-duplication via Set before INSERT loop — one token per unique URL per send
- 03-03: isPermanentBounce() added to email-tracking.js (not a separate file) — colocated with other email-send helpers
- 03-03: Bounce scope is API-level errors only — true 550 DSN bounces (Gmail 200, inbox NDR) explicitly out of scope; documented in code
- 03-03: suppression_list UNIQUE(email) has no client_id scoping — bounce in any client suppresses globally; ON CONFLICT DO NOTHING required
- 03-03: Secondary bounce DB failure logs via console.error (not silent .catch) — observability for new code path
- 03-03: permanentBounce:false returned for transient failures — cron.js only acts when flag is true; no behavior change for existing error path
- 03-04: NULLIF(COUNT(es.id), 0) in SQL rather than COALESCE in JS — null semantics clean; JS handles null->0.0% display
- 03-04: COUNT FILTER pattern over correlated subqueries — single-pass aggregation per sequence
- 03-04: Bounce rate >5% threshold for red highlight — pragmatic industry benchmark; no config needed
- 05-01: Native https for OpenRouter — no axios/node-fetch, zero new dependencies, consistent with codebase style
- 05-01: Digest sent FROM and TO operator's own connected Gmail — no OPENROUTER_DIGEST_EMAIL env var needed
- 05-01: Migration 003 (email deliverability) was missing from initDb(); wired in 05-01 alongside 005
- 05-01: reply_rate_pct null-defaulted to '0.0' in JS before AI prompt to avoid "null%" in LLM input
- 05-01: Idempotency via INSERT ... ON CONFLICT DO NOTHING RETURNING id — empty rows = already sent, no extra SELECT
- 05-01: OpenRouter 30s timeout; on timeout req.destroy() + reject; route falls back to plain-text summary
- 05-02: computeScore() is a pure function in src/lib/ with no DB dependency — fully unit-testable
- 05-02: Portal top-5 leads query scopes via contact_enrollments.salesperson_id (not leads.salesperson_id which doesn't exist)
- 05-02: score-leads UPDATE is idempotent — always sets current computed value, safe to run repeatedly
- 05-02: engagement_score and scored_at columns already in migration 005 from 05-01 — no new migration needed
- 04-01: No Telnyx SDK — plain https.request matches codebase style; zero new npm dependencies
- 04-01: sequence_steps.channel NOT NULL DEFAULT 'email' — preserves all existing email-only steps without backfill
- 04-01: leads.phone gets UNIQUE index — enables call-ended webhook to upsert lead by phone number safely
- 04-01: All voice schema in 006_voice.sql (not split across files) — simpler ordering, single re-run target
- 04-02: /inbound always returns 200 — Retell requires valid HTTP response or call fails to connect
- 04-02: Client lookup by telnyx_phone_number (call.to_number) for MVP — single number maps to single client without extension metadata
- 04-02: call_ended idempotent via ON CONFLICT (retell_call_id) DO NOTHING — Retell may retry webhooks
- 04-02: Auto-enrollment uses first active sequence by id — deterministic, no config needed for MVP
- 04-02: retellRouter mounted after express.json() — parsed body required for webhook payloads
- 04-03: telnyxRouter always returns 200 — Telnyx retries on 5xx; same pattern as retellRouter in 04-02
- 04-03: sms_messages INSERT runs even when lead not found (leadId=null) — preserves unknown-sender records
- 04-03: paused_reason='sms_reply' mirrors 'replied' semantics from email path; distinguishes channel
- 04-03: SMS cron branch uses else — email is default, SMS is explicit per step; existing sequences unaffected
- 04-03: 10DLC gate comment in both telnyx.js route and cron.js — outbound SMS blocked by carriers until Brand+Campaign registered
- 04-04: escapeHtml() added inline in admin.js — no new dependency, consistent with no-template-engine pattern
- 04-04: requireRole('operator', 'owner') multi-arg matches existing agency dashboard pattern
- 04-04: APP_BASE_URL env with req.hostname fallback — webhook URL resolves without extra config on Railway
- 04-04: voice_extension added to both INSERT /clients and UPDATE /clients/:id — both paths persist the field

### Pending Todos

- Set real Railway DATABASE_URL in .env before any plan can run live DB verification
- Provision Railway PostgreSQL instance for CommissionTracker

### Blockers/Concerns

- Phase 4 (Voice): Blocked until Twilio number is purchased and provisioned. All other phases are independent.
- Phase 1 complete — Phase 2 can begin. Enable Railway PostgreSQL connection pooler before Phase 2 scale work begins.
- 01-01 verification: DATABASE_URL is placeholder — migration file and db.js are complete but untested against live DB.

## Session Continuity

Last session: 2026-06-30
Stopped at: Completed 04-03-PLAN.md — Telnyx SMS inbound webhook + cron SMS dispatch
Resume file: None — continue with 04-04 (voice admin form + Retell provisioning)
