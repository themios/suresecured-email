# Phase 02: Commission Engine - Research

**Researched:** 2026-06-30
**Domain:** Tiered commission calculation, PostgreSQL aggregation, Shopify webhook attribution, inline HTML dashboard (Express/Node/Tailwind)
**Confidence:** HIGH — all findings derived from direct codebase inspection of the actual source files

---

## Summary

Phase 2 builds on a fully-wired multi-tenant schema (01-01) with unified JWT auth (01-02) and client CRUD (01-03). The existing codebase has all three Phase 2 surfaces partially built but missing tiered logic: `webhook.js` calculates flat-rate commissions, `portal.js` shows revenue/orders without tier context, and `admin.js` has no cross-client view. The commission engine needs a shared calculation function (02-01), added to both the webhook path (02-04) and the portal (02-02), plus a new agency dashboard route (02-03).

The most important design decision for this phase is the `commission_rules` JSONB schema — all four plans depend on it. Define it precisely in 02-01 and never change it in later plans.

The second most important insight: "units this month" must be counted from the `orders` table (not `commissions`), because orders are the authoritative source of fulfilled sales. The `commissions` table is a derived ledger — counting commissions would double-count if a correction entry is ever added.

**Primary recommendation:** Build 02-01 (tiered engine as a shared JS module) first, then wire it into 02-04 (webhook), then build dashboards (02-02, 02-03) last since they are read-only consumers.

---

## 1. commission_rules JSONB Schema

### Recommended Shape

```json
{
  "tiers": [
    { "from": 0,  "to": 10, "rate": 10 },
    { "from": 10, "to": 20, "rate": 15 },
    { "from": 20, "to": null, "rate": 20 }
  ],
  "bonuses": [
    { "units": 25, "amount": 500 },
    { "units": 50, "amount": 1000 }
  ]
}
```

**Field rules:**
- `tiers` — required, array, ordered ascending by `from`
- `tier.from` — inclusive lower bound (unit count)
- `tier.to` — exclusive upper bound; `null` means "no cap" (last tier)
- `tier.rate` — percentage as integer (10 = 10%)
- `bonuses` — optional, array; each entry is a one-time bonus dollar amount triggered when `units_this_month` crosses that threshold
- `bonus.units` — the unit count that triggers the bonus (checked at crossing point, not retroactively)
- `bonus.amount` — flat dollar bonus inserted as a separate commission row with `source_type = 'bonus'`

**Empty / fallback:** If `commission_rules` is `{}` or missing `tiers`, fall back to `salespeople.commission_rate` (existing flat-rate behavior). This is backward-compatible with all pre-Phase-2 rows.

**Why this shape:**
- Tiers array is ordered and iterable — O(n) lookup for current tier; n is always tiny (<10)
- `to: null` sentinel avoids a magic high number (999) that breaks comparisons
- Bonuses as separate array lets operator add/remove thresholds without touching tier logic
- Flat JSON — no nested objects — so PostgreSQL `->` and `->>` accessors stay simple if ever queried directly

**Confidence:** HIGH (designed from requirements; no external library involved)

---

## 2. Tiered Calculation Algorithm

### Core Function (shared module: `src/lib/commissions.js`)

```js
/**
 * Calculate commission for a single sale given units already completed this month
 * BEFORE this sale (pre-sale unit count).
 *
 * @param {number} saleAmount   - Dollar amount of the order
 * @param {number} unitsBefore  - Units completed this month BEFORE this order
 * @param {object} rules        - Parsed commission_rules JSONB { tiers, bonuses }
 * @param {number} flatRate     - Fallback flat % from salespeople.commission_rate
 * @returns {{ rate: number, earned: number, bonusesTriggered: number[] }}
 */
function calculateCommission(saleAmount, unitsBefore, rules, flatRate = 100) {
  const tiers = rules?.tiers;
  if (!tiers || !tiers.length) {
    // Fallback: flat rate
    return { rate: flatRate, earned: (saleAmount * flatRate) / 100, bonusesTriggered: [] };
  }

  // This sale is unit number (unitsBefore + 1)
  const thisUnit = unitsBefore + 1;

  // Find the tier this unit falls in
  const tier = tiers.find(t => {
    const above = thisUnit > t.from;
    const below = t.to === null || thisUnit <= t.to;
    return above && below;
  });

  const rate = tier ? tier.rate : tiers[tiers.length - 1].rate;
  const earned = (saleAmount * rate) / 100;

  // Check bonus thresholds crossed by this unit
  const bonusesTriggered = [];
  const bonuses = rules?.bonuses || [];
  for (const b of bonuses) {
    if (unitsBefore < b.units && thisUnit >= b.units) {
      bonusesTriggered.push(b);
    }
  }

  return { rate, earned, bonusesTriggered };
}
```

