// src/routes/billing.js — self-serve plan picker + Stripe Checkout handoff.
// The subscription record itself (client_subscriptions) is written ONLY by the
// Stripe webhook (src/routes/webhook.js), never here -- this route just starts
// a checkout session and shows the tenant's current status.
const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const { requireAuth, requireTenantContext } = require('../middleware/auth');
const { shell, esc } = require('../lib/layout');
const { stripeEnabled, createCheckoutSession } = require('../lib/stripe');

router.use(requireAuth, requireTenantContext);

const PLANS = [
  { key: 'managed',    name: 'Fully Managed',        price: '$499/month',              blurb: 'We set it up and run it for you.' },
  { key: 'diy',        name: 'We Build It, You Run It', price: '$199/month + $999 one-time setup', blurb: 'We stand it up, hand it over, you drive.' },
  { key: 'self_serve', name: 'Self-Serve',           price: '$199/month',               blurb: 'Run the platform yourself, no setup fee.' },
];

router.get('/', async (req, res) => {
  const clientId = req.user.client_id;
  const { rows } = await pool.query('SELECT * FROM client_subscriptions WHERE client_id = $1', [clientId]);
  const sub = rows[0];

  const statusBadge = sub && sub.status === 'active'
    ? `<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">Active</span>`
    : sub && sub.status === 'past_due'
    ? `<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Payment failed</span>`
    : sub && sub.status === 'canceled'
    ? `<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-500">Canceled</span>`
    : `<span class="px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-500">No active plan</span>`;

  const configNotice = !stripeEnabled()
    ? `<div class="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 text-sm text-amber-800">Billing is not configured yet. Checkout links will not work until Stripe keys are added.</div>`
    : '';

  const planCards = PLANS.map(p => `
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
      <h3 class="font-semibold text-slate-900">${esc(p.name)}</h3>
      <p class="text-2xl font-bold text-slate-800 mt-1">${esc(p.price)}</p>
      <p class="text-sm text-slate-500 mt-2">${esc(p.blurb)}</p>
      <form method="POST" action="/billing/checkout" class="mt-4">
        <input type="hidden" name="plan" value="${p.key}">
        <button type="submit" class="w-full bg-sky-600 text-white text-sm font-medium rounded-lg px-4 py-2.5 hover:bg-sky-700"
          ${sub?.plan === p.key && sub?.status === 'active' ? 'disabled' : ''}>
          ${sub?.plan === p.key && sub?.status === 'active' ? 'Current plan' : 'Choose this plan'}
        </button>
      </form>
    </div>`).join('');

  const content = `
    <div class="px-6 py-8 max-w-5xl mx-auto">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-slate-900">Billing</h1>
          <p class="text-sm text-slate-400 mt-0.5">Current plan: ${sub?.plan ? esc(sub.plan) : 'none'} ${statusBadge}</p>
        </div>
      </div>
      ${configNotice}
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">${planCards}</div>
    </div>`;

  res.send(shell('Billing', 'billing', content, { user: req.user }));
});

router.post('/checkout', express.urlencoded({ extended: false }), async (req, res) => {
  const clientId = req.user.client_id;
  const plan = req.body.plan;
  if (!['managed', 'diy', 'self_serve'].includes(plan)) {
    return res.redirect('/billing?ok=0&msg=' + encodeURIComponent('Unknown plan.'));
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const result = await createCheckoutSession({
    clientId,
    plan,
    customerEmail: req.user.email,
    successUrl: `${origin}/billing?ok=1&msg=` + encodeURIComponent('Subscription started.'),
    cancelUrl: `${origin}/billing?ok=0&msg=` + encodeURIComponent('Checkout canceled.'),
  });

  if (!result.ok) {
    return res.redirect('/billing?ok=0&msg=' + encodeURIComponent(result.error));
  }
  res.redirect(result.url);
});

module.exports = router;
