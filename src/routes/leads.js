// src/routes/leads.js  — CRM leads list + lead detail view
const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { navHtml } = require('./analytics');

const STAGES = ['new', 'contacted', 'quoted', 'follow_up', 'won', 'lost', 'dormant'];

const STAGE_LABELS = {
  new:        { label: 'New',        color: 'bg-gray-100 text-gray-700' },
  contacted:  { label: 'Contacted',  color: 'bg-blue-100 text-blue-700' },
  quoted:     { label: 'Quoted',     color: 'bg-yellow-100 text-yellow-700' },
  follow_up:  { label: 'Follow Up',  color: 'bg-orange-100 text-orange-700' },
  won:        { label: 'Won',        color: 'bg-green-100 text-green-700' },
  lost:       { label: 'Lost',       color: 'bg-red-100 text-red-700' },
  dormant:    { label: 'Dormant',    color: 'bg-gray-200 text-gray-500' },
};

// ─── Leads List ──────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const stage    = req.query.stage  || '';
  const search   = req.query.search || '';
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = 50;
  const offset   = (page - 1) * pageSize;

  let where = ['1=1'];
  const params = [];

  if (stage) {
    params.push(stage);
    where.push(`l.stage = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(l.first_name ILIKE $${params.length} OR l.last_name ILIKE $${params.length} OR l.email ILIKE $${params.length} OR l.phone ILIKE $${params.length})`);
  }

  const whereClause = where.join(' AND ');

  const [leadsResult, countResult, stageCountResult] = await Promise.all([
    pool.query(`
      SELECT l.id, l.first_name, l.last_name, l.email, l.phone, l.city,
             l.audience_type, l.product_interest, l.stage, l.created_at,
             s.name AS salesperson_name,
             ce.status AS enrollment_status,
             ce.current_step,
             seq.name AS sequence_name,
             l.reply_category, l.reply_urgency
      FROM leads l
      LEFT JOIN salespeople s ON s.id = l.salesperson_id
      LEFT JOIN contact_enrollments ce ON ce.lead_id = l.id AND ce.status = 'active'
      LEFT JOIN sequences seq ON seq.id = ce.sequence_id
      WHERE ${whereClause}
      ORDER BY l.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, pageSize, offset]),

    pool.query(`SELECT COUNT(*) FROM leads l WHERE ${whereClause}`, params),

    pool.query(`
      SELECT stage, COUNT(*) AS cnt
      FROM leads
      GROUP BY stage
    `),
  ]);

  const leads      = leadsResult.rows;
  const totalCount = parseInt(countResult.rows[0].count);
  const totalPages = Math.ceil(totalCount / pageSize);

  const stageCounts = {};
  STAGES.forEach(s => { stageCounts[s] = 0; });
  stageCountResult.rows.forEach(r => { stageCounts[r.stage] = parseInt(r.cnt); });
  const allCount = Object.values(stageCounts).reduce((a, b) => a + b, 0);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Leads – SalesPilot</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 min-h-screen">
  ${navHtml('leads')}

  <div class="max-w-7xl mx-auto px-4 py-8">

    <!-- Header -->
    <div class="flex justify-between items-center mb-6">
      <h1 class="text-2xl font-bold text-gray-800">Leads</h1>
      <span class="text-sm text-gray-500">${totalCount.toLocaleString()} total</span>
    </div>

    <!-- Pipeline Stage Filter -->
    <div class="bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap gap-2 items-center">
      <a href="/leads${search ? '?search=' + encodeURIComponent(search) : ''}"
         class="px-3 py-1.5 rounded-lg text-sm font-medium transition ${!stage ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}">
        All <span class="ml-1 opacity-75">${allCount}</span>
      </a>
      ${STAGES.map(s => {
        const info = STAGE_LABELS[s];
        const active = stage === s;
        const qs = new URLSearchParams({ stage: s, ...(search ? { search } : {}) }).toString();
        return `<a href="/leads?${qs}"
          class="px-3 py-1.5 rounded-lg text-sm font-medium transition ${active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}">
          ${info.label} <span class="ml-1 opacity-75">${stageCounts[s]}</span>
        </a>`;
      }).join('')}

      <!-- Search -->
      <form method="GET" action="/leads" class="ml-auto flex gap-2">
        ${stage ? `<input type="hidden" name="stage" value="${stage}">` : ''}
        <input type="text" name="search" value="${search}"
          placeholder="Search name, email, phone…"
          class="border rounded-lg px-3 py-1.5 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-blue-500">
        <button type="submit" class="bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-blue-700">Search</button>
        ${search ? `<a href="/leads${stage ? '?stage=' + stage : ''}" class="text-sm text-gray-400 hover:text-gray-600 py-1.5">Clear</a>` : ''}
      </form>
    </div>

    <!-- Leads Table -->
    <div class="bg-white rounded-xl shadow-sm overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b">
          <tr class="text-left text-gray-500 text-xs uppercase tracking-wider">
            <th class="px-4 py-3">Name</th>
            <th class="px-4 py-3">Contact</th>
            <th class="px-4 py-3">Stage</th>
            <th class="px-4 py-3">Sequence</th>
            <th class="px-4 py-3">Rep</th>
            <th class="px-4 py-3">Reply</th>
            <th class="px-4 py-3">Added</th>
            <th class="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          ${leads.length === 0 ? `
            <tr><td colspan="8" class="px-4 py-12 text-center text-gray-400">No leads found</td></tr>
          ` : leads.map(l => {
            const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || '—';
            const stageInfo = STAGE_LABELS[l.stage] || STAGE_LABELS.new;
            const replyBadge = l.reply_category
              ? `<span class="px-2 py-0.5 rounded text-xs ${l.reply_urgency === 'high' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}">${l.reply_category.replace('_', ' ')}</span>`
              : '<span class="text-gray-300">—</span>';
            const date = new Date(l.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return `
            <tr class="hover:bg-gray-50 cursor-pointer" onclick="window.location='/leads/${l.id}'">
              <td class="px-4 py-3">
                <div class="font-medium text-gray-900">${name}</div>
                <div class="text-xs text-gray-400">${l.city || ''} ${l.audience_type ? '· ' + l.audience_type : ''}</div>
              </td>
              <td class="px-4 py-3">
                <div class="text-gray-700">${l.email || '—'}</div>
                <div class="text-gray-400 text-xs">${l.phone || ''}</div>
              </td>
              <td class="px-4 py-3">
                <span class="px-2 py-0.5 rounded-full text-xs font-medium ${stageInfo.color}">${stageInfo.label}</span>
              </td>
              <td class="px-4 py-3">
                ${l.sequence_name
                  ? `<div class="text-gray-700">${l.sequence_name}</div><div class="text-xs text-gray-400">Step ${l.current_step}</div>`
                  : '<span class="text-gray-300">—</span>'}
              </td>
              <td class="px-4 py-3 text-gray-600">${l.salesperson_name || '—'}</td>
              <td class="px-4 py-3">${replyBadge}</td>
              <td class="px-4 py-3 text-gray-400 text-xs">${date}</td>
              <td class="px-4 py-3">
                <a href="/leads/${l.id}" class="text-blue-600 hover:underline text-xs" onclick="event.stopPropagation()">View →</a>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>

      <!-- Pagination -->
      ${totalPages > 1 ? `
      <div class="px-4 py-3 border-t flex justify-between items-center text-sm text-gray-500">
        <span>Page ${page} of ${totalPages}</span>
        <div class="flex gap-2">
          ${page > 1 ? `<a href="?${new URLSearchParams({ ...(stage ? { stage } : {}), ...(search ? { search } : {}), page: page - 1 }).toString()}" class="px-3 py-1 border rounded hover:bg-gray-50">← Prev</a>` : ''}
          ${page < totalPages ? `<a href="?${new URLSearchParams({ ...(stage ? { stage } : {}), ...(search ? { search } : {}), page: page + 1 }).toString()}" class="px-3 py-1 border rounded hover:bg-gray-50">Next →</a>` : ''}
        </div>
      </div>` : ''}
    </div>

  </div>
</body>
</html>`);
});

// ─── Lead Detail View ─────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  if (!leadId) return res.status(404).send('Not found');

  const [leadResult, enrollmentsResult, emailSendsResult, callLogsResult, notesResult] = await Promise.all([
    pool.query(`
      SELECT l.*, s.name AS salesperson_name, s.email AS salesperson_email
      FROM leads l
      LEFT JOIN salespeople s ON s.id = l.salesperson_id
      WHERE l.id = $1
    `, [leadId]),

    pool.query(`
      SELECT ce.*, seq.name AS sequence_name, ce.status, ce.current_step,
             ce.enrolled_at, ce.next_send_at, ce.paused_reason, ce.replied_at
      FROM contact_enrollments ce
      JOIN sequences seq ON seq.id = ce.sequence_id
      WHERE ce.lead_id = $1
      ORDER BY ce.enrolled_at DESC
    `, [leadId]),

    pool.query(`
      SELECT es.*, ss.subject, ss.step_number
      FROM email_sends es
      LEFT JOIN sequence_steps ss ON ss.id = es.step_id
      WHERE es.lead_id = $1
      ORDER BY es.sent_at DESC
      LIMIT 30
    `, [leadId]),

    pool.query(`
      SELECT cl.*, sp.name AS salesperson_name
      FROM call_logs cl
      LEFT JOIN salespeople sp ON sp.id = cl.salesperson_id
      WHERE cl.lead_id = $1
      ORDER BY cl.created_at DESC
      LIMIT 20
    `, [leadId]),

    pool.query(`
      SELECT * FROM lead_notes
      WHERE lead_id = $1
      ORDER BY created_at DESC
    `, [leadId]),
  ]);

  const lead = leadResult.rows[0];
  if (!lead) return res.status(404).send('Lead not found');

  const enrollments = enrollmentsResult.rows;
  const emailSends  = emailSendsResult.rows;
  const callLogs    = callLogsResult.rows;
  const notes       = notesResult.rows;

  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unnamed Lead';
  const stageInfo = STAGE_LABELS[lead.stage] || STAGE_LABELS.new;

  // Build unified activity timeline
  const timeline = [
    ...emailSends.map(e => ({
      type: 'email', date: new Date(e.sent_at),
      icon: '✉',
      title: `Email sent: ${e.subject || 'Step ' + e.step_number}`,
      detail: e.opened_at ? `Opened ${new Date(e.opened_at).toLocaleDateString()}` : 'Not opened',
      color: 'blue',
    })),
    ...callLogs.map(c => ({
      type: 'call', date: new Date(c.created_at),
      icon: '📞',
      title: `Inbound call${c.salesperson_name ? ' → ' + c.salesperson_name : ''}`,
      detail: `${Math.round((c.duration_seconds || 0) / 60)}m ${(c.duration_seconds || 0) % 60}s`,
      color: 'green',
    })),
    ...notes.map(n => ({
      type: 'note', date: new Date(n.created_at),
      icon: '📝',
      title: `Note${n.author_name ? ' by ' + n.author_name : ''}`,
      detail: n.content,
      color: 'yellow',
    })),
    ...enrollments.map(e => ({
      type: 'enroll', date: new Date(e.enrolled_at),
      icon: '▶',
      title: `Enrolled in ${e.sequence_name}`,
      detail: `Status: ${e.status}`,
      color: 'purple',
    })),
  ].sort((a, b) => b.date - a.date);

  const colorMap = {
    blue:   'bg-blue-100 text-blue-600',
    green:  'bg-green-100 text-green-600',
    yellow: 'bg-yellow-100 text-yellow-600',
    purple: 'bg-purple-100 text-purple-600',
    red:    'bg-red-100 text-red-600',
  };

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${name} – SalesPilot</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 min-h-screen">
  ${navHtml('leads')}

  <div class="max-w-5xl mx-auto px-4 py-8">

    <!-- Back -->
    <a href="/leads" class="text-sm text-gray-400 hover:text-gray-600 mb-4 inline-block">← Back to Leads</a>

    <div class="grid grid-cols-3 gap-6">

      <!-- Left: Contact Card -->
      <div class="col-span-1 space-y-4">

        <!-- Identity -->
        <div class="bg-white rounded-xl shadow-sm p-5">
          <div class="flex items-center gap-3 mb-4">
            <div class="w-12 h-12 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-lg font-bold">
              ${(lead.first_name?.[0] || '?').toUpperCase()}
            </div>
            <div>
              <div class="font-bold text-gray-900">${name}</div>
              <span class="px-2 py-0.5 rounded-full text-xs font-medium ${stageInfo.color}">${stageInfo.label}</span>
            </div>
          </div>
          <div class="space-y-2 text-sm">
            ${lead.email ? `<div class="flex gap-2"><span class="text-gray-400 w-16">Email</span><span class="text-gray-700">${lead.email}</span></div>` : ''}
            ${lead.phone ? `<div class="flex gap-2"><span class="text-gray-400 w-16">Phone</span><span class="text-gray-700">${lead.phone}</span></div>` : ''}
            ${lead.city  ? `<div class="flex gap-2"><span class="text-gray-400 w-16">City</span><span class="text-gray-700">${lead.city}</span></div>` : ''}
            ${lead.audience_type ? `<div class="flex gap-2"><span class="text-gray-400 w-16">Type</span><span class="text-gray-700">${lead.audience_type}</span></div>` : ''}
            ${lead.product_interest ? `<div class="flex gap-2"><span class="text-gray-400 w-16">Interest</span><span class="text-gray-700">${lead.product_interest}</span></div>` : ''}
            ${lead.salesperson_name ? `<div class="flex gap-2"><span class="text-gray-400 w-16">Rep</span><span class="text-gray-700">${lead.salesperson_name}</span></div>` : ''}
            <div class="flex gap-2"><span class="text-gray-400 w-16">Added</span><span class="text-gray-700">${new Date(lead.created_at).toLocaleDateString()}</span></div>
          </div>
        </div>

        <!-- Stage -->
        <div class="bg-white rounded-xl shadow-sm p-5">
          <h3 class="font-semibold text-gray-700 text-sm mb-3">Pipeline Stage</h3>
          <div class="flex flex-col gap-1.5" id="stage-buttons">
            ${STAGES.map(s => {
              const info = STAGE_LABELS[s];
              const active = lead.stage === s;
              return `<button onclick="setStage(${leadId}, '${s}')"
                class="stage-btn w-full text-left px-3 py-2 rounded-lg text-sm font-medium border transition
                  ${active ? 'border-blue-500 ' + info.color : 'border-transparent bg-gray-50 text-gray-600 hover:bg-gray-100'}"
                data-stage="${s}">
                ${info.label}
              </button>`;
            }).join('')}
          </div>
        </div>

        <!-- Reply Classification -->
        ${lead.reply_category ? `
        <div class="bg-white rounded-xl shadow-sm p-5">
          <h3 class="font-semibold text-gray-700 text-sm mb-3">Last Reply</h3>
          <div class="space-y-2 text-sm">
            <div class="flex gap-2"><span class="text-gray-400">Category</span>
              <span class="font-medium">${lead.reply_category.replace(/_/g, ' ')}</span></div>
            <div class="flex gap-2"><span class="text-gray-400">Urgency</span>
              <span class="px-2 py-0.5 rounded text-xs ${lead.reply_urgency === 'high' ? 'bg-red-100 text-red-700' : lead.reply_urgency === 'low' ? 'bg-gray-100 text-gray-600' : 'bg-yellow-100 text-yellow-700'}">${lead.reply_urgency || 'medium'}</span></div>
            ${lead.reply_summary ? `<div class="text-gray-600 text-xs mt-1">${lead.reply_summary}</div>` : ''}
          </div>
        </div>` : ''}

        <!-- Enrollments -->
        ${enrollments.length ? `
        <div class="bg-white rounded-xl shadow-sm p-5">
          <h3 class="font-semibold text-gray-700 text-sm mb-3">Sequences</h3>
          <div class="space-y-2">
            ${enrollments.map(e => `
            <div class="text-sm border rounded-lg p-2.5">
              <div class="font-medium text-gray-800">${e.sequence_name}</div>
              <div class="text-xs text-gray-400 mt-0.5">
                Step ${e.current_step} ·
                <span class="${e.status === 'active' ? 'text-green-600' : e.status === 'paused' ? 'text-yellow-600' : 'text-gray-400'}">${e.status}</span>
                ${e.paused_reason ? ' · ' + e.paused_reason : ''}
              </div>
            </div>`).join('')}
          </div>
        </div>` : ''}

      </div>

      <!-- Right: Activity Timeline + Notes -->
      <div class="col-span-2 space-y-4">

        <!-- Add Note -->
        <div class="bg-white rounded-xl shadow-sm p-5">
          <h3 class="font-semibold text-gray-700 text-sm mb-3">Add Note</h3>
          <textarea id="note-text" rows="3" placeholder="Add a note about this lead…"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"></textarea>
          <div class="flex justify-end mt-2">
            <button onclick="addNote(${leadId})" class="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700">Add Note</button>
          </div>
        </div>

        <!-- Timeline -->
        <div class="bg-white rounded-xl shadow-sm p-5">
          <h3 class="font-semibold text-gray-700 text-sm mb-4">Activity Timeline</h3>
          ${timeline.length === 0 ? '<p class="text-gray-400 text-sm">No activity yet.</p>' : `
          <div class="space-y-3" id="timeline">
            ${timeline.map(item => `
            <div class="flex gap-3 items-start">
              <div class="w-8 h-8 rounded-full flex items-center justify-center text-xs flex-shrink-0 ${colorMap[item.color] || colorMap.blue}">
                ${item.icon}
              </div>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-gray-800">${item.title}</div>
                <div class="text-xs text-gray-500 mt-0.5">${item.detail}</div>
              </div>
              <div class="text-xs text-gray-400 flex-shrink-0">${item.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
            </div>`).join('')}
          </div>`}
        </div>

      </div>
    </div>
  </div>

  <script>
    async function setStage(leadId, stage) {
      const res = await fetch('/leads/' + leadId + '/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      if (!res.ok) { alert('Failed to update stage'); return; }

      // Update button styles
      document.querySelectorAll('.stage-btn').forEach(btn => {
        const s = btn.dataset.stage;
        const colors = ${JSON.stringify(Object.fromEntries(STAGES.map(s => [s, STAGE_LABELS[s].color])))};
        if (s === stage) {
          btn.className = btn.className.replace(/border-transparent bg-gray-50 text-gray-600 hover:bg-gray-100/, '');
          btn.classList.add('border-blue-500', ...colors[s].split(' '));
        } else {
          btn.classList.remove('border-blue-500', ...colors[s].split(' '));
          btn.classList.add('border-transparent', 'bg-gray-50', 'text-gray-600', 'hover:bg-gray-100');
        }
      });
    }

    async function addNote(leadId) {
      const text = document.getElementById('note-text').value.trim();
      if (!text) return;
      const res = await fetch('/leads/' + leadId + '/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok) { alert('Failed to add note'); return; }
      document.getElementById('note-text').value = '';
      // Reload page to show note in timeline
      window.location.reload();
    }
  </script>
</body>
</html>`);
});

// ─── API: Update Stage ────────────────────────────────────────────────────────
router.post('/:id/stage', requireAuth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  const { stage } = req.body;
  if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
  await pool.query('UPDATE leads SET stage = $1 WHERE id = $2', [stage, leadId]);
  res.json({ ok: true });
});

// ─── API: Add Note ────────────────────────────────────────────────────────────
router.post('/:id/notes', requireAuth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content required' });

  const user = req.user;
  await pool.query(
    'INSERT INTO lead_notes (lead_id, author_name, content) VALUES ($1, $2, $3)',
    [leadId, user?.name || user?.email || 'Admin', content.trim()]
  );
  res.json({ ok: true });
});

module.exports = router;
