const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { shell, ICONS, esc } = require('../lib/layout');
const { createLlm, createAgent } = require('../lib/retell');

// ─── Helpers ───────────────────────────────────────────────────────────────

const escapeHtml = esc;

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

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
      const barColor  = !revPct ? 'bg-slate-200' : parseFloat(revPct) >= 100 ? 'bg-emerald-500' : parseFloat(revPct) >= 70 ? 'bg-yellow-400' : 'bg-sky-500';
      return `
        <tr class="border-t border-slate-100 hover:bg-slate-50 transition-colors">
          <td class="px-4 py-3">
            <div class="font-medium text-slate-900">${sp.name}</div>
            <div class="text-xs text-slate-400">${sp.commission_rate}% commission · ${sp.has_portal ? '<span class="text-emerald-500">Portal active</span>' : '<span class="text-red-300">No portal access</span>'}</div>
          </td>
          <td class="px-4 py-3">
            <div class="flex items-center gap-3">
              <div class="flex-1">
                <div class="flex justify-between text-xs mb-1">
                  <span class="text-slate-600">${fmt(revActual)}</span>
                  <span class="text-slate-400">${revGoal > 0 ? 'Goal: ' + fmt(revGoal) : 'No goal set'}</span>
                </div>
                <div class="h-2 bg-slate-100 rounded-full overflow-hidden w-full">
                  <div class="h-2 rounded-full ${barColor} transition-all" style="width:${revPct || 0}%"></div>
                </div>
                ${revPct ? '<p class="text-xs text-slate-400 mt-0.5">' + revPct + '% to goal</p>' : ''}
              </div>
            </div>
          </td>
          <td class="px-4 py-3 text-center text-sm">
            <span class="font-semibold ${ordGoal > 0 && ordActual >= ordGoal ? 'text-emerald-600' : 'text-slate-700'}">${ordActual}</span>
            ${ordGoal > 0 ? '<span class="text-slate-400"> / ' + ordGoal + '</span>' : ''}
          </td>
          <td class="px-4 py-3 text-right font-semibold text-sky-700">${fmt(sp.commission_earned)}</td>
          <td class="px-4 py-3 text-right">
            <button onclick="openGoalModal(${sp.id}, '${sp.name}', ${revGoal}, ${ordGoal})"
              class="text-xs text-sky-600 hover:text-sky-800 mr-3 font-medium">Set Goal</button>
            <button onclick="openPortalModal(${sp.id}, '${sp.name}')"
              class="text-xs text-violet-600 hover:text-violet-800 font-medium">Set Password</button>
          </td>
        </tr>`;
    }).join('');

    const spRows = salespeople.rows.map(sp => `
      <tr class="border-t border-slate-100 hover:bg-slate-50 transition-colors" id="row-${sp.id}">
        <td class="px-4 py-3">
          <div class="font-medium text-slate-900">${sp.name}</div>
          <div class="text-xs text-slate-400">${sp.email}</div>
        </td>
        <td class="px-4 py-3 text-center">
          <span class="px-2 py-0.5 rounded-full text-xs font-medium ${sp.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}">${sp.active ? 'Active' : 'Inactive'}</span>
        </td>
        <td class="px-4 py-3 text-center text-sm">${sp.commission_rate}%</td>
        <td class="px-4 py-3 text-center text-sm text-violet-600">${sp.tracking_phone_number || '<span class="text-slate-300">—</span>'}</td>
        <td class="px-4 py-3 text-right">
          <button onclick="openEditModal(${JSON.stringify(sp).replace(/"/g,'&quot;')})"
            class="text-xs text-sky-600 hover:text-sky-800 font-medium mr-3">Edit</button>
          <form method="POST" action="/admin/salespeople/${sp.id}/toggle" class="inline">
            <button type="submit" class="text-xs ${sp.active ? 'text-red-500 hover:text-red-700' : 'text-emerald-600 hover:text-emerald-800'} font-medium">
              ${sp.active ? 'Deactivate' : 'Reactivate'}
            </button>
          </form>
        </td>
      </tr>`).join('');

    const matrixRows = matrix.rows.map(m => `
      <tr class="border-t border-slate-100 hover:bg-slate-50 transition-colors">
        <td class="px-3 py-2 text-xs text-slate-600 font-medium">${m.label || '—'}</td>
        <td class="px-3 py-2 text-center"><span class="px-1.5 py-0.5 rounded-full text-xs font-medium ${m.audience_type === 'B2C' ? 'bg-sky-100 text-sky-700' : 'bg-orange-100 text-orange-700'}">${m.audience_type || '—'}</span></td>
        <td class="px-3 py-2 text-xs text-center text-slate-500">${m.product_interest || '—'}</td>
        <td class="px-3 py-2 text-xs text-center text-slate-500">${m.intent_level || '—'}</td>
        <td class="px-3 py-2 text-xs text-slate-500 max-w-xs truncate" title="${m.destination_url}">${m.destination_url}</td>
        <td class="px-3 py-2 text-center"><span class="w-2 h-2 rounded-full inline-block ${m.active ? 'bg-emerald-400' : 'bg-slate-300'}"></span></td>
        <td class="px-3 py-2 text-right">
          <button onclick="openMatrixModal(${JSON.stringify(m).replace(/"/g,'&quot;')})"
            class="text-xs text-sky-600 hover:text-sky-800 font-medium">Edit</button>
        </td>
      </tr>`).join('');

    const adminContent = `
    <div class="px-6 py-8 max-w-7xl mx-auto">
      ${flash}

      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-slate-900">Admin</h1>
          <p class="text-sm text-slate-500 mt-0.5">Manage salespeople, goals, and system configuration</p>
        </div>
        <a href="/admin/agency" class="inline-flex items-center gap-1.5 px-4 py-2 bg-violet-600 text-white text-sm rounded-lg hover:bg-violet-700 transition-colors">
          Agency Dashboard &rarr;
        </a>
      </div>

      <!-- Salespeople -->
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 mb-6 overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 class="font-semibold text-slate-800">Salespeople</h2>
          <button onclick="document.getElementById('add-sp-modal').classList.remove('hidden')"
            class="inline-flex items-center gap-1.5 px-4 py-2 bg-sky-600 text-white text-sm rounded-lg hover:bg-sky-700 transition-colors">
            ${ICONS.plus} Add Salesperson
          </button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm data-table">
            <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
              <tr>
                <th class="px-4 py-3 text-left">Name / Email</th>
                <th class="px-4 py-3 text-center">Status</th>
                <th class="px-4 py-3 text-center">Commission</th>
                <th class="px-4 py-3 text-center">Tracking Number</th>
                <th class="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${spRows || '<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400">No salespeople yet. Add one above.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Goals & Performance -->
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 mb-6 overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-100">
          <h2 class="font-semibold text-slate-800">Goals &amp; Performance — ${monthLabel}</h2>
          <p class="text-xs text-slate-400 mt-0.5">Set monthly revenue and order targets. Enable portal access per salesperson.</p>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm data-table">
            <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
              <tr>
                <th class="px-4 py-3 text-left">Salesperson</th>
                <th class="px-4 py-3 text-left">Revenue vs Goal</th>
                <th class="px-4 py-3 text-center">Orders vs Goal</th>
                <th class="px-4 py-3 text-right">Commission</th>
                <th class="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${goalRows || '<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400">No active salespeople yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Landing Page Matrix -->
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 mb-6 overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-100">
          <h2 class="font-semibold text-slate-800">Landing Page Matrix</h2>
          <p class="text-xs text-slate-400 mt-0.5">Controls which page each email CTA links to based on lead segment</p>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm data-table">
            <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
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
              ${matrixRows || '<tr><td colspan="7" class="px-4 py-6 text-center text-slate-400">No matrix entries yet</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Suppression List -->
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 mb-6 p-6">
        <h2 class="font-semibold text-slate-800 mb-1">Suppression List</h2>
        <p class="text-xs text-slate-400 mb-4">Upload your Shopify customer list so they never receive the dormant lead reconnect sequence.</p>
        <div class="flex items-center gap-6 mb-4">
          <div class="text-3xl font-bold text-slate-700">${parseInt(suppressionCount.rows[0].count).toLocaleString()}</div>
          <div class="text-sm text-slate-500">emails suppressed</div>
          <a href="/admin/suppression" class="ml-auto text-sm text-sky-600 hover:text-sky-700 font-medium transition-colors">View &amp; manage &rarr;</a>
        </div>
        <form method="POST" action="/admin/suppression" enctype="multipart/form-data" class="flex items-end gap-4 flex-wrap">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Upload CSV (one email per row, or column named "email")</label>
            <input type="file" name="csv" accept=".csv,.txt" required
              class="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-600">
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Reason</label>
            <select name="reason" class="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700">
              <option value="existing_customer">Existing Customer</option>
              <option value="unsubscribed">Unsubscribed</option>
              <option value="manual">Manual</option>
            </select>
          </div>
          <button type="submit" class="px-4 py-2 bg-slate-800 text-white text-sm rounded-lg hover:bg-slate-900 transition-colors">
            Upload &amp; Suppress
          </button>
        </form>
      </div>

      <!-- Admin Password -->
      <div class="bg-white rounded-xl shadow-sm p-6 border border-red-100">
        <h2 class="font-semibold text-red-700 mb-3">Admin Password</h2>
        <form method="POST" action="/admin/change-password" class="flex items-end gap-4 flex-wrap">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Current Password</label>
            <input type="password" name="current_password" required
              class="text-sm border border-slate-200 rounded-lg px-3 py-2 w-48 focus:outline-none focus:ring-2 focus:ring-red-400">
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">New Password</label>
            <input type="password" name="new_password" required minlength="8"
              class="text-sm border border-slate-200 rounded-lg px-3 py-2 w-48 focus:outline-none focus:ring-2 focus:ring-red-400">
          </div>
          <button type="submit" class="px-4 py-2 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 transition-colors">
            Change Password
          </button>
        </form>
      </div>
    </div>

    <!-- Add Salesperson Modal -->
    <div id="add-sp-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md mx-4">
        <div class="flex justify-between items-center mb-4">
          <h3 class="font-bold text-slate-900">Add Salesperson</h3>
          <button onclick="document.getElementById('add-sp-modal').classList.add('hidden')" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">${ICONS.x}</button>
        </div>
        <form method="POST" action="/admin/salespeople" class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">First Name</label>
              <input type="text" name="first_name" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">Last Name</label>
              <input type="text" name="last_name" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Email Address</label>
            <input type="email" name="email" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">Direct Phone</label>
              <input type="text" name="phone" placeholder="(818) 555-0101" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">Title</label>
              <input type="text" name="title" placeholder="Sales Representative" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">Voice Extension</label>
              <input type="text" name="voice_extension" placeholder="101" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">Commission Rate (%)</label>
              <input type="number" name="commission_rate" value="100" min="0" max="100" step="0.5" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
          </div>
          <div class="flex gap-3 pt-2">
            <button type="submit" class="flex-1 bg-sky-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-sky-700 transition-colors">Add Salesperson</button>
            <button type="button" onclick="document.getElementById('add-sp-modal').classList.add('hidden')" class="flex-1 border border-slate-200 text-slate-600 rounded-lg py-2 text-sm hover:bg-slate-50 transition-colors">Cancel</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Edit Salesperson Modal -->
    <div id="edit-sp-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md mx-4">
        <div class="flex justify-between items-center mb-4">
          <h3 class="font-bold text-slate-900">Edit Salesperson</h3>
          <button onclick="document.getElementById('edit-sp-modal').classList.add('hidden')" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">${ICONS.x}</button>
        </div>
        <form method="POST" id="edit-sp-form" action="" class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">First Name</label>
              <input type="text" name="first_name" id="edit-first" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">Last Name</label>
              <input type="text" name="last_name" id="edit-last" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Email Address</label>
            <input type="email" name="email" id="edit-email" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">Direct Phone</label>
              <input type="text" name="phone" id="edit-phone" placeholder="(818) 555-0101" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">Title</label>
              <input type="text" name="title" id="edit-title" placeholder="Sales Representative" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">Voice Extension</label>
              <input type="text" name="voice_extension" id="edit-extension" placeholder="101" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">Commission Rate (%)</label>
              <input type="number" name="commission_rate" id="edit-commission" min="0" max="100" step="0.5" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
          </div>
          <div class="flex gap-3 pt-2">
            <button type="submit" class="flex-1 bg-sky-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-sky-700 transition-colors">Save Changes</button>
            <button type="button" onclick="document.getElementById('edit-sp-modal').classList.add('hidden')" class="flex-1 border border-slate-200 text-slate-600 rounded-lg py-2 text-sm hover:bg-slate-50 transition-colors">Cancel</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Edit Matrix Modal -->
    <div id="matrix-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md mx-4">
        <div class="flex justify-between items-center mb-4">
          <h3 class="font-bold text-slate-900">Edit Landing Page Entry</h3>
          <button onclick="document.getElementById('matrix-modal').classList.add('hidden')" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">${ICONS.x}</button>
        </div>
        <form method="POST" id="matrix-form" action="" class="space-y-4">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Label</label>
            <input type="text" name="label" id="m-label" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-50" readonly>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Destination URL <span class="text-slate-400 font-normal">(e.g. /pages/request-a-quote)</span></label>
            <input type="text" name="destination_url" id="m-url" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
          </div>
          <div class="flex items-center gap-2">
            <input type="checkbox" name="active" id="m-active" value="true" class="rounded">
            <label for="m-active" class="text-sm text-slate-700">Active</label>
          </div>
          <div class="flex gap-3 pt-2">
            <button type="submit" class="flex-1 bg-sky-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-sky-700 transition-colors">Save URL</button>
            <button type="button" onclick="document.getElementById('matrix-modal').classList.add('hidden')" class="flex-1 border border-slate-200 text-slate-600 rounded-lg py-2 text-sm hover:bg-slate-50 transition-colors">Cancel</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Set Goal Modal -->
    <div id="goal-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md mx-4">
        <div class="flex justify-between items-center mb-4">
          <h3 class="font-bold text-slate-900">Set Monthly Goal — <span id="goal-sp-name" class="text-sky-600"></span></h3>
          <button onclick="document.getElementById('goal-modal').classList.add('hidden')" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">${ICONS.x}</button>
        </div>
        <form method="POST" id="goal-form" action="" class="space-y-4">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Month <span class="text-slate-400 font-normal">(first day of month)</span></label>
            <input type="month" name="period_month" id="goal-month" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">Revenue Target ($)</label>
              <input type="number" name="target_revenue" id="goal-revenue" min="0" step="100" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-600 mb-1">Orders Target</label>
              <input type="number" name="target_orders" id="goal-orders" min="0" step="1" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
          </div>
          <div class="flex gap-3 pt-2">
            <button type="submit" class="flex-1 bg-sky-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-sky-700 transition-colors">Save Goal</button>
            <button type="button" onclick="document.getElementById('goal-modal').classList.add('hidden')" class="flex-1 border border-slate-200 text-slate-600 rounded-lg py-2 text-sm hover:bg-slate-50 transition-colors">Cancel</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Set Portal Password Modal -->
    <div id="portal-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-white rounded-xl shadow-2xl p-6 w-full max-w-sm mx-4">
        <div class="flex justify-between items-center mb-4">
          <h3 class="font-bold text-slate-900">Portal Access — <span id="portal-sp-name" class="text-violet-600"></span></h3>
          <button onclick="document.getElementById('portal-modal').classList.add('hidden')" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">${ICONS.x}</button>
        </div>
        <p class="text-xs text-slate-500 mb-4">Set a password so this salesperson can log in at <strong>/portal/login</strong> with their email.</p>
        <form method="POST" id="portal-form" action="" class="space-y-4">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">New Password</label>
            <input type="password" name="password" required minlength="6" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500">
          </div>
          <div class="flex gap-3 pt-2">
            <button type="submit" class="flex-1 bg-violet-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-violet-700 transition-colors">Set Password</button>
            <button type="button" onclick="document.getElementById('portal-modal').classList.add('hidden')" class="flex-1 border border-slate-200 text-slate-600 rounded-lg py-2 text-sm hover:bg-slate-50 transition-colors">Cancel</button>
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
      document.getElementById('edit-phone').value = sp.phone || '';
      document.getElementById('edit-title').value = sp.title || '';
      document.getElementById('edit-extension').value = sp.voice_extension || '';
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
    ['add-sp-modal','edit-sp-modal','matrix-modal','goal-modal','portal-modal'].forEach(function(id) {
      document.getElementById(id).addEventListener('click', function(e) {
        if (e.target === this) this.classList.add('hidden');
      });
    });
    </script>`;

    res.send(shell('Admin', 'admin', adminContent, { user: req.user }));
  } catch (err) {
    console.error('Admin page error:', err);
    res.status(500).send('Server error loading admin page');
  }
});

