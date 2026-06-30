const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { navHtml } = require('./analytics');

// ─── Admin page ────────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const [salespeople, matrix, suppressionCount, goalsData] = await Promise.all([
      pool.query('SELECT * FROM salespeople ORDER BY name'),
      pool.query('SELECT * FROM landing_page_matrix ORDER BY audience_type, product_interest, intent_level'),
      pool.query('SELECT COUNT(*) AS count FROM suppression_list'),
      pool.query(`
        SELECT
          s.id, s.name, s.email, s.commission_rate,
          s.portal_password_hash IS NOT NULL AS has_portal,
          COALESCE(g.target_revenue, 0) AS target_revenue,
          COALESCE(g.target_orders, 0)  AS target_orders,
          COALESCE(SUM(o.amount), 0)    AS actual_revenue,
          COUNT(DISTINCT o.id)          AS actual_orders,
          COALESCE(SUM(cm.commission_earned), 0) AS commission_earned
        FROM salespeople s
        LEFT JOIN salesperson_goals g ON g.salesperson_id = s.id AND g.period_start = $1
        LEFT JOIN orders o  ON o.salesperson_id = s.id AND DATE(o.ordered_at) BETWEEN $1 AND $2
        LEFT JOIN commissions cm ON cm.salesperson_id = s.id
          AND cm.created_at BETWEEN $1::timestamptz AND ($2::date + interval '1 day')::timestamptz
        WHERE s.active = true
        GROUP BY s.id, s.name, s.email, s.commission_rate, s.portal_password_hash, g.target_revenue, g.target_orders
        ORDER BY actual_revenue DESC
      `, [monthStart, monthEnd]),
    ]);

    const flash = req.query.msg
      ? `<div class="mb-4 px-4 py-3 rounded-lg text-sm ${req.query.ok === '1' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}">${decodeURIComponent(req.query.msg)}</div>`
      : '';

    const fmt = n => '$' + parseFloat(n||0).toLocaleString('en-US', { minimumFractionDigits: 0 });

    const goalRows = goalsData.rows.map(sp => {
      const revGoal   = parseFloat(sp.target_revenue || 0);
      const revActual = parseFloat(sp.actual_revenue || 0);
      const ordGoal   = parseInt(sp.target_orders || 0);
      const ordActual = parseInt(sp.actual_orders || 0);
      const revPct    = revGoal > 0 ? Math.min(100, revActual / revGoal * 100).toFixed(0) : null;
      const barColor  = !revPct ? 'bg-gray-200' : parseFloat(revPct) >= 100 ? 'bg-green-500' : parseFloat(revPct) >= 70 ? 'bg-yellow-400' : 'bg-blue-500';
      return `
        <tr class="border-t hover:bg-gray-50">
          <td class="px-4 py-3">
            <div class="font-medium text-gray-900">${sp.name}</div>
            <div class="text-xs text-gray-400">${sp.commission_rate}% commission · ${sp.has_portal ? '<span class="text-green-500">Portal active</span>' : '<span class="text-red-300">No portal access</span>'}</div>
          </td>
          <td class="px-4 py-3">
            <div class="flex items-center gap-3">
              <div class="flex-1">
                <div class="flex justify-between text-xs mb-1">
                  <span class="text-gray-600">${fmt(revActual)}</span>
                  <span class="text-gray-400">${revGoal > 0 ? 'Goal: ' + fmt(revGoal) : 'No goal set'}</span>
                </div>
                <div class="h-2.5 bg-gray-100 rounded-full overflow-hidden w-full">
                  <div class="h-2.5 rounded-full ${barColor}" style="width:${revPct || 0}%"></div>
                </div>
                ${revPct ? '<p class="text-xs text-gray-400 mt-0.5">' + revPct + '% to goal</p>' : ''}
              </div>
            </div>
          </td>
          <td class="px-4 py-3 text-center text-sm">
            <span class="font-semibold ${ordGoal > 0 && ordActual >= ordGoal ? 'text-green-600' : 'text-gray-700'}">${ordActual}</span>
            ${ordGoal > 0 ? '<span class="text-gray-400"> / ' + ordGoal + '</span>' : ''}
          </td>
          <td class="px-4 py-3 text-right font-semibold text-blue-700">${fmt(sp.commission_earned)}</td>
          <td class="px-4 py-3 text-right">
            <button onclick="openGoalModal(${sp.id}, '${sp.name}', ${revGoal}, ${ordGoal})"
              class="text-xs text-blue-600 hover:underline mr-3">Set Goal</button>
            <button onclick="openPortalModal(${sp.id}, '${sp.name}')"
              class="text-xs text-purple-600 hover:underline">Set Password</button>
          </td>
        </tr>`;
    }).join('');

    const spRows = salespeople.rows.map(sp => `
      <tr class="border-t hover:bg-gray-50" id="row-${sp.id}">
        <td class="px-4 py-3">
          <div class="font-medium text-gray-900">${sp.name}</div>
          <div class="text-xs text-gray-400">${sp.email}</div>
        </td>
        <td class="px-4 py-3 text-center">
          <span class="px-2 py-0.5 rounded text-xs ${sp.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}">${sp.active ? 'Active' : 'Inactive'}</span>
        </td>
        <td class="px-4 py-3 text-center text-sm">${sp.commission_rate}%</td>
        <td class="px-4 py-3 text-center text-sm text-purple-600">${sp.tracking_phone_number || '<span class="text-gray-300">—</span>'}</td>
        <td class="px-4 py-3 text-right">
          <button onclick="openEditModal(${JSON.stringify(sp).replace(/"/g,'&quot;')})"
            class="text-xs text-blue-600 hover:underline mr-3">Edit</button>
          <form method="POST" action="/admin/salespeople/${sp.id}/toggle" class="inline">
            <button type="submit" class="text-xs ${sp.active ? 'text-red-500 hover:underline' : 'text-green-600 hover:underline'}">
              ${sp.active ? 'Deactivate' : 'Reactivate'}
            </button>
          </form>
        </td>
      </tr>`).join('');

    const matrixRows = matrix.rows.map(m => `
      <tr class="border-t hover:bg-gray-50">
        <td class="px-3 py-2 text-xs text-gray-600">${m.label || '—'}</td>
        <td class="px-3 py-2 text-center"><span class="px-1.5 py-0.5 rounded text-xs ${m.audience_type === 'B2C' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}">${m.audience_type || '—'}</span></td>
        <td class="px-3 py-2 text-xs text-center text-gray-600">${m.product_interest || '—'}</td>
        <td class="px-3 py-2 text-xs text-center text-gray-600">${m.intent_level || '—'}</td>
        <td class="px-3 py-2 text-xs text-gray-500 max-w-xs truncate" title="${m.destination_url}">${m.destination_url}</td>
        <td class="px-3 py-2 text-center"><span class="w-2 h-2 rounded-full inline-block ${m.active ? 'bg-green-400' : 'bg-gray-300'}"></span></td>
        <td class="px-3 py-2 text-right">
          <button onclick="openMatrixModal(${JSON.stringify(m).replace(/"/g,'&quot;')})"
            class="text-xs text-blue-600 hover:underline">Edit</button>
        </td>
      </tr>`).join('');

    res.send(`<!DOCTYPE html>
<html>
<head>
  <title>SureSecured — Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2/dist/tailwind.min.css" rel="stylesheet">
</head>
<body class="bg-gray-100 min-h-screen">

  ${navHtml('admin')}

  <div class="max-w-7xl mx-auto px-6 py-8">
    ${flash}

    <!-- ── Salespeople ─────────────────────────────── -->
    <div class="bg-white rounded-xl shadow-sm mb-6 overflow-hidden">
      <div class="px-6 py-4 border-b flex justify-between items-center">
        <h2 class="font-semibold text-gray-800">Salespeople</h2>
        <button onclick="document.getElementById('add-sp-modal').classList.remove('hidden')"
          class="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition">
          + Add Salesperson
        </button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500 uppercase">
            <tr>
              <th class="px-4 py-3 text-left">Name / Email</th>
              <th class="px-4 py-3 text-center">Status</th>
              <th class="px-4 py-3 text-center">Commission</th>
              <th class="px-4 py-3 text-center">Tracking Number</th>
              <th class="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${spRows || '<tr><td colspan="5" class="px-4 py-6 text-center text-gray-400">No salespeople yet. Add one above.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── Goals & Portal Access ──────────────────── -->
    <div class="bg-white rounded-xl shadow-sm mb-6 overflow-hidden">
      <div class="px-6 py-4 border-b flex justify-between items-center">
        <div>
          <h2 class="font-semibold text-gray-800">Goals &amp; Performance — ${monthLabel}</h2>
          <p class="text-xs text-gray-400 mt-0.5">Set monthly revenue and order targets. Enable portal access per salesperson.</p>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500 uppercase">
            <tr>
              <th class="px-4 py-3 text-left">Salesperson</th>
              <th class="px-4 py-3 text-left">Revenue vs Goal</th>
              <th class="px-4 py-3 text-center">Orders vs Goal</th>
              <th class="px-4 py-3 text-right">Commission</th>
              <th class="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${goalRows || '<tr><td colspan="5" class="px-4 py-6 text-center text-gray-400">No active salespeople yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── Landing Page Matrix ─────────────────────── -->
    <div class="bg-white rounded-xl shadow-sm mb-6 overflow-hidden">
      <div class="px-6 py-4 border-b flex justify-between items-center">
        <div>
          <h2 class="font-semibold text-gray-800">Landing Page Matrix</h2>
          <p class="text-xs text-gray-400 mt-0.5">Controls which page each email CTA links to based on lead segment</p>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500 uppercase">
            <tr>
              <th class="px-3 py-2 text-left">Label</th>
              <th class="px-3 py-2 text-center">Audience</th>
              <th class="px-3 py-2 text-center">Product</th>
              <th class="px-3 py-2 text-center">Intent</th>
              <th class="px-3 py-2 text-left">Destination URL</th>
              <th class="px-3 py-2 text-center">Active</th>
              <th class="px-3 py-2 text-right">Edit</th>
            </tr>
          </thead>
          <tbody>
            ${matrixRows || '<tr><td colspan="7" class="px-4 py-4 text-center text-gray-400">No matrix entries yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── Suppression List ────────────────────────── -->
    <div class="bg-white rounded-xl shadow-sm mb-6 p-6">
      <h2 class="font-semibold text-gray-800 mb-1">Suppression List</h2>
      <p class="text-xs text-gray-400 mb-4">Upload your Shopify customer list so they never receive the dormant lead reconnect sequence.</p>
      <div class="flex items-center gap-6">
        <div class="text-3xl font-bold text-gray-700">${parseInt(suppressionCount.rows[0].count).toLocaleString()}</div>
        <div class="text-sm text-gray-500">emails suppressed</div>
      </div>
      <form method="POST" action="/admin/suppression" enctype="multipart/form-data" class="mt-4 flex items-end gap-4 flex-wrap">
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Upload CSV (one email per row, or column named "email")</label>
          <input type="file" name="csv" accept=".csv,.txt" required
            class="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Reason</label>
          <select name="reason" class="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white">
            <option value="existing_customer">Existing Customer</option>
            <option value="unsubscribed">Unsubscribed</option>
            <option value="manual">Manual</option>
          </select>
        </div>
        <button type="submit" class="px-4 py-2 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-900 transition">
          Upload & Suppress
        </button>
      </form>
    </div>

    <!-- ── Danger Zone ─────────────────────────────── -->
    <div class="bg-white rounded-xl shadow-sm p-6 border border-red-100">
      <h2 class="font-semibold text-red-700 mb-3">Admin Password</h2>
      <form method="POST" action="/admin/change-password" class="flex items-end gap-4 flex-wrap">
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Current Password</label>
          <input type="password" name="current_password" required
            class="text-sm border border-gray-300 rounded-lg px-3 py-2 w-48">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">New Password</label>
          <input type="password" name="new_password" required minlength="8"
            class="text-sm border border-gray-300 rounded-lg px-3 py-2 w-48">
        </div>
        <button type="submit" class="px-4 py-2 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 transition">
          Change Password
        </button>
      </form>
    </div>

  </div>

  <!-- ── Add Salesperson Modal ────────────────────── -->
  <div id="add-sp-modal" class="hidden fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
    <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
      <div class="flex justify-between items-center mb-4">
        <h3 class="font-semibold text-gray-800">Add Salesperson</h3>
        <button onclick="document.getElementById('add-sp-modal').classList.add('hidden')" class="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
      </div>
      <form method="POST" action="/admin/salespeople" class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">First Name</label>
            <input type="text" name="first_name" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Last Name</label>
            <input type="text" name="last_name" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
          </div>
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Email Address</label>
          <input type="email" name="email" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Commission Rate (%)</label>
            <input type="number" name="commission_rate" value="100" min="0" max="100" step="0.5" required
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">CallRail Tracking #</label>
            <input type="text" name="tracking_phone_number" placeholder="(818) 555-0101"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
          </div>
        </div>
        <div class="flex gap-3 pt-2">
          <button type="submit" class="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-blue-700 transition">
            Add Salesperson
          </button>
          <button type="button" onclick="document.getElementById('add-sp-modal').classList.add('hidden')"
            class="flex-1 border border-gray-300 text-gray-600 rounded-lg py-2 text-sm hover:bg-gray-50 transition">
            Cancel
          </button>
        </div>
      </form>
    </div>
  </div>

  <!-- ── Edit Salesperson Modal ───────────────────── -->
  <div id="edit-sp-modal" class="hidden fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
    <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
      <div class="flex justify-between items-center mb-4">
        <h3 class="font-semibold text-gray-800">Edit Salesperson</h3>
        <button onclick="document.getElementById('edit-sp-modal').classList.add('hidden')" class="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
      </div>
      <form method="POST" id="edit-sp-form" action="" class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">First Name</label>
            <input type="text" name="first_name" id="edit-first" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Last Name</label>
            <input type="text" name="last_name" id="edit-last" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
          </div>
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Email Address</label>
          <input type="email" name="email" id="edit-email" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Commission Rate (%)</label>
            <input type="number" name="commission_rate" id="edit-commission" min="0" max="100" step="0.5" required
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">CallRail Tracking #</label>
            <input type="text" name="tracking_phone_number" id="edit-tracking" placeholder="(818) 555-0101"
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
          </div>
        </div>
        <div class="flex gap-3 pt-2">
          <button type="submit" class="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-blue-700 transition">
            Save Changes
          </button>
          <button type="button" onclick="document.getElementById('edit-sp-modal').classList.add('hidden')"
            class="flex-1 border border-gray-300 text-gray-600 rounded-lg py-2 text-sm hover:bg-gray-50 transition">
            Cancel
          </button>
        </div>
      </form>
    </div>
  </div>

  <!-- ── Edit Matrix Modal ─────────────────────────── -->
  <div id="matrix-modal" class="hidden fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
    <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
      <div class="flex justify-between items-center mb-4">
        <h3 class="font-semibold text-gray-800">Edit Landing Page Entry</h3>
        <button onclick="document.getElementById('matrix-modal').classList.add('hidden')" class="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
      </div>
      <form method="POST" id="matrix-form" action="" class="space-y-4">
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Label</label>
          <input type="text" name="label" id="m-label" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" readonly>
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Destination URL <span class="text-gray-400 font-normal">(e.g. /pages/request-a-quote)</span></label>
          <input type="text" name="destination_url" id="m-url" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
        </div>
        <div class="flex items-center gap-2">
          <input type="checkbox" name="active" id="m-active" value="true" class="rounded">
          <label for="m-active" class="text-sm text-gray-700">Active</label>
        </div>
        <div class="flex gap-3 pt-2">
          <button type="submit" class="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-blue-700 transition">
            Save URL
          </button>
          <button type="button" onclick="document.getElementById('matrix-modal').classList.add('hidden')"
            class="flex-1 border border-gray-300 text-gray-600 rounded-lg py-2 text-sm hover:bg-gray-50 transition">
            Cancel
          </button>
        </div>
      </form>
    </div>
  </div>

  <!-- ── Set Goal Modal ───────────────────────────── -->
  <div id="goal-modal" class="hidden fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
    <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
      <div class="flex justify-between items-center mb-4">
        <h3 class="font-semibold text-gray-800">Set Monthly Goal — <span id="goal-sp-name"></span></h3>
        <button onclick="document.getElementById('goal-modal').classList.add('hidden')" class="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
      </div>
      <form method="POST" id="goal-form" action="" class="space-y-4">
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Month <span class="text-gray-400 font-normal">(first day of month)</span></label>
          <input type="month" name="period_month" id="goal-month" required
            class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Revenue Target ($)</label>
            <input type="number" name="target_revenue" id="goal-revenue" min="0" step="100" required
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Orders Target</label>
            <input type="number" name="target_orders" id="goal-orders" min="0" step="1" required
              class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
          </div>
        </div>
        <div class="flex gap-3 pt-2">
          <button type="submit" class="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-blue-700 transition">Save Goal</button>
          <button type="button" onclick="document.getElementById('goal-modal').classList.add('hidden')"
            class="flex-1 border border-gray-300 text-gray-600 rounded-lg py-2 text-sm hover:bg-gray-50 transition">Cancel</button>
        </div>
      </form>
    </div>
  </div>

  <!-- ── Set Portal Password Modal ─────────────────── -->
  <div id="portal-modal" class="hidden fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
    <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
      <div class="flex justify-between items-center mb-4">
        <h3 class="font-semibold text-gray-800">Portal Access — <span id="portal-sp-name"></span></h3>
        <button onclick="document.getElementById('portal-modal').classList.add('hidden')" class="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
      </div>
      <p class="text-xs text-gray-500 mb-4">Set a password so this salesperson can log in at <strong>/portal/login</strong> with their email.</p>
      <form method="POST" id="portal-form" action="" class="space-y-4">
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">New Password</label>
          <input type="password" name="password" required minlength="6"
            class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
        </div>
        <div class="flex gap-3 pt-2">
          <button type="submit" class="flex-1 bg-purple-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-purple-700 transition">Set Password</button>
          <button type="button" onclick="document.getElementById('portal-modal').classList.add('hidden')"
            class="flex-1 border border-gray-300 text-gray-600 rounded-lg py-2 text-sm hover:bg-gray-50 transition">Cancel</button>
        </div>
      </form>
    </div>
  </div>

<script>
  function openEditModal(sp) {
    const names = sp.name.split(' ');
    document.getElementById('edit-first').value = names[0] || '';
    document.getElementById('edit-last').value  = names.slice(1).join(' ') || '';
    document.getElementById('edit-email').value = sp.email || '';
    document.getElementById('edit-commission').value = sp.commission_rate || 100;
    document.getElementById('edit-tracking').value = sp.tracking_phone_number || '';
    document.getElementById('edit-sp-form').action = '/admin/salespeople/' + sp.id;
    document.getElementById('edit-sp-modal').classList.remove('hidden');
  }

  function openMatrixModal(m) {
    document.getElementById('m-label').value = m.label || '';
    document.getElementById('m-url').value   = m.destination_url || '';
    document.getElementById('m-active').checked = m.active;
    document.getElementById('matrix-form').action = '/admin/matrix/' + m.id;
    document.getElementById('matrix-modal').classList.remove('hidden');
  }

  function openGoalModal(id, name, revGoal, ordGoal) {
    document.getElementById('goal-sp-name').textContent = name;
    document.getElementById('goal-revenue').value = revGoal || '';
    document.getElementById('goal-orders').value  = ordGoal || '';
    // Default to current month
    var now = new Date();
    var m = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
    document.getElementById('goal-month').value = m;
    document.getElementById('goal-form').action = '/admin/salespeople/' + id + '/goal';
    document.getElementById('goal-modal').classList.remove('hidden');
  }

  function openPortalModal(id, name) {
    document.getElementById('portal-sp-name').textContent = name;
    document.getElementById('portal-form').action = '/admin/salespeople/' + id + '/portal-password';
    document.getElementById('portal-modal').classList.remove('hidden');
  }

  // Close modals on backdrop click
  ['add-sp-modal','edit-sp-modal','matrix-modal','goal-modal','portal-modal'].forEach(function(id) {
    document.getElementById(id).addEventListener('click', function(e) {
      if (e.target === this) this.classList.add('hidden');
    });
  });
</script>

</body>
</html>`);
  } catch (err) {
    console.error('Admin page error:', err);
    res.status(500).send('Server error loading admin page');
  }
});

