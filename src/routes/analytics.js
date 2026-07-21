const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { shell, navHtml } = require('../lib/layout');

// Data endpoint — returns all chart data as JSON
router.get('/data', requireAuth, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const spFilter = req.query.sp ? parseInt(req.query.sp, 10) : null;
  if (req.query.sp && Number.isNaN(spFilter)) {
    return res.status(400).json({ error: 'Invalid salesperson filter' });
  }

  try {
    const spClause = spFilter ? 'AND salesperson_id = $2' : '';
    const spClauseS = spFilter ? 'AND s.id = $2' : '';
    const spClauseL = spFilter ? 'AND l.salesperson_id = $2' : '';
    const dayParam = [days];
    const daySpParam = spFilter ? [days, spFilter] : [days];
    const monthOnlyParam = spFilter ? [spFilter] : [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);

    const [
      revenueByDay,
      clicksByDay,
      callsByDay,
      formsByDay,
      commissionBySp,
      funnel,
      audienceSplit,
      topProducts,
      goalVsActual,
      salespeople,
    ] = await Promise.all([

      pool.query(`
        SELECT DATE(ordered_at) AS date, COALESCE(SUM(amount),0) AS revenue
        FROM orders WHERE ordered_at >= NOW() - ($1::integer * INTERVAL '1 day') ${spClause}
        GROUP BY DATE(ordered_at) ORDER BY date
      `, daySpParam),

      pool.query(`
        SELECT DATE(clicked_at) AS date, COUNT(*) AS clicks
        FROM clicks WHERE clicked_at >= NOW() - ($1::integer * INTERVAL '1 day') ${spClause}
        GROUP BY DATE(clicked_at) ORDER BY date
      `, daySpParam),

      pool.query(`
        SELECT DATE(called_at) AS date, COUNT(*) AS calls
        FROM phone_calls WHERE called_at >= NOW() - ($1::integer * INTERVAL '1 day') ${spClause}
        GROUP BY DATE(called_at) ORDER BY date
      `, daySpParam),

      pool.query(`
        SELECT DATE(submitted_at) AS date, COUNT(*) AS forms
        FROM form_submissions WHERE submitted_at >= NOW() - ($1::integer * INTERVAL '1 day') ${spClause}
        GROUP BY DATE(submitted_at) ORDER BY date
      `, daySpParam),

      pool.query(`
        SELECT s.name,
          COALESCE(SUM(o.amount), 0) AS revenue,
          COALESCE(SUM(cm.commission_earned), 0) AS commission,
          COUNT(DISTINCT o.id) AS orders,
          COUNT(DISTINCT c.id) AS clicks
        FROM salespeople s
        LEFT JOIN orders o ON o.salesperson_id = s.id
        LEFT JOIN commissions cm ON cm.salesperson_id = s.id
        LEFT JOIN clicks c ON c.salesperson_id = s.id
        WHERE s.active = true ${spClauseS}
        GROUP BY s.name ORDER BY revenue DESC LIMIT 10
      `, monthOnlyParam),

      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM leads ${spFilter ? 'WHERE salesperson_id = $1' : ''}) AS total_leads,
          (SELECT COUNT(*) FROM clicks WHERE clicked_at >= NOW() - ($${spFilter ? 2 : 1}::integer * INTERVAL '1 day') ${spFilter ? 'AND salesperson_id = $1' : ''}) AS total_clicks,
          (SELECT COUNT(*) FROM form_submissions WHERE submitted_at >= NOW() - ($${spFilter ? 2 : 1}::integer * INTERVAL '1 day') ${spFilter ? 'AND salesperson_id = $1' : ''}) AS total_forms,
          (SELECT COUNT(*) FROM phone_calls WHERE called_at >= NOW() - ($${spFilter ? 2 : 1}::integer * INTERVAL '1 day') ${spFilter ? 'AND salesperson_id = $1' : ''}) AS total_calls,
          (SELECT COUNT(*) FROM orders WHERE ordered_at >= NOW() - ($${spFilter ? 2 : 1}::integer * INTERVAL '1 day') ${spFilter ? 'AND salesperson_id = $1' : ''}) AS total_orders
      `, spFilter ? [spFilter, days] : [days]),

      pool.query(`
        SELECT l.audience_type, COUNT(*) AS count FROM leads l
        WHERE 1=1 ${spClauseL}
        GROUP BY l.audience_type
      `, monthOnlyParam),

      pool.query(`
        SELECT COALESCE(l.product_interest, 'Unknown') AS product, COUNT(*) AS count
        FROM leads l WHERE 1=1 ${spClauseL}
        GROUP BY l.product_interest ORDER BY count DESC LIMIT 6
      `, monthOnlyParam),

      pool.query(`
        SELECT s.name,
          COALESCE(g.target_revenue, 0) AS goal_revenue,
          COALESCE(SUM(o.amount), 0)    AS actual_revenue,
          COALESCE(g.target_orders, 0)  AS goal_orders,
          COUNT(DISTINCT o.id)          AS actual_orders
        FROM salespeople s
        LEFT JOIN salesperson_goals g ON g.salesperson_id = s.id AND g.period_start = $1
        LEFT JOIN orders o ON o.salesperson_id = s.id AND DATE(o.ordered_at) >= $1
        WHERE s.active = true ${spFilter ? 'AND s.id = $2' : ''}
        GROUP BY s.name, g.target_revenue, g.target_orders
        ORDER BY actual_revenue DESC
      `, spFilter ? [monthStart, spFilter] : [monthStart]),

      pool.query('SELECT id, name FROM salespeople WHERE active = true ORDER BY name'),
    ]);

    res.json({
      revenueByDay: revenueByDay.rows,
      clicksByDay: clicksByDay.rows,
      callsByDay: callsByDay.rows,
      formsByDay: formsByDay.rows,
      commissionBySp: commissionBySp.rows,
      funnel: funnel.rows[0],
      audienceSplit: audienceSplit.rows,
      topProducts: topProducts.rows,
      goalVsActual: goalVsActual.rows,
      salespeople: salespeople.rows,
    });
  } catch (err) {
    console.error('Analytics data error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Analytics page
router.get('/', requireAuth, async (req, res) => {
  const content = `
  <div class="px-6 py-8 max-w-7xl mx-auto">

    <!-- Page header + Filters -->
    <div class="flex flex-wrap justify-between items-center gap-3 mb-6">
      <div>
        <h1 class="text-2xl font-bold text-slate-900">Analytics</h1>
        <p class="text-sm text-slate-500 mt-0.5">Engagement, revenue, and conversion trends</p>
      </div>
      <div class="flex flex-wrap gap-2 items-center">
        <select id="sp-filter" onchange="loadData(activeDays)"
          class="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-500 shadow-sm cursor-pointer">
          <option value="">All Salespeople</option>
        </select>
        <div class="flex gap-1 bg-white border border-slate-200 rounded-lg p-1 shadow-sm">
          <button onclick="loadData(7)"  id="btn-7"  class="period-btn px-3 py-1.5 text-xs font-semibold rounded-md text-slate-500 hover:bg-slate-100 transition-all">7d</button>
          <button onclick="loadData(30)" id="btn-30" class="period-btn px-3 py-1.5 text-xs font-semibold rounded-md bg-sky-600 text-white shadow-sm transition-all">30d</button>
          <button onclick="loadData(60)" id="btn-60" class="period-btn px-3 py-1.5 text-xs font-semibold rounded-md text-slate-500 hover:bg-slate-100 transition-all">60d</button>
          <button onclick="loadData(90)" id="btn-90" class="period-btn px-3 py-1.5 text-xs font-semibold rounded-md text-slate-500 hover:bg-slate-100 transition-all">90d</button>
        </div>
      </div>
    </div>

    <!-- Conversion Funnel -->
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-6 mb-6">
      <h2 class="font-semibold text-slate-700 mb-5 text-xs uppercase tracking-widest">Conversion Funnel</h2>
      <div class="grid grid-cols-5 gap-0" id="funnel-row">
        ${[
          { id: 'f-leads',  label: 'Leads',         rateId: '',              color: 'text-slate-800',  bg: 'bg-slate-100',  border: 'border-slate-200',  href: '/leads' },
          { id: 'f-clicks', label: 'Email Clicks',   rateId: 'f-clicks-rate', color: 'text-sky-700',    bg: 'bg-sky-50',     border: 'border-sky-200',    href: '/clicks' },
          { id: 'f-forms',  label: 'Quote Requests', rateId: 'f-forms-rate',  color: 'text-indigo-700', bg: 'bg-indigo-50',  border: 'border-indigo-200', href: '/form-submissions' },
          { id: 'f-calls',  label: 'Phone Calls',    rateId: 'f-calls-rate',  color: 'text-violet-700', bg: 'bg-violet-50',  border: 'border-violet-200', href: '/calls' },
          { id: 'f-orders', label: 'Orders',          rateId: 'f-orders-rate', color: 'text-emerald-700',bg: 'bg-emerald-50', border: 'border-emerald-200', href: '/orders' },
        ].map((s, i) => `
        <div class="relative flex flex-col items-center text-center px-2">
          ${i > 0 ? `<div class="absolute left-0 top-1/2 -translate-y-1/2 w-4 h-px bg-slate-200 hidden lg:block" style="left:-8px"></div>` : ''}
          <a href="${s.href}" title="View ${s.label}"
             class="block w-full ${s.bg} border ${s.border} rounded-xl px-3 py-4 cursor-pointer transition-all duration-200 hover:shadow-md hover:-translate-y-0.5">
            <p class="text-2xl font-extrabold ${s.color}" id="${s.id}">—</p>
            <p class="text-xs font-semibold text-slate-500 mt-1">${s.label}</p>
            ${s.rateId ? `<p class="text-xs ${s.color} opacity-70 mt-0.5 font-medium" id="${s.rateId}"></p>` : ''}
          </a>
        </div>`).join('')}
      </div>
    </div>

    <!-- Revenue + Engagement Charts -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
        <h2 class="font-semibold text-slate-700 mb-4 text-xs uppercase tracking-widest">Revenue Over Time</h2>
        <div class="skeleton h-48 mb-2" id="rev-skeleton"></div>
        <canvas id="revenueChart" height="200" style="display:none"></canvas>
      </div>
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
        <h2 class="font-semibold text-slate-700 mb-4 text-xs uppercase tracking-widest">Email Clicks, Forms &amp; Calls</h2>
        <div class="skeleton h-48 mb-2" id="eng-skeleton"></div>
        <canvas id="engagementChart" height="200" style="display:none"></canvas>
        <div id="eng-no-data" class="hidden text-center text-slate-400 text-sm py-12">No email clicks, form submissions, or phone calls in this period yet.</div>
      </div>
    </div>

    <!-- Salesperson + Audience Charts -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-6 lg:col-span-2">
        <h2 class="font-semibold text-slate-700 mb-4 text-xs uppercase tracking-widest">Revenue by Salesperson</h2>
        <div class="skeleton h-44 mb-2" id="sp-skeleton"></div>
        <canvas id="salespersonChart" height="180" style="display:none"></canvas>
      </div>
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
        <h2 class="font-semibold text-slate-700 mb-4 text-xs uppercase tracking-widest">B2C vs B2B</h2>
        <canvas id="audienceChart" height="180"></canvas>
        <div id="audience-legend" class="mt-4 flex flex-col gap-2 text-sm"></div>
      </div>
    </div>

    <!-- Goal vs Actual -->
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-6 mb-6">
      <h2 class="font-semibold text-slate-700 mb-1 text-xs uppercase tracking-widest">Goal vs Actual — This Month</h2>
      <p class="text-xs text-slate-400 mb-4">Revenue target set in Admin vs actual revenue this month per salesperson</p>
      <canvas id="goalChart" height="100"></canvas>
      <div id="goal-no-data" class="hidden text-center text-slate-400 text-sm py-6">No goals set yet. Set goals in the Admin tab.</div>
    </div>

    <!-- Commission + Product Interest -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 pb-8">
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
        <h2 class="font-semibold text-slate-700 mb-4 text-xs uppercase tracking-widest">Commission Earned by Salesperson</h2>
        <canvas id="commissionChart" height="200"></canvas>
      </div>
      <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
        <h2 class="font-semibold text-slate-700 mb-4 text-xs uppercase tracking-widest">Lead Interest Breakdown</h2>
        <canvas id="productChart" height="200"></canvas>
      </div>
    </div>

  </div>

<script>
  let charts = {};
  let activeDays = 30;

  const COLORS = {
    blue:   '#3B82F6',
    indigo: '#6366F1',
    green:  '#10B981',
    purple: '#8B5CF6',
    orange: '#F59E0B',
    red:    '#EF4444',
    gray:   '#9CA3AF',
    teal:   '#14B8A6',
  };
  const PALETTE = Object.values(COLORS);

  function fmt(n) { return '$' + parseFloat(n||0).toLocaleString('en-US',{minimumFractionDigits:0}); }
  function pct(a,b) { return b > 0 ? (a/b*100).toFixed(1)+'%' : '—'; }

  function fillDates(rows, dateKey, valueKey, days) {
    const map = {};
    rows.forEach(r => { map[r[dateKey]?.slice(0,10)] = parseFloat(r[valueKey]||0); });
    const labels = [], values = [];
    for (let i = days-1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate()-i);
      const key = d.toISOString().slice(0,10);
      labels.push(d.toLocaleDateString('en-US',{month:'short',day:'numeric'}));
      values.push(map[key] || 0);
    }
    return { labels, values };
  }

  function makeChart(id, config) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), config);
  }

  // ── Drill-down helpers ──────────────────────────────────────────────────
  // Show a pointer cursor over clickable chart elements.
  function cursorPointer(e, els) {
    var c = e.native && e.native.target;
    if (c) c.style.cursor = els.length ? 'pointer' : 'default';
  }
  // Click a salesperson's bar → filter the whole page to that rep.
  function drillToSalesperson(name) {
    var sel = document.getElementById('sp-filter');
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].textContent === name) { sel.value = sel.options[i].value; loadData(activeDays); return; }
    }
  }
  function barDrill(labels) {
    return function (e, els) { if (els.length) drillToSalesperson(labels[els[0].index]); };
  }

  function loadData(days) {
    if (days) activeDays = days;
    // Update active period button
    document.querySelectorAll('.period-btn').forEach(function(b) {
      b.className = 'period-btn px-3 py-1.5 text-xs font-semibold rounded-md text-slate-500 hover:bg-slate-100 transition-all';
    });
    var active = document.getElementById('btn-'+activeDays);
    if (active) active.className = 'period-btn px-3 py-1.5 text-xs font-semibold rounded-md bg-sky-600 text-white shadow-sm transition-all';

    var spId = document.getElementById('sp-filter').value;
    var url  = '/analytics/data?days=' + activeDays + (spId ? '&sp=' + spId : '');

    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        // Populate salesperson dropdown (first load only)
        var sel = document.getElementById('sp-filter');
        if (sel.options.length <= 1 && data.salespeople && data.salespeople.length) {
          data.salespeople.forEach(function(sp) {
            var o = document.createElement('option');
            o.value = sp.id; o.textContent = sp.name;
            if (String(sp.id) === spId) o.selected = true;
            sel.appendChild(o);
          });
        }
        renderFunnel(data.funnel);
        renderRevenue(data.revenueByDay, activeDays);
        renderEngagement(data.clicksByDay, data.formsByDay, data.callsByDay, activeDays);
        renderSalesperson(data.commissionBySp);
        renderCommission(data.commissionBySp);
        renderAudience(data.audienceSplit);
        renderProducts(data.topProducts);
        renderGoalVsActual(data.goalVsActual);
      })
      .catch(function(err) { console.error('Analytics load error:', err); });
  }

  function renderGoalVsActual(rows) {
    var hasGoals = rows && rows.some(function(r) { return parseFloat(r.goal_revenue) > 0; });
    document.getElementById('goal-no-data').classList.toggle('hidden', hasGoals);
    if (!hasGoals || !rows || !rows.length) return;
    makeChart('goalChart', {
      type: 'bar',
      data: {
        labels: rows.map(function(r) { return r.name; }),
        datasets: [
          {
            label: 'Goal',
            data: rows.map(function(r) { return parseFloat(r.goal_revenue||0); }),
            backgroundColor: 'rgba(156,163,175,0.4)',
            borderColor: '#9CA3AF',
            borderWidth: 1,
            borderRadius: 4,
          },
          {
            label: 'Actual Revenue',
            data: rows.map(function(r) { return parseFloat(r.actual_revenue||0); }),
            backgroundColor: rows.map(function(r) {
              var pct = parseFloat(r.goal_revenue) > 0
                ? parseFloat(r.actual_revenue) / parseFloat(r.goal_revenue)
                : 1;
              return pct >= 1 ? COLORS.green : pct >= 0.7 ? COLORS.orange : COLORS.blue;
            }),
            borderRadius: 4,
          }
        ]
      },
      options: {
        responsive: true,
        onHover: cursorPointer,
        onClick: barDrill(rows.map(function (r) { return r.name; })),
        plugins: {
          legend: { position: 'top' },
          tooltip: {
            callbacks: {
              afterBody: function(items) {
                var r = rows[items[0].dataIndex];
                var pct = parseFloat(r.goal_revenue) > 0
                  ? (parseFloat(r.actual_revenue) / parseFloat(r.goal_revenue) * 100).toFixed(0) + '% to goal'
                  : 'No goal set';
                return [pct];
              }
            }
          }
        },
        scales: {
          y: { ticks: { callback: function(v) { return '$'+v.toLocaleString(); } }, beginAtZero: true },
        }
      }
    });
  }

  function renderFunnel(f) {
    if (!f) return;
    document.getElementById('f-leads').textContent   = parseInt(f.total_leads||0).toLocaleString();
    document.getElementById('f-clicks').textContent  = parseInt(f.total_clicks||0).toLocaleString();
    document.getElementById('f-forms').textContent   = parseInt(f.total_forms||0).toLocaleString();
    document.getElementById('f-calls').textContent   = parseInt(f.total_calls||0).toLocaleString();
    document.getElementById('f-orders').textContent  = parseInt(f.total_orders||0).toLocaleString();
    document.getElementById('f-clicks-rate').textContent = pct(f.total_clicks, f.total_leads) + ' of leads';
    document.getElementById('f-forms-rate').textContent  = pct(f.total_forms, f.total_clicks) + ' of clicks';
    document.getElementById('f-calls-rate').textContent  = pct(f.total_calls, f.total_clicks) + ' of clicks';
    document.getElementById('f-orders-rate').textContent = pct(f.total_orders, f.total_leads) + ' of leads';
  }

  function showChart(id, skeletonId) {
    if (skeletonId) { var sk = document.getElementById(skeletonId); if (sk) sk.style.display = 'none'; }
    var el = document.getElementById(id); if (el) el.style.display = '';
  }

  function renderRevenue(rows, days) {
    showChart('revenueChart', 'rev-skeleton');
    const {labels, values} = fillDates(rows, 'date', 'revenue', days);
    makeChart('revenueChart', {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Revenue',
          data: values,
          borderColor: '#059669',
          backgroundColor: 'rgba(5,150,105,0.07)',
          fill: true,
          tension: 0.35,
          pointRadius: 2,
          pointHoverRadius: 5,
          borderWidth: 2,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx){ return ' $'+parseFloat(ctx.raw||0).toLocaleString(); } } } },
        scales: {
          y: { ticks: { callback: v => '$'+v.toLocaleString() }, beginAtZero: true, grid: { color: 'rgba(226,232,240,.6)' } },
          x: { ticks: { maxTicksLimit: 10, color: '#94a3b8' }, grid: { display: false } }
        }
      }
    });
  }

  function renderEngagement(clicks, forms, calls, days) {
    const cl = fillDates(clicks, 'date', 'clicks', days);
    const fo = fillDates(forms,  'date', 'forms',  days);
    const ca = fillDates(calls,  'date', 'calls',  days);

    // This chart never cleared its skeleton (no showChart call), so it showed a
    // gray placeholder forever. Clear it, and when there is nothing to plot show
    // an empty state instead of blank axes.
    const total = [].concat(cl.values, fo.values, ca.values)
      .reduce(function (a, b) { return a + (parseFloat(b) || 0); }, 0);
    const sk = document.getElementById('eng-skeleton'); if (sk) sk.style.display = 'none';
    const canvas = document.getElementById('engagementChart');
    const noData = document.getElementById('eng-no-data');
    if (!total) {
      if (canvas) canvas.style.display = 'none';
      if (noData) noData.classList.remove('hidden');
      return;
    }
    if (noData) noData.classList.add('hidden');
    showChart('engagementChart', 'eng-skeleton');

    makeChart('engagementChart', {
      type: 'bar',
      data: {
        labels: cl.labels,
        datasets: [
          { label: 'Email Clicks', data: cl.values, backgroundColor: COLORS.blue,   borderRadius: 3 },
          { label: 'Forms',        data: fo.values, backgroundColor: COLORS.indigo, borderRadius: 3 },
          { label: 'Phone Calls',  data: ca.values, backgroundColor: COLORS.purple, borderRadius: 3 },
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top' } },
        scales: {
          x: { stacked: false, ticks: { maxTicksLimit: 10 } },
          y: { beginAtZero: true }
        }
      }
    });
  }

  function renderSalesperson(rows) {
    if (!rows?.length) return;
    showChart('salespersonChart', 'sp-skeleton');
    makeChart('salespersonChart', {
      type: 'bar',
      data: {
        labels: rows.map(r => r.name),
        datasets: [{
          label: 'Revenue ($)',
          data: rows.map(r => parseFloat(r.revenue||0)),
          backgroundColor: rows.map((_,i) => PALETTE[i % PALETTE.length]),
          borderRadius: 5,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        onHover: cursorPointer,
        onClick: barDrill(rows.map(function (r) { return r.name; })),
        plugins: { legend: { display: false }, tooltip: { callbacks: { afterBody: function () { return 'Click to filter to this rep'; } } } },
        scales: {
          x: { ticks: { callback: v => '$'+v.toLocaleString() }, beginAtZero: true },
        }
      }
    });
  }

  function renderCommission(rows) {
    if (!rows?.length) return;
    makeChart('commissionChart', {
      type: 'bar',
      data: {
        labels: rows.map(r => r.name),
        datasets: [
          {
            label: 'Revenue',
            data: rows.map(r => parseFloat(r.revenue||0)),
            backgroundColor: COLORS.blue,
            borderRadius: 4,
          },
          {
            label: 'Commission',
            data: rows.map(r => parseFloat(r.commission||0)),
            backgroundColor: COLORS.green,
            borderRadius: 4,
          }
        ]
      },
      options: {
        responsive: true,
        onHover: cursorPointer,
        onClick: barDrill(rows.map(function (r) { return r.name; })),
        plugins: { legend: { position: 'top' } },
        scales: {
          y: { ticks: { callback: v => '$'+v.toLocaleString() }, beginAtZero: true }
        }
      }
    });
  }

  function renderAudience(rows) {
    if (!rows?.length) return;
    const labels = rows.map(r => r.audience_type || 'Unknown');
    const values = rows.map(r => parseInt(r.count||0));
    const total  = values.reduce((a,b) => a+b, 0);
    makeChart('audienceChart', {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data: values, backgroundColor: [COLORS.blue, COLORS.orange, COLORS.gray], hoverOffset: 6 }]
      },
      options: {
        responsive: true,
        cutout: '65%',
        onHover: cursorPointer,
        onClick: function () { window.location.href = '/leads'; },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ctx.label+': '+ctx.raw.toLocaleString()+' ('+pct(ctx.raw,total)+')' } }
        }
      }
    });
    const legend = document.getElementById('audience-legend');
    legend.innerHTML = rows.map(function(r,i) {
      return '<div class="flex justify-between items-center">'
        + '<div class="flex items-center gap-2">'
        + '<span class="w-3 h-3 rounded-full inline-block flex-shrink-0" style="background:' + PALETTE[i] + '"></span>'
        + '<span class="text-slate-700 text-sm">' + (r.audience_type || 'Unknown') + '</span>'
        + '</div>'
        + '<span class="font-semibold text-slate-900 text-sm">' + parseInt(r.count).toLocaleString()
        + ' <span class="text-slate-400 font-normal">(' + pct(r.count,total) + ')</span></span>'
        + '</div>';
    }).join('');
  }

  function renderProducts(rows) {
    if (!rows?.length) return;
    makeChart('productChart', {
      type: 'doughnut',
      data: {
        labels: rows.map(r => r.product),
        datasets: [{ data: rows.map(r => parseInt(r.count||0)), backgroundColor: PALETTE, hoverOffset: 6 }]
      },
      options: {
        responsive: true,
        cutout: '55%',
        onHover: cursorPointer,
        onClick: function () { window.location.href = '/leads'; },
        plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 12 } } } }
      }
    });
  }

  // Load on page open
  loadData(30);
</script>`;

  res.send(shell('Analytics', 'analytics', content, {
    user: req.user,
    extraHead: `<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>`,
  }));
});

module.exports = { router, navHtml };