// ─── Salesperson Actions ───────────────────────────────────────────────────

router.post('/salespeople', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const { first_name, last_name, email, commission_rate, tracking_phone_number, phone, title, voice_extension } = req.body;
  try {
    await pool.query(
      `INSERT INTO salespeople (name, email, commission_rate, tracking_phone_number, phone, title, voice_extension)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        `${first_name} ${last_name}`.trim(),
        email,
        parseFloat(commission_rate) || 100,
        tracking_phone_number || null,
        phone || null,
        title || null,
        voice_extension || null,
      ]
    );
    res.redirect('/admin?ok=1&msg=' + encodeURIComponent('Salesperson added successfully.'));
  } catch (err) {
    const msg = err.code === '23505' ? 'That email address already exists.' : 'Failed to add salesperson.';
    res.redirect('/admin?ok=0&msg=' + encodeURIComponent(msg));
  }
});

router.post('/salespeople/:id', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const { first_name, last_name, email, commission_rate, tracking_phone_number, phone, title, voice_extension } = req.body;
  try {
    await pool.query(
      `UPDATE salespeople SET name=$1, email=$2, commission_rate=$3, tracking_phone_number=$4, phone=$5, title=$6, voice_extension=$7 WHERE id=$8`,
      [
        `${first_name} ${last_name}`.trim(),
        email,
        parseFloat(commission_rate) || 100,
        tracking_phone_number || null,
        phone || null,
        title || null,
        voice_extension || null,
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

// ─── Suppression List Management ──────────────────────────────────────────

router.get('/suppression', requireAuth, async (req, res) => {
  const search = req.query.search || '';
  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const size   = 50;
  const offset = (page - 1) * size;

  const params = search ? [`%${search}%`] : [];
  const where  = search ? `WHERE LOWER(email) LIKE LOWER($1)` : '';

  const [rows, countRow] = await Promise.all([
    pool.query(`SELECT * FROM suppression_list ${where} ORDER BY added_at DESC LIMIT ${size} OFFSET ${offset}`, params),
    pool.query(`SELECT COUNT(*) FROM suppression_list ${where}`, params),
  ]);

  const total      = parseInt(countRow.rows[0].count);
  const totalPages = Math.ceil(total / size);
  const msg        = req.query.msg || '';
  const ok         = req.query.ok;

  const suppressContent = `
    <div class="px-6 py-8 max-w-4xl mx-auto">
      <div class="flex items-center justify-between mb-6">
        <div>
          <a href="/admin" class="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-slate-600 transition-colors mb-1">
            ${ICONS.arrowleft} Admin
          </a>
          <h1 class="text-2xl font-bold text-slate-900">Suppression List</h1>
        </div>
        <span class="text-sm text-slate-500 bg-slate-100 px-3 py-1.5 rounded-lg">${total.toLocaleString()} suppressed</span>
      </div>

      ${msg ? `<div class="mb-4 px-4 py-3 rounded-lg text-sm ${ok === '1' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}">${escapeHtml(msg)}</div>` : ''}

      <form method="GET" action="/admin/suppression" class="mb-4 flex gap-2">
        <input type="text" name="search" value="${escapeHtml(search)}" placeholder="Search email…"
          class="border border-slate-200 rounded-lg px-3 py-2 text-sm w-72 focus:outline-none focus:ring-2 focus:ring-sky-500">
        <button class="bg-sky-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-sky-700 transition-colors">Search</button>
        ${search ? `<a href="/admin/suppression" class="text-sm text-slate-400 hover:text-slate-600 py-2 px-2 transition-colors">Clear</a>` : ''}
      </form>

      <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
        <table class="w-full text-sm data-table">
          <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
            <tr>
              <th class="px-4 py-3 text-left">Email</th>
              <th class="px-4 py-3 text-left">Reason</th>
              <th class="px-4 py-3 text-left">Added</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            ${rows.rows.length === 0
              ? `<tr><td colspan="4" class="px-4 py-10 text-center text-slate-400">No suppressed emails${search ? ' matching your search' : ''}.</td></tr>`
              : rows.rows.map(r => `
            <tr class="border-t border-slate-100 hover:bg-slate-50 transition-colors">
              <td class="px-4 py-3 text-slate-800 font-mono text-xs">${escapeHtml(r.email)}</td>
              <td class="px-4 py-3">
                <span class="px-2 py-0.5 rounded-full text-xs font-medium ${r.reason === 'bounced' ? 'bg-red-100 text-red-700' : r.reason === 'unsubscribed' ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-600'}">
                  ${escapeHtml(r.reason || 'manual')}
                </span>
              </td>
              <td class="px-4 py-3 text-slate-400 text-xs">${new Date(r.added_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
              <td class="px-4 py-3 text-right">
                <button onclick="removeEmail('${escapeHtml(r.email)}')"
                  class="text-xs text-red-500 hover:text-red-700 border border-red-200 rounded-lg px-2.5 py-1 hover:bg-red-50 transition-colors">
                  Remove
                </button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>

        ${totalPages > 1 ? `
        <div class="px-4 py-3 border-t border-slate-100 flex justify-between items-center text-sm text-slate-500">
          <span>Page ${page} of ${totalPages}</span>
          <div class="flex gap-2">
            ${page > 1 ? `<a href="?${new URLSearchParams({ ...(search ? { search } : {}), page: page - 1 })}" class="px-3 py-1 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">&larr; Prev</a>` : ''}
            ${page < totalPages ? `<a href="?${new URLSearchParams({ ...(search ? { search } : {}), page: page + 1 })}" class="px-3 py-1 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">Next &rarr;</a>` : ''}
          </div>
        </div>` : ''}
      </div>
    </div>

    <script>
    async function removeEmail(email) {
      if (!await showConfirm('Remove <strong>' + email + '</strong> from suppression list?<br><span class="text-slate-500 text-xs">This will allow emails to this address again.</span>', 'Remove')) return;
      const res = await fetch('/admin/suppression/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast(email + ' removed from suppression list.', 'success');
        setTimeout(() => window.location.href = '/admin/suppression', 1200);
      } else {
        showToast('Failed: ' + (data.error || 'unknown error'), 'error');
      }
    }
    </script>`;

  res.send(shell('Suppression List', 'admin', suppressContent, { user: req.user }));
});

router.post('/suppression/remove', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  await pool.query('DELETE FROM suppression_list WHERE LOWER(email) = LOWER($1)', [email]);
  res.json({ ok: true });
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

// ─── Client Management ─────────────────────────────────────────────────────

// GET /admin/clients — list all clients with org name
router.get('/clients', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.name, c.slug, c.active, o.name AS org_name
      FROM clients c
      JOIN organizations o ON o.id = c.organization_id
      ORDER BY o.name, c.name
    `);
    const rowsHtml = rows.length === 0
      ? `<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400">No clients yet. Create one above.</td></tr>`
      : rows.map(c => `
        <tr class="border-t border-slate-100 hover:bg-slate-50 transition-colors">
          <td class="px-4 py-3 font-medium text-slate-900">${c.name}</td>
          <td class="px-4 py-3 text-sm text-slate-500">${c.org_name}</td>
          <td class="px-4 py-3 text-sm"><code class="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-xs">${c.slug}</code></td>
          <td class="px-4 py-3 text-center">
            <span class="px-2 py-0.5 rounded-full text-xs font-medium ${c.active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}">${c.active ? 'Active' : 'Inactive'}</span>
          </td>
          <td class="px-4 py-3 text-right">
            <a href="/admin/clients/${c.id}/edit" class="text-xs text-sky-600 hover:text-sky-800 font-medium">Edit</a>
          </td>
        </tr>`).join('');

    const clientsContent = `
      <div class="px-6 py-8 max-w-5xl mx-auto">
        <div class="flex justify-between items-center mb-6">
          <h1 class="text-2xl font-bold text-slate-900">Clients</h1>
          <a href="/admin/clients/new" class="inline-flex items-center gap-1.5 px-4 py-2 bg-sky-600 text-white text-sm rounded-lg hover:bg-sky-700 transition-colors">
            ${ICONS.plus} New Client
          </a>
        </div>
        <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <table class="w-full text-sm data-table">
            <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
              <tr>
                <th class="px-4 py-3 text-left">Name</th>
                <th class="px-4 py-3 text-left">Org</th>
                <th class="px-4 py-3 text-left">Slug</th>
                <th class="px-4 py-3 text-center">Status</th>
                <th class="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>`;

    res.send(shell('Clients', 'admin', clientsContent, { user: req.user }));
  } catch (err) {
    console.error('Clients list error:', err);
    res.status(500).send('Server error loading clients');
  }
});

// GET /admin/clients/new — blank create form
router.get('/clients/new', requireAuth, async (req, res) => {
  try {
    const { rows: orgs } = await pool.query('SELECT id, name FROM organizations ORDER BY name');
    const orgOptions = orgs.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
    res.send(clientFormHtml(null, orgOptions, []));
  } catch (err) {
    console.error('New client form error:', err);
    res.status(500).send('Server error');
  }
});

// POST /admin/clients — create new client
router.post('/clients', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const { organization_id, name, slug, brand_config, commission_rules, integration_settings } = req.body;
  const voice_extension = (req.body.voice_extension || '').trim() || null;
  const errors = [];
  if (!name || name.trim().length < 2) errors.push('Name must be at least 2 characters');
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) errors.push('Slug must be lowercase alphanumeric with hyphens only');

  if (errors.length) {
    try {
      const { rows: orgs } = await pool.query('SELECT id, name FROM organizations ORDER BY name');
      const orgOptions = orgs.map(o => `<option value="${o.id}" ${organization_id == o.id ? 'selected' : ''}>${o.name}</option>`).join('');
      return res.status(400).send(clientFormHtml(null, orgOptions, errors, req.body));
    } catch (err) {
      return res.status(500).send('Server error');
    }
  }

  const brandJson = parseJsonField(brand_config, {});
  const commJson  = parseJsonField(commission_rules, {});
  const intJson   = parseJsonField(integration_settings, {});

  try {
    await pool.query(
      `INSERT INTO clients (organization_id, name, slug, brand_config, commission_rules, integration_settings, voice_extension)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [organization_id, name.trim(), slug.trim(), JSON.stringify(brandJson), JSON.stringify(commJson), JSON.stringify(intJson), voice_extension]
    );
    res.redirect('/admin/clients');
  } catch (err) {
    const msg = err.code === '23505' ? 'Slug already exists — choose a different slug.' : 'Failed to create client.';
    try {
      const { rows: orgs } = await pool.query('SELECT id, name FROM organizations ORDER BY name');
      const orgOptions = orgs.map(o => `<option value="${o.id}" ${organization_id == o.id ? 'selected' : ''}>${o.name}</option>`).join('');
      return res.status(400).send(clientFormHtml(null, orgOptions, [msg], req.body));
    } catch {
      return res.status(500).send(msg);
    }
  }
});

// GET /admin/clients/:id/edit — pre-populated edit form
router.get('/clients/:id/edit', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).send('Client not found');
    const { rows: orgs } = await pool.query('SELECT id, name FROM organizations ORDER BY name');
    const client = rows[0];
    const orgOptions = orgs.map(o => `<option value="${o.id}" ${client.organization_id == o.id ? 'selected' : ''}>${o.name}</option>`).join('');
    res.send(clientFormHtml(client, orgOptions, []));
  } catch (err) {
    console.error('Edit client form error:', err);
    res.status(500).send('Server error');
  }
});

// POST /admin/clients/:id — update existing client
router.post('/clients/:id', express.urlencoded({ extended: true }), requireAuth, async (req, res) => {
  const { name, slug, brand_config, commission_rules, integration_settings, active } = req.body;
  const voice_extension = (req.body.voice_extension || '').trim() || null;
  const brandJson = parseJsonField(brand_config, {});
  const commJson  = parseJsonField(commission_rules, {});
  const intJson   = parseJsonField(integration_settings, {});
  try {
    await pool.query(
      `UPDATE clients
       SET name=$1, slug=$2, brand_config=$3, commission_rules=$4,
           integration_settings=$5, active=$6, voice_extension=$7
       WHERE id=$8`,
      [name.trim(), slug.trim(), JSON.stringify(brandJson), JSON.stringify(commJson),
       JSON.stringify(intJson), active === 'on', voice_extension, req.params.id]
    );
    res.redirect('/admin/clients');
  } catch (err) {
    console.error('Update client error:', err);
    res.redirect('/admin/clients');
  }
});

// ─── Provision Voice Agent ─────────────────────────────────────────────────

/**
 * POST /admin/clients/:id/provision-voice
 * Creates a Retell LLM + agent for the client and stores the IDs.
 * Idempotent: calling again re-provisions (overwrites existing agent IDs).
 * Requires RETELL_API_KEY in env.
 */
router.post('/clients/:id/provision-voice', requireAuth, requireRole('operator', 'owner'), async (req, res) => {
  const clientId = parseInt(req.params.id);
  if (!clientId) return res.status(400).json({ error: 'invalid client id' });

  try {
    // Load client for name
    const { rows } = await pool.query(
      `SELECT brand_config FROM clients WHERE id = $1`,
      [clientId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'client not found' });

    const brandConfig = rows[0].brand_config || {};
    const clientName  = brandConfig.name || `Client ${clientId}`;
    const appBaseUrl  = process.env.APP_BASE_URL || `https://${req.hostname}`;

    // Step 1: Create LLM
    const llmResult = await createLlm(
      `You are a friendly sales assistant for ${clientName}. ` +
      `Help callers with questions about our products and services. ` +
      `Collect the caller's name and best callback number before ending the call.`
    );
    if (!llmResult.ok) {
      console.error(`[provision-voice] createLlm failed for client ${clientId}:`, llmResult.error);
      return res.status(500).json({ error: 'Failed to create Retell LLM', detail: llmResult.error });
    }

    // Step 2: Create Agent
    const webhookUrl = `${appBaseUrl}/retell-hooks/call-ended`;
    const agentResult = await createAgent(
      llmResult.llmId,
      `${clientName} AI Agent`,
      webhookUrl
    );
    if (!agentResult.ok) {
      console.error(`[provision-voice] createAgent failed for client ${clientId}:`, agentResult.error);
      return res.status(500).json({ error: 'Failed to create Retell agent', detail: agentResult.error });
    }

    // Step 3: Save both IDs to clients table
    await pool.query(
      `UPDATE clients
       SET retell_llm_id = $1, retell_agent_id = $2
       WHERE id = $3`,
      [llmResult.llmId, agentResult.agentId, clientId]
    );

    console.log(`[provision-voice] client ${clientId}: llm=${llmResult.llmId} agent=${agentResult.agentId}`);
    return res.json({ ok: true, llmId: llmResult.llmId, agentId: agentResult.agentId });

  } catch (err) {
    console.error(`[provision-voice] unexpected error for client ${clientId}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Agency Dashboard ──────────────────────────────────────────────────────

router.get('/agency', requireAuth, requireRole('operator', 'owner'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        c.id,
        c.name AS client_name,
        c.slug,
        COUNT(DISTINCT o.id)                                AS units_this_month,
        COALESCE(SUM(o.amount), 0)                         AS revenue_this_month,
        COALESCE(SUM(cm.commission_earned), 0)             AS commission_owed,
        COALESCE(SUM(cm.commission_earned) FILTER (WHERE cm.status = 'paid'), 0) AS commission_paid,
        COUNT(DISTINCT s.id)                               AS salesperson_count
      FROM clients c
        LEFT JOIN orders o  ON o.client_id = c.id
          AND DATE_TRUNC('month', o.ordered_at) = DATE_TRUNC('month', NOW())
        LEFT JOIN commissions cm ON cm.client_id = c.id
          AND DATE_TRUNC('month', cm.created_at) = DATE_TRUNC('month', NOW())
        LEFT JOIN salespeople s ON s.client_id = c.id AND s.active = true
      WHERE c.organization_id = $1
        AND c.active = true
      GROUP BY c.id, c.name, c.slug
      ORDER BY revenue_this_month DESC
    `, [req.user.organization_id]);

    const fmt = n => '$' + parseFloat(n||0).toLocaleString('en-US', { minimumFractionDigits: 0 });

    const clientRows = rows.length === 0
      ? `<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400">No clients yet.</td></tr>`
      : rows.map(c => `
        <tr class="border-t border-slate-100 hover:bg-slate-50 transition-colors">
          <td class="px-4 py-3 font-medium text-slate-900">${c.client_name}</td>
          <td class="px-4 py-3 text-center text-sm text-slate-600">${c.salesperson_count}</td>
          <td class="px-4 py-3 text-center text-sm text-slate-600">${c.units_this_month}</td>
          <td class="px-4 py-3 text-right text-sm font-semibold text-emerald-700">${fmt(c.revenue_this_month)}</td>
          <td class="px-4 py-3 text-right text-sm font-semibold text-sky-700">${fmt(c.commission_owed)}</td>
          <td class="px-4 py-3 text-right">
            <a href="/admin/agency/clients/${c.id}/dashboard" class="text-xs text-sky-600 hover:text-sky-800 font-medium">View &rarr;</a>
          </td>
        </tr>`).join('');

    const agencyContent = `
      <div class="px-6 py-8 max-w-6xl mx-auto">
        <div class="flex justify-between items-center mb-6">
          <div>
            <h1 class="text-2xl font-bold text-slate-900">Agency Dashboard</h1>
            <p class="text-sm text-slate-400 mt-0.5">All clients — current month</p>
          </div>
        </div>
        <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <table class="w-full text-sm data-table">
            <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
              <tr>
                <th class="px-4 py-3 text-left">Client</th>
                <th class="px-4 py-3 text-center">Salespeople</th>
                <th class="px-4 py-3 text-center">Units</th>
                <th class="px-4 py-3 text-right">Revenue</th>
                <th class="px-4 py-3 text-right">Commission Owed</th>
                <th class="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>${clientRows}</tbody>
          </table>
        </div>
      </div>`;

    res.send(shell('Agency Dashboard', 'admin', agencyContent, { user: req.user }));
  } catch (err) {
    console.error('Agency dashboard error:', err);
    res.status(500).send('Server error loading agency dashboard');
  }
});

router.get('/agency/clients/:clientId/dashboard', requireAuth, requireRole('operator', 'owner'), async (req, res) => {
  try {
    const clientCheck = await pool.query(
      'SELECT id, name, organization_id FROM clients WHERE id = $1',
      [req.params.clientId]
    );
    if (!clientCheck.rows.length || clientCheck.rows[0].organization_id !== req.user.organization_id) {
      return res.status(404).send('Client not found');
    }
    const client = clientCheck.rows[0];

    const { rows } = await pool.query(`
      SELECT
        s.id, s.name, s.email,
        COUNT(o.id)                                     AS units_this_month,
        COALESCE(SUM(o.amount), 0)                     AS revenue_this_month,
        COALESCE(SUM(cm.commission_earned), 0)         AS commission_owed,
        c.commission_rules
      FROM salespeople s
      JOIN clients c ON c.id = s.client_id
      LEFT JOIN orders o ON o.salesperson_id = s.id
        AND o.client_id = s.client_id
        AND DATE_TRUNC('month', o.ordered_at) = DATE_TRUNC('month', NOW())
      LEFT JOIN commissions cm ON cm.salesperson_id = s.id
        AND cm.client_id = s.client_id
        AND DATE_TRUNC('month', cm.created_at) = DATE_TRUNC('month', NOW())
      WHERE s.client_id = $1 AND s.active = true
      GROUP BY s.id, s.name, s.email, c.commission_rules
      ORDER BY revenue_this_month DESC
    `, [req.params.clientId]);

    const fmt = n => '$' + parseFloat(n||0).toLocaleString('en-US', { minimumFractionDigits: 0 });
    const { calculateCommission } = require('../lib/commissions');

    const spRowsClient = rows.length === 0
      ? `<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400">No active salespeople for this client.</td></tr>`
      : rows.map(sp => {
          const units = parseInt(sp.units_this_month || 0);
          const { rate } = calculateCommission(0, units, sp.commission_rules || {}, 100);
          return `
        <tr class="border-t border-slate-100 hover:bg-slate-50 transition-colors">
          <td class="px-4 py-3">
            <div class="font-medium text-slate-900">${sp.name}</div>
            <div class="text-xs text-slate-400">${sp.email}</div>
          </td>
          <td class="px-4 py-3 text-center text-sm text-slate-600">${units}</td>
          <td class="px-4 py-3 text-center text-sm text-slate-600">${rate}%</td>
          <td class="px-4 py-3 text-right text-sm font-semibold text-emerald-700">${fmt(sp.revenue_this_month)}</td>
          <td class="px-4 py-3 text-right text-sm font-semibold text-sky-700">${fmt(sp.commission_owed)}</td>
        </tr>`;
        }).join('');

    const clientDashContent = `
      <div class="px-6 py-8 max-w-6xl mx-auto">
        <div class="mb-6">
          <a href="/admin/agency" class="inline-flex items-center gap-1 text-xs text-sky-600 hover:text-sky-800 font-medium transition-colors mb-2">
            ${ICONS.arrowleft} Agency Dashboard
          </a>
          <h1 class="text-2xl font-bold text-slate-900">${esc(client.name)}</h1>
          <p class="text-sm text-slate-400 mt-0.5">Salesperson performance — current month</p>
        </div>
        <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <table class="w-full text-sm data-table">
            <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
              <tr>
                <th class="px-4 py-3 text-left">Salesperson</th>
                <th class="px-4 py-3 text-center">Units This Month</th>
                <th class="px-4 py-3 text-center">Current Tier</th>
                <th class="px-4 py-3 text-right">Revenue</th>
                <th class="px-4 py-3 text-right">Commission Owed</th>
              </tr>
            </thead>
            <tbody>${spRowsClient}</tbody>
          </table>
        </div>
      </div>`;

    res.send(shell(client.name, 'admin', clientDashContent, { user: req.user }));
  } catch (err) {
    console.error('Client drilldown error:', err);
    res.status(500).send('Server error loading client dashboard');
  }
});

// ─── Client form HTML helper ───────────────────────────────────────────────

function clientFormHtml(client, orgOptions, errors, prefill = {}) {
  const title = client ? `Edit Client: ${client.name}` : 'New Client';
  const action = client ? `/admin/clients/${client.id}` : '/admin/clients';
  const errHtml = errors.length
    ? `<div class="mb-4 p-3 rounded bg-red-50 border border-red-200 text-red-700 text-sm"><ul class="list-disc list-inside">${errors.map(e => `<li>${e}</li>`).join('')}</ul></div>`
    : '';
  const val = (field, fallback = '') => {
    if (prefill[field] !== undefined) return prefill[field];
    if (client && client[field] !== undefined) return client[field];
    return fallback;
  };
  const jsonVal = (field) => {
    if (prefill[field] !== undefined) return prefill[field];
    if (client && client[field] !== undefined) return JSON.stringify(client[field], null, 2);
    return '{}';
  };
  const formContent = `
    <div class="px-6 py-8 max-w-2xl mx-auto">
      <div class="mb-6">
        <a href="/admin/clients" class="inline-flex items-center gap-1 text-xs text-sky-600 hover:text-sky-800 font-medium transition-colors mb-2">
          ← Clients
        </a>
        <h1 class="text-2xl font-bold text-slate-900">${title}</h1>
      </div>
      ${errHtml}
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
        <form method="POST" action="${action}" class="space-y-4">
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Organization</label>
            <select name="organization_id" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">${orgOptions}</select>
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Client Name</label>
            <input type="text" name="name" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" value="${val('name')}">
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-600 mb-1">Slug <span class="font-normal text-slate-400">(lowercase, hyphens only)</span></label>
            <input type="text" name="slug" required pattern="[a-z0-9-]+" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" value="${val('slug')}">
          </div>

          <div class="border-t border-slate-100 pt-4">
            <h3 class="text-sm font-semibold text-slate-700 mb-1">Brand Config <span class="font-normal text-slate-400">(JSON)</span></h3>
            <p class="text-xs text-slate-400 mb-2">Keys: primary_color, accent_color, bg_color, name, phone, website, address, cta_url, cta_label</p>
            <textarea name="brand_config" rows="8" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500">${jsonVal('brand_config')}</textarea>
          </div>

          <div class="border-t border-slate-100 pt-4">
            <h3 class="text-sm font-semibold text-slate-700 mb-1">Commission Rules <span class="font-normal text-slate-400">(JSON)</span></h3>
            <textarea name="commission_rules" rows="4" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500">${jsonVal('commission_rules')}</textarea>
          </div>

          <div class="border-t border-slate-100 pt-4">
            <h3 class="text-sm font-semibold text-slate-700 mb-1">Integration Settings <span class="font-normal text-slate-400">(JSON)</span></h3>
            <textarea name="integration_settings" rows="4" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500">${jsonVal('integration_settings')}</textarea>
          </div>

          <div class="border-t border-slate-100 pt-4 mt-4">
            <h3 class="text-sm font-semibold text-slate-700 mb-3">Voice (Retell AI)</h3>
            <div class="grid grid-cols-2 gap-4">
              <div>
                <label class="block text-xs font-medium text-slate-600 mb-1">Voice Extension</label>
                <input type="text" name="voice_extension" value="${escapeHtml(client && client.voice_extension || '')}"
                       placeholder="e.g. 1"
                       class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
                <p class="text-xs text-slate-400 mt-1">Extension number for IVR routing (optional)</p>
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-600 mb-1">Retell Agent ID</label>
                <input type="text" value="${escapeHtml(client && client.retell_agent_id || 'Not provisioned')}"
                       readonly
                       class="w-full border border-slate-100 rounded-lg px-3 py-2 text-sm bg-slate-50 text-slate-400 cursor-not-allowed">
              </div>
            </div>
          ${client && client.id ? `
          <div class="mt-3">
            <button type="button"
                    onclick="provisionVoice(${client.id})"
                    class="px-4 py-2 bg-purple-600 text-white text-sm rounded hover:bg-purple-700">
              ${client.retell_agent_id ? 'Re-provision Voice Agent' : 'Provision Voice Agent'}
            </button>
            <span id="provision-status-${client.id}" class="ml-3 text-sm text-gray-500"></span>
          </div>
          <script>
          async function provisionVoice(clientId) {
            const btn = document.querySelector('[onclick="provisionVoice(' + clientId + ')"]');
            const status = document.getElementById('provision-status-' + clientId);
            btn.disabled = true;
            status.textContent = 'Provisioning...';
            try {
              const r = await fetch('/admin/clients/' + clientId + '/provision-voice', { method: 'POST' });
              const data = await r.json();
              if (data.ok) {
                status.textContent = 'Agent provisioned: ' + data.agentId;
                status.className = 'ml-3 text-sm text-green-600';
              } else {
                status.textContent = 'Error: ' + (data.error || 'unknown');
                status.className = 'ml-3 text-sm text-red-600';
                btn.disabled = false;
              }
            } catch (e) {
              status.textContent = 'Network error';
              status.className = 'ml-3 text-sm text-red-600';
              btn.disabled = false;
            }
          }
          </script>
          ` : '<p class="text-xs text-slate-400 mt-2">Save the client first, then provision voice agent.</p>'}
            </div>

            ${client ? `
            <div class="flex items-center gap-2 pt-2">
              <input type="checkbox" name="active" id="active" class="rounded" ${client.active ? 'checked' : ''}>
              <label for="active" class="text-sm text-slate-700">Active</label>
            </div>` : ''}

            <div class="flex gap-3 pt-4 border-t border-slate-100 mt-2">
              <button type="submit" class="px-5 py-2 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 transition-colors font-semibold">Save Client</button>
              <a href="/admin/clients" class="px-5 py-2 border border-slate-200 text-slate-600 text-sm rounded-lg hover:bg-slate-50 transition-colors">Cancel</a>
            </div>
          </form>
        </div>
      </div>`;

  return shell(title, 'admin', formContent, {});
}

module.exports = router;
