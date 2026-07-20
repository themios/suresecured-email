# Launch Readiness Review — SalesPilot / SureSecured

**Date:** 2026-07-20
**Branch:** master @ bce166e
**Scope:** Full sweep. 24 routes, 4 middleware, ~30 libs, 14 migrations, cron/background jobs.
**Verdict:** **NOT READY TO LAUNCH MULTI-TENANT.** 10 P0 blockers, 18 P1.

---

## Verdict in one paragraph

The single-tenant version of this app is in decent shape: webhook HMAC verification is real, the Google OAuth login flow is properly nonce-bound, GCM encryption is correctly implemented, and the commission/attribution logic has tests. But the multi-tenant layer is a column, not a boundary. `client_id` was added to 17 tables by migration 001 and then inconsistently applied at the query layer. Roughly 40% of queries carry no tenant predicate. Two of the biggest read surfaces — `/analytics/data` and `/api/stats` — are fully global. There is a privilege-escalation chain that lets a tenant self-promote to reading and editing every other tenant. There is no audit log, no billing enforcement, and no backup story. Fix the P0 list before any second tenant touches this system.

---

## Architecture: where the tenant boundary actually lives

```
                      ┌─────────────────────────────────────────┐
                      │  REQUEST                                │
                      └────────────────┬────────────────────────┘
                                       │
         ┌─────────────────────────────┼─────────────────────────────┐
         │                             │                             │
    ┌────▼─────┐               ┌───────▼────────┐            ┌───────▼───────┐
    │ requireAuth│             │ requireSpAuth  │            │ requireClient │
    │ (JWT only) │             │ (JWT + DB re-  │            │ ApiKey        │
    │            │             │  check, active)│            │               │
    └────┬───────┘             └───────┬────────┘            └───────┬───────┘
         │                             │                             │
   req.user.client_id            req.salesperson             req.apiClientId
   from TOKEN (7d stale)         .client_id (fresh)          (SET, NEVER USED)
         │                             │                             │
         ▼                             ▼                             ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  QUERY LAYER — tenant predicate applied by convention, not by force  │
   ├──────────────────────────────────────────────────────────────────────┤
   │  settings.js   28/36  ████████░░  mostly scoped                      │
   │  cron.js       33/44  ███████░░░  mostly scoped                      │
   │  webhook.js     8/7   ██████████  scoped                             │
   │  activity.js   11/16  ███████░░░  mostly scoped                      │
   │  portal.js      4/11  ████░░░░░░  partial                            │
   │  sequences.js   6/34  ██░░░░░░░░  mostly UNSCOPED                    │
   │  admin.js       7/29  ██░░░░░░░░  mostly UNSCOPED                    │
   │  dashboard.js   4/10  ████░░░░░░  partial                            │
   │  leads.js       1/26  ░░░░░░░░░░  UNSCOPED  ← P0                     │
   │  analytics.js   0/10  ░░░░░░░░░░  UNSCOPED  ← P0                     │
   │  api.js         0/13  ░░░░░░░░░░  UNSCOPED  ← P0                     │
   └──────────────────────────────────────────────────────────────────────┘

   No RLS. No query-builder enforcement. No default-deny.
   Tenant isolation = every developer remembering, every time, forever.
```

That last line is the root cause. Everything in the P0 list below is a symptom of it.

---

## P0 — Launch blockers

