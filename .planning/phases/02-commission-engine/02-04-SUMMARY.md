---
phase: 02-commission-engine
plan: "04"
subsystem: api
tags: [shopify, webhook, commissions, tiered, client_id, postgres]

# Dependency graph
requires:
  - phase: 02-01
    provides: calculateCommission() tiered engine with bonus row support
  - phase: 01-01
    provides: clients table with integration_settings JSONB column
provides:
  - POST /webhooks/shopify/order with client_id resolution, tiered commission calc, bonus row insertion
affects: [03-dashboard, reporting, commission-ledger]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "client resolution via integration_settings JSONB lookup on x-shopify-shop-domain header"
    - "graceful degradation on unresolvable client — order recorded, commission skipped, no 5xx"
    - "parallel Promise.all for salesperson rules + monthly unit count queries"
    - "bonus ledger rows with source_type='bonus', sale_amount=0 for threshold crossings"

key-files:
  created: []
  modified:
    - src/routes/webhook.js

key-decisions:
  - "clientId required for commission calc — order recorded without it but commission skipped to avoid retry storms"
  - "spResult joins salespeople s JOIN clients c using salesperson's own client_id to fetch commission_rules — not webhook-resolved clientId"
  - "unitsBefore query excludes current orderId (AND id != $3) to get pre-sale unit count"
  - "ON CONFLICT (shopify_order_id) DO NOTHING preserved — idempotency unchanged"

patterns-established:
  - "Webhook graceful degradation: always return 200 for known-bad attribution, never 5xx Shopify into retry storms"
  - "commission_rules fetched fresh per webhook — no caching, always authoritative"

# Metrics
duration: 8min
completed: 2026-06-30
---

# Phase 2 Plan 04: Shopify Webhook Tiered Commission Summary

**Shopify order webhook upgraded from flat-rate to tiered calculateCommission() with client_id resolution via shop domain header and bonus ledger row insertion**

## Performance

- **Duration:** 8 min
- **Started:** 2026-06-30T20:35:00Z
- **Completed:** 2026-06-30T20:43:00Z
- **Tasks:** 3
- **Files modified:** 1

## Accomplishments

- Client resolution added: `x-shopify-shop-domain` header looked up against `clients.integration_settings->>'shopify_domain'`
- `orders.client_id` populated on every INSERT — downstream dashboards can scope by client
- Flat-rate commission block replaced with `calculateCommission()` call using monthly unit count from `orders` table
- Bonus commission rows inserted as separate ledger entries (`source_type='bonus'`) when unit threshold is crossed
- Graceful degradation when `clientId` is null: order recorded, commission skipped, warning logged, 200 returned

## Task Commits

1. **Tasks 1-3: All webhook changes in single atomic commit** - `91b2cc9` (feat)

**Plan metadata:** (docs commit follows this summary)

## Files Created/Modified

- `src/routes/webhook.js` - client_id resolution, tiered commission, bonus rows, graceful degradation

## Decisions Made

- `clientId` null path: records order but skips commission entirely. Avoids Shopify retry storm (would 500 if we errored on unknown shop domain).
- `spResult` query joins on salesperson's own `client_id` (not webhook-resolved `clientId`) to get correct `commission_rules` — intentional per plan, multi-client salesperson edge case deferred to v2.
- `unitsBefore` query uses `AND id != $3` to exclude the just-inserted order, giving correct pre-sale unit count for tier lookup.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

**Operator action required before webhook attribution works:**
Each client row must have `integration_settings.shopify_domain` populated (e.g. `"mystore.myshopify.com"`) — this is manual operator configuration, not automatable without access to the client's Shopify store.

## Next Phase Readiness

- Commission engine fully wired end-to-end: webhook → tiered calc → ledger rows with client_id
- Ready for Phase 3 dashboard work: `commissions` and `orders` tables both have `client_id` for per-client scoping
- No blockers for remaining 02-xx plans

---
*Phase: 02-commission-engine*
*Completed: 2026-06-30*
