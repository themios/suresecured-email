# SalesWyze Build Plan

**Date:** 2026-07-30
**Goal:** turn a working single-tenant app into a multi-tenant product that can safely sell all three offers (pay-on-close, managed, self-serve), without boiling the ocean.

---

## The one idea that makes this manageable

Do not build the whole platform before you sell anything. Build in phases where **each phase ends in something new you can sell**, and each phase unlocks the next. You are already earning today with SureSecured. The plan below adds a second paying customer as fast as safely possible, then widens.

There is exactly one hard gate before any second customer, managed or self-serve: **tenant isolation**. Everything else can be sequenced behind it.

---

## The thing that makes SalesWyze unique

Every competitor sends mail and hopes. Reactivation vendors do a one-time blast. Cold email agencies charge $2,500 to $12,000 and disappear behind a dashboard. Platforms like GoHighLevel hand you a tool and wish you luck on deliverability.

Your edge is **proven delivery for trades**. Not "we sent it." "We watched it land, and here is the reply." Three things nobody else combines:

1. **It sends from a real inbox and sounds like a person**, so it actually gets read.
2. **A seed canary proves the mail reaches the inbox**, not spam, every day, automatically. You catch a delivery problem before the customer notices their replies dried up.
3. **You only win when they win** (pay-on-close), or you watch it for them (managed). The incentive is honest.

Lead the brand with that. "Reactivation that actually lands." It is a claim your competitors cannot make and your product can prove.

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
   │  → sell pay-on-close +$499 │              └───────────────────────────┘
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

## Phase 0 — Foundation (the gate)

**Why first:** the moment a second business has a login, they share one database with SureSecured. Today the queries are not all scoped, so tenant B could see tenant A's leads, revenue, and customer emails. You cannot sell to anyone, managed or self-serve, until this is closed. It is also the "runs itself" promise: if the automation does not actually run, the product is a demo.

**Work items:**
1. **Tenant-scope every query.** Add `WHERE client_id = $1` across `analytics.js`, `api.js`, `leads.js`, and audit the rest. Pick one enforcement mechanism so the next new route cannot forget: a `tenantQuery(req)` helper plus a lint rule that bans raw `pool.query` in route files. (Postgres row-level security is the stronger long-term answer; the helper is the fast, shippable one.)
2. **Convert the global unique indexes** to `(client_id, column)` composites, and rewrite the roughly ten `ON CONFLICT` call sites in the same change. This was deliberately deferred in migration 015 because doing it half-way breaks unsubscribe and order intake. Do it whole, now, while there is one tenant and no conflicting data.
3. **A two-tenant isolation test suite.** Create two tenants, seed both, assert every list and report returns only its own rows. Without this, the first new route regresses the fix silently.
4. **Turn the automation on.** Four of five scheduled jobs never fire (`poll-email-sources`, `score-leads`, `run-agents`, `daily-digest`). Wire them into the real scheduler and verify each runs. `poll-email-sources` is the "captures new customers" feature, so it matters most.

**What you can sell after:** nothing new yet, but you are now safe to add a second customer. This is the unlock, not the product.

**Rough size:** the biggest single phase. The query scoping and index conversion are the bulk. Call it the one you do carefully and do not rush.

---

## Phase 1 — Managed tier live (fastest to new revenue)

**Why here:** the managed and pay-on-close offers are delivered by hand, so they do not need billing or self-serve onboarding. Once isolation is done, this is a short hop to a second paying client.

**Work items:**
1. **Per-tenant sending that scales past Gmail's cap.** Today sending runs through one Gmail account, capped near 500 a day, and Railway blocks SMTP. Each client needs their own sending identity: their own Google Workspace connected by OAuth (the connect flow already exists), or an API-based ESP per tenant. Decide the default and make onboarding a client include connecting their sender.
2. **The seed canary.** A monitored seed address per tenant, added to each campaign. A daily check reads the seed inbox via the Gmail API (plumbing you already use for reply detection) and records: did it arrive, which folder (inbox, spam, promotions), how long it took. Feed the result into the sending-health banner and `/undelivered`. This is the differentiator and the managed-tier value in one feature.
3. **A light client-health view for you.** One screen across all managed clients: are their sends landing, any bounces climbing, any mailbox that stopped authenticating. This is the "we watch it so you never have to" that justifies the $499.

**What you can sell after:** pay-on-close and $499 managed, to real clients beyond SureSecured, with a delivery guarantee you can actually back.

**Rough size:** medium. The seed canary reuses existing Gmail plumbing. Per-tenant sending is mostly onboarding flow plus a decision on the default sender.

---

## Phase 1.5 — SMS as a second channel

**Why here:** the offer already promises phone follow up, and omnichannel is where the money is. Email-only agencies charge $1,000 to $5,000 a month; add phone and it is $5,000 to $15,000. SMS gets read fast and closes warm replies. But it carries compliance weight email does not, so it earns its own phase and sits just after email is solid.

