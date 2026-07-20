-- Migration 015: attach existing data to its tenant, and stop global unique
-- indexes from blocking a second one. Additive and idempotent.
--
-- Context: tenancy was added by 001 as a nullable column and never backfilled,
-- so every pre-existing row carries client_id IS NULL. Once route queries are
-- scoped (`WHERE client_id = $1`), those rows become invisible. This migration
-- runs BEFORE that scoping lands so the data is already attributed when it does.
--
-- Safe to run against a multi-tenant database later: every backfill below is
-- guarded on there being exactly ONE client, so it no-ops rather than guessing
-- once a second tenant exists.

-- ── 1. Backfill orphaned rows to the sole tenant ───────────────────────────
--
-- Guarded: if there is more than one client, attribution is ambiguous and this
-- block does nothing. A human has to decide who owns those rows at that point.
DO $$
DECLARE
  sole_client INTEGER;
  tbl TEXT;
  touched INTEGER;
BEGIN
  SELECT id INTO sole_client FROM clients
  WHERE active = TRUE
  LIMIT 2;                          -- LIMIT 2 so the count check below is real

  IF (SELECT COUNT(*) FROM clients) <> 1 THEN
    RAISE NOTICE '015: % clients present, skipping backfill (ambiguous)',
      (SELECT COUNT(*) FROM clients);
    RETURN;
  END IF;

  SELECT id INTO sole_client FROM clients LIMIT 1;

  FOREACH tbl IN ARRAY ARRAY[
    'leads', 'orders', 'clicks', 'commissions', 'form_submissions',
    'salespeople', 'tracking_tokens', 'phone_calls', 'contact_enrollments',
    'email_sends', 'sequences', 'sequence_steps', 'lead_notes',
    'salesperson_goals', 'suppression_list'
  ]
  LOOP
    -- Skip tables that don't have the column (schema drift across environments)
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'client_id'
    ) THEN
      EXECUTE format('UPDATE %I SET client_id = $1 WHERE client_id IS NULL', tbl)
        USING sole_client;
      GET DIAGNOSTICS touched = ROW_COUNT;
      IF touched > 0 THEN
        RAISE NOTICE '015: backfilled % row(s) in %', touched, tbl;
      END IF;
    END IF;
  END LOOP;
END $$;

-- ── 2. Attach users to the sole tenant ─────────────────────────────────────
--
-- Separate from the loop above because users also need a role decision. A user
-- with client_id IS NULL now gets a 403 from requireTenantContext, so leaving
-- this NULL locks the account out of /settings entirely.
DO $$
DECLARE
  sole_client INTEGER;
BEGIN
  IF (SELECT COUNT(*) FROM clients) <> 1 THEN
    RAISE NOTICE '015: multiple clients, skipping user backfill';
    RETURN;
  END IF;
  SELECT id INTO sole_client FROM clients LIMIT 1;

  UPDATE users SET client_id = sole_client WHERE client_id IS NULL;

  -- Tenant CRUD (/admin/clients*) is now gated to the platform roles, because
  -- 'admin' is a tenant-level role that customers hand out and it was reaching
  -- cross-tenant routes. The sole existing admin IS the platform operator here,
  -- so promote rather than lock them out. Only fires while one client exists.
  UPDATE users SET role = 'owner'
  WHERE role = 'admin'
    AND client_id = sole_client
    AND (SELECT COUNT(*) FROM users) = 1;
END $$;

-- ── 3. Scope global unique indexes to the tenant ───────────────────────────
--
-- Each of these currently spans all tenants, so tenant B cannot insert a row
-- tenant A already has. Verified against production: zero duplicate phone
-- values, so these conversions cannot fail on existing data. This is strictly
-- a RELAXATION of each constraint — it only ever permits more rows — and it
-- gets harder to do safely with every tenant added, which is why it happens now.
--
-- Deliberately NOT converted:
--   client_auth_domains.domain  — global uniqueness is the point; it guarantees
--                                 a domain maps to exactly one tenant.
--   clients.slug, organizations.slug — tenant identifiers, must stay global.
--   *_token, *_pixel_token      — UUIDs, no collision risk.
--   phone_calls.callrail_id, call_logs.retell_call_id — external vendor ids.

