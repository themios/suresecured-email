# Phase 01 Research: Foundation

## What I found in the codebase

### Current schema (17 tables — all single-tenant)

From `src/db.js` `initDb()`:
1. `salespeople` — name, email, password_hash, commission_rate, active, portal_password_hash, tracking_phone_number, callrail_number_id
2. `leads` — email, first_name, last_name, phone, city, audience_type, product_interest, salesperson_id
3. `tracking_tokens` — token UUID, lead_id, salesperson_id, campaign_id, email_step, destination_url
4. `clicks` — token, lead_id, salesperson_id, ip_address, user_agent, referrer
5. `form_submissions` — token, lead_id, salesperson_id, form_type, submitter_email, raw_data JSONB
6. `orders` — shopify_order_id, token, lead_id, salesperson_id, customer_email, amount, order_data JSONB
7. `commissions` — salesperson_id, source_type, source_id, sale_amount, commission_rate, commission_earned, status
8. `admin_users` — email, password_hash (single admin account, no roles)
9. `salesperson_goals` — salesperson_id, period_start, period_type, target_revenue, target_orders
10. `phone_calls` — salesperson_id, lead_id, tracking_number, caller_number, duration_seconds, callrail_id
11. `suppression_list` — email, reason, added_at
12. `landing_page_matrix` — audience_type, product_interest, location_type, intent_level, angle, destination_url
13. `email_accounts` — salesperson_id, email, oauth_refresh_token, oauth_access_token, oauth_token_expiry
14. `sequences` — name, description, audience_type, active
15. `sequence_steps` — sequence_id, step_number, delay_days, subject, body
16. `contact_enrollments` — lead_id, sequence_id, salesperson_id, status, current_step, next_send_at, paused_reason
17. `email_sends` — enrollment_id, step_id, salesperson_id, lead_id, to_email, subject, gmail_message_id, status, opened_at, replied_at

**No client_id anywhere. Zero tenancy isolation today.**

---

### Auth system — two separate JWT flows, no roles

**Admin flow** (`src/middleware/auth.js`, `src/routes/auth.js`):
- `admin_users` table — just email + password_hash
- Single admin account (no roles, no scoping)
- JWT signed with `JWT_SECRET`, stored in `auth_token` cookie
- `requireAuth` middleware: verifies cookie JWT → attaches `req.user` (just `{id, email}`)

**Salesperson portal flow** (`src/middleware/spAuth.js`, implicit in portal route):
- `salespeople` table — has `portal_password_hash`
- JWT stored in `sp_token` cookie
- `requireSpAuth` middleware: verifies → attaches `req.salesperson`

**What's missing for Phase 1:**
- Multi-user login for non-admin roles (owner, admin, salesperson)
- Role-based access control
- Client/org scoping on `req.user`

---

### Branding — 100% hardcoded in `src/lib/gmail.js`

`buildHtml(body, salespersonName, unsubscribeUrl)` hardcodes:
- Colors: `#030302` (near-black), `#E91111` (red CTA), `#EDEBE7` (warm gray), `#CBDEE8` (info blue)
- Name: `"SureSecured"` (appears 3×)
- Phone: `(747) 688-9992`
- URL: `suresecured.com` (appears 4×, including CTA button href)
- Address: `SureSecured Security Products • Simi Valley, CA 93063`
- Title: `Security Specialist — SureSecured`
- CTA link: `https://suresecured.com/pages/request-a-quote`

The `fromName` in `sendSequenceEmail()` defaults to `vars.salesperson_name || 'SureSecured Team'` — also hardcoded fallback.

**Fix**: `buildHtml` needs to accept a `brandConfig` object (from client record) with keys: `primary_color`, `accent_color`, `bg_color`, `name`, `phone`, `website`, `address`, `cta_url`, `cta_label`.

---

### Cron — no SKIP LOCKED, no batching

`src/routes/cron.js` `/send-sequences`:
- Query: `WHERE ce.status = 'active' AND ce.next_send_at <= $1 LIMIT 100` — **no FOR UPDATE SKIP LOCKED**
- No connection pool tuning
- No partial index on `(status, next_send_at)` — full seq scan at 500k rows
- Batch size hardcoded at 100 rows per cron run

**Risks at scale:**
- Concurrent cron runs would double-process the same enrollments
- Full table scans on `contact_enrollments` without index will degrade at 500k rows
- No batch import for CSV — likely row-by-row inserts

---

## What needs to be built (plan-by-plan breakdown)

### Plan 01-01: Database migration

**New tables:**
- `organizations` (id, name, created_at) — top-level grouping
- `clients` (id, organization_id FK, slug, brand_config JSONB, commission_rules JSONB, integration_settings JSONB, active, created_at)
  - `brand_config`: `{name, primary_color, accent_color, bg_color, phone, website, address, cta_url, cta_label, logo_url}`
  - `commission_rules`: used by Phase 2 — define here, leave empty for now
  - `integration_settings`: shopify webhook secret, etc.

**Alter existing tables** (add `client_id INTEGER REFERENCES clients(id)`):
- leads, salespeople, sequences, contact_enrollments, email_accounts, commissions, orders, tracking_tokens, clicks, form_submissions, phone_calls, email_sends, salesperson_goals, suppression_list, landing_page_matrix, admin_users

That's all 17 tables. Some (like `suppression_list`, `landing_page_matrix`) may be shared; decide: scoped per client or global. Recommendation: scope `suppression_list` per client (email suppression is per-brand); keep `landing_page_matrix` client-scoped too (each client has own landing pages).

