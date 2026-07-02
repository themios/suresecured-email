// src/routes/leads.js  — CRM leads list + lead detail view
const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { navHtml } = require('./analytics');
const { sendDirectEmail, sesEnabled } = require('../lib/gmail');

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

  const [leadResult, enrollmentsResult, emailSendsResult, callLogsResult, notesResult, smsResult, suppressedResult] = await Promise.all([
    pool.query(`
      SELECT l.*, s.name AS salesperson_name, s.email AS salesperson_email
      FROM leads l
      LEFT JOIN salespeople s ON s.id = l.salesperson_id
      WHERE l.id = $1
    `, [leadId]),

    pool.query(`
      SELECT ce.*, seq.name AS sequence_name
      FROM contact_enrollments ce
      JOIN sequences seq ON seq.id = ce.sequence_id
      WHERE ce.lead_id = $1
      ORDER BY ce.enrolled_at DESC
    `, [leadId]),

    pool.query(`
      SELECT es.*, ss.subject AS step_subject, ss.step_number
      FROM email_sends es
      LEFT JOIN sequence_steps ss ON ss.id = es.step_id
      WHERE es.lead_id = $1
      ORDER BY es.sent_at ASC
      LIMIT 50
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
      ORDER BY created_at ASC
    `, [leadId]),

    pool.query(`
      SELECT * FROM sms_messages
      WHERE lead_id = $1
      ORDER BY sent_at ASC
      LIMIT 50
    `, [leadId]).catch(() => ({ rows: [] })),

    pool.query(
      `SELECT reason, added_at FROM suppression_list WHERE LOWER(email) = LOWER((SELECT email FROM leads WHERE id = $1))`,
      [leadId]
    ).catch(() => ({ rows: [] })),
  ]);

  const lead = leadResult.rows[0];
  if (!lead) return res.status(404).send('Lead not found');

  const enrollments = enrollmentsResult.rows;
  const emailSends  = emailSendsResult.rows;
  const callLogs    = callLogsResult.rows;
  const notes       = notesResult.rows;
  const smsMessages  = smsResult.rows;
  const suppressed   = suppressedResult.rows[0] || null;

  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unnamed Lead';
  const stageInfo = STAGE_LABELS[lead.stage] || STAGE_LABELS.new;

  // Last sequence email subject for pre-filling reply
  const lastEmailSubject = emailSends.length
    ? emailSends[emailSends.length - 1].step_subject || emailSends[emailSends.length - 1].subject || ''
    : '';
  const replySubjectDefault = lastEmailSubject.startsWith('Re:') ? lastEmailSubject : `Re: ${lastEmailSubject}`;

  // Build unified activity timeline (chronological, oldest first)
  const timeline = [
    ...emailSends.map(e => ({
      type: 'email_out', date: new Date(e.sent_at),
      label: e.step_subject || e.subject || ('Step ' + e.step_number),
      meta: e.opened_at
        ? `Opened ${new Date(e.opened_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : (e.status === 'failed' ? 'Failed to send' : 'Delivered'),
      from: 'Sales',
      to: lead.email,
    })),
    ...smsMessages.map(s => ({
      type: s.direction === 'inbound' ? 'sms_in' : 'sms_out',
      date: new Date(s.sent_at),
      label: s.body || '',
      meta: '',
      from: s.direction === 'inbound' ? (lead.phone || 'Lead') : 'Sales',
      to:   s.direction === 'inbound' ? 'Sales' : (lead.phone || 'Lead'),
    })),
    ...callLogs.map(c => ({
      type: 'call', date: new Date(c.created_at),
      label: `Call${c.salesperson_name ? ' with ' + c.salesperson_name : ''}`,
      meta: `${Math.round((c.duration_seconds || 0) / 60)}m ${(c.duration_seconds || 0) % 60}s`,
      from: lead.phone || 'Lead',
      to: '',
    })),
    ...notes.map(n => ({
      type: 'note', date: new Date(n.created_at),
      label: n.content,
      meta: n.author_name ? 'by ' + n.author_name : '',
      from: n.author_name || 'Rep',
      to: '',
    })),
    ...enrollments.map(e => ({
      type: 'enroll', date: new Date(e.enrolled_at),
      label: `Enrolled in "${e.sequence_name}"`,
      meta: '',
      from: '',
      to: '',
    })),
  ];

  // Add reply event if lead has replied
  if (lead.reply_classified_at || lead.reply_text) {
    timeline.push({
      type: 'email_in',
      date: lead.reply_classified_at ? new Date(lead.reply_classified_at) : new Date(),
      label: lead.reply_text || '(reply)',
      meta: lead.reply_subject || '',
      from: lead.email,
      to: 'Sales',
    });
  }

  timeline.sort((a, b) => a.date - b.date);

  // Icon + color per type
  const typeConfig = {
    email_out: { icon: '&#x2709;', bg: 'bg-blue-100',   text: 'text-blue-600',   badge: 'Sent',     badgeCls: 'bg-blue-50 text-blue-500' },
    email_in:  { icon: '&#x2709;', bg: 'bg-green-100',  text: 'text-green-600',  badge: 'Received', badgeCls: 'bg-green-50 text-green-600' },
    sms_out:   { icon: '&#x1F4AC;', bg: 'bg-blue-100',  text: 'text-blue-600',   badge: 'SMS Out',  badgeCls: 'bg-blue-50 text-blue-500' },
    sms_in:    { icon: '&#x1F4AC;', bg: 'bg-green-100', text: 'text-green-600',  badge: 'SMS In',   badgeCls: 'bg-green-50 text-green-600' },
    call:      { icon: '&#x1F4DE;', bg: 'bg-purple-100',text: 'text-purple-600', badge: 'Call',     badgeCls: 'bg-purple-50 text-purple-600' },
    note:      { icon: '&#x1F4DD;', bg: 'bg-yellow-100',text: 'text-yellow-700', badge: 'Note',     badgeCls: 'bg-yellow-50 text-yellow-700' },
    enroll:    { icon: '&#x25B6;',  bg: 'bg-gray-100',  text: 'text-gray-600',   badge: 'Enrolled', badgeCls: 'bg-gray-50 text-gray-500' },
  };

  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(name)} – Sales Tracker</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 min-h-screen">
  ${navHtml('leads')}

  <div class="max-w-6xl mx-auto px-4 py-6">
    <a href="/leads" class="text-sm text-gray-400 hover:text-gray-600 mb-4 inline-block">&#x2190; Back to Leads</a>

    <div class="grid grid-cols-12 gap-5">

      <!-- LEFT SIDEBAR -->
      <div class="col-span-3 space-y-4">

        <!-- Contact card -->
        <div class="bg-white rounded-xl shadow-sm p-4">
          <div class="flex items-center gap-3 mb-4">
            <div class="w-11 h-11 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-base font-bold flex-shrink-0">
              ${esc((lead.first_name?.[0] || '?').toUpperCase())}
            </div>
            <div>
              <div class="font-bold text-gray-900 text-sm">${esc(name)}</div>
              <span class="px-2 py-0.5 rounded-full text-xs font-medium ${stageInfo.color}">${stageInfo.label}</span>
            </div>
          </div>
          <div class="space-y-1.5 text-xs">
            ${lead.email    ? `<div class="flex gap-1.5"><span class="text-gray-400 w-14 flex-shrink-0">Email</span><span class="text-gray-700 break-all">${esc(lead.email)}</span></div>` : ''}
            ${lead.phone    ? `<div class="flex gap-1.5"><span class="text-gray-400 w-14 flex-shrink-0">Phone</span><span class="text-gray-700">${esc(lead.phone)}</span></div>` : ''}
            ${lead.city     ? `<div class="flex gap-1.5"><span class="text-gray-400 w-14 flex-shrink-0">City</span><span class="text-gray-700">${esc(lead.city)}</span></div>` : ''}
            ${lead.audience_type     ? `<div class="flex gap-1.5"><span class="text-gray-400 w-14 flex-shrink-0">Type</span><span class="text-gray-700">${esc(lead.audience_type)}</span></div>` : ''}
            ${lead.product_interest  ? `<div class="flex gap-1.5"><span class="text-gray-400 w-14 flex-shrink-0">Interest</span><span class="text-gray-700">${esc(lead.product_interest)}</span></div>` : ''}
            ${lead.salesperson_name  ? `<div class="flex gap-1.5"><span class="text-gray-400 w-14 flex-shrink-0">Rep</span><span class="text-gray-700">${esc(lead.salesperson_name)}</span></div>` : ''}
            <div class="flex gap-1.5"><span class="text-gray-400 w-14 flex-shrink-0">Added</span><span class="text-gray-700">${new Date(lead.created_at).toLocaleDateString()}</span></div>
          </div>
        </div>

        <!-- Suppression warning -->
        ${suppressed ? `
        <div class="rounded-xl border border-red-200 bg-red-50 p-4">
          <div class="flex items-start gap-2">
            <span class="text-red-500 text-base mt-0.5">&#x26D4;</span>
            <div class="flex-1">
              <div class="text-xs font-semibold text-red-700 uppercase tracking-wide mb-0.5">Suppressed</div>
              <div class="text-xs text-red-600">${esc(suppressed.reason || 'manual')} &middot; ${new Date(suppressed.added_at).toLocaleDateString()}</div>
              ${suppressed.reason === 'unsubscribed'
                ? `<div class="text-xs text-red-500 mt-1 font-medium">Customer unsubscribed &mdash; do not re-enroll.</div>`
                : `<button onclick="unsuppress(${leadId})"
                    class="mt-2 text-xs bg-white border border-red-300 text-red-700 px-3 py-1 rounded hover:bg-red-100 transition">
                    Remove from suppression list
                  </button>`}
            </div>
          </div>
        </div>` : ''}

        <!-- Stage -->
        <div class="bg-white rounded-xl shadow-sm p-4">
          <h3 class="font-semibold text-gray-600 text-xs uppercase tracking-wide mb-2">Pipeline Stage</h3>
          <div class="flex flex-col gap-1" id="stage-buttons">
            ${STAGES.map(s => {
              const info = STAGE_LABELS[s];
              const active = lead.stage === s;
              return `<button onclick="setStage(${leadId}, '${s}')"
                class="stage-btn w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium border transition
                  ${active ? 'border-blue-500 ' + info.color : 'border-transparent bg-gray-50 text-gray-600 hover:bg-gray-100'}"
                data-stage="${s}">${info.label}</button>`;
            }).join('')}
          </div>
        </div>

        <!-- Reply intel -->
        ${lead.reply_category ? `
        <div class="bg-white rounded-xl shadow-sm p-4">
          <h3 class="font-semibold text-gray-600 text-xs uppercase tracking-wide mb-2">Reply Intel</h3>
          <div class="space-y-1.5 text-xs">
            <div class="flex gap-1.5"><span class="text-gray-400 w-14">Category</span>
              <span class="font-medium text-gray-700">${esc(lead.reply_category.replace(/_/g,' '))}</span></div>
            <div class="flex gap-1.5"><span class="text-gray-400 w-14">Urgency</span>
              <span class="px-1.5 py-0.5 rounded text-xs font-medium ${lead.reply_urgency === 'high' ? 'bg-red-100 text-red-700' : lead.reply_urgency === 'low' ? 'bg-gray-100 text-gray-600' : 'bg-yellow-100 text-yellow-700'}">${esc(lead.reply_urgency || 'medium')}</span></div>
            ${lead.reply_summary ? `<div class="text-gray-600 mt-1 leading-relaxed">${esc(lead.reply_summary)}</div>` : ''}
          </div>
        </div>` : ''}

        <!-- Enrollment & Email Controls -->
        <div class="bg-white rounded-xl shadow-sm p-4">
          <h3 class="font-semibold text-gray-600 text-xs uppercase tracking-wide mb-3">Email Sequences</h3>

          ${enrollments.length === 0
            ? `<p class="text-xs text-gray-400">Not enrolled in any sequence.</p>`
            : enrollments.map(e => `
            <div class="border rounded-lg p-2.5 mb-2 last:mb-0">
              <div class="font-medium text-gray-800 text-xs mb-0.5">${esc(e.sequence_name)}</div>
              <div class="text-xs text-gray-400 mb-2">
                Step ${e.current_step}
                &middot; <span class="${e.status === 'active' ? 'text-green-600 font-medium' : e.status === 'paused' ? 'text-yellow-600 font-medium' : 'text-gray-400'}">${e.status}</span>
                ${e.paused_reason ? ` &middot; ${esc(e.paused_reason)}` : ''}
              </div>
              <div class="flex gap-1.5 flex-wrap">
                ${e.status === 'active' ? `
                  <button onclick="enrollmentAction(${e.id}, 'pause')"
                    class="text-xs px-2.5 py-1 rounded border border-yellow-300 text-yellow-700 bg-yellow-50 hover:bg-yellow-100 transition">
                    Pause
                  </button>` : ''}
                ${e.status === 'paused' ? `
                  <button onclick="enrollmentAction(${e.id}, 'resume')"
                    class="text-xs px-2.5 py-1 rounded border border-green-300 text-green-700 bg-green-50 hover:bg-green-100 transition">
                    Resume
                  </button>` : ''}
                ${e.status !== 'completed' ? `
                  <button onclick="enrollmentAction(${e.id}, 'unenroll')"
                    class="text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-500 bg-gray-50 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition">
                    Unenroll
                  </button>` : ''}
              </div>
            </div>`).join('')}

          <!-- Suppression actions -->
          <div class="mt-3 pt-3 border-t">
            ${lead.unsubscribed
              ? `<div class="text-xs text-red-500 font-medium flex items-center gap-1.5">
                   <span>&#x26D4;</span> Unsubscribed ${lead.unsubscribed_at ? '· ' + new Date(lead.unsubscribed_at).toLocaleDateString() : ''}
                 </div>`
              : suppressed
                ? `<div class="flex items-center justify-between">
                     <span class="text-xs text-orange-600 font-medium flex items-center gap-1">
                       <span>&#x26A0;</span> Suppressed (${esc(suppressed.reason || 'manual')})
                     </span>
                     <button onclick="unsuppress(${leadId})"
                       class="text-xs px-2.5 py-1 rounded border border-blue-200 text-blue-600 bg-blue-50 hover:bg-blue-100 transition">
                       Unsuppress
                     </button>
                   </div>`
                : `<button onclick="suppressLead(${leadId})"
                     class="w-full text-xs px-2.5 py-1.5 rounded border border-gray-200 text-gray-500 bg-gray-50 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition text-left">
                     &#x26A0; Suppress this lead
                   </button>`}
          </div>
        </div>

      </div>

      <!-- MAIN: Conversation + Compose -->
      <div class="col-span-9 flex flex-col gap-4">

        <!-- Conversation thread -->
        <div class="bg-white rounded-xl shadow-sm flex flex-col" style="min-height:400px">
          <div class="px-5 py-3 border-b flex items-center justify-between">
            <h2 class="font-semibold text-gray-800 text-sm">Conversation</h2>
            <span class="text-xs text-gray-400">${timeline.length} events</span>
          </div>

          <div class="flex-1 overflow-y-auto p-5 space-y-4" id="conversation">
            ${timeline.length === 0 ? '<p class="text-gray-400 text-sm text-center py-8">No activity yet.</p>' :
              timeline.map(item => {
                const cfg = typeConfig[item.type] || typeConfig.note;
                const isInbound = item.type === 'email_in' || item.type === 'sms_in';
                const isOutbound = item.type === 'email_out' || item.type === 'sms_out';
                const dateStr = item.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                  + ' ' + item.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

                if (isInbound) {
                  return `
                  <div class="flex gap-3 items-start">
                    <div class="w-8 h-8 rounded-full ${cfg.bg} ${cfg.text} flex items-center justify-center text-sm flex-shrink-0 mt-0.5">${cfg.icon}</div>
                    <div class="flex-1">
                      <div class="bg-green-50 border border-green-100 rounded-2xl rounded-tl-sm px-4 py-3 max-w-xl">
                        ${item.meta ? `<div class="text-xs text-gray-400 mb-1">${esc(item.meta)}</div>` : ''}
                        <div class="text-sm text-gray-800 whitespace-pre-wrap">${esc(item.label)}</div>
                      </div>
                      <div class="text-xs text-gray-400 mt-1 ml-1">${esc(item.from)} · ${dateStr}</div>
                    </div>
                  </div>`;
                } else if (isOutbound) {
                  return `
                  <div class="flex gap-3 items-start flex-row-reverse">
                    <div class="w-8 h-8 rounded-full ${cfg.bg} ${cfg.text} flex items-center justify-center text-sm flex-shrink-0 mt-0.5">${cfg.icon}</div>
                    <div class="flex-1 flex flex-col items-end">
                      <div class="bg-blue-50 border border-blue-100 rounded-2xl rounded-tr-sm px-4 py-3 max-w-xl">
                        <div class="text-xs font-medium text-blue-700 mb-1">${esc(item.label)}</div>
                        ${item.meta ? `<div class="text-xs text-gray-500">${esc(item.meta)}</div>` : ''}
                      </div>
                      <div class="text-xs text-gray-400 mt-1 mr-1">${dateStr}</div>
                    </div>
                  </div>`;
                } else if (item.type === 'note') {
                  return `
                  <div class="flex gap-3 items-start">
                    <div class="w-8 h-8 rounded-full ${cfg.bg} ${cfg.text} flex items-center justify-center text-sm flex-shrink-0 mt-0.5">${cfg.icon}</div>
                    <div class="flex-1">
                      <div class="bg-yellow-50 border border-yellow-100 rounded-xl px-4 py-3">
                        <div class="text-xs font-medium text-yellow-700 mb-0.5">Note${item.meta ? ' · ' + esc(item.meta) : ''}</div>
                        <div class="text-sm text-gray-700 whitespace-pre-wrap">${esc(item.label)}</div>
                      </div>
                      <div class="text-xs text-gray-400 mt-1 ml-1">${dateStr}</div>
                    </div>
                  </div>`;
                } else {
                  return `
                  <div class="flex gap-2 items-center justify-center">
                    <div class="h-px bg-gray-200 flex-1"></div>
                    <span class="text-xs text-gray-400 px-2">${esc(item.label)} · ${dateStr}</span>
                    <div class="h-px bg-gray-200 flex-1"></div>
                  </div>`;
                }
              }).join('\n')
            }
          </div>
        </div>

        <!-- Compose area -->
        <div class="bg-white rounded-xl shadow-sm p-5">
          <!-- Tabs -->
          <div class="flex gap-1 mb-4 border-b">
            <button onclick="showTab('email')" id="tab-email"
              class="px-4 py-2 text-sm font-medium border-b-2 border-blue-600 text-blue-600 -mb-px">
              Reply via Email
            </button>
            <button onclick="showTab('note')" id="tab-note"
              class="px-4 py-2 text-sm font-medium border-b-2 border-transparent text-gray-500 hover:text-gray-700 -mb-px">
              Add Note
            </button>
          </div>

          <!-- Email compose -->
          <div id="pane-email">
            <div class="mb-3">
              <label class="block text-xs font-medium text-gray-500 mb-1">To</label>
              <div class="text-sm text-gray-700 bg-gray-50 border rounded-lg px-3 py-2">${esc(lead.email)}</div>
            </div>
            <div class="mb-3">
              <label class="block text-xs font-medium text-gray-500 mb-1">Subject</label>
              <input type="text" id="reply-subject" value="${esc(replySubjectDefault)}"
                class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            </div>
            <div class="mb-3">
              <label class="block text-xs font-medium text-gray-500 mb-1">Message</label>
              <textarea id="reply-body" rows="5" placeholder="Type your reply…"
                class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"></textarea>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-xs text-gray-400">Sends from ${esc(process.env.SES_FROM_EMAIL || 'sales@suresecured.com')}</span>
              <button onclick="sendReply(${leadId})" id="reply-btn"
                class="bg-blue-600 text-white text-sm px-5 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                Send Reply
              </button>
            </div>
            <div id="reply-status" class="mt-2 text-sm hidden"></div>
          </div>

          <!-- Note pane -->
          <div id="pane-note" class="hidden">
            <textarea id="note-text" rows="4" placeholder="Add a note about this lead…"
              class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none mb-3"></textarea>
            <div class="flex justify-end">
              <button onclick="addNote(${leadId})"
                class="bg-gray-800 text-white text-sm px-5 py-2 rounded-lg hover:bg-gray-900">
                Save Note
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>

  <script>
    // Scroll conversation to bottom
    const conv = document.getElementById('conversation');
    if (conv) conv.scrollTop = conv.scrollHeight;

    function showTab(tab) {
      ['email','note'].forEach(t => {
        document.getElementById('pane-' + t).classList.toggle('hidden', t !== tab);
        const btn = document.getElementById('tab-' + t);
        if (t === tab) {
          btn.classList.add('border-blue-600','text-blue-600');
          btn.classList.remove('border-transparent','text-gray-500');
        } else {
          btn.classList.remove('border-blue-600','text-blue-600');
          btn.classList.add('border-transparent','text-gray-500');
        }
      });
    }

    async function setStage(leadId, stage) {
      const res = await fetch('/leads/' + leadId + '/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      if (!res.ok) { alert('Failed to update stage'); return; }
      document.querySelectorAll('.stage-btn').forEach(btn => {
        const s = btn.dataset.stage;
        const colors = ${JSON.stringify(Object.fromEntries(STAGES.map(s => [s, STAGE_LABELS[s].color])))};
        if (s === stage) {
          btn.classList.remove('border-transparent','bg-gray-50','text-gray-600','hover:bg-gray-100');
          btn.classList.add('border-blue-500', ...colors[s].split(' '));
        } else {
          btn.classList.remove('border-blue-500', ...colors[s].split(' '));
          btn.classList.add('border-transparent','bg-gray-50','text-gray-600','hover:bg-gray-100');
        }
      });
    }

    async function sendReply(leadId) {
      const subject = document.getElementById('reply-subject').value.trim();
      const body    = document.getElementById('reply-body').value.trim();
      if (!body) { alert('Message is required'); return; }
      const btn = document.getElementById('reply-btn');
      const status = document.getElementById('reply-status');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      status.classList.add('hidden');
      const res = await fetch('/leads/' + leadId + '/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body }),
      });
      const data = await res.json();
      btn.disabled = false;
      btn.textContent = 'Send Reply';
      status.classList.remove('hidden');
      if (res.ok) {
        status.textContent = 'Sent successfully.';
        status.className = 'mt-2 text-sm text-green-600';
        document.getElementById('reply-body').value = '';
        setTimeout(() => window.location.reload(), 1200);
      } else {
        status.textContent = 'Failed: ' + (data.error || 'unknown error');
        status.className = 'mt-2 text-sm text-red-600';
      }
    }

    async function unsuppress(leadId) {
      if (!confirm('Remove this lead from the suppression list?')) return;
      const res = await fetch('/leads/' + leadId + '/unsuppress', { method: 'POST' });
      if (res.ok) { window.location.reload(); }
      else { alert('Failed to unsuppress'); }
    }

    async function suppressLead(leadId) {
      const reason = prompt('Reason for suppression (manual / existing_customer / other):', 'manual');
      if (reason === null) return;
      const res = await fetch('/leads/' + leadId + '/suppress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || 'manual' }),
      });
      if (res.ok) { window.location.reload(); }
      else { alert('Failed to suppress lead'); }
    }

    async function enrollmentAction(enrollmentId, action) {
      const labels = { pause: 'Pause', resume: 'Resume', unenroll: 'Unenroll' };
      if (action === 'unenroll' && !confirm('Unenroll this lead from the sequence? This cannot be undone.')) return;
      const res = await fetch('/leads/enrollment/' + enrollmentId + '/' + action, { method: 'POST' });
      if (res.ok) { window.location.reload(); }
      else { alert(labels[action] + ' failed'); }
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

// ─── API: Suppress Lead ───────────────────────────────────────────────────────
router.post('/:id/suppress', requireAuth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  const reason = req.body.reason || 'manual';
  const { rows } = await pool.query('SELECT email FROM leads WHERE id = $1', [leadId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await pool.query(
    `INSERT INTO suppression_list (email, reason) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET reason = $2, added_at = NOW()`,
    [rows[0].email, reason]
  );
  // Pause any active enrollments
  await pool.query(
    `UPDATE contact_enrollments SET status = 'paused', paused_reason = 'suppressed'
     WHERE lead_id = $1 AND status = 'active'`,
    [leadId]
  );
  res.json({ ok: true });
});

// ─── API: Enrollment Actions (pause / resume / unenroll) ──────────────────────
router.post('/enrollment/:enrollmentId/pause', requireAuth, async (req, res) => {
  const id = parseInt(req.params.enrollmentId);
  await pool.query(
    `UPDATE contact_enrollments SET status = 'paused', paused_reason = 'manual' WHERE id = $1`,
    [id]
  );
  res.json({ ok: true });
});

router.post('/enrollment/:enrollmentId/resume', requireAuth, async (req, res) => {
  const id = parseInt(req.params.enrollmentId);
  // Check lead is not suppressed before resuming
  const { rows } = await pool.query(
    `SELECT l.email, l.unsubscribed FROM leads l
     JOIN contact_enrollments ce ON ce.lead_id = l.id WHERE ce.id = $1`,
    [id]
  );
  const lead = rows[0];
  if (lead?.unsubscribed) return res.status(400).json({ error: 'Lead has unsubscribed' });
  if (lead) {
    const { rows: sup } = await pool.query(
      `SELECT 1 FROM suppression_list WHERE LOWER(email) = LOWER($1)`, [lead.email]
    );
    if (sup.length) return res.status(400).json({ error: 'Lead is suppressed' });
  }
  await pool.query(
    `UPDATE contact_enrollments SET status = 'active', paused_reason = NULL WHERE id = $1`,
    [id]
  );
  res.json({ ok: true });
});

router.post('/enrollment/:enrollmentId/unenroll', requireAuth, async (req, res) => {
  const id = parseInt(req.params.enrollmentId);
  await pool.query(
    `UPDATE contact_enrollments SET status = 'cancelled', paused_reason = 'manual_unenroll' WHERE id = $1`,
    [id]
  );
  res.json({ ok: true });
});

// ─── API: Unsuppress Lead ─────────────────────────────────────────────────────
router.post('/:id/unsuppress', requireAuth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  const { rows } = await pool.query('SELECT email FROM leads WHERE id = $1', [leadId]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await pool.query('DELETE FROM suppression_list WHERE LOWER(email) = LOWER($1)', [rows[0].email]);
  res.json({ ok: true });
});

// ─── API: Send Reply Email ────────────────────────────────────────────────────
router.post('/:id/reply', requireAuth, async (req, res) => {
  const leadId = parseInt(req.params.id);
  const { subject, body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Body required' });

  const { rows: leads } = await pool.query(
    'SELECT first_name, last_name, email FROM leads WHERE id = $1', [leadId]
  );
  const lead = leads[0];
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  // Resolve clientId — admin users may have null client_id in JWT
  let clientId = req.user?.client_id;
  if (!clientId) {
    const { rows: cr } = await pool.query('SELECT id FROM clients ORDER BY id LIMIT 1');
    clientId = cr[0]?.id || null;
  }

  try {
    const result = await sendDirectEmail({
      fromName:      process.env.SES_FROM_NAME  || 'Sales',
      fromAddress:   process.env.SES_FROM_EMAIL || process.env.SES_SMTP_USER,
      to:            lead.email,
      subject:       subject?.trim() || `Re: Following up`,
      textBody:      body.trim(),
      htmlBody:      `<div style="font-family:sans-serif;font-size:15px;line-height:1.6;color:#222">${body.trim().replace(/\n/g,'<br>')}</div>`,
      salespersonId: req.user?.id,
      clientId,
    });

    // Store Gmail thread ID so cron can detect replies to this direct email
    if (result.threadId) {
      await pool.query(
        `UPDATE leads SET direct_email_thread_id = $1, direct_email_salesperson_id = $2 WHERE id = $3`,
        [result.threadId, req.user?.id, leadId]
      );
    }

    const user = req.user;
    await pool.query(
      `INSERT INTO lead_notes (lead_id, author_name, content) VALUES ($1, $2, $3)`,
      [leadId, user?.name || user?.email || 'Rep', `[Email sent] ${subject?.trim() || ''}\n\n${body.trim()}`]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[reply] send failed:', err.message);
    res.status(500).json({ error: err.message });
  }
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
