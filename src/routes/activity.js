// src/routes/activity.js — full paginated views behind the dashboard KPI cards
// (orders, commissions, phone calls, email clicks, form submissions)
const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { shell, ICONS, esc } = require('../lib/layout');
const { calculateCommission } = require('../lib/commissions');

const PAGE_SIZE = 50;

// Assign an uncredited order to a rep (e.g. accepting a name suggestion) and
// credit the commission identically to the webhook path.
router.post('/orders/:id/assign', requireAuth, express.urlencoded({ extended: false }), async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const salespersonId = parseInt(req.body.salesperson_id, 10);
  if (!orderId || !salespersonId) return res.redirect('/orders');

  const { rows: ord } = await pool.query(
    'SELECT id, client_id, amount, commission_status FROM orders WHERE id = $1', [orderId]);
  const order = ord[0];
  if (!order || order.commission_status === 'credited' || !order.client_id) return res.redirect('/orders');

  // The rep must belong to this order's tenant.
  const { rows: sp } = await pool.query(
    `SELECT s.commission_rate, c.commission_rules
       FROM salespeople s JOIN clients c ON c.id = s.client_id
      WHERE s.id = $1 AND s.client_id = $2`,
    [salespersonId, order.client_id]);
  if (!sp[0]) return res.redirect('/orders');

  const { rows: unitsRows } = await pool.query(
    `SELECT COUNT(*) AS units FROM orders
      WHERE salesperson_id = $1 AND client_id = $2
        AND DATE_TRUNC('month', ordered_at) = DATE_TRUNC('month', NOW()) AND id != $3`,
    [salespersonId, order.client_id, orderId]);

  const { rate, earned, bonusesTriggered } = calculateCommission(
    Number(order.amount), parseInt(unitsRows[0].units || 0), sp[0].commission_rules || {}, sp[0].commission_rate || 100);

  await pool.query(
    `UPDATE orders SET salesperson_id = $1, commission_status = 'credited', suggested_salesperson_id = NULL WHERE id = $2`,
    [salespersonId, orderId]);
  await pool.query(
    `INSERT INTO commissions (salesperson_id, client_id, source_type, source_id, sale_amount, commission_rate, commission_earned)
     VALUES ($1, $2, 'shopify_order', $3, $4, $5, $6)`,
    [salespersonId, order.client_id, orderId, Number(order.amount), rate, earned]);
  for (const bonus of bonusesTriggered || []) {
    await pool.query(
      `INSERT INTO commissions (salesperson_id, client_id, source_type, source_id, sale_amount, commission_rate, commission_earned)
       VALUES ($1, $2, 'bonus', $3, 0, 0, $4)`,
      [salespersonId, order.client_id, orderId, bonus.amount]);
  }
  res.redirect('/orders');
});

function getPage(req) {
  return Math.max(1, parseInt(req.query.page) || 1);
}

function formatCurrency(n) {
  return '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
}

