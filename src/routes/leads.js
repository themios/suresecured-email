// src/routes/leads.js  — CRM leads list + lead detail view
const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { shell, ICONS, esc } = require('../lib/layout');
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
  const replied  = req.query.replied || '';
  const urgency  = req.query.urgency || '';
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
  if (replied) {
    where.push(`l.reply_classified_at IS NOT NULL`);
  }
  if (urgency) {
    params.push(urgency);
    where.push(`l.reply_urgency = $${params.length}`);
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

  const content = `
  <div class="px-6 py-8 max-w-7xl mx-auto">

    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold text-slate-900">Leads</h1>
        <p class="text-sm text-slate-500 mt-0.5">
          ${totalCount.toLocaleString()} ${replied ? 'replied' : urgency ? esc(urgency) + '-urgency' : 'total'} contact${totalCount === 1 ? '' : 's'}
          ${(replied || urgency) ? `<a href="/leads" class="text-sky-600 hover:text-sky-700 ml-2 font-medium">Clear filter</a>` : ''}
        </p>
      </div>
    </div>

    <!-- Stage Filter + Search -->
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-4 mb-4">
      <div class="flex flex-wrap gap-2 items-center">
        <a href="/leads${search ? '?search=' + encodeURIComponent(search) : ''}"
           class="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${!stage ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">
          All <span class="ml-1 opacity-70">${allCount}</span>
        </a>
        ${STAGES.map(s => {
          const info  = STAGE_LABELS[s];
          const active = stage === s;
          const qs    = new URLSearchParams({ stage: s, ...(search ? { search } : {}) }).toString();
          return `<a href="/leads?${qs}"
            class="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${active ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}">
            ${info.label} <span class="ml-1 opacity-70">${stageCounts[s]}</span>
          </a>`;
        }).join('')}

        <form method="GET" action="/leads" class="ml-auto flex gap-2">
          ${stage ? `<input type="hidden" name="stage" value="${stage}">` : ''}
          <div class="relative">
            <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4">${ICONS.search}</span>
            <input type="text" name="search" value="${esc(search)}"
              placeholder="Search name, email, phone…"
              class="border border-slate-200 rounded-lg pl-9 pr-3 py-1.5 text-sm w-60 focus:outline-none focus:ring-2 focus:ring-sky-500">
          </div>
          <button type="submit" class="bg-sky-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-sky-700 transition-colors">Search</button>
          ${search ? `<a href="/leads${stage ? '?stage=' + stage : ''}" class="text-sm text-slate-400 hover:text-slate-600 py-1.5">Clear</a>` : ''}
        </form>
      </div>
    </div>

    <!-- Leads Table -->
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
      <table class="w-full text-sm data-table">
        <thead class="bg-slate-50 border-b border-slate-100">
          <tr class="text-left text-slate-500 text-xs uppercase tracking-wider">
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
        <tbody class="divide-y divide-slate-100">
          ${leads.length === 0 ? `
            <tr><td colspan="8" class="px-4 py-12 text-center text-slate-400">No leads found</td></tr>
          ` : leads.map(l => {
            const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || '—';
            const stageInfo = STAGE_LABELS[l.stage] || STAGE_LABELS.new;
            const replyBadge = l.reply_category
              ? `<span class="px-2 py-0.5 rounded-full text-xs font-medium ${l.reply_urgency === 'high' ? 'bg-red-100 text-red-700' : 'bg-indigo-100 text-indigo-700'}">${l.reply_category.replace('_', ' ')}</span>`
              : '<span class="text-slate-300">—</span>';
            const date = new Date(l.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return `
            <tr class="hover:bg-slate-50 transition-colors cursor-pointer" onclick="window.location='/leads/${l.id}'">
              <td class="px-4 py-3">
                <div class="font-semibold text-slate-900">${esc(name)}</div>
                <div class="text-xs text-slate-400">${esc(l.city || '')} ${l.audience_type ? '· ' + esc(l.audience_type) : ''}</div>
              </td>
              <td class="px-4 py-3">
                <div class="text-slate-700">${esc(l.email || '—')}</div>
                <div class="text-slate-400 text-xs">${esc(l.phone || '')}</div>
              </td>
              <td class="px-4 py-3">
                <span class="px-2 py-0.5 rounded-full text-xs font-medium ${stageInfo.color}">${stageInfo.label}</span>
              </td>
              <td class="px-4 py-3">
                ${l.sequence_name
                  ? `<div class="text-slate-700 text-xs">${esc(l.sequence_name)}</div><div class="text-xs text-slate-400">Step ${l.current_step}</div>`
                  : '<span class="text-slate-300">—</span>'}
              </td>
              <td class="px-4 py-3 text-slate-600 text-xs">${esc(l.salesperson_name || '—')}</td>
              <td class="px-4 py-3">${replyBadge}</td>
              <td class="px-4 py-3 text-slate-400 text-xs">${date}</td>
              <td class="px-4 py-3">
                <a href="/leads/${l.id}" class="text-sky-600 hover:text-sky-700 text-xs font-medium flex items-center gap-1" onclick="event.stopPropagation()">
                  View ${ICONS.chevronright}
                </a>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>

      ${totalPages > 1 ? `
      <div class="px-4 py-3 border-t border-slate-100 flex justify-between items-center text-sm text-slate-500">
        <span>Page ${page} of ${totalPages}</span>
        <div class="flex gap-2">
          ${page > 1 ? `<a href="?${new URLSearchParams({ ...(stage ? { stage } : {}), ...(search ? { search } : {}), ...(replied ? { replied } : {}), ...(urgency ? { urgency } : {}), page: page - 1 }).toString()}" class="px-3 py-1 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">&larr; Prev</a>` : ''}
          ${page < totalPages ? `<a href="?${new URLSearchParams({ ...(stage ? { stage } : {}), ...(search ? { search } : {}), ...(replied ? { replied } : {}), ...(urgency ? { urgency } : {}), page: page + 1 }).toString()}" class="px-3 py-1 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">Next &rarr;</a>` : ''}
        </div>
      </div>` : ''}
    </div>

  </div>`;

  res.send(shell('Leads', 'leads', content, { user: req.user }));
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

  const enrollments  = enrollmentsResult.rows;
  const emailSends   = emailSendsResult.rows;
  const callLogs     = callLogsResult.rows;
  const notes        = notesResult.rows;
  const smsMessages  = smsResult.rows;
  const suppressed   = suppressedResult.rows[0] || null;

  const name      = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unnamed Lead';
  const stageInfo = STAGE_LABELS[lead.stage] || STAGE_LABELS.new;

  const lastEmailSubject = emailSends.length
    ? emailSends[emailSends.length - 1].step_subject || emailSends[emailSends.length - 1].subject || ''
    : '';
  const replySubjectDefault = lastEmailSubject.startsWith('Re:') ? lastEmailSubject : `Re: ${lastEmailSubject}`;

  // Build unified activity timeline
  const timeline = [
    ...emailSends.map(e => ({
      type: 'email_out', date: new Date(e.sent_at),
      label: e.step_subject || e.subject || ('Step ' + e.step_number),
      meta: e.opened_at
        ? `Opened ${new Date(e.opened_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : (e.status === 'failed' ? 'Failed to send' : 'Delivered'),
      from: 'Sales', to: lead.email,
    })),
    ...smsMessages.map(s => ({
      type: s.direction === 'inbound' ? 'sms_in' : 'sms_out',
      date: new Date(s.sent_at), label: s.body || '', meta: '',
      from: s.direction === 'inbound' ? (lead.phone || 'Lead') : 'Sales',
      to:   s.direction === 'inbound' ? 'Sales' : (lead.phone || 'Lead'),
    })),
    ...callLogs.map(c => ({
      type: 'call', date: new Date(c.created_at),
      label: `Call${c.salesperson_name ? ' with ' + c.salesperson_name : ''}`,
      meta: `${Math.round((c.duration_seconds || 0) / 60)}m ${(c.duration_seconds || 0) % 60}s`,
      from: lead.phone || 'Lead', to: '',
    })),
    ...notes.map(n => ({
      type: 'note', date: new Date(n.created_at),
      label: n.content, meta: n.author_name ? 'by ' + n.author_name : '',
      from: n.author_name || 'Rep', to: '',
    })),
    ...enrollments.map(e => ({
      type: 'enroll', date: new Date(e.enrolled_at),
      label: `Enrolled in "${e.sequence_name}"`,
      meta: '', from: '', to: '',
    })),
  ];

  if (lead.reply_classified_at || lead.reply_text) {
    timeline.push({
      type: 'email_in',
      date: lead.reply_classified_at ? new Date(lead.reply_classified_at) : new Date(),
      label: lead.reply_text || '(reply)',
      meta: lead.reply_subject || '',
      from: lead.email, to: 'Sales',
    });
  }

  timeline.sort((a, b) => a.date - b.date);

  // SVG icon + color per timeline event type
  const typeConfig = {
    email_out: { icon: ICONS.send,      bg: 'bg-sky-100',     text: 'text-sky-600',     badge: 'Sent',     badgeCls: 'bg-sky-50 text-sky-600' },
    email_in:  { icon: ICONS.inbox,     bg: 'bg-emerald-100', text: 'text-emerald-600', badge: 'Received', badgeCls: 'bg-emerald-50 text-emerald-600' },
    sms_out:   { icon: ICONS.msgsquare, bg: 'bg-sky-100',     text: 'text-sky-600',     badge: 'SMS Out',  badgeCls: 'bg-sky-50 text-sky-600' },
    sms_in:    { icon: ICONS.msgsquare, bg: 'bg-emerald-100', text: 'text-emerald-600', badge: 'SMS In',   badgeCls: 'bg-emerald-50 text-emerald-600' },
    call:      { icon: ICONS.phonesm,   bg: 'bg-violet-100',  text: 'text-violet-600',  badge: 'Call',     badgeCls: 'bg-violet-50 text-violet-600' },
    note:      { icon: ICONS.pencil,    bg: 'bg-amber-100',   text: 'text-amber-700',   badge: 'Note',     badgeCls: 'bg-amber-50 text-amber-700' },
    enroll:    { icon: ICONS.playsm,    bg: 'bg-slate-100',   text: 'text-slate-600',   badge: 'Enrolled', badgeCls: 'bg-slate-50 text-slate-500' },
  };

  const content = `
  <div class="px-6 py-6 max-w-6xl mx-auto">

    <a href="/leads" class="text-sm text-slate-400 hover:text-slate-600 mb-4 inline-flex items-center gap-1.5 transition-colors">
      ${ICONS.arrowleft} Back to Leads
    </a>

    <div class="grid grid-cols-12 gap-5">

      <!-- LEFT SIDEBAR -->
      <div class="col-span-3 space-y-4">

        <!-- Contact card -->
        <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-4">
          <div class="flex items-center gap-3 mb-4">
            <div class="w-11 h-11 rounded-full bg-sky-100 text-sky-700 flex items-center justify-center text-base font-bold flex-shrink-0">
              ${esc((lead.first_name?.[0] || '?').toUpperCase())}
            </div>
            <div>
              <div class="font-bold text-slate-900 text-sm">${esc(name)}</div>
              <span class="px-2 py-0.5 rounded-full text-xs font-medium ${stageInfo.color}">${stageInfo.label}</span>
            </div>
          </div>
          <div class="space-y-1.5 text-xs">
            ${lead.email   ? `<div class="flex gap-1.5"><span class="text-slate-400 w-14 flex-shrink-0">Email</span><span class="text-slate-700 break-all">${esc(lead.email)}</span></div>` : ''}
            ${lead.phone   ? `<div class="flex gap-1.5"><span class="text-slate-400 w-14 flex-shrink-0">Phone</span><span class="text-slate-700">${esc(lead.phone)}</span></div>` : ''}
            ${lead.city    ? `<div class="flex gap-1.5"><span class="text-slate-400 w-14 flex-shrink-0">City</span><span class="text-slate-700">${esc(lead.city)}</span></div>` : ''}
            ${lead.audience_type    ? `<div class="flex gap-1.5"><span class="text-slate-400 w-14 flex-shrink-0">Type</span><span class="text-slate-700">${esc(lead.audience_type)}</span></div>` : ''}
            ${lead.product_interest ? `<div class="flex gap-1.5"><span class="text-slate-400 w-14 flex-shrink-0">Interest</span><span class="text-slate-700">${esc(lead.product_interest)}</span></div>` : ''}
            ${lead.salesperson_name ? `<div class="flex gap-1.5"><span class="text-slate-400 w-14 flex-shrink-0">Rep</span><span class="text-slate-700">${esc(lead.salesperson_name)}</span></div>` : ''}
            <div class="flex gap-1.5"><span class="text-slate-400 w-14 flex-shrink-0">Added</span><span class="text-slate-700">${new Date(lead.created_at).toLocaleDateString()}</span></div>
          </div>
        </div>

        <!-- Suppression warning -->
        ${suppressed ? `
        <div class="rounded-xl border border-red-200 bg-red-50 p-4">
          <div class="flex items-start gap-2">
            <span class="text-red-500 flex-shrink-0 mt-0.5">${ICONS.ban}</span>
            <div class="flex-1">
              <div class="text-xs font-semibold text-red-700 uppercase tracking-wide mb-0.5">Suppressed</div>
              <div class="text-xs text-red-600">${esc(suppressed.reason || 'manual')} &middot; ${new Date(suppressed.added_at).toLocaleDateString()}</div>
              ${suppressed.reason === 'unsubscribed'
                ? `<div class="text-xs text-red-500 mt-1 font-medium">Customer unsubscribed &mdash; do not re-enroll.</div>`
                : `<button onclick="unsuppress(${leadId})"
                    class="mt-2 text-xs bg-white border border-red-300 text-red-700 px-3 py-1 rounded-lg hover:bg-red-100 transition-colors">
                    Remove from suppression list
                  </button>`}
            </div>
          </div>
        </div>` : ''}

        <!-- Pipeline Stage -->
        <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-4">
          <h3 class="font-semibold text-slate-500 text-xs uppercase tracking-widest mb-2">Pipeline Stage</h3>
          <div class="flex flex-col gap-1" id="stage-buttons">
            ${STAGES.map(s => {
              const info   = STAGE_LABELS[s];
              const active = lead.stage === s;
              return `<button onclick="setStage(${leadId}, '${s}')"
                class="stage-btn w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors
                  ${active ? 'border-sky-500 ' + info.color : 'border-transparent bg-slate-50 text-slate-600 hover:bg-slate-100'}"
                data-stage="${s}">${info.label}</button>`;
            }).join('')}
          </div>
        </div>

        <!-- Reply intel -->
        ${lead.reply_category ? `
        <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-4">
          <h3 class="font-semibold text-slate-500 text-xs uppercase tracking-widest mb-2">Reply Intel</h3>
          <div class="space-y-1.5 text-xs">
            <div class="flex gap-1.5"><span class="text-slate-400 w-14">Category</span>
              <span class="font-medium text-slate-700">${esc(lead.reply_category.replace(/_/g,' '))}</span></div>
            <div class="flex gap-1.5"><span class="text-slate-400 w-14">Urgency</span>
              <span class="px-1.5 py-0.5 rounded text-xs font-medium ${lead.reply_urgency === 'high' ? 'bg-red-100 text-red-700' : lead.reply_urgency === 'low' ? 'bg-slate-100 text-slate-600' : 'bg-amber-100 text-amber-700'}">${esc(lead.reply_urgency || 'medium')}</span></div>
            ${lead.reply_summary ? `<div class="text-slate-600 mt-1 leading-relaxed">${esc(lead.reply_summary)}</div>` : ''}
          </div>
        </div>` : ''}

        <!-- Enrollment & Suppression Controls -->
        <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-4">
          <h3 class="font-semibold text-slate-500 text-xs uppercase tracking-widest mb-3">Email Sequences</h3>

          ${enrollments.length === 0
            ? `<p class="text-xs text-slate-400">Not enrolled in any sequence.</p>`
            : enrollments.map(e => `
            <div class="border border-slate-100 rounded-lg p-2.5 mb-2 last:mb-0">
              <div class="font-medium text-slate-800 text-xs mb-0.5">${esc(e.sequence_name)}</div>
              <div class="text-xs text-slate-400 mb-2">
                Step ${e.current_step}
                &middot; <span class="${e.status === 'active' ? 'text-emerald-600 font-medium' : e.status === 'paused' ? 'text-amber-600 font-medium' : 'text-slate-400'}">${e.status}</span>
                ${e.paused_reason ? ` &middot; ${esc(e.paused_reason)}` : ''}
              </div>
              <div class="flex gap-1.5 flex-wrap">
                ${e.status === 'active' ? `
                  <button onclick="enrollmentAction(${e.id}, 'pause')"
                    class="text-xs px-2.5 py-1 rounded-lg border border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors">
                    Pause
                  </button>` : ''}
                ${e.status === 'paused' ? `
                  <button onclick="enrollmentAction(${e.id}, 'resume')"
                    class="text-xs px-2.5 py-1 rounded-lg border border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-colors">
                    Resume
                  </button>` : ''}
                ${e.status !== 'completed' ? `
                  <button onclick="enrollmentAction(${e.id}, 'unenroll')"
                    class="text-xs px-2.5 py-1 rounded-lg border border-slate-200 text-slate-500 bg-slate-50 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors">
                    Unenroll
                  </button>` : ''}
              </div>
            </div>`).join('')}

          <div class="mt-3 pt-3 border-t border-slate-100">
            ${lead.unsubscribed
              ? `<div class="text-xs text-red-500 font-medium flex items-center gap-1.5">
                   ${ICONS.ban} Unsubscribed ${lead.unsubscribed_at ? '· ' + new Date(lead.unsubscribed_at).toLocaleDateString() : ''}
                 </div>`
              : suppressed
                ? `<div class="flex items-center justify-between">
                     <span class="text-xs text-amber-600 font-medium flex items-center gap-1">
                       ${ICONS.warning} Suppressed (${esc(suppressed.reason || 'manual')})
                     </span>
                     <button onclick="unsuppress(${leadId})"
                       class="text-xs px-2.5 py-1 rounded-lg border border-sky-200 text-sky-600 bg-sky-50 hover:bg-sky-100 transition-colors">
                       Unsuppress
                     </button>
                   </div>`
                : `<button onclick="suppressLead(${leadId})"
                     class="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-500 bg-slate-50 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors text-left flex items-center gap-1.5">
                     ${ICONS.warning} Suppress this lead
                   </button>`}
          </div>
        </div>

      </div>

      <!-- MAIN: Conversation + Compose -->
      <div class="col-span-9 flex flex-col gap-4">

        <!-- Conversation thread -->
        <div class="bg-white rounded-xl shadow-sm border border-slate-100 flex flex-col" style="min-height:400px">
          <div class="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
            <h2 class="font-semibold text-slate-800 text-sm">Conversation</h2>
            <span class="text-xs text-slate-400">${timeline.length} events</span>
          </div>

          <div class="flex-1 overflow-y-auto p-5 space-y-4" id="conversation">
            ${timeline.length === 0 ? '<p class="text-slate-400 text-sm text-center py-8">No activity yet.</p>' :
              timeline.map(item => {
                const cfg       = typeConfig[item.type] || typeConfig.note;
                const isInbound = item.type === 'email_in' || item.type === 'sms_in';
                const isOutbound = item.type === 'email_out' || item.type === 'sms_out';
                const dateStr   = item.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                  + ' ' + item.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

                if (isInbound) {
                  return `
                  <div class="flex gap-3 items-start">
                    <div class="w-8 h-8 rounded-full ${cfg.bg} ${cfg.text} flex items-center justify-center flex-shrink-0 mt-0.5">${cfg.icon}</div>
                    <div class="flex-1">
                      <div class="bg-emerald-50 border border-emerald-100 rounded-2xl rounded-tl-sm px-4 py-3 max-w-xl">
                        ${item.meta ? `<div class="text-xs text-slate-400 mb-1">${esc(item.meta)}</div>` : ''}
                        <div class="text-sm text-slate-800 whitespace-pre-wrap">${esc(item.label)}</div>
                      </div>
                      <div class="text-xs text-slate-400 mt-1 ml-1">${esc(item.from)} · ${dateStr}</div>
                    </div>
                  </div>`;
                } else if (isOutbound) {
                  return `
                  <div class="flex gap-3 items-start flex-row-reverse">
                    <div class="w-8 h-8 rounded-full ${cfg.bg} ${cfg.text} flex items-center justify-center flex-shrink-0 mt-0.5">${cfg.icon}</div>
                    <div class="flex-1 flex flex-col items-end">
                      <div class="bg-sky-50 border border-sky-100 rounded-2xl rounded-tr-sm px-4 py-3 max-w-xl">
                        <div class="text-xs font-medium text-sky-700 mb-1">${esc(item.label)}</div>
                        ${item.meta ? `<div class="text-xs text-slate-500">${esc(item.meta)}</div>` : ''}
                      </div>
                      <div class="text-xs text-slate-400 mt-1 mr-1">${dateStr}</div>
                    </div>
                  </div>`;
                } else if (item.type === 'note') {
                  return `
                  <div class="flex gap-3 items-start">
                    <div class="w-8 h-8 rounded-full ${cfg.bg} ${cfg.text} flex items-center justify-center flex-shrink-0 mt-0.5">${cfg.icon}</div>
                    <div class="flex-1">
                      <div class="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3">
                        <div class="text-xs font-medium text-amber-700 mb-0.5">Note${item.meta ? ' · ' + esc(item.meta) : ''}</div>
                        <div class="text-sm text-slate-700 whitespace-pre-wrap">${esc(item.label)}</div>
                      </div>
                      <div class="text-xs text-slate-400 mt-1 ml-1">${dateStr}</div>
                    </div>
                  </div>`;
                } else {
                  return `
                  <div class="flex gap-2 items-center justify-center">
                    <div class="h-px bg-slate-200 flex-1"></div>
                    <span class="text-xs text-slate-400 px-2">${esc(item.label)} · ${dateStr}</span>
                    <div class="h-px bg-slate-200 flex-1"></div>
                  </div>`;
                }
              }).join('\n')
            }
          </div>
        </div>

        <!-- Compose area -->
        <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-5">
          <div class="flex gap-1 mb-4 border-b border-slate-100">
            <button onclick="showTab('email')" id="tab-email"
              class="px-4 py-2 text-sm font-medium border-b-2 border-sky-600 text-sky-600 -mb-px">
              Reply via Email
            </button>
            <button onclick="showTab('note')" id="tab-note"
              class="px-4 py-2 text-sm font-medium border-b-2 border-transparent text-slate-500 hover:text-slate-700 -mb-px transition-colors">
              Add Note
            </button>
          </div>

          <div id="pane-email">
            <div class="mb-3">
              <label class="block text-xs font-medium text-slate-500 mb-1">To</label>
              <div class="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">${esc(lead.email)}</div>
            </div>
            <div class="mb-3">
              <label class="block text-xs font-medium text-slate-500 mb-1">Subject</label>
              <input type="text" id="reply-subject" value="${esc(replySubjectDefault)}"
                class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            </div>
            <div class="mb-3">
              <label class="block text-xs font-medium text-slate-500 mb-1">Message</label>
              <textarea id="reply-body" rows="5" placeholder="Type your reply…"
                class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 resize-none"></textarea>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-xs text-slate-400">Sends from ${esc(process.env.SES_FROM_EMAIL || 'sales@suresecured.com')}</span>
              <button onclick="sendReply(${leadId})" id="reply-btn"
                class="bg-sky-600 text-white text-sm px-5 py-2 rounded-lg hover:bg-sky-700 transition-colors disabled:opacity-50">
                Send Reply
              </button>
            </div>
          </div>

          <div id="pane-note" class="hidden">
            <textarea id="note-text" rows="4" placeholder="Add a note about this lead…"
              class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 resize-none mb-3"></textarea>
            <div class="flex justify-end">
              <button onclick="addNote(${leadId})"
                class="bg-slate-800 text-white text-sm px-5 py-2 rounded-lg hover:bg-slate-900 transition-colors">
                Save Note
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>

  <script>
    const conv = document.getElementById('conversation');
    if (conv) conv.scrollTop = conv.scrollHeight;

    function showTab(tab) {
      ['email','note'].forEach(t => {
        document.getElementById('pane-' + t).classList.toggle('hidden', t !== tab);
        const btn = document.getElementById('tab-' + t);
        if (t === tab) {
          btn.classList.add('border-sky-600','text-sky-600');
          btn.classList.remove('border-transparent','text-slate-500');
        } else {
          btn.classList.remove('border-sky-600','text-sky-600');
          btn.classList.add('border-transparent','text-slate-500');
        }
      });
    }

    async function setStage(leadId, stage) {
      const res = await fetch('/leads/' + leadId + '/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      });
      if (!res.ok) { showToast('Failed to update stage', 'error'); return; }
      document.querySelectorAll('.stage-btn').forEach(btn => {
        const s      = btn.dataset.stage;
        const colors = ${JSON.stringify(Object.fromEntries(STAGES.map(s => [s, STAGE_LABELS[s].color])))};
        if (s === stage) {
          btn.classList.remove('border-transparent','bg-slate-50','text-slate-600','hover:bg-slate-100');
          btn.classList.add('border-sky-500', ...colors[s].split(' '));
        } else {
          btn.classList.remove('border-sky-500', ...colors[s].split(' '));
          btn.classList.add('border-transparent','bg-slate-50','text-slate-600','hover:bg-slate-100');
        }
      });
      showToast('Stage updated', 'success', 2000);
    }

    async function sendReply(leadId) {
      const subject = document.getElementById('reply-subject').value.trim();
      const body    = document.getElementById('reply-body').value.trim();
      if (!body) { showToast('Message is required', 'error'); return; }
      const btn = document.getElementById('reply-btn');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      const res  = await fetch('/leads/' + leadId + '/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body }),
      });
      const data = await res.json();
      btn.disabled = false;
      btn.textContent = 'Send Reply';
      if (res.ok) {
        showToast('Email sent successfully', 'success');
        document.getElementById('reply-body').value = '';
        setTimeout(() => window.location.reload(), 1200);
      } else {
        showToast('Failed to send: ' + (data.error || 'unknown error'), 'error');
      }
    }

    async function unsuppress(leadId) {
      if (!await showConfirm('Remove this lead from the suppression list?', 'Confirm')) return;
      const res = await fetch('/leads/' + leadId + '/unsuppress', { method: 'POST' });
      if (res.ok) { window.location.reload(); }
      else { showToast('Failed to unsuppress', 'error'); }
    }

    async function suppressLead(leadId) {
      const reason = await showPrompt('Reason for suppression:', 'manual', 'Suppress Lead');
      if (reason === null) return;
      const res = await fetch('/leads/' + leadId + '/suppress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || 'manual' }),
      });
      if (res.ok) { window.location.reload(); }
      else { showToast('Failed to suppress lead', 'error'); }
    }

    async function enrollmentAction(enrollmentId, action) {
      if (action === 'unenroll') {
        const ok = await showDestruct('Unenroll this lead from the sequence? This cannot be undone.', 'Unenroll Lead', 'Unenroll');
        if (!ok) return;
      }
      const res = await fetch('/leads/enrollment/' + enrollmentId + '/' + action, { method: 'POST' });
      if (res.ok) { window.location.reload(); }
      else { showToast(action.charAt(0).toUpperCase() + action.slice(1) + ' failed', 'error'); }
    }

    async function addNote(leadId) {
      const text = document.getElementById('note-text').value.trim();
      if (!text) return;
      const res = await fetch('/leads/' + leadId + '/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok) { showToast('Failed to add note', 'error'); return; }
      window.location.reload();
    }
  </script>`;

  res.send(shell(name, 'leads', content, { user: req.user }));
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
    `UPDATE contact_enrollments SET status = 'paused', paused_reason = 'manual' WHERE id = $1`, [id]
  );
  res.json({ ok: true });
});