**Key logic:**
- `unitsBefore` is fetched from DB BEFORE inserting the commission row
- Threshold crossing check: `unitsBefore < b.units && thisUnit >= b.units` — triggers only on the crossing sale, not every sale after
- Bonuses are inserted as separate commission rows after the primary commission row

**Confidence:** HIGH

---

## 3. Monthly Reset Logic — Counting Units This Month

### What "unit" means
A unit = one fulfilled Shopify order attributed to a salesperson for a given client. Source of truth: `orders` table, not `commissions` table.

### Query to count units this month (before inserting current order)

```sql
SELECT COUNT(*) AS units_this_month
FROM orders
WHERE salesperson_id = $1
  AND client_id = $2
  AND DATE_TRUNC('month', ordered_at) = DATE_TRUNC('month', NOW())
```

**Important:**
- Use `DATE_TRUNC('month', ordered_at) = DATE_TRUNC('month', NOW())` — timezone-safe, index-friendly
- Run this query BEFORE inserting the current order (so count is "units already completed")
- `client_id` scoping is required — one salesperson may serve multiple clients; tiers reset per-client

### Monthly reset
There is no explicit reset job needed. Counting from `DATE_TRUNC('month', NOW())` is inherently monthly. When January rolls to February, all prior January orders are outside the window and the count starts at 0 automatically.

### Schema gap
`orders` table currently has `client_id` (added by 01-01 migration via the DO $$ loop) but `webhook.js` does not populate it. This is one of the missing fields the webhook must write.

**Confidence:** HIGH

---

## 4. Webhook Gap Analysis (`webhook.js` → COMM-04)

Current `webhook.js` issues, in priority order:

| Gap | What's Missing | Fix Required |
|-----|---------------|--------------|
| No `client_id` lookup | Webhook receives no client context | Derive from Shopify shop domain: `req.headers['x-shopify-shop-domain']` or a per-client webhook secret; look up clients row by `integration_settings->>'shopify_domain'` |
| Flat-rate commission | Uses `salespeople.commission_rate` directly | Replace with `calculateCommission(amount, unitsBefore, rules, flatRate)` call |
| No tiered context | Does not count units before sale | Add units-this-month query before commission INSERT |
| No bonus insertion | No bonus rows written | After primary commission insert, loop `bonusesTriggered` and insert one row per bonus with `source_type='bonus'` |
| orders.client_id not set | INSERT does not include client_id | Add `client_id` to orders INSERT |
| commissions.client_id not set | INSERT does not include client_id | Add `client_id` to commissions INSERT |
| ON CONFLICT on orders — returns nothing on dup | `ON CONFLICT DO NOTHING` skips commission if order already exists | Acceptable — idempotency is correct; commission is skipped on duplicate webhook |

### How to derive client_id from webhook

Shopify sends `x-shopify-shop-domain` header on all webhooks (e.g., `mystore.myshopify.com`). Store this in `clients.integration_settings->>'shopify_domain'`. Lookup:

```sql
SELECT c.id, c.commission_rules, s.commission_rate
FROM clients c
JOIN salespeople s ON s.client_id = c.id AND s.id = $1
WHERE c.integration_settings->>'shopify_domain' = $2
LIMIT 1
```

If no match, still record the order but skip commission (log a warning).

**Confidence:** HIGH

---

## 5. Dashboard Gap Analysis (`portal.js` → COMM-02)

Current `portal.js` problems for COMM-02:

| Missing Feature | Current State | What to Add |
|----------------|---------------|-------------|
| Current tier display | Not shown — shows flat `commission_rate%` | Fetch `client.commission_rules`, compute current tier from `unitsBefore`, display tier rate |
| Units sold this month | Not shown (orders count is shown but not labeled as "units") | Add labeled "Units This Month" stat card; use COUNT from orders |
| Pending vs paid split | `commissions.status` is always `'pending'` — no paid/history split | Add pending/paid filter to commission queries using `status` column |
| Client-scoped view | `req.salesperson.client_id` IS populated by 01-02 spAuth but NO query uses it | Add `AND o.client_id = $client_id` to all queries |
| Tier progress bar | Nothing | Show "X of Y units to next tier" progress |
| Auth alignment | Uses separate `sp_token` login, not unified `/auth/login` | 01-02 summary says spAuth is DB-backed and provides client_id — portal.js login can stay as-is for now; spAuth already handles this |

