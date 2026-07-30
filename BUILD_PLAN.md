# SalesWyze Build Plan

**Date:** 2026-07-30 · **Last updated:** 2026-07-30 (Phase 0 is DONE and verified — see below; audit log, data deletion, and a login rate-limit gap also shipped)
**Goal:** turn a working single-tenant app into a multi-tenant product that can safely sell its offers (done-for-you and self-serve), without boiling the ocean.

> **Phase 0 status: COMPLETE.** Every route was audited and scoped to `client_id` (including three files — `dashboard.js`, `activity.js`, `admin.js` — that a security review caught after the first pass missed them, one of which was a cross-tenant account-takeover path). The global unique indexes on `leads.phone`, `orders.shopify_order_id`, and `salespeople.email` are now per-tenant composites (migration 018), verified against both a fresh boot and a simulated production transition with real data. A 10-test two-tenant isolation suite (`npm run test:isolation`) drives the real HTTP app and proves tenant A cannot read or mutate tenant B's data anywhere it checked. **The app is now safe to onboard a second tenant.**

> **Pricing decision (2026-07-30):** pay-on-close is dropped. Close attribution cannot be verified without the customer's cooperation and turns every invoice into a dispute. The model is now flat, three tiers:
> - **Fully managed — $499/month.** We set it up and we run it. No setup fee.
> - **We build it, you run it — $199/month plus a one-time $999 setup.** We stand it up, hand it over, you drive. This is the featured tier; the landing page accentuates the $199 and keeps the "$999 one-time setup" small and non-bold.
> - **Self-serve — $199/month, no setup (coming later).** The platform runs by the customer end to end. Gated on Phase 2 billing.
>
> The free estimate is the entry point and de-risks the setup. This decision also **removes the attribution and close-tracking engine from the build** entirely, which is a real scope reduction. Where the phases below still say "pay-on-close," read the flat tiers above.

---

## Who this is for (broadened 2026-07-30)

Originally scoped to trades. It is now **any business sitting on a list of old leads and past customers** — auto dealers, law firms, retail, agriculture, medical and dental, real estate, insurance, home services, and more. The product does not care what they sell; it cares that they have a customer list they never followed up on. The landing copy, the free estimate's industry benchmarks, and the SEO all reflect this wider audience. "What's your trade" is gone. The blog cluster still needs to widen to match (see Already shipped → open items).

---

## Already shipped (as of 2026-07-30)

These are done and on `master` (live on Railway). The phases below build on top of them.

- **App bootstraps from an empty database** — phased `initDb()`; disaster recovery actually works now.
- **Delivery feedback loop** — send failures are classified and recorded, a sending-health banner shows when mail stops landing, and `/undelivered` lists what failed. This is the spine the Phase 1 seed canary plugs into.
- **Auth reads role/client_id from the DB per request** — closes the stale-JWT revocation gap (a down payment on Phase 0).
- **Gmail API sending** — Railway blocks outbound SMTP (port 587), so the platform sends over the Gmail API. This is the only working send path and what the audit email rides on.
- **Landing page + SEO** — StoryBrand-structured funnel, JSON-LD (Organization, Service, FAQ, Article), sitemap, five blog posts, transparent three-tier pricing section.
- **Free estimate ("audit"), built end to end** — the landing form now returns an **instant, industry-tailored recoverable-revenue report** in the same app and theme. The 1% / 2.5% / 5% math is computed in code (never by the LLM); the AI writes only the short narrative, gated by a lingo + em-dash reject with a plain-human fallback. It uses the prospect's own "what is one sale worth" number when given, else an industry benchmark. It also **emails the prospect a copy** (so we land in their inbox and contacts) via the Gmail path, best-effort in the background. This replaces the old lead-capture-only CTA, which was a form with no product behind it.

**Open items from this work:** widen the five blog posts (currently trades-only) to the broader audience, one targeted post per vertical is better for SEO than watering the existing ones down. The audit's per-industry deal benchmarks are seeded defaults; tune them as real data comes in. The emailed copy carries our physical address (CAN-SPAM) and is a single, solicited, one-time response, which is defensible without an unsubscribe link — but if it ever becomes a drip, it needs List-Unsubscribe like the sequence mail already has.