### P0-1. `/analytics/data` returns every tenant's data to any logged-in user
[src/routes/analytics.js:8-110](src/routes/analytics.js#L8-L110)

Ten queries, zero `client_id` predicates. Guarded by `requireAuth` only — any authenticated user of any tenant. Returns cross-tenant revenue by day, clicks, calls, form submissions, commission-by-salesperson, funnel counts, audience split, top products, and goal-vs-actual.

```js
// analytics.js:38 — no tenant filter
SELECT DATE(ordered_at) AS date, COALESCE(SUM(amount),0) AS revenue
FROM orders WHERE ordered_at >= NOW() - ($1::integer * INTERVAL '1 day')
```

Worse, `salespeople` at line 110 is fetched globally and rendered into the filter dropdown, so tenant A's UI literally lists tenant B's staff by name. And the `?sp=` filter accepts any salesperson id with no ownership check, so tenant A can pull tenant B's individual rep performance on demand.

**Fix:** add `AND client_id = $n` to all ten. Scope the salespeople dropdown. Validate `?sp=` belongs to `req.user.client_id`.

---

### P0-2. `/api/stats` is global and reachable by any tenant admin
[src/routes/api.js:99-140](src/routes/api.js#L99-L140)

Three queries, no tenant predicate. Returns every salesperson across every tenant with revenue and commission totals, plus the 20 most recent orders and 20 most recent form submissions system-wide — including `submitter_email`, `customer_email`, and full `raw_data` / `order_data` JSONB blobs.

This is the highest-value PII leak in the codebase. `SELECT o.*` and `SELECT fs.*` mean any future column is auto-exposed too.

---

### P0-3. Privilege escalation: any tenant `admin` can read and edit all tenants

`requireAdminAuth` accepts `['operator', 'owner', 'admin']` ([apiAuth.js:5](src/middleware/apiAuth.js#L5)). The tenant-management routes are gated on that alone:

```
admin.js:790  GET  /admin/clients            requireAdminAuth        ← lists ALL tenants
admin.js:857  POST /admin/clients            requireAdminAuth        ← creates tenants
admin.js:898  GET  /admin/clients/:id/edit   requireAdminAuth        ← ANY tenant
admin.js:913  POST /admin/clients/:id        requireAdminAuth        ← edits ANY tenant
```

Compare to [admin.js:1001](src/routes/admin.js#L1001) and [admin.js:1073](src/routes/admin.js#L1073), where `/agency` correctly adds `requireRole('operator','owner')`. The tenant CRUD routes were missed. `admin` is a *tenant-level* role, so every customer admin is effectively a platform operator.

**Now chain it with P0-4.**

---

### P0-4. Domain auto-join grants arbitrary roles, with no public-domain blocklist
[migrations/013_auth_domains.sql:12-13](migrations/013_auth_domains.sql#L12-L13), [src/routes/auth.js:36-59](src/routes/auth.js#L36-L59)

`client_auth_domains.default_role` allows `'operator'`, `'owner'`, `'admin'`. Anyone who can add a domain row can mint platform-level accounts. And nothing rejects public domains:

```
Tenant registers domain "gmail.com" with default_role='admin'
  → any Google user on earth signs in
  → auto-provisioned as admin
  → GET /admin/clients (P0-3)
  → reads and edits every tenant on the platform
```

`UNIQUE(domain)` means the first tenant to claim `gmail.com` also permanently blocks every other tenant's Gmail users from auto-join. The settings UI at [settings.js:583](src/routes/settings.js#L583) advertises this as "anyone with an email on these domains ... automatically get a seat."

**Fix:** hard-block public mailbox providers; cap `default_role` to `'salesperson'`; require domain-ownership verification (DNS TXT) before activation.

---

### P0-5. Lead IDOR — read and write across tenants by id
[src/routes/leads.js:204-256](src/routes/leads.js#L204-L256), [leads.js:703-772](src/routes/leads.js#L703-L772)

`GET /leads/:id` fetches `WHERE l.id = $1` with no tenant predicate, then joins in the full activity history: contact enrollments, email sends, call logs, SMS, notes, suppression status. Every mutation has the same hole:

```js
leads.js:707  UPDATE leads SET stage = $1 WHERE id = $2              // any tenant's lead
leads.js:734  UPDATE contact_enrollments SET status='paused' WHERE id = $1
leads.js:762  UPDATE contact_enrollments SET status='cancelled' WHERE id = $1
leads.js:772  DELETE FROM suppression_list WHERE LOWER(email) = ...  // global delete
```

Lead ids are sequential integers. Enumeration is trivial.

---

### P0-6. Silent fallback to tenant #1
[src/routes/leads.js:788-790](src/routes/leads.js#L788-L790)

```js
let clientId = req.user?.client_id;
if (!clientId) {
  const { rows: cr } = await pool.query('SELECT id FROM clients ORDER BY id LIMIT 1');
  clientId = cr[0]?.id;   // ← attributes work to whoever registered first
}
```

Any user with a null `client_id` (platform operators, legacy rows, the seeded `operator@suresecured.com` which is inserted with no `client_id` at [auth.js:262](src/routes/auth.js#L262)) writes into your oldest customer's account. This pattern should not exist; a missing tenant must be a 500, never a guess.

---

### P0-7. Gmail ingestion is hard-wired to one tenant
[src/routes/cron.js:38-48](src/routes/cron.js#L38-L48)

```sql
FROM email_accounts ea
CROSS JOIN (
  SELECT cec2.* FROM client_email_config cec2
  WHERE cec2.inbound_capture_enabled = true
  ORDER BY cec2.client_id LIMIT 1      -- ← ONE config for EVERYONE
) cec
WHERE ea.enabled = true
```

The `CROSS JOIN ... LIMIT 1` binds *every* tenant's connected Gmail account to the *lowest-numbered* tenant's inbound config. Consequences: leads captured from tenant B's inbox are written with tenant A's `client_id` and enrolled into tenant A's `inbound_sequence_id`; `inbound_last_check_at` is a single shared cursor, so tenants race each other and drop messages; and if tenant A disables inbound capture, ingestion silently stops for everyone.

This needs to be a join on `ea.client_id = cec.client_id`, plus a per-account cursor.

---

### P0-8. Global unique indexes make a second tenant impossible
[migrations/006_voice.sql:60](migrations/006_voice.sql#L60), [src/db.js](src/db.js)

```sql
CREATE UNIQUE INDEX idx_leads_phone ON leads(phone);   -- across ALL tenants
```

Plus `users.email UNIQUE`, `salespeople.email UNIQUE`, `orders.shopify_order_id UNIQUE`.

If tenant A has a lead with phone `+15551234567`, tenant B's insert of that same number **fails**. Same person, two dealerships, one row. In auto and home-services verticals, shared prospects are the norm, not the exception. Every one of these needs to become `UNIQUE(client_id, <col>)`.

Related: `salespeople.email UNIQUE` means one human cannot work at two tenants, and `users.email UNIQUE` combined with `ON CONFLICT (email) DO NOTHING` in `provisionByDomain` means a user already in tenant A silently fails to provision into tenant B.

---

### P0-9. No audit logging. At all.

A grep for `audit` across `src/` returns two hits, both marketing copy. There is no record of who logged in, who changed a commission rate, who reassigned a lead, who created or edited a tenant, who exported data, or who connected a Gmail account.

For a system that computes commission payouts and holds customer PII, this is disqualifying on three fronts: you cannot investigate a dispute, you cannot detect the P0-3 escalation if it is used, and you cannot satisfy any enterprise security questionnaire.

**Minimum:** append-only `audit_log(id, client_id, actor_user_id, actor_ip, action, entity_type, entity_id, before, after, created_at)`, written on every state change in admin/settings/leads/sequences, and on every auth event.

---

### P0-10. Billing does not exist
Grep for `stripe|billing|subscription|plan_tier|seat` returns nothing but Shopify `billing_address` fields and marketing copy.

There is no plan model, no seat counting, no usage metering, no enforcement anywhere. `client_auth_domains` hands out unlimited seats by design. The AI agent system ([lib/agents/costs.js](src/lib/agents/costs.js)) tracks OpenRouter spend but the header comment says explicitly "not billing," and nothing caps it — a tenant can run up unbounded model spend on your account.

If launch means "charge money," this is a from-scratch build, not a fix.

---

### P0-11. The application cannot start against an empty database
[migrations/001_add_tenancy.sql:56](migrations/001_add_tenancy.sql#L56), [src/db.js](src/db.js)

*Found by execution, not by reading.* Migration 001's `DO` block checks whether the **column** `client_id` exists, but never whether the **table** does:

```sql
EXECUTE format('ALTER TABLE %I ADD COLUMN client_id ...', tbl);
-- tbl = 'salespeople', which db.js does not create until AFTER all migrations run
```

Against a fresh database this aborts on the first migration. Verified: `initDb()` fails with `relation "salespeople" does not exist`, and because the file executes as one implicit transaction, **zero tables are created** — even `clients`, which 001 successfully created moments earlier, is rolled back.

The dependency is circular, so no simple reordering fixes it:

```
migration 001  ──needs──>  salespeople, leads, orders, ...   (created by db.js inline SQL)
db.js inline   ──needs──>  clients                           (created by migration 001)
```

Production works only because those tables were created under an older code ordering and have persisted since. Consequences:

- **Disaster recovery does not work.** Restoring a schema-less database and booting the app fails. The "no backups" finding is worse than stated: even with a backup, the app cannot bootstrap.
- No staging or dev environment can be created.
- Blocks a CI integration-test harness, which is how this was found.

**Fix:** split `initDb()` into three phases — base tables that don't reference `clients`, then migrations, then the two tables that do (`client_email_config`, `platform_leads`). Migration 015 demonstrates the defensive pattern: every statement guarded by `to_regclass(...) IS NOT NULL`, so it no-ops on a fresh database instead of aborting the boot.

---

### P0-12. Send failures were recorded without a reason — nothing was delivered for days
[src/lib/gmail.js:431](src/lib/gmail.js#L431)

*Found by execution.* `sendSequenceEmail()` caught every send error but only persisted the message when `isPermanentBounce(msg)` was true. Every other class — SMTP auth rejection, unreachable host, TLS failure, quota, unverified From alias — was written as `status='failed'` with `bounce_error` NULL.

Production state when reviewed: 10 sends to the operator's own test address, all `status='failed'`, all with no reason. Direct diagnosis against the configured mailbox returned:

```
535 Authentication credentials invalid   (EAUTH)
smtp.ionos.com:587  user=sales@suresecured.com
```

The IONOS password was wrong. Every send had been failing at authentication for days. The operator could see sends "happening" and no replies arriving, with nothing connecting the two, and had already shipped two commits trying to surface the reason.

Two secondary bugs made it undiagnosable:
- `getAuthedClient()` sets `email_accounts.last_error = NULL` on every successful token refresh ([gmail.js:138](src/lib/gmail.js#L138)), and the cron refreshes every 15 minutes — so the error was wiped before anyone could read it.
- `client_email_config.last_error` and `last_tested_at` existed but nothing ever wrote to them. `last_tested_at` was NULL in production while every send failed.

**Fixed** in migration 016 + `classifySendFailure()`: every failure class is persisted with a reason, identity-level failures (`auth`/`connection`/`config`) escalate to the tenant with a `consecutive_failures` counter, and a success resets the counter and the alert gate. 11 tests cover the classifier, including the verbatim IONOS string.

---

## P1 — Fix before or immediately after launch

### Error handling

**P1-1. No global error handler and no 404 handler.** [src/index.js](src/index.js) ends at the `/health` route. Express 5's default handler will serve stack traces when `NODE_ENV !== 'production'`, and every unhandled route falls through to a bare 404. Add `app.use((err, req, res, next) => ...)` that logs with a request id and returns an opaque body.

**P1-2. No `unhandledRejection` / `uncaughtException` handlers.** Async throws inside the cron scheduler and the agent runner will terminate the process. Railway restarts it, but any in-flight sequence batch is lost with no record of where it stopped.

**P1-3. Inconsistent error disclosure.** ~50 `catch` blocks `console.error` the raw error then return a generic 500 — good. But `res.redirect('/login?error=1')` on a DB failure ([auth.js:157](src/routes/auth.js#L157)) tells the user "invalid password" when the database is down.

### Rate limits

**P1-4. Rate limiter is in-memory and resets globally.** [src/middleware/rateLimit.js:11](src/middleware/rateLimit.js#L11) does `setInterval(() => buckets.clear(), windowMs)` — a fixed window that flushes *all* buckets simultaneously. An attacker gets `2 × max` in a burst straddling the boundary. It also does not survive a restart and does not work across instances, so the moment you scale past one Railway container the login limiter is effectively `max × N`.

**P1-5. `leadFormLimiter` is exported but never applied.** [rateLimit.js:26](src/middleware/rateLimit.js#L26) defines it; nothing imports it. `POST /get-started` on the public marketing site is unthrottled.

**P1-6. Only 4 paths are rate-limited.** `/login`, `/portal/login`, `/api`, `/cron`. Not limited: `/webhooks/*`, `/retell-hooks/*`, `/telnyx-hooks/*`, `/unsubscribe`, `/r/:token`, `/pixel`, `/e`. The tracking endpoints are unauthenticated and write a DB row per request.

### Webhooks

**P1-7. Zero replay protection on any webhook.** Shopify, Retell, CallRail, and Telnyx all verify a signature but none check freshness or dedupe by event id. A captured `POST /webhooks/shopify/order` replays forever and re-triggers commission calculation each time. Retell's HMAC covers no timestamp at all. Telnyx signs `${timestamp}|${body}` but [webhookVerify.js:68](src/lib/webhookVerify.js#L68) never validates that the timestamp is recent.

**Fix:** reject timestamps outside ±5 min, and add a `webhook_events(provider, event_id)` unique table checked before processing.

**P1-8. Signature verification silently downgrades to a bearer token.** [webhookVerify.js:47-52](src/lib/webhookVerify.js#L47-L52) and [:53-60](src/lib/webhookVerify.js#L53-L60): if `TELNYX_WEBHOOK_SECRET` or `RETELL_WEBHOOK_SECRET` is set, a static bearer string is accepted *instead of* the cryptographic signature. That secret sits in env, logs, and dashboards. Make signature verification mandatory in production.

**P1-9. `rawBodyString` fails open.** [webhookVerify.js:27](src/lib/webhookVerify.js#L27) falls back to `JSON.stringify(req.body || {})` when the raw buffer is missing. Re-serialized JSON will not byte-match the original for any non-trivial payload, so this does not actually verify — it just produces a confusing mismatch. It should throw.

**P1-10. Telnyx inbound SMS picks an arbitrary tenant's lead.** [telnyx.js:37-40](src/routes/telnyx.js#L37-L40): `SELECT id, client_id FROM leads WHERE phone = $1 LIMIT 1`. Once P0-8 is fixed and phone numbers can repeat across tenants, this routes an inbound reply to whichever tenant's row sorts first. Route by the *destination* number (`toNumber`) to the owning tenant instead.

### Auth / session

**P1-11. JWT carries `role` and `client_id` with a 7-day TTL and no revocation.** [auth.js:12-29](src/routes/auth.js#L12-L29). Deactivating a user, demoting them, or moving them between tenants has no effect for up to a week. `requireAuth` never touches the DB — note that `requireSpAuth` ([spAuth.js:12](src/middleware/spAuth.js#L12)) *does* re-check `active = true`, so the correct pattern already exists in the codebase and just wasn't applied to the main session. Shorten to ~1h with a refresh, or re-check the user row per request.

**P1-12. No CSRF protection anywhere.** `sameSite: 'lax'` blocks cross-site POSTs from forms, which covers most of it, but there is no token on any state-changing route and several are `GET` (`/auth/logout`, `/logout`). Add tokens to the admin/settings mutations.

**P1-13. Email case handling is inconsistent across three paths.** Password login: `WHERE email = $1` (exact). Google login: `WHERE LOWER(email) = $1`. Provisioning inserts the raw string. `Tim@acme.com` and `tim@acme.com` become distinct rows that behave differently depending on how you sign in.

**P1-14. `provisionByDomain` inserts `password_hash = ''`.** [auth.js:47](src/routes/auth.js#L47). `bcrypt.compare(pw, '')` returns false, so this is currently safe — but it is one refactor away from being a bypass. Use `NULL` and explicitly reject null-hash rows in the password path.

**P1-15. `CLIENT_API_KEY` env is a global master key.** [apiAuth.js:26-29](src/middleware/apiAuth.js#L26-L29) sets `req.apiClientId = null` and calls `next()`, bypassing per-tenant key lookup entirely. Combined with P1-16, this means one leaked env var writes to any tenant.

**P1-16. `req.apiClientId` is set and then never used.** [api.js:16-36](src/routes/api.js#L16-L36): `/api/form-submission` authenticates the client key, resolves the client id, then inserts a row without it. Same for `/api/leads`, `/api/salespeople`, `/api/generate-links` — all accept `salesperson_id` and `lead_id` straight from the request body with no ownership check, so a valid key for tenant A can attach records to tenant B's salespeople.

### Data / PII

**P1-17. Encryption is optional and fails silently to plaintext.** [lib/crypto.js:45-48](src/lib/crypto.js#L45-L48): `maybeEncrypt` returns plaintext when `ENCRYPTION_KEY` is unset. The GCM implementation itself is correct (random 12-byte IV, auth tag, proper framing) — the problem is that a deploy missing one env var stores Gmail OAuth refresh tokens and API secrets in the clear with no warning and no alert. Fail startup in production instead. Note `.env` and `YOUR_RAILWAY_VARS.txt` are both present in the working tree — confirm neither is committed.

**P1-18. Suppression list is global, unsubscribe leaks across tenants.** [unsubscribe.js:7-22](src/routes/unsubscribe.js#L7-L22): `suppression_list` has no `client_id`, and `UPDATE leads SET unsubscribed = true WHERE LOWER(email) = LOWER($1)` hits every tenant's copy of that person. Unsubscribing from dealership A silently kills dealership B's ability to email the same customer. Legally you may want a global "do not contact," but it must be a deliberate, documented choice — right now it is an accident of a missing column. The unsubscribe page also hardcodes SureSecured branding and `info@suresecured.com` for every tenant.

**P1-19. No retention policy, no deletion path, no DSAR support.** Nothing implements "delete this person's data." `ON DELETE SET NULL` on every `client_id` FK ([001_add_tenancy.sql:53](migrations/001_add_tenancy.sql#L53)) means deleting a tenant *orphans* its rows into a `client_id IS NULL` bucket that the unscoped queries in P0-1 and P0-2 will then happily show to everyone. Should be `ON DELETE CASCADE` or `RESTRICT`.

**P1-20. Full request payloads stored unbounded.** `raw_data JSONB`, `order_data JSONB`, and Retell call transcripts are persisted verbatim with no redaction and no TTL.

### Migrations

**P1-21. Migrations run in-process on every boot with no lock and no version table.** [db.js:23-115](src/db.js#L23-L115) reads 13 `.sql` files and executes them sequentially inside `initDb()`, then runs ~300 lines of inline `CREATE TABLE IF NOT EXISTS`. Problems: two instances booting concurrently race on the same DDL; a failure mid-way leaves a partial schema with no record of how far it got; there is no `schema_migrations` table, so "which migrations has prod run" is unanswerable; there are no down migrations; and a slow `ALTER TABLE` blocks the health check and Railway kills the deploy.

**P1-22. Migration 004 is missing from the sequence.** Files run 001, 002, 003, **005**, 006... Either it was deleted after being applied to prod (in which case a fresh environment builds a different schema than production) or the numbering just skipped. Nobody can tell which, because of P1-21. Resolve before the next environment is created.

**P1-23. Schema is defined in two places.** Migrations own some tables; `db.js` inline SQL owns `salespeople`, `leads`, `tracking_tokens`, `clicks`, `form_submissions`, `orders`, `commissions`, `admin_users` and more. `leads` is created in `db.js` but altered by four different migrations. There is no single source of truth for the schema.

### Background jobs

**P1-24. ~~Duplicate cron~~ — CORRECTED. Four of five scheduled jobs never run at all.**

*Original finding was wrong.* I claimed the in-process `node-cron` in [index.js:130](src/index.js#L130) duplicated the `[[cron]]` blocks in [railway.toml](railway.toml), causing double sends. Verified against production logs: `[cron] send-sequences` fires exactly **once** per 15-minute window. There is no duplication.

The actual problem is the inverse and worse. `[[cron]]` **is not a valid Railway config key.** Railway schedules via a per-service `cronSchedule`, and a cron service runs its start command rather than serving HTTP. This project has one service (`suresecured-email`) serving HTTP, so all five `[[cron]]` blocks are inert.

`node-cron` in `index.js` schedules **only** `send-sequences`. Therefore these four jobs have never run in production:

| Job | railway.toml schedule | Actually runs? |
|---|---|---|
| `send-sequences` | `*/15 * * * *` | Yes — via node-cron |
| `daily-digest` | `0 6 * * *` | **No** |
| `score-leads` | `30 6 * * *` | **No** |
| `run-agents` | `0 7 * * 1` | **No** |
| `poll-email-sources` | `*/15 * * * *` | **No** |

Lead scoring, daily digests, the AI agent fan-out, and email-source polling are all dead code paths in production. Some are no-ops until a tenant opts in, which is why nobody noticed.

**Fix:** add the four missing schedules to the `node-cron` block, then delete the misleading `[[cron]]` blocks from railway.toml. Longer term, move to a real scheduler with locking so the service can scale past one replica — today a second replica would double-send, since `sendSequencesHandler` has no lock.

Original sub-finding still stands: if `CRON_SECRET` is unset the header becomes the literal `Bearer undefined`, `cronAuth` rejects it ([cron.js:22](src/routes/cron.js#L22)), and sending stops with only a `console.log` to show for it. `CRON_SECRET` is set in production, so this is latent.

**P1-25. No job locking.** Two instances = two concurrent `send-sequences` runs = duplicate emails to customers. There is no advisory lock, no `locked_at` column, no run table.

**P1-26. No retry, no dead-letter, no visibility.** Failures increment a local `errors` counter and are logged. There is no record of which enrollment failed or why, and no way to replay.

**P1-27. Unbounded batch.** `sendSequencesHandler` processes everything due in one pass with no `LIMIT`. A backlog after downtime produces one enormous run that will exceed Railway's request timeout.

### Performance

**P1-28. Analytics does full table scans.** No index on `orders.ordered_at`, `clicks.clicked_at`, `form_submissions.submitted_at`, or `phone_calls.called_at` — every `/analytics/data` load scans all four tables. `leads.client_id` and `leads.email` are unindexed (only the composite `(client_id, segment)` exists, which does not serve the plain `client_id` lookups these routes will need once scoped). `leads.stage` is unindexed. At 40k leads (per `All 40530 Leads.xlsx` in the repo root) this is already slow; the 10 parallel queries in `/analytics/data` will contend for the pool's 20 connections.

**P1-29. `SELECT *` in hot paths.** `SELECT o.*`, `SELECT fs.*`, `SELECT * FROM salespeople` — pulls JSONB blobs the UI never renders.

### Frontend / misc

**P1-30. Helmet CSP disabled.** [index.js:39](src/index.js#L39): `contentSecurityPolicy: false` because dashboards use inline styles. Tailwind is then loaded from `cdn.jsdelivr.net` with no SRI hash ([auth.js:88](src/routes/auth.js#L88)) — a CDN compromise executes arbitrary JS on your login page. Vendor Tailwind locally and re-enable CSP with a nonce.

**P1-31. Potential XSS in server-rendered HTML.** Routes build HTML via template literals with user-controlled values interpolated (lead names, emails, product interest). `${email}` at [unsubscribe.js:52](src/routes/unsubscribe.js#L52) comes from a signed token so it is constrained, but the leads and admin pages interpolate raw DB strings. Needs an audit for an `escapeHtml` helper on every interpolation.

---

## Backup and recovery

Nothing exists. `.github/workflows/` contains only `test.yml`. No `pg_dump`, no PITR configuration, no documented restore procedure, no tested restore, no RPO/RTO target.

Railway Postgres has backups depending on plan tier — confirm which, then **test a restore into a scratch database and time it**. An untested backup is not a backup. Given P1-21, also confirm that restoring a dump and booting the app produces a working schema.

---

## Note on your brief: there is no Twilio

You asked about Twilio SMS and voice. This codebase uses:
- **Telnyx** for SMS ([lib/telnyx.js](src/lib/telnyx.js), [routes/telnyx.js](src/routes/telnyx.js)) — Ed25519 webhook verification, 10DLC registration required before outbound works (noted in the route header).
- **Retell AI** for voice ([lib/retell.js](src/lib/retell.js), [routes/retell.js](src/routes/retell.js)) — HMAC-SHA256 webhooks.
- **CallRail** for call tracking ([routes/phonecall.js](src/routes/phonecall.js)) — shared bearer secret.

If Twilio is on the roadmap, none of it is built. If it was a mis-recollection, the findings above cover the providers you actually have.

---

## Recommended sequence

**Gate 1 — before a second tenant exists (blocks launch)**

1. P0-3 + P0-4 together. Add `requireRole('operator','owner')` to `/admin/clients*`; cap `default_role` to `salesperson`; blocklist public email domains. This is the escalation chain — close it first, it is the cheapest fix on the list.
2. P0-1, P0-2, P0-5. Add tenant predicates to analytics, api, and leads.
3. P0-6. Delete the tenant-#1 fallback, throw instead.
4. P0-7. Fix the Gmail `CROSS JOIN`.
5. P0-8. Convert global unique indexes to `(client_id, col)` composites. **Do this before you have data that conflicts** — it gets much harder later.
6. Write integration tests that assert isolation: create two tenants, seed both, and assert every list endpoint returns only its own rows. Without these, the fixes above regress the first time someone adds a route.

**Gate 2 — before charging money**

7. P0-9 audit log.
8. P0-10 billing, seats, plan enforcement, agent-spend caps.
9. P1-21/22/23 migration runner with a version table and an advisory lock; resolve the missing 004.
10. Backup verification with a timed restore drill.

**Gate 3 — hardening**

11. Webhook replay protection (P1-7/8/9).
12. Error handlers, process-level handlers, rate limit coverage (P1-1/2/4/5/6).
13. Job locking and batch limits (P1-25/27).
14. Indexes (P1-28).

---

## The structural recommendation

Fixing 40+ individual queries leaves you exactly where you started: isolation by developer discipline. The next route someone adds will forget again.

Pick one enforcement mechanism:

- **Postgres RLS** — strongest. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` with a policy on `current_setting('app.client_id')`, set via `SET LOCAL` at the start of each request's transaction. The database refuses to leak even when the query is wrong. Costs you a connection-per-request transaction wrapper.
- **A scoped query helper** — `tenantQuery(req)` that injects the predicate, plus a lint rule banning direct `pool.query` in `src/routes/`. Weaker, but far less invasive and shippable in a day.

Given the timeline pressure of a launch, the helper plus the isolation test suite is the right trade now, with RLS as the follow-up. What you cannot do is ship the current model and add tenants.

---

## GSTACK REVIEW REPORT

| Runs | Status | Findings |
|------|--------|----------|
| plan-eng-review (full sweep) | COMPLETE | 10 P0, 31 P1 |
| Tenant isolation | FAIL | P0-1,2,5,6,7,8 — 3 route files fully unscoped |
| Authn / authz | FAIL | P0-3,4 — privilege escalation chain; P1-11..16 |
| Roles / seat permissions | FAIL | `admin` is tenant-level but gates platform routes; no seat model |
| Lead ownership | FAIL | P0-5 IDOR read+write; P0-8 global phone unique |
| Gmail ingestion | FAIL | P0-7 CROSS JOIN LIMIT 1 binds all tenants to one config |
| SMS / voice (Telnyx + Retell, not Twilio) | PARTIAL | signatures verified; P1-10 tenant routing, P1-7 replay |
| Webhook auth | PASS | HMAC/Ed25519 correct, timing-safe compares |
| Webhook replay protection | FAIL | P1-7 — none on any provider |
| Audit logging | FAIL | P0-9 — does not exist |
| PII protection | PARTIAL | GCM correct; P1-17 optional key, P1-18,19,20 |
| Billing boundaries | FAIL | P0-10 — does not exist |
| DB migrations | FAIL | P1-21,22,23 — no lock, no version table, 004 missing |
| Background jobs | FAIL | P1-24..27 — no locking, silent failure, unbounded |
| Error handling | FAIL | P1-1,2 — no global or process-level handlers |
| Rate limits | PARTIAL | P1-4,5,6 — in-memory, 4 paths covered |
| Backup / recovery | FAIL | nothing exists, no tested restore |

**VERDICT: NOT READY TO LAUNCH MULTI-TENANT.** Single-tenant operation is viable today. Gate 1 (items 1-6) is the minimum to onboard a second customer. Gate 2 is the minimum to charge money.

**UNRESOLVED DECISIONS:**
- Enforcement mechanism for tenant isolation: Postgres RLS vs. scoped query helper + lint rule. Recommendation is helper-first, RLS follow-up, but this is a real architectural fork and yours to call.
- Suppression semantics: is unsubscribe global across tenants (current accidental behavior) or per-tenant? Legal and product both have opinions here.
- Migration 004: deleted after prod apply, or a numbering skip? Determines whether prod and a fresh environment currently diverge.
- Is Twilio actually planned, or was the brief referring to Telnyx/Retell?
