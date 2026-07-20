const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// TLS: in production, encrypt by default. Set DB_SSL_REJECT_UNAUTHORIZED=true
// (optionally with DB_SSL_CA = PEM cert) to also authenticate the server cert
// and defeat MITM. Left permissive by default so managed hosts whose cert chain
// isn't trusted out of the box keep working.
function dbSsl() {
  if (process.env.NODE_ENV !== 'production') return false;
  const strict = process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true';
  const ca = process.env.DB_SSL_CA;
  return { rejectUnauthorized: strict, ...(ca ? { ca } : {}) };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: dbSsl(),
});

/**
 * Schema bootstrap. The phase order is load-bearing — do not collapse it.
 *
 *   PHASE 0  createTenancyCore()        migration 001, table-guarded
 *              └─ creates organizations / clients / users ONLY.
 *                 Its ALTER loop skips every table that does not exist yet.
 *
 *   PHASE 1  createBaseTables()         salespeople, leads, orders, email_sends…
 *              └─ plus client_email_config + lead_notes, which need `clients`
 *                 from phase 0 to satisfy their REFERENCES.
 *
 *   PHASE 2  runMigrations()            001..016, in full
 *              └─ 001 runs a SECOND time. It is idempotent, and this is the
 *                 pass where its ALTERs actually apply, now that phase 1 has
 *                 created the tables they target.
 *
 *   PHASE 3  postMigrationAlters()      columns on migration-created tables
 *              └─ e.g. call_logs, which migration 006 creates.
 *
 * Why two passes over 001: the dependency is genuinely circular.
 *
 *     migration 001 ──needs──> salespeople, leads, …   (created in phase 1)
 *     client_email_config ──needs──> clients            (created by 001)
 *
 * Splitting 001 into "create the tenancy tables" and "attach client_id to
 * everything else" breaks the cycle without duplicating any schema definition.
 *
 * Before this, ALL migrations ran BEFORE any inline CREATE TABLE, so a fresh
 * database died on migration 001 with `relation "salespeople" does not exist`.
 * Because a migration file executes as one implicit transaction, that rolled
 * back everything — including the clients table 001 had just created — leaving
 * ZERO tables. Production only worked because its schema predated the current
 * ordering. That meant no new environment could be created and a restore from
 * backup could not boot, so disaster recovery did not actually work.
 *
 * Every phase is idempotent (IF NOT EXISTS / guarded DO blocks), so this runs
 * unchanged against both an empty and a fully-populated database.
 */
async function initDb() {
  await createTenancyCore();
  await createBaseTables();
  await createTenantScopedTables();
  await runMigrations();
  await postMigrationAlters();
  await seedLandingPageMatrix();
  console.log('Database tables ready.');
}

// ── PHASE 0: tenancy core ─────────────────────────────────────────────────
// Runs migration 001 against a possibly-empty database. Its ALTER loop and its
// contact_enrollments index are both guarded by to_regclass(), so on an empty
// database this creates organizations/clients/users and skips everything else.
// On an existing database it is a no-op.
async function createTenancyCore() {
  const sql = fs.readFileSync(
    path.join(__dirname, '../migrations/001_add_tenancy.sql'),
    'utf8'
  );
  await pool.query(sql);
}

// ── PHASE 3: columns on migration-created tables ──────────────────────────
// These target tables that the migrations create, so they cannot run in phase 1.
async function postMigrationAlters() {
  // call_logs is created by migration 006.
  await pool.query(`
    ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS salesperson_id INTEGER REFERENCES salespeople(id);
  `);
}

