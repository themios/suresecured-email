-- Migration 002: Commission engine schema safety net + performance indexes
-- All statements are idempotent

-- Safety net: client_id should already exist on these tables via 001's DO $$ loop,
-- but verify/add defensively since DATABASE_URL was a placeholder during 001 authoring.
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE orders      ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;

-- Indexes for monthly tiered-commission queries (DATE_TRUNC('month', ...) lookups)
CREATE INDEX IF NOT EXISTS idx_commissions_sp_client_month
  ON commissions (salesperson_id, client_id, created_at);

CREATE INDEX IF NOT EXISTS idx_orders_sp_client_month
  ON orders (salesperson_id, client_id, ordered_at);
