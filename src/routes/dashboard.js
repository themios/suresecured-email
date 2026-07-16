const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { shell, ICONS, esc } = require('../lib/layout');

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

    const totals      = totalStats.rows[0];
    const salespeople = spStats.rows;
    const recentReplies = hotLeads.rows;

    const formatCurrency = n => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
    const formatDate     = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

    // ── KPI card helper ──────────────────────────────────────────────────────
    function kpiCard({ icon, label, value, valueColor, note, borderColor, bgColor, iconColor, href }) {
      const tag   = href ? 'a' : 'div';
      const attrs = href ? `href="${href}"` : '';
      return `
      <${tag} ${attrs} class="bg-white rounded-xl shadow-sm border border-slate-100 p-5 flex items-start gap-4 hover:shadow-md ${href ? 'hover:border-slate-200 cursor-pointer' : ''} transition-shadow duration-200" style="border-left:4px solid ${borderColor}">
        <div class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style="background:${bgColor}; color:${iconColor}">
          ${icon}
        </div>
        <div class="min-w-0">
          <p class="text-xs font-semibold text-slate-500 uppercase tracking-widest">${label}</p>
          <p class="text-2xl font-extrabold mt-0.5 ${valueColor}">${value}</p>
          ${note ? `<p class="text-xs text-slate-400 mt-0.5">${note}</p>` : ''}
        </div>
      </${tag}>`;
    }

    const primaryKpis = `
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
      ${kpiCard({ icon: ICONS.users,      label: 'Total Leads',        value: parseInt(totals.total_leads||0).toLocaleString(),    valueColor: 'text-slate-900', borderColor: '#0369a1', bgColor: '#eff6ff', iconColor: '#0369a1', href: '/leads' })}
      ${kpiCard({ icon: ICONS.mouseclick, label: 'Email Clicks',       value: parseInt(totals.total_clicks||0).toLocaleString(),   valueColor: 'text-sky-700',   borderColor: '#0ea5e9', bgColor: '#f0f9ff', iconColor: '#0ea5e9', href: '/clicks' })}
      ${kpiCard({ icon: ICONS.dollar,     label: 'Total Revenue',      value: formatCurrency(totals.total_revenue),               valueColor: 'text-emerald-700', borderColor: '#059669', bgColor: '#ecfdf5', iconColor: '#059669', href: '/orders' })}
      ${kpiCard({ icon: ICONS.award,      label: 'Commissions Earned', value: formatCurrency(totals.total_commission),            valueColor: 'text-blue-700',  borderColor: '#2563eb', bgColor: '#eff6ff', iconColor: '#2563eb', href: '/commissions' })}
    </div>`;

    const secondaryKpis = `
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
      ${kpiCard({ icon: ICONS.phone,       label: 'Phone Calls',     value: parseInt(totals.total_calls||0).toLocaleString(),     valueColor: 'text-violet-700', borderColor: '#7c3aed', bgColor: '#f5f3ff', iconColor: '#7c3aed', href: '/calls' })}
      ${kpiCard({ icon: ICONS.clipboard,   label: 'Form Submissions',value: parseInt(totals.total_forms||0).toLocaleString(),     valueColor: 'text-slate-900',  borderColor: '#64748b', bgColor: '#f8fafc', iconColor: '#64748b', href: '/form-submissions' })}
      ${kpiCard({ icon: ICONS.shoppingbag, label: 'Orders',          value: parseInt(totals.total_orders||0).toLocaleString(),    valueColor: 'text-slate-900',  borderColor: '#64748b', bgColor: '#f8fafc', iconColor: '#64748b', href: '/orders' })}
      ${kpiCard({ icon: ICONS.eyeoff,      label: 'Suppressed',      value: parseInt(totals.total_suppressed||0).toLocaleString(), valueColor: 'text-slate-400', borderColor: '#cbd5e1', bgColor: '#f8fafc', iconColor: '#94a3b8', note: 'existing customers', href: '/admin/suppression' })}
      ${kpiCard({ icon: ICONS.msgcircle,   label: 'Replies',         value: parseInt(totals.total_replies||0).toLocaleString(),   valueColor: 'text-indigo-700', borderColor: '#4f46e5', bgColor: '#eef2ff', iconColor: '#4f46e5', href: '/leads?replied=1',
                  note: parseInt(totals.hot_leads||0) > 0 ? `<span class="inline-flex items-center gap-1 text-red-500 font-semibold">${ICONS.flame} ${totals.hot_leads} hot</span>` : '' })}
    </div>`;

    // ── Leaderboard rows ────────────────────────────────────────────────────
    const spRows = salespeople.map(sp => `
      <tr class="border-t border-slate-100 hover:bg-slate-50 transition-colors">
        <td class="px-4 py-3">
          <div class="font-semibold text-slate-900">${esc(sp.name)}</div>
          <div class="text-xs text-slate-400">${esc(sp.email)}</div>
          ${sp.tracking_phone_number
            ? `<div class="text-xs text-violet-600 mt-0.5 flex items-center gap-1">${ICONS.phonesm} ${esc(sp.tracking_phone_number)}</div>`
            : `<div class="text-xs text-red-300 mt-0.5">No tracking number</div>`}
        </td>
        <td class="px-4 py-3 text-center text-sm text-slate-700">${sp.total_leads}</td>
        <td class="px-4 py-3 text-center text-sm text-slate-700">${sp.total_clicks}</td>
        <td class="px-4 py-3 text-center text-sm text-slate-700">${sp.form_submissions}</td>
        <td class="px-4 py-3 text-center text-sm text-slate-700">${sp.phone_calls}</td>
        <td class="px-4 py-3 text-center text-sm text-slate-700">${sp.orders}</td>
        <td class="px-4 py-3 text-right font-semibold text-emerald-700">${formatCurrency(sp.total_revenue)}</td>
        <td class="px-4 py-3 text-right font-bold text-blue-700">${formatCurrency(sp.total_commission)}</td>
        <td class="px-4 py-3 text-center text-xs text-slate-500">${sp.commission_rate}%</td>
      </tr>
    `).join('');

    const orderRows = recentOrders.rows.map(o => `
      <tr class="border-t border-slate-100 text-sm hover:bg-slate-50 transition-colors">
        <td class="px-4 py-2.5 text-slate-500">${formatDate(o.ordered_at)}</td>
        <td class="px-4 py-2.5 text-slate-700">${esc(o.customer_email) || '—'}</td>
        <td class="px-4 py-2.5 font-semibold text-emerald-700">${formatCurrency(o.amount)}</td>
        <td class="px-4 py-2.5">${o.salesperson ? esc(o.salesperson) : '<span class="text-red-400 text-xs">Unassigned</span>'}</td>
      </tr>
    `).join('') || '<tr><td colspan="4" class="px-4 py-8 text-center text-slate-400 text-sm">No orders yet</td></tr>';

    const formRows = recentForms.rows.map(f => `
      <tr class="border-t border-slate-100 text-sm hover:bg-slate-50 transition-colors">
        <td class="px-4 py-2.5 text-slate-500">${formatDate(f.submitted_at)}</td>
        <td class="px-4 py-2.5 text-slate-700">${esc(f.submitter_name) || '—'}</td>
        <td class="px-4 py-2.5 text-slate-500">${esc(f.submitter_email) || '—'}</td>
        <td class="px-4 py-2.5">
          <span class="px-2 py-0.5 rounded-full text-xs font-medium ${f.form_type === 'dealer' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}">
            ${esc(f.form_type) || 'quote'}
          </span>
        </td>
        <td class="px-4 py-2.5">${f.salesperson ? esc(f.salesperson) : '<span class="text-red-400 text-xs">Unassigned</span>'}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400 text-sm">No form submissions yet</td></tr>';

    // ── Recent Replies section ───────────────────────────────────────────────
    const repliesSection = recentReplies.length ? `
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 mb-6 overflow-hidden">
      <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
        <h2 class="font-semibold text-slate-800">Recent Replies</h2>
        <span class="text-xs text-slate-400">${recentReplies.length} shown</span>
      </div>
      <div class="divide-y divide-slate-100">
        ${recentReplies.map(r => {
          const urgencyBg  = r.reply_urgency === 'high' ? 'bg-red-500'    : r.reply_urgency === 'low' ? 'bg-slate-300' : 'bg-amber-400';
          const badgeCls   = r.reply_urgency === 'high' ? 'bg-red-100 text-red-700' : r.reply_urgency === 'low' ? 'bg-slate-100 text-slate-600' : 'bg-amber-100 text-amber-700';
          const initial    = (r.first_name?.[0] || r.email[0]).toUpperCase();
          return `
          <a href="/leads/${r.id}" class="flex items-center gap-4 px-6 py-3.5 hover:bg-slate-50 transition-colors">
            <div class="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0 ${urgencyBg}">
              ${esc(initial)}
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-semibold text-slate-900">${esc(r.first_name || '')} ${esc(r.last_name || '')} <span class="text-slate-400 font-normal">${esc(r.email)}</span></p>
              ${r.reply_summary ? `<p class="text-xs text-slate-500 truncate mt-0.5">${esc(r.reply_summary)}</p>` : ''}
            </div>
            <div class="text-right flex-shrink-0">
              <span class="px-2 py-0.5 rounded-full text-xs font-semibold ${badgeCls}">
                ${esc((r.reply_category || '').replace(/_/g, ' '))}
              </span>
              <p class="text-xs text-slate-400 mt-1">${new Date(r.reply_classified_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
            </div>
          </a>`;
        }).join('')}
      </div>
    </div>` : '';

    // AI agent report card — latest weekly Reporting agent summary + pending
    // approvals. Fully defensive: any failure yields an empty card so it can
    // never break the live dashboard.
    let agentReportCard = '';
    try {
      const clientId = req.user?.client_id
        || (await pool.query('SELECT id FROM clients ORDER BY id LIMIT 1')).rows[0]?.id || null;
      if (clientId) {
        const [{ rows: enabledRows }, { rows: reportRows }, { rows: pendRows }] = await Promise.all([
          pool.query(`SELECT enabled FROM client_agent_settings WHERE client_id=$1 AND agent='reporting'`, [clientId]),
          pool.query(`SELECT period, summary, created_at FROM agent_reports WHERE client_id=$1 ORDER BY created_at DESC LIMIT 1`, [clientId]),
          pool.query(`SELECT COUNT(*)::int AS n FROM agent_proposals WHERE client_id=$1 AND status='pending'`, [clientId]),
        ]);
        const enabled = enabledRows[0]?.enabled === true;
        const report  = reportRows[0];
        const pending  = pendRows[0]?.n || 0;
        if (enabled) {
          const inner = report
            ? `<p class="text-sm text-slate-700 leading-relaxed">${esc(report.summary)}</p>
               <p class="text-xs text-slate-400 mt-2">Week ${esc(report.period)} · generated ${formatDate(report.created_at)}</p>`
            : `<p class="text-sm text-slate-500">No report yet — the first weekly summary runs on the next scheduled cycle.</p>`;
          agentReportCard = `
          <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden mb-6">
            <div class="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
              <h2 class="font-semibold text-slate-800">📊 AI Weekly Report</h2>
              ${pending ? `<a href="/settings/agents" class="ml-auto text-xs font-medium px-2 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">${pending} awaiting approval</a>` : '<span class="ml-auto text-xs text-emerald-500 font-medium">Reporting agent on</span>'}
            </div>
            <div class="px-6 py-4">${inner}</div>
          </div>`;
        }
      }
    } catch (err) {
      console.error('[dashboard] agent card failed (non-fatal):', err.message);
    }

    const content = `
    <div class="px-6 py-8 max-w-7xl mx-auto">

      <div class="mb-6">
        <h1 class="text-2xl font-bold text-slate-900">Overview</h1>
        <p class="text-sm text-slate-500 mt-0.5">All-time performance across all salespeople</p>
      </div>

      ${agentReportCard}

      ${primaryKpis}
      ${secondaryKpis}
      ${repliesSection}

      <!-- Salesperson Leaderboard -->
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 mb-6 overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-100">
          <h2 class="font-semibold text-slate-800">Salesperson Commission Summary</h2>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm data-table">
            <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
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
              ${spRows || '<tr><td colspan="9" class="px-4 py-8 text-center text-slate-400 text-sm">No salespeople yet — add one via Admin</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <!-- Recent Orders -->
        <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <div class="px-6 py-4 border-b border-slate-100">
            <h2 class="font-semibold text-slate-800">Recent Orders</h2>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm data-table">
              <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
                <tr>
                  <th class="px-4 py-2.5 text-left">Date</th>
                  <th class="px-4 py-2.5 text-left">Customer</th>
                  <th class="px-4 py-2.5 text-left">Amount</th>
                  <th class="px-4 py-2.5 text-left">Salesperson</th>
                </tr>
              </thead>
              <tbody>${orderRows}</tbody>
            </table>
          </div>
        </div>

        <!-- Recent Form Submissions -->
        <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <div class="px-6 py-4 border-b border-slate-100">
            <h2 class="font-semibold text-slate-800">Recent Quote Requests</h2>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm data-table">
              <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
                <tr>
                  <th class="px-4 py-2.5 text-left">Date</th>
                  <th class="px-4 py-2.5 text-left">Name</th>
                  <th class="px-4 py-2.5 text-left">Email</th>
                  <th class="px-4 py-2.5 text-left">Type</th>
                  <th class="px-4 py-2.5 text-left">Salesperson</th>
                </tr>
              </thead>
              <tbody>${formRows}</tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Recent Phone Calls -->
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden pb-2">
        <div class="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
          <h2 class="font-semibold text-slate-800">Recent Phone Calls</h2>
          <span class="text-xs text-violet-500 font-medium">via CallRail</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm data-table">
            <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
              <tr>
                <th class="px-4 py-2.5 text-left">Date</th>
                <th class="px-4 py-2.5 text-left">Caller</th>
                <th class="px-4 py-2.5 text-left">Tracking Number</th>
                <th class="px-4 py-2.5 text-left">Duration</th>
                <th class="px-4 py-2.5 text-left">Salesperson</th>
              </tr>
            </thead>
            <tbody>
              ${recentCalls.rows.length > 0 ? recentCalls.rows.map(c => `
                <tr class="border-t border-slate-100 text-sm hover:bg-slate-50 transition-colors">
                  <td class="px-4 py-2.5 text-slate-500">${formatDate(c.called_at)}</td>
                  <td class="px-4 py-2.5 text-slate-700">${esc(c.caller_number) || '—'}</td>
                  <td class="px-4 py-2.5 text-violet-600 font-medium">${esc(c.tracking_number) || '—'}</td>
                  <td class="px-4 py-2.5 text-slate-700">${c.duration_seconds ? Math.floor(c.duration_seconds/60)+'m '+((c.duration_seconds||0)%60)+'s' : '—'}</td>
                  <td class="px-4 py-2.5">${c.salesperson ? esc(c.salesperson) : '<span class="text-red-400 text-xs">Unknown</span>'}</td>
                </tr>
              `).join('') : '<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400 text-sm">No calls yet — set up CallRail tracking numbers to start</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

    </div>`;

    res.send(shell('Overview', 'dashboard', content, { user: req.user }));
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Server error loading dashboard');
  }
});

module.exports = router;