router.post('/enrollment/:enrollmentId/resume', requireAuth, async (req, res) => {
  const id = parseInt(req.params.enrollmentId);
  const { rows } = await pool.query(
    `SELECT l.email, l.unsubscribed FROM leads l
     JOIN contact_enrollments ce ON ce.lead_id = l.id WHERE ce.id = $1`, [id]
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
    `UPDATE contact_enrollments SET status = 'active', paused_reason = NULL WHERE id = $1`, [id]
  );
  res.json({ ok: true });
});

router.post('/enrollment/:enrollmentId/unenroll', requireAuth, async (req, res) => {
  const id = parseInt(req.params.enrollmentId);
  await pool.query(
    `UPDATE contact_enrollments SET status = 'cancelled', paused_reason = 'manual_unenroll' WHERE id = $1`, [id]
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

  let clientId = req.user?.client_id;
  if (!clientId) {
    const { rows: cr } = await pool.query('SELECT id FROM clients ORDER BY id LIMIT 1');
    clientId = cr[0]?.id || null;
  }

  try {
    const result = await sendDirectEmail({
      fromName:    process.env.SES_FROM_NAME  || 'Sales',
      fromAddress: process.env.SES_FROM_EMAIL || process.env.SES_SMTP_USER,
      to:          lead.email,
      subject:     subject?.trim() || `Re: Following up`,
      textBody:    body.trim(),
      htmlBody:    `<div style="font-family:sans-serif;font-size:15px;line-height:1.6;color:#222">${body.trim().replace(/\n/g,'<br>')}</div>`,
      salespersonId: req.user?.id,
      clientId,
    });

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
