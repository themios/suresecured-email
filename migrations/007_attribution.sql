-- 007_attribution.sql — first-touch salesperson ownership + commission audit trail

ALTER TABLE leads ADD COLUMN IF NOT EXISTS attributed_salesperson_id INTEGER REFERENCES salespeople(id);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS attributed_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS attribution_source VARCHAR(50);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS attribution_locked BOOLEAN DEFAULT false;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_email BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_sms BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_email_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_sms_at TIMESTAMPTZ;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission_status VARCHAR(20) DEFAULT 'credited';

CREATE TABLE IF NOT EXISTS commission_events (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  salesperson_id INTEGER REFERENCES salespeople(id),
  client_id INTEGER REFERENCES clients(id),
  resolution_path TEXT NOT NULL,
  sale_amount NUMERIC(10,2),
  commission_earned NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_attributed_sp ON leads(attributed_salesperson_id);
CREATE INDEX IF NOT EXISTS idx_commission_events_order ON commission_events(order_id);