function formatDate(d) {
  return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

function pageHeader(title, subtitle, icon) {
  return `
    <div class="flex items-center justify-between mb-6">
      <div>
        <a href="/dashboard" class="text-sm text-slate-400 hover:text-slate-600 mb-1 inline-flex items-center gap-1">&larr; Back to Overview</a>
        <h1 class="text-2xl font-bold text-slate-900 flex items-center gap-2 mt-1">${icon || ''} ${title}</h1>
        <p class="text-sm text-slate-500 mt-0.5">${subtitle}</p>
      </div>
    </div>`;
}

function pagination(basePath, page, totalPages) {
  if (totalPages <= 1) return '';
  return `
  <div class="px-4 py-3 border-t border-slate-100 flex justify-between items-center text-sm text-slate-500">
    <span>Page ${page} of ${totalPages}</span>
    <div class="flex gap-2">
      ${page > 1 ? `<a href="${basePath}?page=${page - 1}" class="px-3 py-1 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">&larr; Prev</a>` : ''}
      ${page < totalPages ? `<a href="${basePath}?page=${page + 1}" class="px-3 py-1 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">Next &rarr;</a>` : ''}
    </div>
  </div>`;
}

function tableShell(headers, rows, emptyMessage) {
  return `
  <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
    <div class="overflow-x-auto">
      <table class="w-full text-sm data-table">
        <thead class="bg-slate-50 border-b border-slate-100">
          <tr class="text-left text-slate-500 text-xs uppercase tracking-wider">
            ${headers.map(h => `<th class="px-4 py-3">${h}</th>`).join('')}
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          ${rows.length === 0 ? `<tr><td colspan="${headers.length}" class="px-4 py-12 text-center text-slate-400">${emptyMessage}</td></tr>` : rows.join('')}
        </tbody>
      </table>
    </div>`;
}

// ─── Orders ─────────────────────────────────────────────────────────────────
router.get('/orders', requireAuth, async (req, res) => {
  const page   = getPage(req);
  const offset = (page - 1) * PAGE_SIZE;

  const [rowsResult, countResult] = await Promise.all([
    pool.query(`
      SELECT o.id, o.shopify_order_id, o.customer_email, o.amount, o.currency,
             o.commission_status, o.ordered_at, s.name AS salesperson_name,
             o.suggested_salesperson_id, ss.name AS suggested_name
      FROM orders o
      LEFT JOIN salespeople s  ON s.id  = o.salesperson_id
      LEFT JOIN salespeople ss ON ss.id = o.suggested_salesperson_id
      ORDER BY o.ordered_at DESC
      LIMIT $1 OFFSET $2
    `, [PAGE_SIZE, offset]),
    pool.query('SELECT COUNT(*), COALESCE(SUM(amount),0) AS total FROM orders'),
  ]);

  const totalCount = parseInt(countResult.rows[0].count);
  const totalAmount = countResult.rows[0].total;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const rows = rowsResult.rows.map(o => {
    const statusCls = o.commission_status === 'credited' ? 'bg-emerald-100 text-emerald-700'
      : o.commission_status === 'pending_review' ? 'bg-amber-100 text-amber-700'
      : 'bg-slate-100 text-slate-600';
    return `
    <tr class="hover:bg-slate-50 transition-colors">
      <td class="px-4 py-3 text-slate-400 text-xs">${formatDate(o.ordered_at)}</td>
      <td class="px-4 py-3 text-slate-700 font-mono text-xs">${esc(o.shopify_order_id || '—')}</td>
      <td class="px-4 py-3 text-slate-700">${esc(o.customer_email || '—')}</td>
      <td class="px-4 py-3 font-semibold text-emerald-700">${formatCurrency(o.amount)}</td>
      <td class="px-4 py-3">${o.salesperson_name
        ? esc(o.salesperson_name)
        : (o.suggested_name
          ? `<form method="post" action="/orders/${o.id}/assign" class="flex items-center gap-1">
               <input type="hidden" name="salesperson_id" value="${o.suggested_salesperson_id}">
               <span class="text-slate-400 text-xs">Suggested:</span>
               <button class="text-xs text-sky-600 hover:text-sky-700 font-medium underline decoration-dotted" title="Assign this order to the suggested rep and credit the commission">${esc(o.suggested_name)} — assign</button>
             </form>`
          : '<span class="text-red-400 text-xs">Unassigned</span>')}</td>
      <td class="px-4 py-3"><span class="px-2 py-0.5 rounded-full text-xs font-medium ${statusCls}">${esc((o.commission_status || 'credited').replace('_', ' '))}</span></td>
    </tr>`;
  });

  const content = `
  <div class="px-6 py-8 max-w-7xl mx-auto">
    ${pageHeader('Orders', `${totalCount.toLocaleString()} orders · ${formatCurrency(totalAmount)} total revenue`, ICONS.shoppingbag)}
    ${tableShell(['Date', 'Order ID', 'Customer', 'Amount', 'Salesperson', 'Commission'], rows, 'No orders yet')}
    ${pagination('/orders', page, totalPages)}
  </div>
  </div>`;

  res.send(shell('Orders', 'dashboard', content, { user: req.user }));
});

// ─── Commissions ────────────────────────────────────────────────────────────
router.get('/commissions', requireAuth, async (req, res) => {
  const page   = getPage(req);
  const offset = (page - 1) * PAGE_SIZE;

  const [rowsResult, countResult] = await Promise.all([
    pool.query(`
      SELECT cm.id, cm.source_type, cm.sale_amount, cm.commission_rate, cm.commission_earned,
             cm.status, cm.created_at, s.name AS salesperson_name
      FROM commissions cm LEFT JOIN salespeople s ON s.id = cm.salesperson_id
      ORDER BY cm.created_at DESC
      LIMIT $1 OFFSET $2
    `, [PAGE_SIZE, offset]),
    pool.query('SELECT COUNT(*), COALESCE(SUM(commission_earned),0) AS total FROM commissions'),
  ]);

  const totalCount = parseInt(countResult.rows[0].count);
  const totalAmount = countResult.rows[0].total;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const rows = rowsResult.rows.map(c => `
    <tr class="hover:bg-slate-50 transition-colors">
      <td class="px-4 py-3 text-slate-400 text-xs">${formatDate(c.created_at)}</td>
      <td class="px-4 py-3">${c.salesperson_name ? esc(c.salesperson_name) : '<span class="text-red-400 text-xs">Unassigned</span>'}</td>
      <td class="px-4 py-3"><span class="px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">${esc((c.source_type || '—').replace('_', ' '))}</span></td>
      <td class="px-4 py-3 text-slate-700">${formatCurrency(c.sale_amount)}</td>
      <td class="px-4 py-3 text-slate-500 text-xs">${c.commission_rate != null ? c.commission_rate + '%' : '—'}</td>
      <td class="px-4 py-3 font-bold text-blue-700">${formatCurrency(c.commission_earned)}</td>
    </tr>`);

  const content = `
  <div class="px-6 py-8 max-w-7xl mx-auto">
    ${pageHeader('Commissions', `${totalCount.toLocaleString()} commission events · ${formatCurrency(totalAmount)} total earned`, ICONS.award)}
    ${tableShell(['Date', 'Salesperson', 'Source', 'Sale Amount', 'Rate', 'Commission'], rows, 'No commissions yet')}
    ${pagination('/commissions', page, totalPages)}
  </div>
  </div>`;

  res.send(shell('Commissions', 'dashboard', content, { user: req.user }));
});

// ─── Phone Calls ────────────────────────────────────────────────────────────
router.get('/calls', requireAuth, async (req, res) => {
  const page   = getPage(req);
  const offset = (page - 1) * PAGE_SIZE;

  const [rowsResult, countResult] = await Promise.all([
    pool.query(`
      SELECT pc.id, pc.caller_number, pc.tracking_number, pc.duration_seconds, pc.called_at,
             s.name AS salesperson_name
      FROM phone_calls pc LEFT JOIN salespeople s ON s.id = pc.salesperson_id
      ORDER BY pc.called_at DESC
      LIMIT $1 OFFSET $2
    `, [PAGE_SIZE, offset]),
    pool.query('SELECT COUNT(*) FROM phone_calls'),
  ]);

  const totalCount = parseInt(countResult.rows[0].count);
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const rows = rowsResult.rows.map(c => `
    <tr class="hover:bg-slate-50 transition-colors">
      <td class="px-4 py-3 text-slate-400 text-xs">${formatDate(c.called_at)}</td>
      <td class="px-4 py-3 text-slate-700">${esc(c.caller_number || '—')}</td>
      <td class="px-4 py-3 text-violet-600 font-medium">${esc(c.tracking_number || '—')}</td>
      <td class="px-4 py-3 text-slate-700">${c.duration_seconds ? Math.floor(c.duration_seconds / 60) + 'm ' + (c.duration_seconds % 60) + 's' : '—'}</td>
      <td class="px-4 py-3">${c.salesperson_name ? esc(c.salesperson_name) : '<span class="text-red-400 text-xs">Unknown</span>'}</td>
    </tr>`);

  const content = `
  <div class="px-6 py-8 max-w-7xl mx-auto">
    ${pageHeader('Phone Calls', `${totalCount.toLocaleString()} calls tracked via CallRail`, ICONS.phone)}
    ${tableShell(['Date', 'Caller', 'Tracking Number', 'Duration', 'Salesperson'], rows, 'No calls yet — set up CallRail tracking numbers to start')}
    ${pagination('/calls', page, totalPages)}
  </div>
  </div>`;

  res.send(shell('Phone Calls', 'dashboard', content, { user: req.user }));
});

// ─── Email Clicks ───────────────────────────────────────────────────────────
router.get('/clicks', requireAuth, async (req, res) => {
  const page   = getPage(req);
  const offset = (page - 1) * PAGE_SIZE;

  const [rowsResult, countResult] = await Promise.all([
    pool.query(`
      SELECT c.id, c.clicked_at, c.referrer, l.first_name, l.last_name, l.email AS lead_email,
             s.name AS salesperson_name
      FROM clicks c
      LEFT JOIN leads l ON l.id = c.lead_id
      LEFT JOIN salespeople s ON s.id = c.salesperson_id
      ORDER BY c.clicked_at DESC
      LIMIT $1 OFFSET $2
    `, [PAGE_SIZE, offset]),
    pool.query('SELECT COUNT(*) FROM clicks'),
  ]);

  const totalCount = parseInt(countResult.rows[0].count);
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const rows = rowsResult.rows.map(c => {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.lead_email || '—';
    return `
    <tr class="hover:bg-slate-50 transition-colors">
      <td class="px-4 py-3 text-slate-400 text-xs">${formatDate(c.clicked_at)}</td>
      <td class="px-4 py-3 text-slate-700">${esc(name)}</td>
      <td class="px-4 py-3">${c.salesperson_name ? esc(c.salesperson_name) : '<span class="text-red-400 text-xs">Unassigned</span>'}</td>
      <td class="px-4 py-3 text-slate-400 text-xs truncate max-w-xs">${esc(c.referrer || '—')}</td>
    </tr>`;
  });

  const content = `
  <div class="px-6 py-8 max-w-7xl mx-auto">
    ${pageHeader('Email Clicks', `${totalCount.toLocaleString()} tracked link clicks`, ICONS.mouseclick)}
    ${tableShell(['Date', 'Lead', 'Salesperson', 'Referrer'], rows, 'No clicks yet')}
    ${pagination('/clicks', page, totalPages)}
  </div>
  </div>`;

  res.send(shell('Email Clicks', 'dashboard', content, { user: req.user }));
});

// ─── Form Submissions ───────────────────────────────────────────────────────
router.get('/form-submissions', requireAuth, async (req, res) => {
  const page   = getPage(req);
  const offset = (page - 1) * PAGE_SIZE;

  const [rowsResult, countResult] = await Promise.all([
    pool.query(`
      SELECT fs.id, fs.submitter_name, fs.submitter_email, fs.form_type, fs.submitted_at,
             s.name AS salesperson_name
      FROM form_submissions fs LEFT JOIN salespeople s ON s.id = fs.salesperson_id
      ORDER BY fs.submitted_at DESC
      LIMIT $1 OFFSET $2
    `, [PAGE_SIZE, offset]),
    pool.query('SELECT COUNT(*) FROM form_submissions'),
  ]);

  const totalCount = parseInt(countResult.rows[0].count);
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const rows = rowsResult.rows.map(f => `
    <tr class="hover:bg-slate-50 transition-colors">
      <td class="px-4 py-3 text-slate-400 text-xs">${formatDate(f.submitted_at)}</td>
      <td class="px-4 py-3 text-slate-700">${esc(f.submitter_name || '—')}</td>
      <td class="px-4 py-3 text-slate-500">${esc(f.submitter_email || '—')}</td>
      <td class="px-4 py-3"><span class="px-2 py-0.5 rounded-full text-xs font-medium ${f.form_type === 'dealer' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}">${esc(f.form_type || 'quote')}</span></td>
      <td class="px-4 py-3">${f.salesperson_name ? esc(f.salesperson_name) : '<span class="text-red-400 text-xs">Unassigned</span>'}</td>
    </tr>`);

  const content = `
  <div class="px-6 py-8 max-w-7xl mx-auto">
    ${pageHeader('Form Submissions', `${totalCount.toLocaleString()} quote &amp; dealer form submissions`, ICONS.clipboard)}
    ${tableShell(['Date', 'Name', 'Email', 'Type', 'Salesperson'], rows, 'No form submissions yet')}
    ${pagination('/form-submissions', page, totalPages)}
  </div>
  </div>`;

  res.send(shell('Form Submissions', 'dashboard', content, { user: req.user }));
});

module.exports = router;
