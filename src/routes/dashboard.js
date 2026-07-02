const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { navHtml } = require('./analytics');

router.get('/', requireAuth, async (req, res) => {
  try {
    const [spStats, recentOrders, recentForms, recentCalls, totalStats, hotLeads] = await Promise.all([
      pool.query(`
        SELECT
          s.id, s.name, s.email, s.commission_rate, s.tracking_phone_number,
          COUNT(DISTINCT l.id) AS total_leads,
          COUNT(DISTINCT c.id) AS total_clicks,
          COUNT(DISTINCT fs.id) AS form_submissions,
          COUNT(DISTINCT o.id) AS orders,
          COUNT(DISTINCT pc.id) AS phone_calls,
          COALESCE(SUM(DISTINCT o.amount), 0) AS total_revenue,
          COALESCE(SUM(cm.commission_earned), 0) AS total_commission
        FROM salespeople s
        LEFT JOIN leads l ON l.salesperson_id = s.id
        LEFT JOIN clicks c ON c.salesperson_id = s.id
        LEFT JOIN form_submissions fs ON fs.salesperson_id = s.id
        LEFT JOIN orders o ON o.salesperson_id = s.id
        LEFT JOIN phone_calls pc ON pc.salesperson_id = s.id
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
        SELECT pc.caller_number, pc.tracking_number, pc.duration_seconds, pc.called_at, s.name AS salesperson
        FROM phone_calls pc LEFT JOIN salespeople s ON s.id = pc.salesperson_id
        ORDER BY pc.called_at DESC LIMIT 15
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM leads) AS total_leads,
          (SELECT COUNT(*) FROM clicks) AS total_clicks,
          (SELECT COUNT(*) FROM form_submissions) AS total_forms,
          (SELECT COUNT(*) FROM orders) AS total_orders,
          (SELECT COUNT(*) FROM phone_calls) AS total_calls,
          (SELECT COUNT(*) FROM suppression_list) AS total_suppressed,
          (SELECT COALESCE(SUM(amount),0) FROM orders) AS total_revenue,
          (SELECT COALESCE(SUM(commission_earned),0) FROM commissions) AS total_commission,
          (SELECT COUNT(*) FROM leads WHERE reply_classified_at IS NOT NULL) AS total_replies,
          (SELECT COUNT(*) FROM leads WHERE reply_urgency = 'high') AS hot_leads
      `),
      pool.query(`
        SELECT l.id, l.first_name, l.last_name, l.email, l.reply_category, l.reply_urgency, l.reply_summary, l.reply_classified_at
        FROM leads l
        WHERE l.reply_classified_at IS NOT NULL
        ORDER BY l.reply_classified_at DESC
        LIMIT 10
      `),
    ]);

    const totals = totalStats.rows[0];
    const salespeople = spStats.rows;
    const recentReplies = hotLeads.rows;

    const formatCurrency = n => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
    const formatDate = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

    const spRows = salespeople.map(sp => `
      <tr class="border-t hover:bg-gray-50">
        <td class="px-4 py-3">
          <div class="font-medium text-gray-900">${sp.name}</div>
          <div class="text-xs text-gray-400">${sp.email}</div>
          ${sp.tracking_phone_number ? `<div class="text-xs text-purple-500 mt-0.5">📞 ${sp.tracking_phone_number}</div>` : '<div class="text-xs text-red-300 mt-0.5">No tracking number</div>'}
        </td>
        <td class="px-4 py-3 text-center text-sm">${sp.total_leads}</td>
        <td class="px-4 py-3 text-center text-sm">${sp.total_clicks}</td>
        <td class="px-4 py-3 text-center text-sm">${sp.form_submissions}</td>
        <td class="px-4 py-3 text-center text-sm">${sp.phone_calls}</td>
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
  ${navHtml('dashboard')}

  <div class="max-w-7xl mx-auto px-6 py-8">

    <!-- Summary Cards -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
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
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      <div class="bg-white rounded-xl shadow-sm p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Phone Calls</p>
        <p class="text-3xl font-bold text-purple-700 mt-1">${parseInt(totals.total_calls || 0).toLocaleString()}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Form Submissions</p>
        <p class="text-3xl font-bold text-gray-800 mt-1">${parseInt(totals.total_forms || 0).toLocaleString()}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Orders</p>
        <p class="text-3xl font-bold text-gray-800 mt-1">${parseInt(totals.total_orders || 0).toLocaleString()}</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Suppressed</p>
        <p class="text-3xl font-bold text-gray-400 mt-1">${parseInt(totals.total_suppressed || 0).toLocaleString()}</p>
        <p class="text-xs text-gray-400 mt-1">existing customers</p>
      </div>
      <div class="bg-white rounded-xl shadow-sm p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wide">Replies</p>
        <p class="text-3xl font-bold text-indigo-700 mt-1">${parseInt(totals.total_replies || 0).toLocaleString()}</p>
        <p class="text-xs text-red-500 mt-1">🔥 ${parseInt(totals.hot_leads || 0)} hot leads</p>
      </div>
    </div>

    <!-- Hot Leads / Recent Replies -->
    ${recentReplies.length ? `
    <div class="bg-white rounded-xl shadow-sm mb-8 overflow-hidden">
      <div class="px-6 py-4 border-b">
        <h2 class="font-semibold text-gray-800">Recent Replies</h2>
      </div>
      <div class="divide-y">
        ${recentReplies.map(r => `
        <a href="/leads/${r.id}" class="flex items-center gap-4 px-6 py-3 hover:bg-gray-50 transition">
          <div class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white
            ${r.reply_urgency === 'high' ? 'bg-red-500' : r.reply_urgency === 'low' ? 'bg-gray-400' : 'bg-yellow-500'}">
            ${(r.first_name?.[0] || r.email[0]).toUpperCase()}
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-gray-900">${r.first_name || ''} ${r.last_name || ''} <span class="text-gray-400 font-normal">${r.email}</span></p>
            ${r.reply_summary ? `<p class="text-xs text-gray-500 truncate">${r.reply_summary}</p>` : ''}
          </div>
          <div class="text-right shrink-0">
            <span class="px-2 py-0.5 rounded text-xs font-medium
              ${r.reply_urgency === 'high' ? 'bg-red-100 text-red-700' : r.reply_urgency === 'low' ? 'bg-gray-100 text-gray-600' : 'bg-yellow-100 text-yellow-700'}">
              ${(r.reply_category || '').replace(/_/g, ' ')}
            </span>
            <p class="text-xs text-gray-400 mt-1">${new Date(r.reply_classified_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
          </div>
        </a>`).join('')}
      </div>
    </div>` : ''}

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
              <th class="px-4 py-3 text-center">Calls</th>
              <th class="px-4 py-3 text-center">Orders</th>
              <th class="px-4 py-3 text-right">Revenue</th>
              <th class="px-4 py-3 text-right">Commission</th>
              <th class="px-4 py-3 text-center">Rate</th>
            </tr>
          </thead>
          <tbody>
            ${spRows || '<tr><td colspan="9" class="px-4 py-4 text-center text-gray-400">No salespeople yet — add one via the API</td></tr>'}
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

    <!-- Recent Phone Calls -->
    <div class="bg-white rounded-xl shadow-sm mt-6 overflow-hidden">
      <div class="px-6 py-4 border-b flex justify-between items-center">
        <h2 class="font-semibold text-gray-800">Recent Phone Calls <span class="text-xs text-purple-500 font-normal ml-2">(via CallRail tracking numbers)</span></h2>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500 uppercase">
            <tr>
              <th class="px-4 py-2 text-left">Date</th>
              <th class="px-4 py-2 text-left">Caller Number</th>
              <th class="px-4 py-2 text-left">Tracking Number</th>
              <th class="px-4 py-2 text-left">Duration</th>
              <th class="px-4 py-2 text-left">Salesperson</th>
            </tr>
          </thead>
          <tbody>
            ${recentCalls.rows.length > 0 ? recentCalls.rows.map(c => `
              <tr class="border-t text-sm hover:bg-gray-50">
                <td class="px-4 py-2 text-gray-500">${formatDate(c.called_at)}</td>
                <td class="px-4 py-2">${c.caller_number || '—'}</td>
                <td class="px-4 py-2 text-purple-600">${c.tracking_number || '—'}</td>
                <td class="px-4 py-2">${c.duration_seconds ? Math.floor(c.duration_seconds/60)+'m '+((c.duration_seconds||0)%60)+'s' : '—'}</td>
                <td class="px-4 py-2">${c.salesperson || '<span class="text-red-400">Unknown</span>'}</td>
              </tr>
            `).join('') : '<tr><td colspan="5" class="px-4 py-4 text-center text-gray-400">No calls yet — set up CallRail tracking numbers to start</td></tr>'}
          </tbody>
        </table>
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