// ── PHASE 2: versioned migration files ────────────────────────────────────
// Runs after createBaseTables() so the ALTER TABLE statements in 001 have
// something to alter, and before createTenantScopedTables() so `clients` exists
// for those tables to reference.
async function runMigrations() {
  // Run tenancy migration first (idempotent)
  const migrationSql = fs.readFileSync(
    path.join(__dirname, '../migrations/001_add_tenancy.sql'),
    'utf8'
  );
  await pool.query(migrationSql);

  // Run commission engine migration (idempotent)
  const migration002Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/002_commission_engine.sql'),
    'utf8'
  );
  await pool.query(migration002Sql);

  // Run email deliverability migration (idempotent)
  const migration003Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/003_email_deliverability.sql'),
    'utf8'
  );
  await pool.query(migration003Sql);

  // Run AI intelligence migration (idempotent)
  const migration005Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/005_ai_intelligence.sql'),
    'utf8'
  );
  await pool.query(migration005Sql);

  // Run voice migration (idempotent)
  const migration006Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/006_voice.sql'),
    'utf8'
  );
  await pool.query(migration006Sql);

  const migration007Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/007_attribution.sql'),
    'utf8'
  );
  await pool.query(migration007Sql);

  const migration008Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/008_send_limits.sql'),
    'utf8'
  );
  await pool.query(migration008Sql);

  // Run AI agent system migration (idempotent) — event bus, per-tenant
  // enablement, run/cost log, approval queue, reporting output.
  const migration009Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/009_agent_system.sql'),
    'utf8'
  );
  await pool.query(migration009Sql);

  // Lead segmentation (idempotent) — engagement tier label written by the
  // Segmentation agent.
  const migration010Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/010_lead_segment.sql'),
    'utf8'
  );
  await pool.query(migration010Sql);

  // Research (enrichment) + campaign planning agents (idempotent).
  const migration011Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/011_agent_research_planning.sql'),
    'utf8'
  );
  await pool.query(migration011Sql);

  // Multiple email intake sources + sender rules (idempotent).
  const migration012Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/012_email_sources.sql'),
    'utf8'
  );
  await pool.query(migration012Sql);

  // Per-tenant Google sign-in domains for auto-join (idempotent).
  const migration013Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/013_auth_domains.sql'),
    'utf8'
  );
  await pool.query(migration013Sql);

  // Name-based attribution suggestion on orders (idempotent).
  const migration014Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/014_order_suggested_salesperson.sql'),
    'utf8'
  );
  await pool.query(migration014Sql);

  // Attach pre-tenancy rows to their tenant, and convert the global unique
  // indexes that would block a second one (idempotent). Must run before route
  // queries are tenant-scoped, or the backfilled rows go invisible.
  const migration015Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/015_tenant_backfill.sql'),
    'utf8'
  );
  await pool.query(migration015Sql);

  // Delivery feedback: persist WHY a send failed, and track identity-level
  // health so a broken mailbox surfaces to the operator instead of failing
  // silently (idempotent).
  const migration016Sql = fs.readFileSync(
    path.join(__dirname, '../migrations/016_delivery_feedback.sql'),
    'utf8'
  );
  await pool.query(migration016Sql);
}