-- Every statement below is wrapped in a table-existence guard. Migration 001
-- does NOT do this — its DO block checks for the COLUMN but not the TABLE, so it
-- hard-fails on an empty database (the base tables are created by db.js's inline
-- SQL, which runs AFTER the migrations). That makes a from-scratch bootstrap
-- impossible today. This migration refuses to add a second instance of that bug:
-- on a fresh database it no-ops cleanly instead of aborting the boot.
DO $$
DECLARE
  has_clients BOOLEAN := to_regclass('public.clients') IS NOT NULL;
BEGIN
  -- leads.phone
  IF to_regclass('public.leads') IS NOT NULL AND has_clients THEN
    DROP INDEX IF EXISTS idx_leads_phone;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_client_phone
      ON leads (client_id, phone) WHERE phone IS NOT NULL;

    -- leads.email is queried constantly by the unsubscribe and ingestion paths
    -- and has no index at all today. Non-unique: a tenant legitimately re-imports
    -- the same address.
    CREATE INDEX IF NOT EXISTS idx_leads_client_email
      ON leads (client_id, LOWER(email));

    CREATE INDEX IF NOT EXISTS idx_leads_client_stage ON leads (client_id, stage);
  END IF;

  -- users.email — one human may hold a seat at more than one tenant.
  IF to_regclass('public.users') IS NOT NULL THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_client_email
      ON users (client_id, LOWER(email));
  END IF;

  -- salespeople.email — same reasoning; a rep can work for two dealerships.
  IF to_regclass('public.salespeople') IS NOT NULL THEN
    ALTER TABLE salespeople DROP CONSTRAINT IF EXISTS salespeople_email_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_salespeople_client_email
      ON salespeople (client_id, LOWER(email));
    CREATE INDEX IF NOT EXISTS idx_salespeople_client ON salespeople (client_id, active);
  END IF;

  -- orders.shopify_order_id — two tenants running separate Shopify stores can
  -- legitimately produce the same numeric order id.
  IF to_regclass('public.orders') IS NOT NULL THEN
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_shopify_order_id_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_shopify
      ON orders (client_id, shopify_order_id) WHERE shopify_order_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_orders_client_ordered_at ON orders (client_id, ordered_at DESC);
  END IF;

  -- suppression_list.email — currently global, so unsubscribing from one tenant
  -- silently suppresses the address for every other tenant. Scoping it makes
  -- suppression per-tenant, which is what the UI already implies.
  -- NOTE: if a global do-not-contact list is what you legally want, revert this
  -- block and document the choice.
  IF to_regclass('public.suppression_list') IS NOT NULL THEN
    ALTER TABLE suppression_list DROP CONSTRAINT IF EXISTS suppression_list_email_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_suppression_client_email
      ON suppression_list (client_id, LOWER(email));
  END IF;

  -- ── Indexes the tenant-scoped queries will need ──────────────────────────
  -- Every list/analytics query becomes `WHERE client_id = $1 AND <time> >= ...`.
  -- Without these, scoping just turns full scans into slightly smaller ones.
  -- client_id leads each composite since it is always an equality predicate.
  IF to_regclass('public.clicks') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_clicks_client_clicked_at ON clicks (client_id, clicked_at DESC);
  END IF;
  IF to_regclass('public.form_submissions') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_forms_client_submitted_at ON form_submissions (client_id, submitted_at DESC);
  END IF;
  IF to_regclass('public.phone_calls') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_calls_client_called_at ON phone_calls (client_id, called_at DESC);
  END IF;
  IF to_regclass('public.commissions') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_commissions_client ON commissions (client_id);
  END IF;
END $$;