**The parts that already exist:** Telnyx is integrated (inbound webhook, send function), `sequence_steps` already has a `channel` column, and there is a per-tenant voice extension. The plumbing is partly there. What is missing is the campaign layer and the compliance layer.

**Work items:**
1. **Per-tenant phone number.** Each client texts from their own Telnyx number, not a shared one. Buy and assign on onboarding.
2. **10DLC registration per client.** US carriers block business SMS until the brand and campaign are registered, a 3 to 7 day approval. This is an external gate, so start it early in a client's onboarding and let it run in the background while email goes live.
3. **SMS steps inside sequences.** Let a sequence mix email and text touches on one timeline, using the `channel` column that already exists. A text nudge after an unopened email, a text to confirm a booked call.
4. **Consent and opt-out, done right.** This is the legal core. Texting for business needs prior express consent, and a STOP request has to suppress the number instantly and permanently. A past customer who gave you their number for a job is on firmer ground than a cold lead who never did. Build the opt-out handling into the inbound webhook, honor STOP and HELP automatically, and keep a consent record per contact. Lead with email, and let people opt into text by replying.
5. **Delivery receipts and monitoring.** Telnyx returns delivery status per message. Record it the same way email sends are recorded, so a text that fails to deliver shows up on the health view, not silently.
6. **Metering.** SMS has a real per-message cost (about $0.008 a segment) plus the 10DLC fees. Meter it per tenant and mark it up, the same as email sends and verification in Phase 2.

**What you can sell after:** the omnichannel version of managed and pay-on-close, which is the tier the expensive agencies charge the most for. It roughly doubles the value of the offer.

**Rough size:** medium, but front-loaded by the 10DLC approval wait, which is calendar time, not work time. Do the code while the registration clears.

**The honest compliance note:** SMS is the one place where getting it wrong is expensive in a legal sense, not just a deliverability sense. TCPA penalties are per message. Do not text a cold list. Text people who gave you their number, honor every STOP instantly, and keep the consent record. Handled that way it is a powerful channel. Handled carelessly it is a lawsuit.

---

## Phase 2 — Self-serve tier live ($199)

**Why here:** self-serve is the scale tier, but it is the most build. It needs a customer to sign up, pay, connect sending, import a list, and launch without you touching anything.

**Work items:**
1. **Billing.** Stripe. Plans, subscriptions, and the seat model. Card handling and the plan gate that enforces limits.
2. **Metering and fair use.** From the pricing work: unlimited contacts, but a monthly send allowance with metered overage, so one heavy sender does not eat the margin or the sender reputation. Track usage per tenant.
3. **Self-serve onboarding.** Sign up, connect your own sending, upload and verify a list, pick or generate a sequence, launch. The parts exist in pieces; this stitches them into a flow a stranger can complete alone.
4. **Verification as a metered add-on.** Integrate MillionVerifier (cheaper than the current ZeroBounce), resell at a markup, count usage per tenant. This is the "bill for scrubbing" idea, and it only makes sense once billing exists.

**What you can sell after:** $199 self-serve, and the business stops being capped by your team's hours.

**Rough size:** the second-biggest phase, mostly billing and onboarding.

---

## Phase 3 — Trust and scale (runs alongside)

**Why:** not blockers for the first few clients, but they become real as you grow and as bigger clients ask harder questions.

**Work items, roughly in order of when they bite:**
1. **Audit log.** Append-only record of logins and state changes (commissions, leads, tenant edits). Needed for disputes and for any client who asks a security question.
2. **A real migration runner and tested backups.** Migrations currently run in-process with no version table and no lock; restoring a backup and booting has failed before. Add a `schema_migrations` table with an advisory lock, and run one timed restore drill.
3. **Security hardening from the launch review.** Webhook replay protection, global error and process handlers, wider rate-limit coverage, and vendoring Tailwind locally so the login and dashboards stop loading it from a CDN with CSP disabled.

**What you can sell after:** nothing new, but you can keep and defend the customers Phase 1 and 2 brought in.

**Rough size:** several small independent items you can pick off between phases.

---

## What I would do first

1. **Phase 0, item 1 and 3 together:** the `tenantQuery` helper and the two-tenant isolation test suite, because the test suite is what keeps the fix from rotting. This is the single highest-leverage thing in the whole plan.
2. **Phase 0, item 4:** turn the four dead jobs on and verify, because "it captures customers and runs itself" has to be true before you sell it.
3. Then the index conversion, then Phase 1's seed canary, which is the feature that makes the brand promise real.

Everything after that is a straight line you can walk one shippable step at a time.

---

## The honest scope note

This is a real build, not a weekend. But it is manageable because it is ordered and each phase pays for itself. The two phases that carry weight are Phase 0 (isolation) and Phase 2 (billing). Everything else is small, independent, and mostly reuses plumbing that already exists. You do not need to hold the whole thing in your head. You need to do Phase 0 carefully, then follow the map.