### New queries needed for portal

**Tier context query:**
```sql
SELECT
  c.commission_rules,
  s.commission_rate,
  COUNT(o.id) AS units_this_month
FROM salespeople s
JOIN clients c ON c.id = s.client_id
LEFT JOIN orders o ON o.salesperson_id = s.id
  AND o.client_id = s.client_id
  AND DATE_TRUNC('month', o.ordered_at) = DATE_TRUNC('month', NOW())
WHERE s.id = $1
GROUP BY c.commission_rules, s.commission_rate
```

**Pending/paid split:**
```sql
SELECT
  SUM(commission_earned) FILTER (WHERE status = 'pending') AS pending_payout,
  SUM(commission_earned) FILTER (WHERE status = 'paid')    AS paid_total
FROM commissions
WHERE salesperson_id = $1
  AND client_id = $2
```

**Confidence:** HIGH

---

## 6. Agency Dashboard Design (`admin.js` → COMM-03)

### New route: `GET /admin/agency`

**Who sees it:** `requireAuth` + `requireRole('operator', 'owner')` — operators managing multiple clients

**Core query (all clients in one view):**

```sql
SELECT
  c.id,
  c.name AS client_name,
  c.slug,
  COUNT(DISTINCT o.id)                                AS units_this_month,
  COALESCE(SUM(o.amount), 0)                         AS revenue_this_month,
  COALESCE(SUM(cm.commission_earned), 0)             AS commission_owed,
  COALESCE(SUM(cm.commission_earned) FILTER (WHERE cm.status = 'paid'), 0) AS commission_paid,
  COUNT(DISTINCT s.id)                               AS salesperson_count
FROM clients c
  JOIN organizations o_org ON o_org.id = c.organization_id
  LEFT JOIN orders o  ON o.client_id = c.id
    AND DATE_TRUNC('month', o.ordered_at) = DATE_TRUNC('month', NOW())
  LEFT JOIN commissions cm ON cm.client_id = c.id
    AND DATE_TRUNC('month', cm.created_at) = DATE_TRUNC('month', NOW())
  LEFT JOIN salespeople s ON s.client_id = c.id AND s.active = true
WHERE c.organization_id = $1
  AND c.active = true
GROUP BY c.id, c.name, c.slug
ORDER BY revenue_this_month DESC
```

`$1` = `req.user.organization_id` from JWT.

**Quick-switch navigation:** Each client row gets a "View" button that links to `/admin/agency/clients/:clientId/dashboard`. This route sets a session variable or appends `?client_id=X` to subsequent admin queries. Simplest approach: a URL param scoping pattern, no session state needed.

### Per-client drilldown: `GET /admin/agency/clients/:clientId/dashboard`

Shows salespeople for that client with their tier status:

```sql
SELECT
  s.id, s.name, s.email,
  COUNT(o.id)                                     AS units_this_month,
  COALESCE(SUM(o.amount), 0)                     AS revenue_this_month,
  COALESCE(SUM(cm.commission_earned), 0)         AS commission_owed,
  c.commission_rules
FROM salespeople s
JOIN clients c ON c.id = s.client_id
LEFT JOIN orders o ON o.salesperson_id = s.id
  AND o.client_id = s.client_id
  AND DATE_TRUNC('month', o.ordered_at) = DATE_TRUNC('month', NOW())
LEFT JOIN commissions cm ON cm.salesperson_id = s.id
  AND cm.client_id = s.client_id
  AND DATE_TRUNC('month', cm.created_at) = DATE_TRUNC('month', NOW())
WHERE s.client_id = $1 AND s.active = true
GROUP BY s.id, s.name, s.email, c.commission_rules
ORDER BY revenue_this_month DESC
```

**No re-login required** — operator uses same JWT cookie; route just checks `client.organization_id = req.user.organization_id` to prevent cross-org access.

**Confidence:** HIGH

---

## 7. Plan Dependency Order

```
02-01: Tiered Engine (shared module + commission_rules schema)
  └─► 02-04: Shopify Webhook (consumes calculateCommission from 02-01)
  └─► 02-02: Salesperson Dashboard (consumes tier context from 02-01)
  └─► 02-03: Agency Dashboard (read-only, no engine dependency — can run in parallel with 02-02)
```

**Hard dependency:** 02-01 must complete before 02-04 or 02-02 can be correctly implemented.
**Parallelizable:** 02-02 and 02-03 can be built simultaneously after 02-01.
**02-04 before 02-02/02-03 preferred** — dashboards display more interesting data if real commission rows exist with `client_id` populated.