**Indexes:**
- `CREATE INDEX CONCURRENTLY ON contact_enrollments (status, next_send_at) WHERE status = 'active'` — partial index for cron
- `CREATE INDEX ON leads (client_id)`
- `CREATE INDEX ON contact_enrollments (client_id, status)`

**Migration approach:**
- Use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id)` — non-destructive, existing rows get NULL client_id
- Seed one `organization` and one `client` record for SureSecured with current brand values
- Backfill: `UPDATE <table> SET client_id = 1 WHERE client_id IS NULL`
- Add NOT NULL constraint after backfill

**NOT NULL constraint timing:** Add `NOT NULL` only after backfill, or enforce at application layer first. For Railway/Postgres: safe to do in same migration since no live traffic during migration.

---

### Plan 01-02: User auth system

**Decision**: Extend `admin_users` or create new `users` table?

Recommendation: **New `users` table** — `admin_users` is legacy single-tenant. Replace with:
```sql
users (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('operator', 'owner', 'admin', 'salesperson')),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
)
```
- `operator` role = cross-client superuser (no client_id restriction)
- `owner/admin/salesperson` = scoped to their client_id

**Auth middleware** (`requireAuth`):
- Existing middleware checks `admin_users` — replace to check `users` table
- JWT payload: `{id, email, role, client_id}` — `client_id` null for operator
- Role guard middleware: `requireRole('owner', 'admin')` — compose with `requireAuth`
- All existing `requireAuth` routes keep working; token shape changes

**Login page**: Update to support all user types (single `/login` page, role-inferred from DB lookup)

**Salesperson portal**: Currently separate `/portal/login` with `sp_token`. Phase 1 can merge into unified auth or keep separate — recommend: **unify** — one login, role determines what they see. Eliminates `spAuth.js` middleware.

---

### Plan 01-03: Client management UI

**Admin-only route** (operator role): `/admin/clients`

**Client record form fields:**
- Organization (select or create)
- Client name, slug
- Brand config: name, colors (hex pickers), phone, website, address, logo URL, CTA URL, CTA label
- Commission rules: JSON editor or structured form (leave structured for Phase 2, raw JSON for now)
- Integration settings: Shopify webhook secret

**Implementation**: Express route + inline HTML (matching existing pattern in auth.js — no template engine, just `res.send()` with Tailwind CDN)

**Pages needed:**
- `GET /admin/clients` — list all clients
- `GET /admin/clients/new` — create form
- `POST /admin/clients` — save
- `GET /admin/clients/:id/edit` — edit form
- `POST /admin/clients/:id` — update

**DB queries**: INSERT/UPDATE to `clients` table with JSONB fields

---

### Plan 01-04: Dynamic email branding

**Change**: `buildHtml(body, salespersonName, unsubscribeUrl)` → `buildHtml(body, salespersonName, unsubscribeUrl, brandConfig)`

`brandConfig` shape (from `clients.brand_config`):
```js
{
  name: 'SureSecured',
  primary_color: '#030302',
  accent_color: '#E91111',
  bg_color: '#EDEBE7',
  info_color: '#CBDEE8',
  phone: '(747) 688-9992',
  website: 'https://suresecured.com',
  address: 'SureSecured Security Products • Simi Valley, CA 93063',
  cta_url: 'https://suresecured.com/pages/request-a-quote',
  cta_label: 'Request a Free Quote →',
}
```

**Callers to update**: Find every call to `buildHtml` or `sendSequenceEmail` — need to pass `client_id` so they can query `clients.brand_config`. Cron route is the main caller.

**Default fallback**: If `brandConfig` is null/missing, use SureSecured defaults (so existing sends don't break during migration).

---

### Plan 01-05: Scale-ready cron

**Changes to `src/routes/cron.js`:**

1. **FOR UPDATE SKIP LOCKED**:
```sql
SELECT ... FROM contact_enrollments ce
...
WHERE ce.status = 'active' AND ce.next_send_at <= $1
ORDER BY ce.next_send_at
LIMIT 100
FOR UPDATE OF ce SKIP LOCKED
```

2. **Partial index** (created in Plan 01-01):
```sql
CREATE INDEX ON contact_enrollments (status, next_send_at) WHERE status = 'active'
```
This makes the cron query sub-second at 500k rows.

3. **Batched CSV import**: Add `POST /admin/leads/import` route that reads CSV, inserts in batches of 1000 using multi-row `INSERT ... VALUES ($1,$2),($3,$4)...` — avoids 500k individual round-trips.

4. **Connection pool tuning**: `src/db.js` — add `max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 2000` to Pool constructor. Railway Postgres free tier allows up to 25 connections.

**Proof point for success criterion**: Seed 500k contact_enrollments (all with `status='active'` and `next_send_at` in the past), run cron, confirm it completes in <5s with no duplicate-processing errors. Seed script needed as part of this plan.

---

## Key decisions already made (from STATE.md)

1. **Brownfield evolution** — add tenancy around existing 17-table schema, do not rewrite working routes
2. **JSONB for client config** (brand, commission, voice, AI, integrations) — avoids future migrations
3. **Railway PostgreSQL** — connection pooler must be enabled before Phase 2 scale work

## Dependencies between plans

```
01-01 (DB migration)
  ├── 01-02 (auth) — needs users table + client_id on users
  ├── 01-03 (client UI) — needs clients table
  ├── 01-04 (branding) — needs clients.brand_config
  └── 01-05 (cron) — needs partial index from 01-01
```

01-01 must execute first. 01-02, 01-03, 01-04, 01-05 can execute in parallel after 01-01.

## RESEARCH COMPLETE
