const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDb() {
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

  console.log('Database tables ready.');
}

module.exports = { pool, initDb };
