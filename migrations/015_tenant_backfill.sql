-- Migration 015: attach existing data to its tenant, and add the indexes the
-- tenant-scoped queries will need. Strictly additive and idempotent -- nothing
-- here drops a constraint or an index (see section 3 for why that was split
-- out).
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

-- ── 3. DEFERRED: converting global unique indexes to per-tenant ────────────
--
-- This migration originally dropped the global unique constraints below and
-- replaced them with (client_id, ...) composites. That is the correct end state
-- -- without it a second tenant cannot hold a customer the first tenant already
-- has -- but shipping it alone BREAKS PRODUCTION, because ~10 code paths use
-- `ON CONFLICT (<col>)` and Postgres resolves that against a matching unique
-- index. Drop the index and every one of them raises:
--
--     ERROR: there is no unique or exclusion constraint matching the
--            ON CONFLICT specification
--
-- Verified against a production schema clone. The breakage is not theoretical:
--
--   suppression_list_email_key   unsubscribe.js:10, leads.js:719, admin.js:600,
--                                api.js:245, sequences.js:319
--                                -> unsubscribe stops working (compliance)
--   orders_shopify_order_id_key  webhook.js:94
--                                -> Shopify orders stop being ingested (revenue)
--   idx_leads_phone              retell.js:136 (whose comment names the index)
--                                -> inbound call handling breaks
--   users_email_key              auth.js:49, auth.js:275, setup.js:18
--                                -> Google auto-provisioning breaks
--   salespeople_email_key        no current ON CONFLICT, but same class of risk
--
-- The conversion must land in ONE change together with rewriting each of those
-- call sites to target the composite index and to supply client_id -- work that
-- naturally belongs with the tenant-scoping pass over the query layer, since
-- those same statements are being rewritten there anyway.
--
-- Doing it now is cheap ONLY while a single tenant exists (verified: zero
-- duplicate phone values), so it should happen early in that pass rather than
-- being left until real conflicting data exists. Tracked as P0-8.
--
-- What stays below is additive and safe: non-unique indexes that the
-- tenant-scoped queries will need regardless.

CREATE INDEX IF NOT EXISTS idx_leads_client_email_lookup
  ON leads (client_id, LOWER(email));

-- When the conversion above is eventually done, these stay GLOBAL on purpose:
--   client_auth_domains.domain       global uniqueness is the point; it
--                                    guarantees a domain maps to one tenant
--   clients.slug, organizations.slug tenant identifiers
--   *_token, *_pixel_token           UUIDs, no collision risk
--   phone_calls.callrail_id,
--   call_logs.retell_call_id         external vendor ids

-- ── 4. Indexes the tenant-scoped queries will need ─────────────────────────
-- Every statement below is wrapped in a table-existence guard. Migration 001
-- does NOT do this -- its DO block checks for the COLUMN but not the TABLE. All
-- of these are plain additive indexes: no constraint is dropped, so no
-- ON CONFLICT target changes meaning (see the deferral note above).
DO $$
BEGIN
  IF to_regclass('public.leads') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_leads_client_stage ON leads (client_id, stage);
  END IF;
  IF to_regclass('public.salespeople') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_salespeople_client ON salespeople (client_id, active);
  END IF;
  IF to_regclass('public.orders') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_orders_client_ordered_at ON orders (client_id, ordered_at DESC);
  END IF;
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