// ── PHASE 1: base tables ──────────────────────────────────────────────────
// Every table here is free of any `REFERENCES clients(...)`, so it can be built
// on an empty database before migration 001 exists to create `clients`. The 17
// tables migration 001 adds client_id to must ALL be created in this phase.
async function createBaseTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS salespeople (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255),
      commission_rate NUMERIC(5,2) DEFAULT 100.00,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      phone VARCHAR(50),
      city VARCHAR(255),
      audience_type VARCHAR(10) DEFAULT 'B2C',
      product_interest VARCHAR(255),
      salesperson_id INTEGER REFERENCES salespeople(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tracking_tokens (
      id SERIAL PRIMARY KEY,
      token UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
      lead_id INTEGER REFERENCES leads(id),
      salesperson_id INTEGER REFERENCES salespeople(id),
      campaign_id VARCHAR(255),
      email_step INTEGER,
      destination_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS clicks (
      id SERIAL PRIMARY KEY,
      token UUID NOT NULL,
      lead_id INTEGER REFERENCES leads(id),
      salesperson_id INTEGER REFERENCES salespeople(id),
      ip_address VARCHAR(50),
      user_agent TEXT,
      referrer TEXT,
      clicked_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS form_submissions (
      id SERIAL PRIMARY KEY,
      token UUID,
      lead_id INTEGER REFERENCES leads(id),
      salesperson_id INTEGER REFERENCES salespeople(id),
      form_type VARCHAR(50),
      submitter_email VARCHAR(255),
      submitter_name VARCHAR(255),
      raw_data JSONB,
      submitted_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      shopify_order_id VARCHAR(255) UNIQUE,
      token UUID,
      lead_id INTEGER REFERENCES leads(id),
      salesperson_id INTEGER REFERENCES salespeople(id),
      customer_email VARCHAR(255),
      amount NUMERIC(10,2),
      currency VARCHAR(10) DEFAULT 'USD',
      order_data JSONB,
      ordered_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS commissions (
      id SERIAL PRIMARY KEY,
      salesperson_id INTEGER REFERENCES salespeople(id),
      source_type VARCHAR(50),
      source_id INTEGER,
      sale_amount NUMERIC(10,2),
      commission_rate NUMERIC(5,2),
      commission_earned NUMERIC(10,2),
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Email campaign tables. These must be created BEFORE the ALTER TABLE
  // blocks below, several of which target email_sends. Ordering here is not
  // cosmetic: on a fresh database an ALTER against a not-yet-created table
  // aborts the whole boot.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_accounts (
      id SERIAL PRIMARY KEY,
      salesperson_id INTEGER REFERENCES salespeople(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      oauth_refresh_token TEXT,
      oauth_access_token TEXT,
      oauth_token_expiry TIMESTAMPTZ,
      enabled BOOLEAN DEFAULT true,
      last_error TEXT,
      connected_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(salesperson_id)
    );

    CREATE TABLE IF NOT EXISTS sequences (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      audience_type VARCHAR(10) DEFAULT 'B2C',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sequence_steps (
      id SERIAL PRIMARY KEY,
      sequence_id INTEGER REFERENCES sequences(id) ON DELETE CASCADE,
      step_number INTEGER NOT NULL,
      delay_days INTEGER NOT NULL DEFAULT 0,
      subject VARCHAR(500) NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(sequence_id, step_number)
    );

    CREATE TABLE IF NOT EXISTS contact_enrollments (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      sequence_id INTEGER REFERENCES sequences(id) ON DELETE CASCADE,
      salesperson_id INTEGER REFERENCES salespeople(id),
      status VARCHAR(20) DEFAULT 'active',
      current_step INTEGER DEFAULT 0,
      enrolled_at TIMESTAMPTZ DEFAULT NOW(),
      next_send_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      paused_reason VARCHAR(50),
      UNIQUE(lead_id, sequence_id)
    );

    CREATE TABLE IF NOT EXISTS email_sends (
      id SERIAL PRIMARY KEY,
      enrollment_id INTEGER REFERENCES contact_enrollments(id) ON DELETE CASCADE,
      step_id INTEGER REFERENCES sequence_steps(id),
      salesperson_id INTEGER REFERENCES salespeople(id),
      lead_id INTEGER REFERENCES leads(id),
      to_email VARCHAR(255),
      subject TEXT,
      gmail_message_id VARCHAR(255),
      gmail_thread_id VARCHAR(255),
      status VARCHAR(20) DEFAULT 'sent',
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      opened_at TIMESTAMPTZ,
      replied_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS portal_password_hash VARCHAR(255);

    CREATE TABLE IF NOT EXISTS salesperson_goals (
      id SERIAL PRIMARY KEY,
      salesperson_id INTEGER REFERENCES salespeople(id) ON DELETE CASCADE,
      period_start DATE NOT NULL,
      period_type VARCHAR(20) DEFAULT 'monthly',
      target_revenue NUMERIC(10,2) DEFAULT 0,
      target_orders INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(salesperson_id, period_start)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS phone_calls (
      id SERIAL PRIMARY KEY,
      salesperson_id INTEGER REFERENCES salespeople(id),
      lead_id INTEGER REFERENCES leads(id),
      tracking_number VARCHAR(50),
      caller_number VARCHAR(50),
      duration_seconds INTEGER DEFAULT 0,
      recording_url TEXT,
      callrail_id VARCHAR(255) UNIQUE,
      called_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS suppression_list (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      reason VARCHAR(50) DEFAULT 'existing_customer',
      added_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS landing_page_matrix (
      id SERIAL PRIMARY KEY,
      audience_type VARCHAR(10),
      product_interest VARCHAR(50),
      location_type VARCHAR(50),
      intent_level VARCHAR(20),
      angle VARCHAR(50),
      destination_url TEXT NOT NULL,
      label VARCHAR(255),
      active BOOLEAN DEFAULT true
    );

    -- Add tracking_number column to salespeople if not exists
    ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS tracking_phone_number VARCHAR(50);
    ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS callrail_number_id VARCHAR(255);
    ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
    ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS title VARCHAR(255);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS reply_category VARCHAR(50);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS reply_urgency VARCHAR(10);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS reply_summary TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS reply_classified_at TIMESTAMPTZ;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
    ALTER TABLE salespeople ADD COLUMN IF NOT EXISTS voice_extension VARCHAR(20);
    -- NOTE: the ALTER TABLE call_logs statement lives in
    -- createTenantScopedTables(), not here. call_logs is created by migration
    -- 006, which has not run yet at this point in the boot sequence.

    -- CRM pipeline stage on leads
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS stage VARCHAR(30) DEFAULT 'new';
  `);

  // SES / multi-provider sending columns
  await pool.query(`
    ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS send_service VARCHAR(20) DEFAULT 'gmail';
  `);

  // Email tracking columns (open/click pixel, bounce handling)
  await pool.query(`
    ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS pixel_token VARCHAR(255);
    ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS open_count INTEGER DEFAULT 0;
    ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS click_count INTEGER DEFAULT 0;
    ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS bounced BOOLEAN DEFAULT false;
    ALTER TABLE email_sends ADD COLUMN IF NOT EXISTS bounce_error TEXT;
  `);

  // Full reply text storage on lead
  await pool.query(`
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS reply_text TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS reply_subject VARCHAR(500);
  `);


  // Test mode: delay_minutes overrides delay_days when set
  await pool.query(`
    ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS delay_minutes INTEGER;
  `);



  // Prospective agency clients captured from the public marketing site.
  // Deliberately separate from `leads` (a tenant's own contacts) — no client_id,
  // these people don't belong to a tenant yet.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_leads (
      id SERIAL PRIMARY KEY,
      business_name VARCHAR(255) NOT NULL,
      contact_name VARCHAR(255),
      trade VARCHAR(100),
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      list_size VARCHAR(50),
      message TEXT,
      source VARCHAR(100) DEFAULT 'landing_page',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

}

// ── PHASE 3: tables that reference `clients` ──────────────────────────────
// These cannot be created until migration 001 has created the clients table, so
// they are deliberately built AFTER runMigrations() rather than alongside the
// base tables. Keep this list minimal: anything that does not need a clients FK
// belongs in createBaseTables().
async function createTenantScopedTables() {
  // Per-tenant email provider config (SMTP + IMAP, encrypted credentials)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_email_config (
      id               SERIAL PRIMARY KEY,
      client_id        INTEGER REFERENCES clients(id) ON DELETE CASCADE UNIQUE,
      provider         VARCHAR(30) NOT NULL DEFAULT 'smtp',
      smtp_host        VARCHAR(255),
      smtp_port        INTEGER DEFAULT 587,
      smtp_secure      BOOLEAN DEFAULT false,
      smtp_user        VARCHAR(255),
      smtp_pass_enc    TEXT,
      from_name        VARCHAR(255),
      from_email       VARCHAR(255),
      reply_to         VARCHAR(255),
      imap_host        VARCHAR(255),
      imap_port        INTEGER DEFAULT 993,
      imap_user        VARCHAR(255),
      imap_pass_enc    TEXT,
      enabled          BOOLEAN DEFAULT true,
      last_error       TEXT,
      last_tested_at   TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Permanent unsubscribe flag — survives suppression list cleanup
  await pool.query(`
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS unsubscribed BOOLEAN DEFAULT false;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ;
  `);

  // Track direct (non-sequence) emails sent via reply composer for reply detection
  await pool.query(`
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS direct_email_thread_id TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS direct_email_salesperson_id INTEGER;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
  `);

  // Inbound lead capture config on client email config
  await pool.query(`
    ALTER TABLE client_email_config ADD COLUMN IF NOT EXISTS inbound_capture_enabled BOOLEAN DEFAULT false;
    ALTER TABLE client_email_config ADD COLUMN IF NOT EXISTS inbound_sequence_id INTEGER;
    ALTER TABLE client_email_config ADD COLUMN IF NOT EXISTS inbound_last_check_at TIMESTAMPTZ;
  `);

  // CRM notes / activity log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_notes (
      id           SERIAL PRIMARY KEY,
      lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      client_id    INTEGER REFERENCES clients(id),
      author_name  VARCHAR(255),
      content      TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lead_notes_lead_id ON lead_notes(lead_id);
  `);
}

async function seedLandingPageMatrix() {
  const existing = await pool.query('SELECT COUNT(*) FROM landing_page_matrix');
  if (parseInt(existing.rows[0].count) > 0) return;

  const rows = [
    ['B2C', 'door',    null,       'normal',   'product',    '/products/double-french-security-screen-doors', 'B2C – Door interest'],
    ['B2C', 'window',  null,       'normal',   'product',    '/products/fixed-security-screen-windows',       'B2C – Window interest'],
    ['B2C', 'both',    null,       'normal',   'product',    '/collections/all',                              'B2C – Door + Window'],
    ['B2C', null,      'la_county','normal',   'install',    '/pages/installations',                          'B2C – LA County (pro install)'],
    ['B2C', null,      'national', 'normal',   'diy',        '/collections/all',                              'B2C – Nationwide (DIY/shipping)'],
    ['B2C', null,      null,       'high',     'close',      '/pages/request-a-quote',                        'B2C – High intent (close)'],
    ['B2C', null,      null,       'normal',   'financing',  '/pages/financing',                              'B2C – Financing angle'],
    ['B2C', null,      null,       'normal',   'reconnect',  '/',                                             'B2C – Generic reconnect'],
    ['B2B', null,      null,       'normal',   'dealer',     '/pages/become-a-dealer',                        'B2B – Dealer CTA'],
    ['B2B', null,      null,       'high',     'close',      '/pages/become-a-dealer',                        'B2B – High intent close'],
  ];

  for (const [audience_type, product_interest, location_type, intent_level, angle, destination_url, label] of rows) {
    await pool.query(
      `INSERT INTO landing_page_matrix
         (audience_type, product_interest, location_type, intent_level, angle, destination_url, label)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [audience_type, product_interest, location_type, intent_level, angle, destination_url, label]
    );
  }
}

module.exports = { pool, initDb };