---

## The one idea that makes this manageable

Do not build the whole platform before you sell anything. Build in phases where **each phase ends in something new you can sell**, and each phase unlocks the next. You are already earning today with SureSecured. The plan below adds a second paying customer as fast as safely possible, then widens.

There is exactly one hard gate before any second customer, managed or self-serve: **tenant isolation**. Everything else can be sequenced behind it.

---

## The thing that makes SalesWyze unique

Every competitor sends mail and hopes. Reactivation vendors do a one-time blast. Cold email agencies charge $2,500 to $12,000 and disappear behind a dashboard. Platforms like GoHighLevel hand you a tool and wish you luck on deliverability.

Your edge is **proven delivery**. Not "we sent it." "We watched it land, and here is the reply." Three things nobody else combines:

1. **It sends from a real inbox and sounds like a person**, so it actually gets read.
2. **A seed canary proves the mail reaches the inbox**, not spam, every day, automatically. You catch a delivery problem before the customer notices their replies dried up.
3. **You do it for them and you watch it, or they run it themselves.** Either way the follow up actually happens, which for a busy owner is the whole point.

Lead the brand with that. "Reactivation that actually lands." It is a claim your competitors cannot make and your product can prove. The **instant free estimate** is the top of that funnel: a stranger enters their industry, list size, and average sale, and gets a believable recoverable-revenue number in seconds, in their inbox, before you have spent a minute on them.

---

## Dependency map

```
                        ┌─────────────────────────────┐
                        │  PHASE 0  Foundation        │
                        │  tenant isolation + the      │
                        │  automation actually runs    │
                        └──────────────┬──────────────┘
                                       │  (hard gate: no 2nd customer without this)
                 ┌─────────────────────┼─────────────────────┐
                 ▼                                           ▼
   ┌───────────────────────────┐              ┌───────────────────────────┐
   │  PHASE 1  Managed live    │              │  PHASE 3  Trust & scale   │
   │  per-tenant sending +      │              │  audit log, backups,       │
   │  seed canary + hand        │              │  security hardening        │
   │  onboarding                │              │  (needed as clients grow)  │
   │  → sell done-for-you       │              └───────────────────────────┘
   └──────────────┬────────────┘
                  ▼
   ┌───────────────────────────┐
   │  PHASE 2  Self-serve live │
   │  billing + self onboarding │
   │  + send metering + verify  │
   │  → sell $199 self-serve    │
   └───────────────────────────┘
```

Read it as: Phase 0 first, always. Then Phase 1 gets you to two revenue tiers fast. Phase 2 adds the third. Phase 3 runs alongside as you grow.

---

## Phase 0 — Foundation (the gate) — ✅ DONE (2026-07-30)

**Why first:** the moment a second business has a login, they share one database with SureSecured. Before this work, queries were not all scoped, so tenant B could see tenant A's leads, revenue, and customer emails. It is also the "runs itself" promise: if the automation does not actually run, the product is a demo.

**Work items, all shipped:**
1. **Every query tenant-scoped.** `analytics.js`, `leads.js`, `sequences.js`, `api.js` first, then a security review swept the files the first pass never covered — `dashboard.js` (the whole overview leaked every tenant's revenue/reps/reply PII), `activity.js` (all five drill-downs — orders, commissions, calls, clicks, form-submissions — same leak, plus an order-assign mutation that never checked the order belonged to the caller's tenant), and `admin.js` (a tenant admin could set **any other tenant's rep's portal password** — a real account-takeover path — plus several unscoped salesperson/client writes). All closed. `requireTenantContext` is now enforced at the router level in every tenant-facing route file, not per-route, so a new route added later cannot forget it.
2. **Global unique indexes converted** to `(client_id, column)` composites — `leads.phone`, `orders.shopify_order_id`, `salespeople.email` (migration 018). Every `ON CONFLICT` call site updated in lockstep (`webhook.js`, `retell.js`). Two cross-tenant write bugs found in the process and fixed: the inbound-email-capture cron was joining ONE globally-picked `client_email_config` to every connected mailbox (misattributing new leads across tenants), and two `ON CONFLICT (email)` clauses on `leads` targeted an index that no longer exists (leads has no global email uniqueness, by design — a lead can belong to more than one tenant).
3. **Two-tenant isolation test suite shipped**: `src/test/isolation.test.js`, run with `npm run test:isolation`. Seeds two real tenants, drives the actual HTTP app (not mocks), and asserts leads/analytics/sequences/dashboard/orders never cross tenant lines, that cross-tenant reads 404, that cross-tenant writes are refused, and specifically that the portal-password takeover is closed. 10/10 pass.
4. **All four dead cron jobs turned on** (`poll-email-sources`, `score-leads`, `run-agents`, `daily-digest`) — they only existed in `railway.toml` `[[cron]]` blocks, which Railway does not treat as a real schedule, so they never fired. Now wired into the same `node-cron` block as the one job that worked.

