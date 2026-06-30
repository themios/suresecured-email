-- Migration 001: Add multi-tenant schema
-- All statements are idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING / DO $$ blocks)

-- 1. organizations
CREATE TABLE IF NOT EXISTS organizations (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. clients (one org can have many clients / brands)
CREATE TABLE IF NOT EXISTS clients (
  id                   SERIAL PRIMARY KEY,
  organization_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  slug                 TEXT NOT NULL UNIQUE,
  brand_config         JSONB NOT NULL DEFAULT '{}',
  commission_rules     JSONB NOT NULL DEFAULT '{}',
  integration_settings JSONB NOT NULL DEFAULT '{}',
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. users (replaces admin_users for multi-role auth)
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('operator','owner','admin','salesperson')),
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Add client_id to all 17 existing tables (idempotent via DO block)
DO $$
DECLARE
  tbl TEXT;
  tbls TEXT[] := ARRAY[
    'salespeople','leads','tracking_tokens','clicks','form_submissions',
    'orders','commissions','admin_users','salesperson_goals','phone_calls',
    'suppression_list','landing_page_matrix','email_accounts','sequences',
    'sequence_steps','contact_enrollments','email_sends'
  ];
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = tbl AND column_name = 'client_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL', tbl);
    END IF;
  END LOOP;
END $$;

-- 5. Partial index for cron scale (idempotent)
CREATE INDEX IF NOT EXISTS idx_contact_enrollments_active_next
  ON contact_enrollments (next_send_at)
  WHERE status = 'active';

-- 6. Seed operator account and SureSecured org+client (idempotent)
INSERT INTO organizations (name, slug) VALUES ('SureSecured', 'suresecured')
  ON CONFLICT (slug) DO NOTHING;

INSERT INTO clients (organization_id, name, slug, brand_config)
VALUES (
  (SELECT id FROM organizations WHERE slug = 'suresecured'),
  'SureSecured',
  'suresecured',
  '{
    "primary_color": "#030302",
    "accent_color": "#E91111",
    "bg_color": "#EDEBE7",
    "info_color": "#CBDEE8",
    "name": "SureSecured",
    "phone": "(747) 688-9992",
    "website": "suresecured.com",
    "address": "SureSecured Security Products • Simi Valley, CA 93063",
    "cta_url": "https://suresecured.com/pages/request-a-quote",
    "cta_label": "Request a Quote"
  }'
) ON CONFLICT (slug) DO NOTHING;
