-- Migration 014: name-based attribution suggestion on orders
-- When strong signals (token/email/phone) don't resolve an order, a fuzzy name
-- match can SUGGEST a rep for a human to confirm. It never auto-credits.
-- Additive and idempotent.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS suggested_salesperson_id INTEGER REFERENCES salespeople(id) ON DELETE SET NULL;
