const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const [spStats, recentOrders, recentForms, totalStats] = await Promise.all([
      pool.query(`
        SELECT
          s.id, s.name, s.email, s.commission_rate,
          COUNT(DISTINCT l.id) AS total_leads,
          COUNT(DISTINCT c.id) AS total_clicks,
          COUNT(DISTINCT fs.id) AS form_submissions,
          COUNT(DISTINCT o.id) AS orders,
          COALESCE(SUM(DISTINCT o.amount), 0) AS total_revenue,
          COALESCE(SUM(cm.commission_earned), 0) AS total_commission
        FROM salespeople s
        LEFT JOIN leads l ON l.salesperson_id = s.id
        LEFT JOIN clicks c ON c.salesperson_id = s.id
        LEFT JOIN form_submissions fs ON fs.salesperson_id = s.id
        LEFT JOIN orders o ON o.salesperson_id = s.id
        LEFT JOIN commissions cm ON cm.salesperson_id = s.id
        WHERE s.active = true
        GROUP BY s.id ORDER BY total_revenue DESC
      `),
      pool.query(`
        SELECT o.shopify_order_id, o.customer_email, o.amount, o.ordered_at, s.name AS salesperson
        FROM orders o LEFT JOIN salespeople s ON s.id = o.salesperson_id
        ORDER BY o.ordered_at DESC LIMIT 15
      `),
      pool.query(`
        SELECT fs.submitter_name, fs.submitter_email, fs.form_type, fs.submitted_at, s.name AS salesperson
        FROM form_submissions fs LEFT JOIN salespeople s ON s.id = fs.salesperson_id
        ORDER BY fs.submitted_at DESC LIMIT 15
      `),
      pool.query(`
        SELECT
          COUNT(DISTINCT l.id) AS total_leads,
          COUNT(DISTINCT c.id) AS total_clicks,
          COUNT(DISTINCT fs.id) AS total_forms,
          COUNT(DISTINCT o.id) AS total_orders,
          COALESCE(SUM(o.amount), 0) AS total_revenue,
          COALESCE(SUM(cm.commission_earned), 0) AS total_commission
        FROM leads l
        FULL OUTER JOIN clicks c ON true
        FULL OUTER JOIN form_submissions fs ON true
        FULL OUTER JOIN orders o ON true
        FULL OUTER JOIN commissions cm ON true
      `),
    ]);

    const totals = totalStats.rows[0];
    const salespeople = spStats.rows;

    const formatCurrency = n => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
    const formatDate = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

    const spRows = salespeople.map(sp => `
      <tr class="border-t hover:bg-gray-50">
        <td class="px-4 py-3">
          <div class="font-medium text-gray-900">${sp.name}</div>
          <div class="text-xs text-gray-400">${sp.email}</div>
        </td>
        <td class="px-4 py-3 text-center text-sm">${sp.total_leads}</td>
        <td class="px-4 py-3 text-center text-sm">${sp.total_clicks}</td>
        <td class="px-4 py-3 text-center text-sm">${sp.form_submissions}</td>
        <td class="px-4 py-3 text-center text-sm">${sp.orders}</td>
        <td class="px-4 py-3 text-right font-semibold text-green-700">${formatCurrency(sp.total_revenue)}</td>
        <td class="px-4 py-3 text-right font-bold text-blue-700">${formatCurrency(sp.total_commission)}</td>
        <td class="px-4 py-3 text-center text-sm text-gray-500">${sp.commission_rate}%</td>
      </tr>
    `).join('');

    const orderRows = recentOrders.rows.map(o => `
      <tr class="border-t text-sm hover:bg-gray-50">
        <td class="px-4 py-2 text-gray-500">${formatDate(o.ordered_at)}</td>
        <td class="px-4 py-2">${o.customer_email || '—'}</td>
        <td class="px-4 py-2 font-semibold text-green-700">${formatCurrency(o.amount)}</td>
        <td class="px-4 py-2">${o.salesperson || '<span class="text-red-400">Unassigned</span>'}</td>
      </tr>
    `).join('') || '<tr><td colspan="4" class="px-4 py-4 text-center text-gray-400">No orders yet</td></tr>';

    const formRows = recentForms.rows.map(f => `
      <tr class="border-t text-sm hover:bg-gray-50">
        <td class="px-4 py-2 text-gray-500">${formatDate(f.submitted_at)}</td>
        <td class="px-4 py-2">${f.submitter_name || '—'}</td>
        <td class="px-4 py-2 text-gray-500">${f.submitter_email || '—'}</td>
        <td class="px-4 py-2">
          <span class="px-2 py-0.5 rounded text-xs ${f.form_type === 'dealer' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}">
            ${f.form_type || 'quote'}
          </span>
        </td>
        <td class="px-4 py-2">${f.salesperson || '<span class="text-red-400">Unassigned</span>'}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="px-4 py-4 text-center text-gray-400">No form submissions yet</td></tr>';

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>SureSecured — Commission Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2/dist/tailwind.min.css" rel="stylesheet">
</head>
<body class="bg-gray-100 min-h-screen">
  <nav class="bg-white border-b px-6 py-4 flex justify-between items-center shadow-sm">
    <div>
      <span class="font-bold text-gray-800 text-lg">SureSecured</span>
      <span class="text-gray-400 text-sm ml-2">Commission Tracker</span>
    </div>
    <a href="/logout" class="text-sm text-gray-500 hover:text-red-600 transition">Sign out</a>
  </nav>

  <div class="max-w-7xl mx-auto px-6 py-8">

    <!-- Summary Cards -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      <div class="bg-white rounded-xl shadow-sm p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Total Leads</p>
        <p class="text-3xl font-bold text-gray-800 mt-1">${parseInt(totals.total_leads || 0).toLocaleString()}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Email Clicks</p>
        <p class="text-3xl font-bold text-gray-800 mt-1">${parseInt(totals.total_clicks || 0).toLocaleString()}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Total Revenue</p>
        <p class="text-3xl font-bold text-green-700 mt-1">${formatCurrency(totals.total_revenue)}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Commissions Earned</p>
        <p class="text-3xl font-bold text-blue-700 mt-1">${formatCurrency(totals.total_commission)}</p>
      </div>
    </div>

    <!-- Salesperson Leaderboard -->
    <div class="bg-white rounded-xl shadow-sm mb-8 overflow-hidden">
      <div class="px-6 py-4 border-b flex justify-between items-center">
        <h2 class="font-semibold text-gray-800">Salesperson Commission Summary</h2>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
            <tr>
              <th class="px-4 py-3 text-left">Salesperson</th>
              <th class="px-4 py-3 text-center">Leads</th>
              <th class="px-4 py-3 text-center">Clicks</th>
              <th class="px-4 py-3 text-center">Forms</th>
              <th class="px-4 py-3 text-center">Orders</th>
              <th class="px-4 py-3 text-right">Revenue</th>
              <th class="px-4 py-3 text-right">Commission</th>
              <th class="px-4 py-3 text-center">Rate</th>
            </tr>
          </thead>
          <tbody>
            ${spRows || '<tr><td colspan="8" class="px-4 py-4 text-center text-gray-400">No salespeople yet — add one via the API</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- Recent Orders -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-6 py-4 border-b">
          <h2 class="font-semibold text-gray-800">Recent Orders</h2>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 text-xs text-gray-500 uppercase">
              <tr>
                <th class="px-4 py-2 text-left">Date</th>
                <th class="px-4 py-2 text-left">Customer</th>
                <th class="px-4 py-2 text-left">Amount</th>
                <th class="px-4 py-2 text-left">Salesperson</th>
              </tr>
            </thead>
            <tbody>${orderRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Recent Form Submissions -->
      <div class="bg-white rounded-xl shadow-sm overflow-hidden">
        <div class="px-6 py-4 border-b">
          <h2 class="font-semibold text-gray-800">Recent Quote Requests</h2>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 text-xs text-gray-500 uppercase">
              <tr>
                <th class="px-4 py-2 text-left">Date</th>
                <th class="px-4 py-2 text-left">Name</th>
                <th class="px-4 py-2 text-left">Email</th>
                <th class="px-4 py-2 text-left">Type</th>
                <th class="px-4 py-2 text-left">Salesperson</th>
              </tr>
            </thead>
            <tbody>${formRows}</tbody>
          </table>
        </div>
      </div>
    </div>

  </div>
</body>
</html>`);
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Server error loading dashboard');
  }
});

module.exports = router;
