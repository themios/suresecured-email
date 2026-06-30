const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  // Run tenancy migration first (idempotent)
  const migrationSql = fs.readFileSync(
    path.join(__dirname, '../migrations/001_add_tenancy.sql'),
    'utf8'
  );
  await pool.query(migrationSql);


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
  `);

  // Email campaign tables
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

  await seedLandingPageMatrix();

  console.log('Database tables ready.');
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
