-- Migration 022: billing scaffold for Phase 2 (self-serve + subscription
-- tracking). One row per tenant. Plan and status are driven by Stripe webhook
-- events, never set directly by the app, so this table is a mirror of Stripe's
-- own state rather than a second source of truth for it.
CREATE TABLE IF NOT EXISTS client_subscriptions (
  id                    SERIAL PRIMARY KEY,
  client_id             INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE UNIQUE,
  plan                  VARCHAR(30),      -- 'managed' | 'diy' | 'self_serve'
  status                VARCHAR(30) NOT NULL DEFAULT 'none', -- 'none' | 'active' | 'past_due' | 'canceled' | 'incomplete'
  stripe_customer_id    VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  setup_fee_paid        BOOLEAN NOT NULL DEFAULT false,
  current_period_end    TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_subscriptions_stripe_customer ON client_subscriptions (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_client_subscriptions_stripe_sub ON client_subscriptions (stripe_subscription_id);
