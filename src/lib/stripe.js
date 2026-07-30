/**
 * Stripe billing. Mirrors the sesEnabled()-style pattern used elsewhere in
 * this codebase: every function degrades gracefully (returns null / a clear
 * error) when STRIPE_SECRET_KEY isn't set, so the app runs fine before
 * billing is configured, and the same code path works in Stripe test mode
 * and live mode -- only the key changes.
 */
const Stripe = require('stripe');

function stripeEnabled() {
  return !!process.env.STRIPE_SECRET_KEY;
}

let _client = null;
function getStripeClient() {
  if (!stripeEnabled()) return null;
  if (!_client) _client = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _client;
}

// Plan -> env vars holding the Stripe Price ID(s) for that plan. A plan can
// have a recurring price and, for 'diy', an additional one-time setup price.
const PLAN_PRICE_ENV = {
  managed:    { recurring: 'STRIPE_PRICE_MANAGED' },
  diy:        { recurring: 'STRIPE_PRICE_DIY', oneTime: 'STRIPE_PRICE_DIY_SETUP' },
  self_serve: { recurring: 'STRIPE_PRICE_SELF_SERVE' },
};

function planPriceIds(plan) {
  const cfg = PLAN_PRICE_ENV[plan];
  if (!cfg) return null;
  const recurring = process.env[cfg.recurring];
  const oneTime = cfg.oneTime ? process.env[cfg.oneTime] : null;
  if (!recurring) return null; // price not configured yet
  return { recurring, oneTime };
}

/**
 * Create a Stripe Checkout Session for a plan and return its URL. Mixes a
 * one-time setup line item into a subscription-mode session when the plan has
 * one (Stripe supports this: the one-time price bills once on the first
 * invoice, the recurring price continues after).
 */
async function createCheckoutSession({ clientId, plan, customerEmail, successUrl, cancelUrl }) {
  const stripe = getStripeClient();
  if (!stripe) return { ok: false, error: 'Billing is not configured yet.' };

  const prices = planPriceIds(plan);
  if (!prices) return { ok: false, error: 'This plan is not available yet.' };

  const lineItems = [{ price: prices.recurring, quantity: 1 }];
  if (prices.oneTime) lineItems.push({ price: prices.oneTime, quantity: 1 });

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: lineItems,
    customer_email: customerEmail || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
    // client_reference_id + metadata both carry the tenant, so the webhook
    // can resolve it regardless of which Stripe object it receives first.
    client_reference_id: String(clientId),
    subscription_data: { metadata: { client_id: String(clientId), plan } },
    metadata: { client_id: String(clientId), plan },
  });

  return { ok: true, url: session.url };
}

/** Verify and parse a Stripe webhook payload. Requires the RAW request body. */
function constructWebhookEvent(rawBody, signature) {
  const stripe = getStripeClient();
  if (!stripe) throw new Error('Stripe not configured');
  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

module.exports = { stripeEnabled, getStripeClient, planPriceIds, createCheckoutSession, constructWebhookEvent };