// ─── Salesperson Actions ───────────────────────────────────────────────────

router.post('/salespeople', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const { first_name, last_name, email, commission_rate, tracking_phone_number } = req.body;
  try {
    await pool.query(
      `INSERT INTO salespeople (name, email, commission_rate, tracking_phone_number)
       VALUES ($1, $2, $3, $4)`,
      [
        `${first_name} ${last_name}`.trim(),
        email,
        parseFloat(commission_rate) || 100,
        tracking_phone_number || null,
      ]
    );
    res.redirect('/admin?ok=1&msg=' + encodeURIComponent('Salesperson added successfully.'));
  } catch (err) {
    const msg = err.code === '23505' ? 'That email address already exists.' : 'Failed to add salesperson.';
    res.redirect('/admin?ok=0&msg=' + encodeURIComponent(msg));
  }
});

router.post('/salespeople/:id', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const { first_name, last_name, email, commission_rate, tracking_phone_number } = req.body;
  try {
    await pool.query(
      `UPDATE salespeople SET name=$1, email=$2, commission_rate=$3, tracking_phone_number=$4 WHERE id=$5`,
      [
        `${first_name} ${last_name}`.trim(),
        email,
        parseFloat(commission_rate) || 100,
        tracking_phone_number || null,
        req.params.id,
      ]
    );
    res.redirect('/admin?ok=1&msg=' + encodeURIComponent('Salesperson updated.'));
  } catch (err) {
    res.redirect('/admin?ok=0&msg=' + encodeURIComponent('Failed to update salesperson.'));
  }
});

