const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireSpAuth } = require('../middleware/spAuth');
const { calculateCommission } = require('../lib/commissions');

// ─── Login ─────────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  const error = req.query.error
    ? '<div class="bg-red-50 text-red-600 text-sm rounded-lg p-3 mb-4">Invalid email or password.</div>'
    : '';
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>SureSecured — Salesperson Portal</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2/dist/tailwind.min.css" rel="stylesheet">
</head>
<body class="bg-gradient-to-br from-blue-900 to-gray-900 min-h-screen flex items-center justify-center">
  <div class="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-sm mx-4">
    <div class="text-center mb-6">
      <div class="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-3">
        <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
        </svg>
      </div>
      <h1 class="text-xl font-bold text-gray-800">Salesperson Portal</h1>
      <p class="text-gray-400 text-sm mt-1">SureSecured</p>
    </div>
    ${error}
    <form method="POST" action="/portal/login" class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Email</label>
        <input type="email" name="email" required autofocus
          class="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Password</label>
        <input type="password" name="password" required
          class="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      </div>
      <button type="submit"
        class="w-full bg-blue-600 text-white rounded-xl py-2.5 text-sm font-semibold hover:bg-blue-700 transition">
        Sign In
      </button>
    </form>
    <p class="text-center text-xs text-gray-400 mt-6">Contact your manager if you need access.</p>
  </div>