### Recommended execution order
1. 02-01 (engine + schema definition)
2. 02-04 (webhook — produces data)
3. 02-02 (salesperson view — reads that data)
4. 02-03 (agency view — reads aggregated data)

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| HMAC webhook verification | Custom crypto | Already in webhook.js — keep `crypto.timingSafeEqual` pattern |
| Monthly date boundaries | Manual timestamp math | `DATE_TRUNC('month', NOW())` in PostgreSQL — timezone-correct, index-friendly |
| Commission tier lookup | Binary search or complex branching | Simple `.find()` on a small sorted array — tiers array will never exceed ~10 items |
| Bonus deduplication | A separate bonuses table | Check `unitsBefore < threshold && thisUnit >= threshold` — one-time by definition |

---

## Common Pitfalls

### Pitfall 1: Counting units from commissions table instead of orders
**What goes wrong:** If a correction or bonus commission row is inserted, unit count inflates, triggering wrong tier.
**Fix:** Always count `orders` for "units this month". `commissions` is the ledger; `orders` is the source of truth for unit count.

### Pitfall 2: client_id not populated on new commission/order rows
**What goes wrong:** Agency dashboard query joining on `cm.client_id = c.id` returns zero rows for all new data.
**Fix:** 02-04 must include `client_id` in both `orders` INSERT and `commissions` INSERT. Verify by checking that commission rows have non-null `client_id` after webhook fires.

### Pitfall 3: Timezone mismatch in monthly boundary
**What goes wrong:** `DATE(ordered_at) BETWEEN $1 AND $2` with app-generated date strings can miscount orders near midnight depending on Railway server timezone vs. expected timezone.
**Fix:** Use `DATE_TRUNC('month', ordered_at) = DATE_TRUNC('month', NOW())` — single expression, no client-side date string generation, PostgreSQL handles timezone internally.

### Pitfall 4: Shopify webhook fires before client_id is resolvable
**What goes wrong:** If Shopify domain is not stored in `integration_settings`, client_id lookup returns null and all commissions go uncategorized.
**Fix:** Webhook handler must gracefully handle null client_id — log warning and skip commission if shop domain cannot be matched. Do not 500 or 401. Shopify will retry on 5xx.

### Pitfall 5: Bonus triggered on every subsequent sale after threshold
**What goes wrong:** Checking `thisUnit >= b.units` without the `unitsBefore < b.units` guard triggers the bonus on every sale after the threshold, not just the crossing sale.
**Fix:** The `unitsBefore < b.units && thisUnit >= b.units` guard is required.

### Pitfall 6: Portal shows stale commission rate from salespeople.commission_rate
**What goes wrong:** portal.js currently renders `${info.commission_rate}%` hardcoded. With tiered rules, this is wrong — the displayed rate should be the current tier rate based on units this month.
**Fix:** Compute current tier in the dashboard handler using `commission_rules` and `units_this_month`, display the active tier rate.

---

## Schema Additions Required

02-01 must add these columns via a new migration (`002_commission_engine.sql`):

```sql
-- commissions table needs client_id (already added by 001 DO $$ loop — verify it's there)
-- If not: ALTER TABLE commissions ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id);

-- orders table needs client_id (same — verify)
-- If not: ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id);

-- Index for monthly commission queries (performance)
CREATE INDEX IF NOT EXISTS idx_commissions_sp_client_month
  ON commissions (salesperson_id, client_id, created_at);

CREATE INDEX IF NOT EXISTS idx_orders_sp_client_month
  ON orders (salesperson_id, client_id, ordered_at);
```

Both `client_id` columns were added by the 001 migration's DO $$ loop — but verify they exist before depending on them, since the DO loop runs silently and the DB has not been provisioned yet.

---

## Code Examples

### Shared commission module skeleton (`src/lib/commissions.js`)

```js
function calculateCommission(saleAmount, unitsBefore, rules, flatRate = 100) {
  const tiers = rules?.tiers;
  if (!tiers || !tiers.length) {
    return { rate: flatRate, earned: (saleAmount * flatRate) / 100, bonusesTriggered: [] };
  }
  const thisUnit = unitsBefore + 1;
  const tier = tiers.find(t =>
    thisUnit > t.from && (t.to === null || thisUnit <= t.to)
  );
  const rate = tier ? tier.rate : tiers[tiers.length - 1].rate;
  const earned = (saleAmount * rate) / 100;
  const bonusesTriggered = (rules?.bonuses || []).filter(
    b => unitsBefore < b.units && thisUnit >= b.units
  );
  return { rate, earned, bonusesTriggered };
}

module.exports = { calculateCommission };
```