router.post('/salespeople/:id/toggle', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE salespeople SET active = NOT active WHERE id = $1',
      [req.params.id]
    );
    res.redirect('/admin?ok=1&msg=' + encodeURIComponent('Salesperson status updated.'));
  } catch (err) {
    res.redirect('/admin?ok=0&msg=' + encodeURIComponent('Failed to update status.'));
  }
});

// ─── Landing Page Matrix ───────────────────────────────────────────────────

router.post('/matrix/:id', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const { destination_url, active } = req.body;
  try {
    await pool.query(
      'UPDATE landing_page_matrix SET destination_url=$1, active=$2 WHERE id=$3',
      [destination_url, active === 'true', req.params.id]
    );
    res.redirect('/admin?ok=1&msg=' + encodeURIComponent('Landing page updated.'));
  } catch (err) {
    res.redirect('/admin?ok=0&msg=' + encodeURIComponent('Failed to update landing page.'));
  }
});

// ─── Suppression List Upload ───────────────────────────────────────────────

router.post('/suppression', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  // Railway / most hosts don't have multipart by default — handle raw text CSV via body
  // For file upload we use a simple text area approach via urlencoded fallback
  // The form sends the file; we read it as text
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', async () => {
    try {
      // Extract emails from raw CSV body — handles headers, comma-separated, one-per-line
      const lines = body.split(/[\r\n,]+/).map(l => l.trim().replace(/^["']|["']$/g,'').toLowerCase());
      const emails = lines.filter(l => l.includes('@') && l.includes('.'));

      // Get reason from query since body is raw
      const reason = body.includes('existing_customer') ? 'existing_customer'
                   : body.includes('unsubscribed') ? 'unsubscribed' : 'manual';

      let added = 0;
      for (const email of emails) {
        try {
          await pool.query(
            'INSERT INTO suppression_list (email, reason) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING',
            [email, reason]
          );
          added++;
        } catch {}
      }

      res.redirect('/admin?ok=1&msg=' + encodeURIComponent(added + ' emails added to suppression list.'));
    } catch (err) {
      console.error('Suppression upload error:', err);
      res.redirect('/admin?ok=0&msg=' + encodeURIComponent('Upload failed. Please try again.'));
    }
  });
});