</body>
</html>`);
});

router.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query(
      'SELECT * FROM salespeople WHERE email = $1 AND active = true',
      [email]
    );
    if (!result.rows.length) return res.redirect('/portal/login?error=1');

    const sp = result.rows[0];
    if (!sp.portal_password_hash) return res.redirect('/portal/login?error=1');

    const valid = await bcrypt.compare(password, sp.portal_password_hash);
    if (!valid) return res.redirect('/portal/login?error=1');

    const token = jwt.sign(
      { id: sp.id, name: sp.name, email: sp.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('sp_token', token, {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    });

    res.redirect('/portal');
  } catch (err) {
    console.error('Portal login error:', err);
    res.redirect('/portal/login?error=1');
  }
});

router.get('/logout', (req, res) => {
  res.clearCookie('sp_token');
  res.redirect('/portal/login');
});

// ─── Portal Dashboard ──────────────────────────────────────────────────────

router.get('/', requireSpAuth, async (req, res) => {
  const spId = req.salesperson.id;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  try {
    const [sp, thisMonth, allTime, goal, monthlyHistory, recentActivity, recentClicks, tierContext, payoutSplit, topLeads] = await Promise.all([

      // Salesperson info
      pool.query('SELECT * FROM salespeople WHERE id = $1', [spId]),

      // This month stats
      pool.query(`
        SELECT
          COALESCE(SUM(o.amount), 0)            AS revenue,
          COUNT(DISTINCT o.id)                   AS orders,
          COALESCE(SUM(cm.commission_earned), 0) AS commission,
          COUNT(DISTINCT c.id)                   AS clicks,
          COUNT(DISTINCT fs.id)                  AS forms,
          COUNT(DISTINCT pc.id)                  AS calls
        FROM salespeople s
        LEFT JOIN orders o  ON o.salesperson_id  = s.id AND DATE(o.ordered_at)    BETWEEN $2 AND $3
        LEFT JOIN commissions cm ON cm.salesperson_id = s.id
          AND cm.created_at BETWEEN $2::timestamptz AND ($3::date + interval '1 day')::timestamptz
        LEFT JOIN clicks c  ON c.salesperson_id  = s.id AND DATE(c.clicked_at)    BETWEEN $2 AND $3
        LEFT JOIN form_submissions fs ON fs.salesperson_id = s.id AND DATE(fs.submitted_at) BETWEEN $2 AND $3
        LEFT JOIN phone_calls pc ON pc.salesperson_id = s.id AND DATE(pc.called_at) BETWEEN $2 AND $3
        WHERE s.id = $1
      `, [spId, monthStart, monthEnd]),

      // All-time totals
      pool.query(`
        SELECT
          COUNT(DISTINCT l.id)                   AS total_leads,
          COUNT(DISTINCT o.id)                   AS total_orders,
          COALESCE(SUM(o.amount), 0)             AS total_revenue,
          COALESCE(SUM(cm.commission_earned), 0) AS total_commission,
          COUNT(DISTINCT c.id)                   AS total_clicks
        FROM salespeople s
        LEFT JOIN leads l   ON l.salesperson_id  = s.id
        LEFT JOIN orders o  ON o.salesperson_id  = s.id
        LEFT JOIN commissions cm ON cm.salesperson_id = s.id
        LEFT JOIN clicks c  ON c.salesperson_id  = s.id
        WHERE s.id = $1
      `, [spId]),

      // Current month goal
      pool.query(`
        SELECT * FROM salesperson_goals
        WHERE salesperson_id = $1 AND period_start = $2
      `, [spId, monthStart]),

      // Last 6 months history
      pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('month', o.ordered_at), 'Mon YYYY') AS month,
          DATE_TRUNC('month', o.ordered_at) AS month_date,
          COALESCE(SUM(o.amount), 0)  AS revenue,
          COUNT(o.id)                 AS orders,
          COALESCE((
            SELECT target_revenue FROM salesperson_goals g
            WHERE g.salesperson_id = $1
            AND g.period_start = DATE_TRUNC('month', o.ordered_at)::date
          ), 0) AS goal
        FROM orders o
        WHERE o.salesperson_id = $1
        AND o.ordered_at >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', o.ordered_at)
        ORDER BY month_date DESC
      `, [spId]),

      // Recent form submissions and orders
      pool.query(`
        SELECT 'order' AS type, customer_email AS contact, amount::text AS value, ordered_at AS event_at
        FROM orders WHERE salesperson_id = $1
        UNION ALL
        SELECT 'form', submitter_email, form_type, submitted_at
        FROM form_submissions WHERE salesperson_id = $1
        ORDER BY event_at DESC LIMIT 20
      `, [spId]),

      // Recent email clicks
      pool.query(`
        SELECT c.clicked_at, l.first_name, l.last_name, l.email AS lead_email, c.user_agent
        FROM clicks c
        LEFT JOIN leads l ON l.id = c.lead_id
        WHERE c.salesperson_id = $1
        ORDER BY c.clicked_at DESC LIMIT 10
      `, [spId]),

      // Tier context: units this month + commission rules (scoped to client)
      pool.query(`
        SELECT
          c.commission_rules,
          s.commission_rate,
          COUNT(o.id) AS units_this_month
        FROM salespeople s
        JOIN clients c ON c.id = s.client_id
        LEFT JOIN orders o ON o.salesperson_id = s.id
          AND o.client_id = s.client_id
          AND DATE_TRUNC('month', o.ordered_at) = DATE_TRUNC('month', NOW())
        WHERE s.id = $1
        GROUP BY c.commission_rules, s.commission_rate
      `, [spId]),

      // Pending/paid payout split (scoped to client)
      pool.query(`
        SELECT
          SUM(commission_earned) FILTER (WHERE status = 'pending') AS pending_payout,
          SUM(commission_earned) FILTER (WHERE status = 'paid')    AS paid_total
        FROM commissions
        WHERE salesperson_id = $1
          AND client_id = $2
      `, [spId, req.salesperson.client_id]),

      // Top 5 leads by engagement_score — scoped via contact_enrollments.salesperson_id
      pool.query(`
        SELECT l.first_name, l.last_name, l.email, l.engagement_score
        FROM leads l
        JOIN contact_enrollments ce ON ce.lead_id = l.id
        WHERE ce.salesperson_id = $1 AND l.engagement_score > 0
        GROUP BY l.id, l.first_name, l.last_name, l.email, l.engagement_score
        ORDER BY l.engagement_score DESC
        LIMIT 5
      `, [spId]),
    ]);

    const info   = sp.rows[0];
    const tm     = thisMonth.rows[0];
    const at     = allTime.rows[0];
    const g      = goal.rows[0];
    const hist   = monthlyHistory.rows;

    const tier = tierContext.rows[0];
    const rules = tier?.commission_rules || {};
    const flatRate = tier?.commission_rate || 100;
    const unitsThisMonth = parseInt(tier?.units_this_month || 0);

    // Current tier rate: use unitsBefore = unitsThisMonth (since these units are already completed,
    // the "current" rate is what the NEXT sale would earn — matches operator mental model of "what tier am I in")
    const { rate: currentTierRate } = calculateCommission(0, unitsThisMonth, rules, flatRate);

    // Find next tier threshold for progress display
    const tiers = rules?.tiers || [];
    const nextTier = tiers.find(t => t.from >= unitsThisMonth);
    const unitsToNextTier = nextTier ? (nextTier.from - unitsThisMonth) : null;

    const payout = payoutSplit.rows[0];
    const pendingPayout = parseFloat(payout?.pending_payout || 0);
    const paidTotal = parseFloat(payout?.paid_total || 0);

    const scoreBadge = (score) => {
      const s = parseInt(score || 0);
      const bg    = s >= 60 ? '#dcfce7' : s >= 30 ? '#fef9c3' : '#f3f4f6';
      const color = s >= 60 ? '#166534' : s >= 30 ? '#854d0e' : '#6b7280';
      return `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;background:${bg};color:${color}">${s}</span>`;
    };

    const topLeadRows = topLeads.rows.length
      ? topLeads.rows.map(l => `
        <tr class="border-t hover:bg-gray-50 text-sm">
          <td class="px-4 py-2 font-medium text-gray-800">${l.first_name || ''} ${l.last_name || ''}</td>
          <td class="px-4 py-2 text-gray-500">${l.email}</td>
          <td class="px-4 py-2">${scoreBadge(l.engagement_score)}</td>
        </tr>`).join('')
      : '<tr><td colspan="3" class="px-4 py-4 text-center text-gray-400">No scored leads yet — run scoring cron to populate</td></tr>';

    const fmt    = n => '$' + parseFloat(n||0).toLocaleString('en-US', { minimumFractionDigits: 0 });
    const fmtD   = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

    const revenueGoal  = parseFloat(g?.target_revenue || 0);
    const revenueActual = parseFloat(tm.revenue || 0);
    const ordersGoal   = parseInt(g?.target_orders || 0);
    const ordersActual = parseInt(tm.orders || 0);
    const revPct  = revenueGoal > 0 ? Math.min(100, (revenueActual / revenueGoal * 100)).toFixed(1) : null;
    const ordPct  = ordersGoal  > 0 ? Math.min(100, (ordersActual  / ordersGoal  * 100)).toFixed(1) : null;

    const histRows = hist.map(h => {
      const gAmt = parseFloat(h.goal || 0);
      const rAmt = parseFloat(h.revenue || 0);
      const pct  = gAmt > 0 ? (rAmt / gAmt * 100).toFixed(0) : null;
      const color = !pct ? 'text-gray-400' : parseFloat(pct) >= 100 ? 'text-green-600' : parseFloat(pct) >= 70 ? 'text-yellow-600' : 'text-red-500';
      return `
        <tr class="border-t hover:bg-gray-50">
          <td class="px-4 py-3 text-sm font-medium text-gray-700">${h.month}</td>
          <td class="px-4 py-3 text-sm text-right font-semibold text-green-700">${fmt(h.revenue)}</td>
          <td class="px-4 py-3 text-sm text-right text-gray-500">${gAmt > 0 ? fmt(gAmt) : '—'}</td>
          <td class="px-4 py-3 text-sm text-right ${color} font-bold">${pct ? pct+'%' : '—'}</td>
          <td class="px-4 py-3 text-sm text-center text-gray-600">${h.orders}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="5" class="px-4 py-4 text-center text-gray-400">No order history yet</td></tr>';

    const activityRows = recentActivity.rows.map(a => {
      const isOrder = a.type === 'order';
      return `
        <div class="flex items-start gap-3 py-3 border-b last:border-0">
          <div class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${isOrder ? 'bg-green-100' : 'bg-blue-100'}">
            <span class="text-sm">${isOrder ? '💰' : '📋'}</span>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-gray-800">${isOrder ? 'Order — ' + fmt(a.value) : 'Quote Request — ' + (a.value || 'quote')}</p>
            <p class="text-xs text-gray-400 truncate">${a.contact || '—'}</p>
          </div>
          <div class="text-xs text-gray-400 flex-shrink-0">${fmtD(a.event_at)}</div>
        </div>`;
    }).join('') || '<p class="text-sm text-gray-400 py-4 text-center">No activity yet</p>';

    const clickRows = recentClicks.rows.map(c => `
      <tr class="border-t hover:bg-gray-50 text-sm">
        <td class="px-4 py-2 text-gray-500">${fmtD(c.clicked_at)}</td>
        <td class="px-4 py-2">${c.first_name ? c.first_name + ' ' + (c.last_name||'') : '—'}</td>
        <td class="px-4 py-2 text-gray-400 truncate max-w-xs">${c.lead_email || '—'}</td>
      </tr>`).join('') || '<tr><td colspan="3" class="px-4 py-4 text-center text-gray-400">No clicks yet</td></tr>';

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>My Portal — ${info.name}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2/dist/tailwind.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
</head>
<body class="bg-gray-100 min-h-screen">

  <!-- Nav -->
  <nav class="bg-white border-b px-6 py-3 flex justify-between items-center shadow-sm">
    <div>
      <span class="font-bold text-gray-800">SureSecured</span>
      <span class="text-gray-400 text-sm ml-2">My Portal</span>
    </div>
    <div class="flex items-center gap-4">
      <span class="text-sm text-gray-600 font-medium">${info.name}</span>
      <a href="/portal/logout" class="text-sm text-gray-400 hover:text-red-600 transition">Sign out</a>
    </div>
  </nav>

  <div class="max-w-6xl mx-auto px-6 py-8">

    <!-- Header -->
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-gray-800">My Dashboard</h1>
      <p class="text-gray-400 text-sm mt-1">${monthLabel} · Current tier rate: <strong class="text-gray-700">${currentTierRate}%</strong></p>
    </div>

    <!-- Goal Progress -->
    ${revenueGoal > 0 || ordersGoal > 0 ? `
    <div class="bg-white rounded-xl shadow-sm p-6 mb-6">
      <h2 class="font-semibold text-gray-700 mb-4">${monthLabel} — Goal Progress</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">

        ${revenueGoal > 0 ? `
        <div>
          <div class="flex justify-between items-end mb-2">
            <span class="text-sm text-gray-600">Revenue</span>
            <span class="text-sm font-semibold ${parseFloat(revPct) >= 100 ? 'text-green-600' : 'text-gray-700'}">${fmt(revenueActual)} <span class="text-gray-400 font-normal">of ${fmt(revenueGoal)}</span></span>
          </div>
          <div class="h-4 bg-gray-100 rounded-full overflow-hidden">
            <div class="h-4 rounded-full transition-all ${parseFloat(revPct) >= 100 ? 'bg-green-500' : parseFloat(revPct) >= 70 ? 'bg-yellow-400' : 'bg-blue-500'}"
              style="width:${revPct}%"></div>
          </div>
          <p class="text-xs text-gray-400 mt-1">${revPct}% to goal${parseFloat(revPct) >= 100 ? ' 🎉' : ''}</p>
        </div>` : ''}

        ${ordersGoal > 0 ? `
        <div>
          <div class="flex justify-between items-end mb-2">
            <span class="text-sm text-gray-600">Orders</span>
            <span class="text-sm font-semibold ${parseFloat(ordPct) >= 100 ? 'text-green-600' : 'text-gray-700'}">${ordersActual} <span class="text-gray-400 font-normal">of ${ordersGoal}</span></span>
          </div>
          <div class="h-4 bg-gray-100 rounded-full overflow-hidden">
            <div class="h-4 rounded-full transition-all ${parseFloat(ordPct) >= 100 ? 'bg-green-500' : parseFloat(ordPct) >= 70 ? 'bg-yellow-400' : 'bg-blue-500'}"
              style="width:${ordPct}%"></div>
          </div>
          <p class="text-xs text-gray-400 mt-1">${ordPct}% to goal${parseFloat(ordPct) >= 100 ? ' 🎉' : ''}</p>
        </div>` : ''}

      </div>
    </div>` : `
    <div class="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-6 text-sm text-yellow-800">
      No goal set for ${monthLabel} yet. Ask your manager to set a monthly goal.
    </div>`}

    <!-- Commission Tier -->
    <div class="bg-white rounded-xl shadow-sm p-6 mb-6">
      <h2 class="font-semibold text-gray-700 mb-4">Commission Tier — ${monthLabel}</h2>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div>
          <p class="text-xs text-gray-500 uppercase tracking-wide">Units This Month</p>
          <p class="text-2xl font-bold text-gray-800 mt-1">${unitsThisMonth}</p>
          ${unitsToNextTier !== null ? `<p class="text-xs text-gray-400 mt-1">${unitsToNextTier} more unit${unitsToNextTier === 1 ? '' : 's'} to reach ${nextTier.rate}% tier</p>` : '<p class="text-xs text-gray-400 mt-1">Top tier reached</p>'}
        </div>
        <div>
          <p class="text-xs text-gray-500 uppercase tracking-wide">Pending Payout</p>
          <p class="text-2xl font-bold text-yellow-600 mt-1">${fmt(pendingPayout)}</p>
        </div>
        <div>
          <p class="text-xs text-gray-500 uppercase tracking-wide">Paid To Date</p>
          <p class="text-2xl font-bold text-green-700 mt-1">${fmt(paidTotal)}</p>
        </div>
      </div>
      ${unitsToNextTier !== null ? `
      <div class="mt-4">
        <div class="h-3 bg-gray-100 rounded-full overflow-hidden">
          <div class="h-3 bg-blue-500 rounded-full transition-all" style="width:${Math.min(100, (unitsThisMonth / nextTier.from * 100)).toFixed(0)}%"></div>
        </div>
      </div>` : ''}
    </div>

    <!-- This Month Stats -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div class="bg-white rounded-xl shadow-sm p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Revenue This Month</p>
        <p class="text-2xl font-bold text-green-700 mt-1">${fmt(tm.revenue)}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Commission Earned</p>
        <p class="text-2xl font-bold text-blue-700 mt-1">${fmt(tm.commission)}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Orders</p>
        <p class="text-2xl font-bold text-gray-800 mt-1">${tm.orders}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Email Clicks</p>
        <p class="text-2xl font-bold text-gray-800 mt-1">${tm.clicks}</p>
        <p class="text-xs text-gray-400 mt-1">${tm.forms} quotes · ${tm.calls} calls</p>
      </div>
    </div>

    <!-- All-Time Totals -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      <div class="bg-white rounded-xl shadow-sm p-5 border-l-4 border-blue-500">
        <p class="text-xs text-gray-500 uppercase tracking-wide">All-Time Revenue</p>
        <p class="text-2xl font-bold text-gray-800 mt-1">${fmt(at.total_revenue)}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5 border-l-4 border-green-500">
        <p class="text-xs text-gray-500 uppercase tracking-wide">All-Time Commission</p>
        <p class="text-2xl font-bold text-gray-800 mt-1">${fmt(at.total_commission)}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5 border-l-4 border-purple-500">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Total Orders</p>
        <p class="text-2xl font-bold text-gray-800 mt-1">${at.total_orders}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5 border-l-4 border-orange-400">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Total Leads</p>
        <p class="text-2xl font-bold text-gray-800 mt-1">${parseInt(at.total_leads).toLocaleString()}</p>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">

      <!-- Monthly History Table -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-6 py-4 border-b">
          <h2 class="font-semibold text-gray-800">Monthly History</h2>
        </div>
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500 uppercase">
            <tr>
              <th class="px-4 py-2 text-left">Month</th>
              <th class="px-4 py-2 text-right">Revenue</th>
              <th class="px-4 py-2 text-right">Goal</th>
              <th class="px-4 py-2 text-right">% to Goal</th>
              <th class="px-4 py-2 text-center">Orders</th>
            </tr>
          </thead>
          <tbody>${histRows}</tbody>
        </table>
      </div>

      <!-- Recent Activity Feed -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-6 py-4 border-b">
          <h2 class="font-semibold text-gray-800">Recent Activity</h2>
        </div>
        <div class="px-6 py-2 max-h-80 overflow-y-auto">${activityRows}</div>
      </div>

    </div>

    <!-- Recent Email Clicks -->
    <div class="bg-white rounded-xl shadow-sm overflow-hidden mb-6">
      <div class="px-6 py-4 border-b">
        <h2 class="font-semibold text-gray-800">Recent Email Clicks</h2>
        <p class="text-xs text-gray-400 mt-0.5">Leads who clicked a link in one of your emails</p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500 uppercase">
            <tr>
              <th class="px-4 py-2 text-left">Time</th>
              <th class="px-4 py-2 text-left">Lead Name</th>
              <th class="px-4 py-2 text-left">Email</th>
            </tr>
          </thead>
          <tbody>${clickRows}</tbody>
        </table>
      </div>
    </div>

    <!-- Top Leads by Engagement Score -->
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="px-6 py-4 border-b">
        <h2 class="font-semibold text-gray-800">Top Leads by Engagement Score</h2>
        <p class="text-xs text-gray-400 mt-0.5">Highest engagement score leads in your sequences — prioritize these for outreach</p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500 uppercase">
            <tr>
              <th class="px-4 py-2 text-left">Name</th>
              <th class="px-4 py-2 text-left">Email</th>
              <th class="px-4 py-2 text-left">Score</th>
            </tr>
          </thead>
          <tbody>${topLeadRows}</tbody>
        </table>
      </div>
    </div>

  </div>
</body>
</html>`);
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).send('Error loading portal');
  }
});

module.exports = router;
