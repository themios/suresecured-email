-- Migration 018: convert the global unique indexes on tenant-owned tables to
-- per-tenant (client_id, col) composites. This is the P0-8 conversion that
-- migration 015 section 3 deliberately DEFERRED until the query layer was
-- tenant-scoped and every `ON CONFLICT (<col>)` call site could be rewritten in
-- lockstep. That scoping has now landed, so this is the second half.
--
-- Why it is safe to run now (verified in 015: a single tenant, zero duplicate
-- phone values): each global unique currently holds, so a per-tenant composite
-- is a STRICTLY WEAKER constraint and its creation cannot fail on existing data.
-- We always CREATE the composite BEFORE dropping the global, so there is never a
-- window without a uniqueness guard and the ON CONFLICT arbiters never vanish
-- mid-transaction. Idempotent and guarded, so re-running (or running on a fresh
-- database after createBaseTables + migration 006) converges to the same state.
--
-- DELIBERATELY LEFT GLOBAL (do not convert here):
--   suppression_list.email  -- still a global cross-tenant safety list. Making
--                              it per-tenant needs the unsubscribe token to
--                              carry a client_id and a production duplicate
--                              check first. Tracked separately.
--   users.email             -- auth identity, must stay globally unique.
--   *_token / *_pixel_token -- UUIDs, no collision risk.
--   phone_calls.callrail_id, call_logs.retell_call_id -- external vendor ids.
--   clients.slug, organizations.slug, client_auth_domains.domain -- identifiers
--                              whose global uniqueness is the whole point.

-- ── 1. leads(phone): global idx_leads_phone -> (client_id, phone) ──────────
-- The composite is named idx_leads_client_phone because migration 006 already
-- checks for exactly that name and skips recreating the global index once it
-- exists (so this conversion sticks across reboots).
DO $$
BEGIN
  IF to_regclass('public.leads') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_client_phone
      ON leads (client_id, phone);
    DROP INDEX IF EXISTS idx_leads_phone;
  END IF;
END $$;

-- ── 2. orders(shopify_order_id): global -> (client_id, shopify_order_id) ────
-- webhook.js upserts orders with ON CONFLICT; it is updated in the same change
-- to target (client_id, shopify_order_id). Shopify order ids are globally unique
-- from Shopify, so the composite has no duplicates either.
DO $$
BEGIN
  IF to_regclass('public.orders') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_shopify
      ON orders (client_id, shopify_order_id);
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_shopify_order_id_key;
  END IF;
END $$;

-- ── 3. salespeople(email): global -> (client_id, email) ────────────────────
-- No ON CONFLICT depends on this one, but the global unique blocks two tenants
-- from having a rep with the same email. Auth joins on email still work.
DO $$
BEGIN
  IF to_regclass('public.salespeople') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_salespeople_client_email
      ON salespeople (client_id, email);
    ALTER TABLE salespeople DROP CONSTRAINT IF EXISTS salespeople_email_key;
  END IF;
END $$;