**Verification performed:** fresh-database boot, idempotent rerun, and — the one that matters most — a **simulated production transition**: recreated the old global indexes with real seed data, then ran the migration and confirmed the composites replaced them cleanly with zero data loss. This is the closest verification possible short of running it against the live database directly.

**What you can sell after:** nothing new yet, but the app is now safe to add a second customer — the unlock, not the product.

**Rough size:** the biggest single phase. The query scoping and index conversion are the bulk. Call it the one you do carefully and do not rush.

---

## Phase 1 — Managed tier live (fastest to new revenue) — ✅ SHIPPED (2026-07-30)

**Why here:** the done-for-you offer is delivered by hand, so they do not need billing or self-serve onboarding. Once isolation is done, this is a short hop to a second paying client.

**Shipped:**
1. **The seed canary.** Each tenant connects one monitored inbox in Settings → Email (its own OAuth flow, `src/lib/seedCanary.js`). Every real campaign send also copies to it; a daily job (`/cron/seed-check`, 08:00 UTC) checks the inbox via the Gmail API and classifies where the mail landed (inbox / promotions / spam) from Gmail's own labels. Feeds both the sending-health banner (a milder amber warning distinct from the red "sending is down" state) and `/undelivered`.
2. **Client-health view.** `GET /admin/client-health` — cross-tenant by design (the platform operator's own monitoring surface), gated to operator/owner. Shows every managed client's sending health, last 5 seed checks, and 24h send volume in one screen.
3. **Per-tenant sending** was already mostly there (Gmail OAuth connect exists per salesperson, `client_email_config` supports per-tenant SMTP/from-address) — no new work needed here; onboarding a client still means connecting their sender through the existing flow.

**What you can sell after:** both managed tiers — fully managed at $499/month, or build-it-you-run-it at $199/month plus the one-time $999 setup — to real clients beyond SureSecured, with a delivery guarantee you can now actually prove, not just claim.

---

## Phase 1.5 — SMS as a second channel — ✅ SHIPPED (2026-07-30)

**Why here:** the offer already promises phone follow up, and omnichannel is where the money is. Email-only agencies charge $1,000 to $5,000 a month; add phone and it is $5,000 to $15,000. SMS gets read fast and closes warm replies. But it carries compliance weight email does not, so it earns its own phase and sits just after email is solid.

**Shipped:**
1. **Per-tenant phone number.** Settings → Phone & SMS now saves to `clients.telnyx_phone_number` (E.164 validated, with a cross-tenant collision check — the column has no DB-level unique constraint and both the SMS and voice inbound webhooks resolve the tenant with a bare lookup, so two tenants sharing a number would misroute each other's replies/calls). Found and fixed a pre-existing bug in the same area: the old field on this page wrote to `brand_config.telnyx_phone`, a key no sending code ever read — consolidated onto the real column.
2. **SMS steps inside sequences.** The sequence editor now has an Email/SMS toggle per step. SMS hides the subject field (schema requires one; the backend synthesizes a short label from the body) and relabels the body field with a ~300-char guidance note.
3. **Consent and opt-out, done right.** `leads.consent_sms` (already in the schema, unused until now) gates every outbound send in `cron.js` — an enrollment reaching an SMS step for a non-consenting lead is paused (`no_sms_consent`), not silently skipped or sent anyway. This closed a real compliance gap: the existing SMS dispatch had no consent check at all before this. STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT (exact match, not substring) revoke consent instantly, cancel active enrollments, and send a confirmation text; HELP sends a static support reply.
4. **Delivery receipts.** Telnyx's `message.finalized` event (previously ignored as a "status event") now updates the matching `sms_messages` row to delivered/failed by `telnyx_message_id`, the same way email failures are tracked.
5. **10DLC registration** remains an external step per tenant (3-7 day approval) — inbound replies and STOP/HELP work immediately regardless; outbound is gated on it.
6. **Metering** is not yet built — still open, lower priority than the compliance/consent piece above.

**What you can sell after:** the omnichannel version of done-for-you. Confirmed working end to end against live test data (STOP correctly flips consent, HELP and delivery-status webhooks both process correctly).

**The honest compliance note still stands:** do not text a cold list, honor every STOP instantly, keep the consent record. The code now enforces the first two; the record-keeping (`consent_sms_at`) was already there.

---

## Phase 2 — Self-serve tier live ($199) — 🟡 SCAFFOLDED (2026-07-30), needs your Stripe account

**Why here:** self-serve is the scale tier, but it is the most build. It needs a customer to sign up, pay, connect sending, import a list, and launch without you touching anything.

**Shipped (inert until Stripe is configured — degrades gracefully, no key set = no crash, just a "not configured yet" notice):**
1. **Billing scaffold.** `client_subscriptions` table (a read-through mirror of Stripe's own state, never a second source of truth). `GET /billing` plan picker (all three tiers), `POST /billing/checkout` creates a Stripe Checkout Session. `POST /webhooks/stripe` handles `checkout.session.completed`, `customer.subscription.updated`/`.deleted`, `invoice.payment_failed`. Price IDs come from env vars (`STRIPE_PRICE_MANAGED`, `STRIPE_PRICE_DIY`, `STRIPE_PRICE_DIY_SETUP`, `STRIPE_PRICE_SELF_SERVE`) — nothing hardcoded, so standing up real billing is a config step once you have a Stripe account and price IDs, not a code change.
2. **Still open:** seat/usage metering and fair-use enforcement, self-serve onboarding flow (sign up → connect sender → import list → launch, unassisted), and MillionVerifier as a metered add-on. None of these can be built usefully until the billing plumbing above has a real account behind it.

**What you can sell after billing is connected:** $199 self-serve, and the business stops being capped by your team's hours.

---

## Phase 3 — Trust and scale (runs alongside)

**Why:** not blockers for the first few clients, but they become real as you grow and as bigger clients ask harder questions.

**Shipped 2026-07-30:**
1. **Audit log** (`migrations/019_audit_log.sql`, `src/lib/auditLog.js`). Append-only, records login success/failure (password and Google, with the reason), portal-password changes, tenant/client edits, and order-assign commission credits. Best-effort — never blocks the action it records.
2. **Real migration runner.** `schema_migrations` tracking table + a `pg_advisory_lock` around the whole boot sequence, so overlapping deploys or a second replica can never race the schema. Verified: fresh boot applies all 17 (now 19) migrations and records them; rerun applies none.
3. **Global error and process handlers.** An Express error handler returns a clean 500 instead of a hung request; `unhandledRejection`/`uncaughtException` are logged (Railway restarts on the latter).
4. **Login rate limiting was silently not applied.** `app.use('/login', loginLimiter)` only matches the GET page path; the actual password-check route is `POST /auth/login`, which that prefix never reached — brute-force login attempts had zero rate limiting. Fixed and verified live (21st rapid attempt returns 429).
5. **Data deletion path** (`src/lib/dataDeletion.js`) for state privacy law requests — see the compliance section below.

**Still open:**
1. **Tested backup/restore drill.** The migration runner is now tracked and locked, but a timed restore-from-backup drill against Railway has not been run.
2. **Webhook replay protection.** Not yet reviewed in this pass.
3. **Vendor Tailwind locally + re-enable CSP.** Deliberately **not attempted** in this session — the CDN script (`src/lib/layout.js:107`) feeds the shared shell every authenticated page uses, and there was no browser available to visually verify the result. Rebuilding it blind and shipping it while the owner is unavailable to check the dashboards for breakage was the wrong trade. Do this in a session where you can look at the rendered pages before it goes live.

**What you can sell after:** nothing new, but you can keep and defend the customers Phase 1 and 2 brought in.

**Rough size:** several small independent items you can pick off between phases.

---

## Compliance and legal (woven through every phase, not a bolt-on)

This is a real surface with real teeth, especially for SMS. Read this first, plainly: **I can build the controls, but I cannot be your lawyer, and "compliant in every state" is a moving target that a lawyer has to sign off on.** The state privacy and texting laws change most years, and the SMS ones carry per-message penalties that fund a whole litigation industry. Build the controls below, then have counsel review the contracts, the consent language, and the multi-state SMS approach before you scale texting.

### Your liability structure (the smart part you already named)

The customer, not SalesWyze, is the sender of record. Make that structural, in both the product and the paperwork:

- **They authorize the exact verbiage.** Before anything sends, the customer approves the email and SMS wording. Build this as an approval step in the product, and keep a timestamped record of what they approved.
- **They stand behind their claims and their list.** In the agreement, the customer attests that they have the legal right and the consent to contact everyone on the list, that the claims in their messages are true, and that they are responsible for the content. Pair it with an indemnification clause.
- **Reality check:** this shifts most of the risk to the customer, which is correct and important, but it does not make the platform invisible to the law. A facilitator can still carry obligations. So the customer attestation is necessary, not sufficient. It rides alongside the technical controls, it does not replace them.

### Email (federal CAN-SPAM) — audited against the FTC's seven rules

Checked each requirement against the live code. Penalties are up to $53,088 per email, so this matters.

1. **No false or misleading headers.** Mail sends from a real business From name and address. Met.
2. **No deceptive subject lines.** Content is customer-authorized (see the liability structure above), and the sequences use plain honest subjects. Met, and owned by the customer.
3. **Identify the message as an advertisement.** This is the one soft spot. The footer establishes the relationship ("you received this because you requested information from ..."), which is the basis for the relationship and prior-consent leeway, since the list is prior inquirers, not cold. But the messages do not carry an explicit ad label. Have counsel confirm whether the relationship footing is enough for your list, or whether a light identifier is worth adding. Do not slap "ADVERTISEMENT" on everything, that would gut the "sounds like a person" value. This is a lawyer call, not a code gap.
4. **Valid physical postal address.** Present in every footer ("Sure Secured, 1555 Simi Town Center Way, Simi Valley, CA 93065"). Met. A registered agent address or a post office box registered with the USPS is also acceptable if you ever want to keep the street address private.
5. **A working opt-out.** One-click List-Unsubscribe headers plus a single unsubscribe page, no login, no extra info required. Met.
6. **Honor opt-outs fast, keep the mechanism live, charge nothing.** The rule is within 10 business days, with the mechanism working at least 30 days, no fee, no info beyond an email address. Ours suppresses **immediately** on click, the token link works indefinitely, and it asks for nothing. Exceeds the requirement.
7. **You are responsible for mail sent on your behalf.** This is the SalesWyze point: because you send for the customer, both of you can be held liable. The customer-authorization and indemnification structure above is exactly the right response, but it shares the risk, it does not remove your obligation to keep the platform itself compliant. Keep suppression, addressing, and unsubscribe correct on your side regardless of what the customer approves.

Net: four requirements clearly met, one exceeded, one owned by the customer, and one (ad identification) worth a quick legal read for your specific list. No urgent code gap on the email side.

### SMS and voice (federal TCPA, plus the Telemarketing Sales Rule) — the high-risk area

- **Prior express consent**, in writing for marketing texts. Do not text a cold list. Text people who gave you their number, and keep the record that proves they did.
- **STOP and HELP honored automatically and instantly**, with the number suppressed permanently.
- **Time-of-day limits** (roughly 8am to 9pm in the recipient's local time), identification of who is texting, and 10DLC brand and campaign registration per customer.
- Penalties are per message, so this is the one place where careless equals expensive.

### The state patchwork — where "all states" actually lives

Two separate bodies of state law apply, and both are growing.

- **State comprehensive privacy laws.** California's CCPA and CPRA started it, and roughly twenty states now have their own (Virginia, Colorado, Connecticut, Utah, Texas, Oregon, Montana, and more, with new ones most years). They give people the right to know, access, delete, and opt out, and they require a real privacy policy, honoring deletion requests, data minimization, and in several states honoring a browser-level opt-out signal. The controls this demands: a working data-deletion path, a retention policy, a privacy policy, and a way to log and fulfill a request.
- **State mini-TCPA and telemarketing laws.** Several states go beyond the federal floor. Florida's FTSA is the one that reshaped the industry: stricter consent, a private right of action, and a wave of lawsuits behind it. Others (Oklahoma, Washington, and more) have their own rules. The safe posture is to meet the strictest state you operate in, not the federal minimum, and to let counsel confirm the list.

### Data rights and documents

- **A deletion path — ✅ shipped 2026-07-30.** `src/lib/dataDeletion.js` deletes a lead's activity/tracking records, anonymizes (rather than deletes) their orders to preserve revenue/commission history, and suppresses their email so a later import can't recreate them. Tenant-scoped and transactional — verified it refuses to touch another tenant's lead.
- **A retention policy** — still open. No concrete retention period is set per data category yet; the draft privacy policy below flags this as the main open item before it can be published.
- **The paperwork — drafted, not final.** `PRIVACY_POLICY_DRAFT.md`, `TERMS_OF_SERVICE_DRAFT.md`, and `DATA_PROCESSING_AGREEMENT_DRAFT.md` now exist at the repo root, grounded in what the product actually does (CAN-SPAM footer, unsubscribe, the deletion path, the audit log). Each is clearly marked DRAFT / NOT LEGAL ADVICE and lists its own open items (retention periods, which state laws apply, sub-processor list, SMS/TCPA terms once Phase 1.5 ships). **Do not publish any of the three without a lawyer's review.**

### Where the controls land by phase

| Control | Phase |
|---|---|
| Email CAN-SPAM footer, unsubscribe | done |
| Verbiage-approval step and record | Phase 1 (managed), reused everywhere |
| SMS consent capture, STOP/HELP, time limits, 10DLC | Phase 1.5 (SMS) |
| Consent record per contact | Phase 1.5, and Phase 2 for self-serve |
| Data deletion path, retention policy | Phase 3 (do before you have many customers' data) |
| Privacy policy, terms, DPA, indemnification | before the first non-SureSecured customer signs |
| Counsel review of multi-state SMS | before SMS goes live beyond a pilot |

**The one hard rule:** do not turn on broad SMS until a lawyer has looked at your consent flow and your state coverage. Email you can grow carefully on your own judgment. SMS you should not.

---

## What's next now that Phases 0-2 are shipped

1. **Add your Stripe price IDs** (env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MANAGED`, `STRIPE_PRICE_DIY`, `STRIPE_PRICE_DIY_SETUP`, `STRIPE_PRICE_SELF_SERVE`) once your Stripe account and products exist — that's the only thing standing between the billing scaffold and a real, working checkout flow.
2. **Wait out 10DLC approval** for the Telnyx number you already have (3-7 days) — outbound SMS is gated on it, but everything else (inbound replies, STOP/HELP, the sequence editor's SMS steps) works today.
3. **Connect the support@saleswyze.com mailbox** (Settings → Email) so the platform's own mail — the audit email — actually sends from that address instead of degrading to whichever mailbox is connected as the fallback.
4. **Connect a seed inbox per tenant** (Settings → Email → Deliverability seed inbox) to start getting real spam/inbox placement data — the canary is inert with no signal until an address is connected.
5. Self-serve onboarding (sign up → connect sender → import list → launch, unassisted) and metering/fair-use are the two pieces of Phase 2 still worth building, once there's a real Stripe account to build them against.

Everything after that is a straight line you can walk one shippable step at a time.

---

## The honest scope note

This is a real build, not a weekend. But it is manageable because it is ordered and each phase pays for itself. The two phases that carry weight are Phase 0 (isolation) and Phase 2 (billing). Everything else is small, independent, and mostly reuses plumbing that already exists. You do not need to hold the whole thing in your head. You need to do Phase 0 carefully, then follow the map.