### Webhook tiered commission block (replaces existing flat-rate block in webhook.js)

```js
// Inside webhook POST handler, after order is inserted:
if (orderResult.rows.length > 0 && resolvedSalespersonId && clientId) {
  const orderId = orderResult.rows[0].id;

  // Get rules and current unit count (before this sale)
  const [spResult, unitsResult] = await Promise.all([
    pool.query(
      `SELECT s.commission_rate, c.commission_rules
       FROM salespeople s JOIN clients c ON c.id = s.client_id
       WHERE s.id = $1`, [resolvedSalespersonId]
    ),
    pool.query(
      `SELECT COUNT(*) AS units
       FROM orders
       WHERE salesperson_id = $1 AND client_id = $2
         AND DATE_TRUNC('month', ordered_at) = DATE_TRUNC('month', NOW())
         AND id != $3`,  // exclude current order
      [resolvedSalespersonId, clientId, orderId]
    )
  ]);

  const rules = spResult.rows[0]?.commission_rules || {};
  const flatRate = spResult.rows[0]?.commission_rate || 100;
  const unitsBefore = parseInt(unitsResult.rows[0]?.units || 0);

  const { rate, earned, bonusesTriggered } = calculateCommission(orderAmount, unitsBefore, rules, flatRate);

  await pool.query(
    `INSERT INTO commissions
       (salesperson_id, client_id, source_type, source_id, sale_amount, commission_rate, commission_earned)
     VALUES ($1, $2, 'shopify_order', $3, $4, $5, $6)`,
    [resolvedSalespersonId, clientId, orderId, orderAmount, rate, earned]
  );

  for (const bonus of bonusesTriggered) {
    await pool.query(
      `INSERT INTO commissions
         (salesperson_id, client_id, source_type, source_id, sale_amount, commission_rate, commission_earned)
       VALUES ($1, $2, 'bonus', $3, 0, 0, $4)`,
      [resolvedSalespersonId, clientId, orderId, bonus.amount]
    );
  }
}
```

---

## Open Questions

1. **How does the webhook know which client it's for?**
   - Shopify sends `x-shopify-shop-domain` header. Requires `clients.integration_settings->>'shopify_domain'` to be populated.
   - If blank for existing client, webhook cannot scope to client. Must be documented as operator setup step.
   - Recommendation: 02-04 plan must include a note that operator must set `shopify_domain` in integration_settings before webhook attribution works.

2. **Is `commissions.client_id` actually present in the live DB?**
   - The 001 migration's DO $$ loop added it, but DATABASE_URL is a placeholder. Verify on first live DB connection.
   - 02-01 migration should use `ADD COLUMN IF NOT EXISTS` as a safety net.

3. **Portal login stays on separate sp_token or migrates to /auth/login?**
   - 01-02 summary says "portal.js login (queries salespeople table — will need update to use unified auth from 01-02)" is listed as missing.
   - However, spAuth is already DB-backed and provides client_id. The portal login UX can stay as-is for Phase 2 — what matters is that `req.salesperson.client_id` is populated, which 01-02 already ensures.
   - Recommendation: Don't migrate portal login in Phase 2. Add client_id scoping to queries only.

---

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection: `src/routes/webhook.js` — exact flat-rate logic and token resolution
- Direct codebase inspection: `src/routes/portal.js` — full dashboard query set, confirmed no tier/client_id logic
- Direct codebase inspection: `src/routes/admin.js` — confirmed no agency cross-client view
- Direct codebase inspection: `src/db.js` — commissions and orders schema
- Direct codebase inspection: `migrations/001_add_tenancy.sql` — confirmed client_id added to both tables via DO $$ loop
- Direct codebase inspection: `src/middleware/spAuth.js` — confirmed client_id is populated on req.salesperson
- Phase 01 summaries (01-01 through 01-04) — confirmed patterns: inline HTML, parseJsonField, no EJS

### Tertiary (LOW confidence, design decisions)
- commission_rules JSONB shape: designed from COMM-01 requirements, not an external standard

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries; same Express/pg/JWT/Tailwind stack as Phase 1
- Architecture (shared module): HIGH — standard Node.js pattern
- commission_rules schema: HIGH — designed to match requirements precisely
- Gap analyses (webhook, portal): HIGH — from direct source inspection
- Agency dashboard queries: HIGH — standard PostgreSQL aggregation
- Plan dependency order: HIGH — verified from logical data flow

**Research date:** 2026-06-30
**Valid until:** 2026-07-30 (stable — no external library changes expected)
