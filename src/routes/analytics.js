const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

// Shared nav HTML — same tabs on both pages
function navHtml(activePage) {
  const tab = (label, href, page) => `
    <a href="${href}" class="px-4 py-2 text-sm font-medium rounded-lg transition ${
      activePage === page
        ? 'bg-blue-600 text-white'
        : 'text-gray-500 hover:text-gray-800 hover:bg-gray-100'
    }">${label}</a>`;

  return `
    <nav class="bg-white border-b px-6 py-3 flex justify-between items-center shadow-sm">
      <div class="flex items-center gap-6">
        <div>
          <span class="font-bold text-gray-800 text-lg">SureSecured</span>
          <span class="text-gray-400 text-sm ml-2">Commission Tracker</span>
        </div>
        <div class="flex gap-1">
          ${tab('Overview', '/dashboard', 'dashboard')}
          ${tab('Analytics', '/analytics', 'analytics')}
          ${tab('Admin', '/admin', 'admin')}
        </div>
      </div>
      <a href="/logout" class="text-sm text-gray-500 hover:text-red-600 transition">Sign out</a>
    </nav>`;
}

// Data endpoint — returns all chart data as JSON
router.get('/data', requireAuth, async (req, res) => {
  const days = parseInt(req.query.days) || 30;

  try {
    const [
      revenueByDay,
      clicksByDay,
      callsByDay,
      formsByDay,
      commissionBySp,
      funnel,
      audienceSplit,
      topProducts,
    ] = await Promise.all([

      // Revenue per day
      pool.query(`
        SELECT DATE(ordered_at) AS date, COALESCE(SUM(amount),0) AS revenue
        FROM orders
        WHERE ordered_at >= NOW() - INTERVAL '${days} days'
        GROUP BY DATE(ordered_at) ORDER BY date
      `),

      // Clicks per day
      pool.query(`
        SELECT DATE(clicked_at) AS date, COUNT(*) AS clicks
        FROM clicks
        WHERE clicked_at >= NOW() - INTERVAL '${days} days'
        GROUP BY DATE(clicked_at) ORDER BY date
      `),

      // Phone calls per day
      pool.query(`
        SELECT DATE(called_at) AS date, COUNT(*) AS calls
        FROM phone_calls
        WHERE called_at >= NOW() - INTERVAL '${days} days'
        GROUP BY DATE(called_at) ORDER BY date
      `),

      // Form submissions per day
      pool.query(`
        SELECT DATE(submitted_at) AS date, COUNT(*) AS forms
        FROM form_submissions
        WHERE submitted_at >= NOW() - INTERVAL '${days} days'
        GROUP BY DATE(submitted_at) ORDER BY date
      `),

      // Commission & revenue per salesperson
      pool.query(`
        SELECT
          s.name,
          COALESCE(SUM(o.amount), 0) AS revenue,
          COALESCE(SUM(cm.commission_earned), 0) AS commission,
          COUNT(DISTINCT o.id) AS orders,
          COUNT(DISTINCT c.id) AS clicks
        FROM salespeople s
        LEFT JOIN orders o ON o.salesperson_id = s.id
        LEFT JOIN commissions cm ON cm.salesperson_id = s.id
        LEFT JOIN clicks c ON c.salesperson_id = s.id
        WHERE s.active = true
        GROUP BY s.name ORDER BY revenue DESC LIMIT 10
      `),

      // Conversion funnel totals
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM leads) AS total_leads,
          (SELECT COUNT(*) FROM clicks) AS total_clicks,
          (SELECT COUNT(*) FROM form_submissions) AS total_forms,
          (SELECT COUNT(*) FROM phone_calls) AS total_calls,
          (SELECT COUNT(*) FROM orders) AS total_orders
      `),

      // B2C vs B2B split
      pool.query(`
        SELECT audience_type, COUNT(*) AS count
        FROM leads
        GROUP BY audience_type
      `),

      // Top product interests
      pool.query(`
        SELECT
          COALESCE(product_interest, 'Unknown') AS product,
          COUNT(*) AS count
        FROM leads
        GROUP BY product_interest
        ORDER BY count DESC LIMIT 6
      `),
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
    });
  } catch (err) {
    console.error('Analytics data error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Analytics page
router.get('/', requireAuth, async (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>SureSecured — Analytics</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2/dist/tailwind.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
</head>
<body class="bg-gray-100 min-h-screen">

  ${navHtml('analytics')}

  <div class="max-w-7xl mx-auto px-6 py-8">

    <!-- Period selector -->
    <div class="flex justify-between items-center mb-6">
      <h1 class="text-xl font-bold text-gray-800">Analytics</h1>
      <div class="flex gap-2">
        <button onclick="loadData(7)"  id="btn-7"  class="period-btn px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-white transition">7d</button>
        <button onclick="loadData(30)" id="btn-30" class="period-btn px-3 py-1.5 text-sm rounded-lg border border-blue-500 bg-blue-600 text-white transition">30d</button>
        <button onclick="loadData(60)" id="btn-60" class="period-btn px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-white transition">60d</button>
        <button onclick="loadData(90)" id="btn-90" class="period-btn px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-white transition">90d</button>
      </div>
    </div>

    <!-- Funnel Row -->
    <div class="bg-white rounded-xl shadow-sm p-6 mb-6">
      <h2 class="font-semibold text-gray-700 mb-4 text-sm uppercase tracking-wide">Conversion Funnel</h2>
      <div class="flex items-center justify-around" id="funnel-row">
        <div class="text-center">
          <p class="text-3xl font-bold text-gray-800" id="f-leads">—</p>
          <p class="text-xs text-gray-500 mt-1">Leads</p>
        </div>
        <div class="text-gray-300 text-2xl">→</div>
        <div class="text-center">
          <p class="text-3xl font-bold text-blue-600" id="f-clicks">—</p>
          <p class="text-xs text-gray-500 mt-1">Email Clicks</p>
          <p class="text-xs text-blue-400 mt-0.5" id="f-clicks-rate"></p>
        </div>
        <div class="text-gray-300 text-2xl">→</div>
        <div class="text-center">
          <p class="text-3xl font-bold text-indigo-600" id="f-forms">—</p>
          <p class="text-xs text-gray-500 mt-1">Quote Requests</p>
          <p class="text-xs text-indigo-400 mt-0.5" id="f-forms-rate"></p>
        </div>
        <div class="text-gray-300 text-2xl">→</div>
        <div class="text-center">
          <p class="text-3xl font-bold text-purple-600" id="f-calls">—</p>
          <p class="text-xs text-gray-500 mt-1">Phone Calls</p>
          <p class="text-xs text-purple-400 mt-0.5" id="f-calls-rate"></p>
        </div>
        <div class="text-gray-300 text-2xl">→</div>
        <div class="text-center">
          <p class="text-3xl font-bold text-green-600" id="f-orders">—</p>
          <p class="text-xs text-gray-500 mt-1">Orders</p>
          <p class="text-xs text-green-400 mt-0.5" id="f-orders-rate"></p>
        </div>
      </div>
    </div>

    <!-- Revenue + Engagement Charts -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">

      <div class="bg-white rounded-xl shadow-sm p-6">
        <h2 class="font-semibold text-gray-700 mb-4 text-sm uppercase tracking-wide">Revenue Over Time</h2>
        <canvas id="revenueChart" height="200"></canvas>
      </div>

      <div class="bg-white rounded-xl shadow-sm p-6">
        <h2 class="font-semibold text-gray-700 mb-4 text-sm uppercase tracking-wide">Email Clicks, Forms & Calls</h2>
        <canvas id="engagementChart" height="200"></canvas>
      </div>

    </div>

    <!-- Salesperson + Audience Charts -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">

      <div class="bg-white rounded-xl shadow-sm p-6 lg:col-span-2">
        <h2 class="font-semibold text-gray-700 mb-4 text-sm uppercase tracking-wide">Revenue by Salesperson</h2>
        <canvas id="salespersonChart" height="180"></canvas>
      </div>

      <div class="bg-white rounded-xl shadow-sm p-6">
        <h2 class="font-semibold text-gray-700 mb-4 text-sm uppercase tracking-wide">B2C vs B2B</h2>
        <canvas id="audienceChart" height="180"></canvas>
        <div id="audience-legend" class="mt-4 flex flex-col gap-2 text-sm"></div>
      </div>

    </div>

    <!-- Commission vs Revenue + Product Interest -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">

      <div class="bg-white rounded-xl shadow-sm p-6">
        <h2 class="font-semibold text-gray-700 mb-4 text-sm uppercase tracking-wide">Commission Earned by Salesperson</h2>
        <canvas id="commissionChart" height="200"></canvas>
      </div>

      <div class="bg-white rounded-xl shadow-sm p-6">
        <h2 class="font-semibold text-gray-700 mb-4 text-sm uppercase tracking-wide">Lead Interest Breakdown</h2>
        <canvas id="productChart" height="200"></canvas>
      </div>

    </div>

  </div>

<script>
  let charts = {};

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

  function loadData(days = 30) {
    // Update active button
    document.querySelectorAll('.period-btn').forEach(b => {
      b.className = 'period-btn px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-white transition';
    });
    const active = document.getElementById('btn-'+days);
    if (active) active.className = 'period-btn px-3 py-1.5 text-sm rounded-lg border border-blue-500 bg-blue-600 text-white transition';

    fetch('/analytics/data?days='+days)
      .then(r => r.json())
      .then(data => {
        renderFunnel(data.funnel);
        renderRevenue(data.revenueByDay, days);
        renderEngagement(data.clicksByDay, data.formsByDay, data.callsByDay, days);
        renderSalesperson(data.commissionBySp);
        renderCommission(data.commissionBySp);
        renderAudience(data.audienceSplit);
        renderProducts(data.topProducts);
      })
      .catch(err => console.error('Analytics load error:', err));
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

  function renderRevenue(rows, days) {
    const {labels, values} = fillDates(rows, 'date', 'revenue', days);
    makeChart('revenueChart', {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Revenue',
          data: values,
          borderColor: COLORS.green,
          backgroundColor: 'rgba(16,185,129,0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          pointHoverRadius: 5,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { ticks: { callback: v => '$'+v.toLocaleString() }, beginAtZero: true },
          x: { ticks: { maxTicksLimit: 10 } }
        }
      }
    });
  }

  function renderEngagement(clicks, forms, calls, days) {
    const cl = fillDates(clicks, 'date', 'clicks', days);
    const fo = fillDates(forms,  'date', 'forms',  days);
    const ca = fillDates(calls,  'date', 'calls',  days);
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
        plugins: { legend: { display: false } },
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
        + '<span class="w-3 h-3 rounded-full inline-block" style="background:' + PALETTE[i] + '"></span>'
        + '<span class="text-gray-700">' + (r.audience_type || 'Unknown') + '</span>'
        + '</div>'
        + '<span class="font-semibold text-gray-800">' + parseInt(r.count).toLocaleString()
        + ' <span class="text-gray-400 font-normal">(' + pct(r.count,total) + ')</span></span>'
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
        plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 12 } } } }
      }
    });
  }

  // Load on page open
  loadData(30);
</script>

</body>
</html>`);
});

module.exports = { router, navHtml };