// ─── Set Goal ─────────────────────────────────────────────────────────────

router.post('/salespeople/:id/goal', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const { period_month, target_revenue, target_orders } = req.body;
  try {
    // period_month is "YYYY-MM", convert to first day of month
    const periodStart = period_month + '-01';
    await pool.query(
      `INSERT INTO salesperson_goals (salesperson_id, period_start, target_revenue, target_orders)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (salesperson_id, period_start)
       DO UPDATE SET target_revenue = $3, target_orders = $4`,
      [req.params.id, periodStart, parseFloat(target_revenue) || 0, parseInt(target_orders) || 0]
    );
    res.redirect('/admin?ok=1&msg=' + encodeURIComponent('Goal saved successfully.'));
  } catch (err) {
    console.error('Set goal error:', err);
    res.redirect('/admin?ok=0&msg=' + encodeURIComponent('Failed to save goal.'));
  }
});

// ─── Set Portal Password ───────────────────────────────────────────────────

router.post('/salespeople/:id/portal-password', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const bcrypt = require('bcryptjs');
  const { password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'UPDATE salespeople SET portal_password_hash = $1 WHERE id = $2',
      [hash, req.params.id]
    );
    res.redirect('/admin?ok=1&msg=' + encodeURIComponent('Portal password set. Salesperson can now log in at /portal/login.'));
  } catch (err) {
    res.redirect('/admin?ok=0&msg=' + encodeURIComponent('Failed to set portal password.'));
  }
});

// ─── Change Password ───────────────────────────────────────────────────────

router.post('/change-password', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const bcrypt = require('bcryptjs');
  const { current_password, new_password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM admin_users WHERE id = $1', [req.user.id]);
    if (!result.rows.length) return res.redirect('/admin?ok=0&msg=' + encodeURIComponent('User not found.'));

    const valid = await bcrypt.compare(current_password, result.rows[0].password_hash);
    if (!valid) return res.redirect('/admin?ok=0&msg=' + encodeURIComponent('Current password is incorrect.'));

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE admin_users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);

    res.redirect('/admin?ok=1&msg=' + encodeURIComponent('Password changed successfully.'));
  } catch (err) {
    res.redirect('/admin?ok=0&msg=' + encodeURIComponent('Failed to change password.'));
  }
});

module.exports = router;
