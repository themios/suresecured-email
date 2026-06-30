const express  = require('express');
const router   = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { navHtml } = require('./analytics');

// ── API endpoints ──────────────────────────────────────────────────────────

// List sequences
router.get('/api/sequences', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, COUNT(ss.id) AS step_count
     FROM sequences s
     LEFT JOIN sequence_steps ss ON ss.sequence_id = s.id
     GROUP BY s.id ORDER BY s.created_at DESC`
  );
  res.json(rows);
});

// Get one sequence with steps
router.get('/api/sequences/:id', requireAuth, async (req, res) => {
  const [seq, steps] = await Promise.all([
    pool.query('SELECT * FROM sequences WHERE id = $1', [req.params.id]),
    pool.query('SELECT * FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_number', [req.params.id]),
  ]);
  if (!seq.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ ...seq.rows[0], steps: steps.rows });
});

// Create sequence
router.post('/api/sequences', requireAuth, async (req, res) => {
  const { name, description, audience_type } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO sequences (name, description, audience_type) VALUES ($1,$2,$3) RETURNING *`,
    [name, description, audience_type || 'B2C']
  );
  res.json(rows[0]);
});

// Update sequence
router.put('/api/sequences/:id', requireAuth, async (req, res) => {
  const { name, description, audience_type, active } = req.body;
  const { rows } = await pool.query(
    `UPDATE sequences SET name=$1, description=$2, audience_type=$3, active=$4 WHERE id=$5 RETURNING *`,
    [name, description, audience_type, active, req.params.id]
  );
  res.json(rows[0]);
});

// Delete sequence
router.delete('/api/sequences/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM sequences WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// Upsert a step
router.post('/api/sequences/:id/steps', requireAuth, async (req, res) => {
  const { step_number, delay_days, subject, body } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO sequence_steps (sequence_id, step_number, delay_days, subject, body)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (sequence_id, step_number) DO UPDATE
       SET delay_days=$3, subject=$4, body=$5
     RETURNING *`,
    [req.params.id, step_number, delay_days, subject, body]
  );
  res.json(rows[0]);
});

// Delete a step
router.delete('/api/sequences/:seqId/steps/:stepId', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM sequence_steps WHERE id = $1 AND sequence_id = $2',
    [req.params.stepId, req.params.seqId]);
  res.json({ ok: true });
});

// Enroll contacts in a sequence
router.post('/api/sequences/:id/enroll', requireAuth, async (req, res) => {
  const { salesperson_id, lead_ids } = req.body;
  if (!lead_ids?.length) return res.status(400).json({ error: 'No lead_ids provided' });

  // Get first step delay to set initial next_send_at
  const { rows: firstStep } = await pool.query(
    `SELECT delay_days FROM sequence_steps WHERE sequence_id = $1 AND step_number = 1`,
    [req.params.id]
  );
  const delayDays  = firstStep[0]?.delay_days ?? 0;
  const nextSendAt = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000).toISOString();

  let enrolled = 0, skipped = 0;
  for (const leadId of lead_ids) {
    try {
      await pool.query(
        `INSERT INTO contact_enrollments (lead_id, sequence_id, salesperson_id, next_send_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (lead_id, sequence_id) DO NOTHING`,
        [leadId, req.params.id, salesperson_id, nextSendAt]
      );
      enrolled++;
    } catch {
      skipped++;
    }
  }
  res.json({ ok: true, enrolled, skipped });
});

// List enrollments for a sequence
router.get('/api/sequences/:id/enrollments', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ce.*, l.email, l.first_name, l.last_name, s.name AS salesperson_name,
            (SELECT COUNT(*) FROM email_sends WHERE enrollment_id = ce.id) AS emails_sent
     FROM contact_enrollments ce
     JOIN leads l ON l.id = ce.lead_id
     JOIN salespeople s ON s.id = ce.salesperson_id
     WHERE ce.sequence_id = $1
     ORDER BY ce.enrolled_at DESC
     LIMIT 200`,
    [req.params.id]
  );
  res.json(rows);
});

// Pause/resume enrollment
router.post('/api/enrollments/:id/pause', requireAuth, async (req, res) => {
  await pool.query(
    `UPDATE contact_enrollments SET status = 'paused', paused_reason = 'manual' WHERE id = $1`,
    [req.params.id]
  );
  res.json({ ok: true });
});
router.post('/api/enrollments/:id/resume', requireAuth, async (req, res) => {
  await pool.query(
    `UPDATE contact_enrollments SET status = 'active', paused_reason = NULL WHERE id = $1`,
    [req.params.id]
  );
  res.json({ ok: true });
});

// Email account status for all salespeople
router.get('/api/email-accounts', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.id, s.name, ea.email AS gmail_email, ea.enabled, ea.last_error, ea.connected_at
     FROM salespeople s
     LEFT JOIN email_accounts ea ON ea.salesperson_id = s.id
     WHERE s.active = true
     ORDER BY s.name`
  );
  res.json(rows);
});

// Per-sequence deliverability report
// Join path: sequences → contact_enrollments → email_sends
// Scoped to req.user.client_id for multi-tenant isolation
router.get('/api/sequences/report', requireAuth, async (req, res) => {
  const clientId = req.user?.client_id || null;

  const { rows } = await pool.query(
    `SELECT
       seq.id            AS sequence_id,
       seq.name          AS sequence_name,
       COUNT(es.id)      AS total_sends,
       COUNT(es.id) FILTER (WHERE es.open_count  > 0)    AS opened_sends,
       COUNT(es.id) FILTER (WHERE es.click_count > 0)    AS clicked_sends,
       COUNT(es.id) FILTER (WHERE es.bounced = TRUE)     AS bounced_sends,
       ROUND(
         100.0 * COUNT(es.id) FILTER (WHERE es.open_count  > 0)
         / NULLIF(COUNT(es.id), 0), 1
       ) AS open_rate_pct,
       ROUND(
         100.0 * COUNT(es.id) FILTER (WHERE es.click_count > 0)
         / NULLIF(COUNT(es.id), 0), 1
       ) AS click_rate_pct,
       ROUND(
         100.0 * COUNT(es.id) FILTER (WHERE es.bounced = TRUE)
         / NULLIF(COUNT(es.id), 0), 1
       ) AS bounce_rate_pct
     FROM sequences seq
     LEFT JOIN contact_enrollments ce ON ce.sequence_id = seq.id
     LEFT JOIN email_sends es ON es.enrollment_id = ce.id
     WHERE seq.client_id = $1
     GROUP BY seq.id, seq.name
     ORDER BY seq.created_at DESC`,
    [clientId]
  );

  res.json(rows);
});

// Contact list for enrollment — all leads with suppression check
router.get('/api/leads/enrollable', requireAuth, async (req, res) => {
  const seqId = req.query.sequence_id;
  const { rows } = await pool.query(
    `SELECT l.id, l.email, l.first_name, l.last_name, l.city, l.audience_type, l.product_interest,
            s.name AS salesperson_name,
            EXISTS (
              SELECT 1 FROM contact_enrollments ce
              WHERE ce.lead_id = l.id AND ce.sequence_id = $1
            ) AS already_enrolled,
            EXISTS (
              SELECT 1 FROM suppression_list sl WHERE LOWER(sl.email) = LOWER(l.email)
            ) AS suppressed
     FROM leads l
     LEFT JOIN salespeople s ON s.id = l.salesperson_id
     ORDER BY l.created_at DESC
     LIMIT 500`,
    [seqId || 0]
  );
  res.json(rows);
});

// CSV import of leads
router.post('/api/leads/import', requireAuth, express.text({ type: 'text/csv', limit: '10mb' }), async (req, res) => {
  const lines = req.body.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: 'Empty CSV' });

  // Auto-detect header
  const header = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g, ''));
  const idx = (name) => header.indexOf(name);

  const emailIdx   = idx('email');
  const firstIdx   = idx('first_name') >= 0 ? idx('first_name') : idx('first name');
  const lastIdx    = idx('last_name')  >= 0 ? idx('last_name')  : idx('last name');
  const phoneIdx   = idx('phone');
  const cityIdx    = idx('city');
  const typeIdx    = idx('audience_type') >= 0 ? idx('audience_type') : idx('type');
  const productIdx = idx('product_interest') >= 0 ? idx('product_interest') : idx('product');

  if (emailIdx < 0) return res.status(400).json({ error: 'CSV must have an "email" column' });

  let imported = 0, skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const email = cols[emailIdx];
    if (!email || !email.includes('@')) { skipped++; continue; }

    try {
      await pool.query(
        `INSERT INTO leads (email, first_name, last_name, phone, city, audience_type, product_interest)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [
          email.toLowerCase(),
          firstIdx   >= 0 ? cols[firstIdx]   : null,
          lastIdx    >= 0 ? cols[lastIdx]     : null,
          phoneIdx   >= 0 ? cols[phoneIdx]    : null,
          cityIdx    >= 0 ? cols[cityIdx]     : null,
          typeIdx    >= 0 ? (cols[typeIdx] || 'B2C') : 'B2C',
          productIdx >= 0 ? cols[productIdx]  : null,
        ]
      );
      imported++;
    } catch { skipped++; }
  }
  res.json({ ok: true, imported, skipped });
});

// ── Sequences UI page ──────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  const [seqRows, spRows] = await Promise.all([
    pool.query(`SELECT s.*, COUNT(ss.id) AS step_count,
                  COUNT(ce.id) FILTER (WHERE ce.status='active') AS active_enrollments
                FROM sequences s
                LEFT JOIN sequence_steps ss ON ss.sequence_id = s.id
                LEFT JOIN contact_enrollments ce ON ce.sequence_id = s.id
                GROUP BY s.id ORDER BY s.created_at DESC`),
    pool.query('SELECT s.id, s.name, ea.email AS gmail_email, ea.enabled, ea.last_error FROM salespeople s LEFT JOIN email_accounts ea ON ea.salesperson_id = s.id WHERE s.active = true ORDER BY s.name'),
  ]);

  const sequences  = seqRows.rows;
  const salespeople = spRows.rows;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sequences – SureSecured</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 min-h-screen">
  ${navHtml('sequences')}

  <div class="max-w-7xl mx-auto px-4 py-8">

    <!-- Gmail Connections -->
    <div class="bg-white rounded-xl shadow-sm p-6 mb-6">
      <div class="flex justify-between items-center mb-4">
        <h2 class="font-semibold text-gray-700">Gmail Connections</h2>
        <span class="text-xs text-gray-400">Each salesperson sends from their own Google Workspace inbox</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-gray-500 border-b">
            <th class="pb-2">Salesperson</th><th class="pb-2">Gmail Account</th>
            <th class="pb-2">Status</th><th class="pb-2">Action</th>
          </tr></thead>
          <tbody>
            ${salespeople.map(sp => `
            <tr class="border-b last:border-0">
              <td class="py-2 font-medium">${sp.name}</td>
              <td class="py-2 text-gray-600">${sp.gmail_email || '<span class="text-gray-400 italic">Not connected</span>'}</td>
              <td class="py-2">
                ${sp.gmail_email && sp.enabled
                  ? '<span class="text-green-600 font-medium">● Connected</span>'
                  : sp.last_error
                    ? '<span class="text-red-500 text-xs">● Error</span>'
                    : '<span class="text-gray-400">○ Not connected</span>'}
              </td>
              <td class="py-2">
                ${sp.gmail_email
                  ? '<button onclick="disconnectGmail(' + sp.id + ')" class="text-xs text-red-500 hover:underline">Disconnect</button>'
                  : '<a href="/gmail/connect/' + sp.id + '" class="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700">Connect Gmail</a>'}
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Sequences -->
    <div class="bg-white rounded-xl shadow-sm p-6 mb-6">
      <div class="flex justify-between items-center mb-4">
        <h2 class="font-semibold text-gray-700">Email Sequences</h2>
        <button onclick="showCreateSeq()" class="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700">+ New Sequence</button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-gray-500 border-b">
            <th class="pb-2">Name</th><th class="pb-2">Audience</th>
            <th class="pb-2">Steps</th><th class="pb-2">Active Contacts</th>
            <th class="pb-2">Status</th><th class="pb-2">Actions</th>
          </tr></thead>
          <tbody id="seq-table">
            ${sequences.map(s => `
            <tr class="border-b last:border-0" id="seq-row-${s.id}">
              <td class="py-2">
                <div class="font-medium">${s.name}</div>
                <div class="text-xs text-gray-400">${s.description || ''}</div>
              </td>
              <td class="py-2"><span class="px-2 py-0.5 rounded text-xs ${s.audience_type === 'B2B' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}">${s.audience_type}</span></td>
              <td class="py-2">${s.step_count} steps</td>
              <td class="py-2">${s.active_enrollments} contacts</td>
              <td class="py-2"><span class="${s.active ? 'text-green-600' : 'text-gray-400'}">${s.active ? '● Active' : '○ Inactive'}</span></td>
              <td class="py-2 flex gap-3">
                <button onclick="editSequence(${s.id})" class="text-blue-600 hover:underline text-xs">Edit Steps</button>
                <button onclick="enrollContacts(${s.id}, '${s.name}')" class="text-green-600 hover:underline text-xs">Enroll</button>
                <button onclick="viewEnrollments(${s.id}, '${s.name}')" class="text-gray-500 hover:underline text-xs">View</button>
                <button onclick="deleteSeq(${s.id})" class="text-red-400 hover:underline text-xs">Delete</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Contact Import -->
    <div class="bg-white rounded-xl shadow-sm p-6">
      <h2 class="font-semibold text-gray-700 mb-4">Import Contacts (CSV)</h2>
      <p class="text-sm text-gray-500 mb-3">Required column: <code>email</code>. Optional: <code>first_name, last_name, phone, city, audience_type, product_interest</code></p>
      <div class="flex gap-3 items-center flex-wrap">
        <input type="file" id="csv-file" accept=".csv" class="text-sm border border-gray-300 rounded p-2">
        <button onclick="importCsv()" class="bg-green-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-green-700">Upload & Import</button>
        <span id="import-status" class="text-sm text-gray-500"></span>
      </div>
    </div>
  </div>

  <!-- Create/Edit Sequence Modal -->
  <div id="seq-modal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
    <div class="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6">
      <div class="flex justify-between items-center mb-4">
        <h3 id="seq-modal-title" class="font-semibold text-lg">New Sequence</h3>
        <button onclick="closeSeqModal()" class="text-gray-400 hover:text-gray-600 text-xl">✕</button>
      </div>

      <input type="hidden" id="seq-id">
      <div class="grid grid-cols-2 gap-4 mb-4">
        <div class="col-span-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">Sequence Name</label>
          <input id="seq-name" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="e.g. B2C Door Interest – 20 Email">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Audience</label>
          <select id="seq-audience" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
            <option value="B2C">B2C</option>
            <option value="B2B">B2B</option>
          </select>
        </div>
        <div class="col-span-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">Description (optional)</label>
          <input id="seq-desc" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="Short description">
        </div>
      </div>

      <button onclick="saveSequence()" class="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700 mb-6">Save Sequence</button>

      <!-- Steps editor — only shown when editing existing -->
      <div id="steps-section" class="hidden">
        <div class="flex justify-between items-center mb-3">
          <h4 class="font-semibold text-gray-700">Email Steps</h4>
          <button onclick="addStep()" class="text-sm bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg">+ Add Step</button>
        </div>
        <div id="steps-list" class="space-y-4"></div>
      </div>
    </div>
  </div>

  <!-- Enroll Modal -->
  <div id="enroll-modal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
    <div class="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6">
      <div class="flex justify-between items-center mb-4">
        <h3 class="font-semibold text-lg">Enroll Contacts – <span id="enroll-seq-name"></span></h3>
        <button onclick="closeEnroll()" class="text-gray-400 hover:text-gray-600 text-xl">✕</button>
      </div>

      <div class="flex gap-3 flex-wrap mb-4">
        <select id="enroll-sp" class="border border-gray-300 rounded-lg px-3 py-2 text-sm">
          <option value="">Select Salesperson</option>
          ${salespeople.filter(s => s.gmail_email && s.enabled).map(s => `<option value="${s.id}">${s.name} (${s.gmail_email})</option>`).join('')}
        </select>
        <input id="enroll-search" oninput="filterLeads()" placeholder="Search email or name..." class="border border-gray-300 rounded-lg px-3 py-2 text-sm flex-1">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" id="enroll-hide-enrolled" onchange="filterLeads()"> Hide already enrolled
        </label>
        <button onclick="enrollSelected()" class="bg-green-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-green-700">Enroll Selected</button>
      </div>

      <div class="text-sm text-gray-500 mb-2"><span id="enroll-count">0</span> selected</div>
      <div class="overflow-x-auto max-h-96 overflow-y-auto">
        <table class="w-full text-sm">
          <thead class="sticky top-0 bg-white"><tr class="text-left text-gray-500 border-b">
            <th class="pb-2 pr-3"><input type="checkbox" onchange="toggleAllLeads(this)"></th>
            <th class="pb-2">Email</th><th class="pb-2">Name</th>
            <th class="pb-2">Type</th><th class="pb-2">Status</th>
          </tr></thead>
          <tbody id="leads-table"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Enrollment View Modal -->
  <div id="view-modal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
    <div class="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6">
      <div class="flex justify-between items-center mb-4">
        <h3 class="font-semibold text-lg">Enrollments – <span id="view-seq-name"></span></h3>
        <button onclick="document.getElementById('view-modal').classList.add('hidden')" class="text-gray-400 hover:text-gray-600 text-xl">✕</button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-gray-500 border-b">
            <th class="pb-2">Contact</th><th class="pb-2">Salesperson</th>
            <th class="pb-2">Step</th><th class="pb-2">Emails Sent</th>
            <th class="pb-2">Status</th><th class="pb-2">Next Send</th><th class="pb-2">Actions</th>
          </tr></thead>
          <tbody id="view-table"></tbody>
        </table>
      </div>
    </div>
  </div>

<script>
var activeSeqId = null;
var allLeads    = [];

function disconnectGmail(spId) {
  if (!confirm('Disconnect this Gmail account?')) return;
  fetch('/gmail/disconnect/' + spId, { method: 'POST' })
    .then(function() { location.reload(); });
}

function showCreateSeq() {
  document.getElementById('seq-id').value = '';
  document.getElementById('seq-name').value = '';
  document.getElementById('seq-desc').value = '';
  document.getElementById('seq-audience').value = 'B2C';
  document.getElementById('steps-section').classList.add('hidden');
  document.getElementById('seq-modal-title').textContent = 'New Sequence';
  document.getElementById('seq-modal').classList.remove('hidden');
}

function closeSeqModal() { document.getElementById('seq-modal').classList.add('hidden'); }

function saveSequence() {
  var id       = document.getElementById('seq-id').value;
  var name     = document.getElementById('seq-name').value.trim();
  var desc     = document.getElementById('seq-desc').value.trim();
  var audience = document.getElementById('seq-audience').value;

  if (!name) { alert('Name is required'); return; }

  var url    = id ? '/sequences/api/sequences/' + id : '/sequences/api/sequences';
  var method = id ? 'PUT' : 'POST';

  fetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, description: desc, audience_type: audience, active: true }),
  })
  .then(function(r) { return r.json(); })
  .then(function(seq) {
    if (!id) {
      activeSeqId = seq.id;
      document.getElementById('seq-id').value = seq.id;
      document.getElementById('seq-modal-title').textContent = 'Edit Steps – ' + seq.name;
      document.getElementById('steps-section').classList.remove('hidden');
    }
    location.reload();
  });
}

function editSequence(id) {
  fetch('/sequences/api/sequences/' + id)
    .then(function(r) { return r.json(); })
    .then(function(seq) {
      activeSeqId = id;
      document.getElementById('seq-id').value = id;
      document.getElementById('seq-name').value = seq.name;
      document.getElementById('seq-desc').value = seq.description || '';
      document.getElementById('seq-audience').value = seq.audience_type;
      document.getElementById('seq-modal-title').textContent = 'Edit – ' + seq.name;
      document.getElementById('steps-section').classList.remove('hidden');
      renderSteps(seq.steps || []);
      document.getElementById('seq-modal').classList.remove('hidden');
    });
}

function renderSteps(steps) {
  var list = document.getElementById('steps-list');
  list.innerHTML = '';
  steps.forEach(function(step) {
    list.innerHTML += buildStepHtml(step.step_number, step.delay_days, step.subject, step.body, step.id);
  });
}

function buildStepHtml(stepNum, delayDays, subject, body, stepId) {
  return '<div class="border border-gray-200 rounded-lg p-4" id="step-block-' + stepNum + '">' +
    '<div class="flex justify-between items-center mb-3">' +
      '<span class="font-medium text-sm">Step ' + stepNum + '</span>' +
      '<button onclick="deleteStep(' + (stepId || 0) + ', ' + stepNum + ')" class="text-red-400 text-xs hover:underline">Remove</button>' +
    '</div>' +
    '<div class="grid grid-cols-4 gap-3 mb-3">' +
      '<div>' +
        '<label class="block text-xs text-gray-500 mb-1">Send after (days)</label>' +
        '<input type="number" min="0" value="' + delayDays + '" id="step-delay-' + stepNum + '" class="w-full border border-gray-300 rounded px-2 py-1 text-sm">' +
      '</div>' +
      '<div class="col-span-3">' +
        '<label class="block text-xs text-gray-500 mb-1">Subject line</label>' +
        '<input type="text" value="' + (subject || '').replace(/"/g,'&quot;') + '" id="step-subject-' + stepNum + '" class="w-full border border-gray-300 rounded px-2 py-1 text-sm" placeholder="e.g. Quick question about your security concerns">' +
      '</div>' +
    '</div>' +
    '<label class="block text-xs text-gray-500 mb-1">Email body (use {first_name}, {city}, {product_interest})</label>' +
    '<textarea id="step-body-' + stepNum + '" rows="5" class="w-full border border-gray-300 rounded px-2 py-1.5 text-sm font-mono">' + (body || '') + '</textarea>' +
    '<button onclick="saveStep(' + stepNum + (stepId ? ', ' + stepId : '') + ')" class="mt-2 text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700">Save Step</button>' +
  '</div>';
}

var stepCount = 0;
function addStep() {
  var list = document.getElementById('steps-list');
  stepCount = list.children.length + 1;
  list.innerHTML += buildStepHtml(stepCount, stepCount === 1 ? 0 : 3, '', '', null);
  list.lastElementChild.scrollIntoView({ behavior: 'smooth' });
}

function saveStep(stepNum, stepId) {
  if (!activeSeqId) { alert('Save the sequence first'); return; }
  var delay   = document.getElementById('step-delay-' + stepNum).value;
  var subject = document.getElementById('step-subject-' + stepNum).value.trim();
  var body    = document.getElementById('step-body-' + stepNum).value;
  if (!subject || !body) { alert('Subject and body are required'); return; }

  fetch('/sequences/api/sequences/' + activeSeqId + '/steps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step_number: stepNum, delay_days: parseInt(delay), subject: subject, body: body }),
  })
  .then(function(r) { return r.json(); })
  .then(function() {
    var btn = document.querySelector('#step-block-' + stepNum + ' button:last-child');
    if (btn) { btn.textContent = '✓ Saved'; btn.style.background = '#16a34a'; }
  });
}

function deleteStep(stepId, stepNum) {
  if (!confirm('Remove step ' + stepNum + '?')) return;
  if (stepId && activeSeqId) {
    fetch('/sequences/api/sequences/' + activeSeqId + '/steps/' + stepId, { method: 'DELETE' })
      .then(function() { document.getElementById('step-block-' + stepNum).remove(); });
  } else {
    var el = document.getElementById('step-block-' + stepNum);
    if (el) el.remove();
  }
}

function deleteSeq(id) {
  if (!confirm('Delete this sequence? This cannot be undone.')) return;
  fetch('/sequences/api/sequences/' + id, { method: 'DELETE' })
    .then(function() { document.getElementById('seq-row-' + id).remove(); });
}

// ── Enroll flow ──
var enrollSeqId = null;

function enrollContacts(seqId, seqName) {
  enrollSeqId = seqId;
  document.getElementById('enroll-seq-name').textContent = seqName;
  document.getElementById('enroll-modal').classList.remove('hidden');
  document.getElementById('leads-table').innerHTML = '<tr><td colspan="5" class="py-4 text-center text-gray-400">Loading…</td></tr>';

  fetch('/sequences/api/leads/enrollable?sequence_id=' + seqId)
    .then(function(r) { return r.json(); })
    .then(function(leads) {
      allLeads = leads;
      renderLeads(leads);
    });
}

function closeEnroll() {
  document.getElementById('enroll-modal').classList.add('hidden');
  allLeads = [];
}

function renderLeads(leads) {
  var hideEnrolled = document.getElementById('enroll-hide-enrolled').checked;
  var filtered = hideEnrolled ? leads.filter(function(l) { return !l.already_enrolled; }) : leads;
  var tbody = document.getElementById('leads-table');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-gray-400">No contacts found</td></tr>';
    return;
  }
  tbody.innerHTML = filtered.map(function(l) {
    var disabled = l.already_enrolled || l.suppressed;
    return '<tr class="border-b last:border-0 ' + (disabled ? 'opacity-50' : '') + '">' +
      '<td class="py-1.5 pr-3"><input type="checkbox" class="lead-check" value="' + l.id + '"' +
        (disabled ? ' disabled' : '') + ' onchange="updateCount()"></td>' +
      '<td class="py-1.5">' + l.email + '</td>' +
      '<td class="py-1.5">' + (l.first_name || '') + ' ' + (l.last_name || '') + '</td>' +
      '<td class="py-1.5"><span class="px-1.5 py-0.5 text-xs rounded ' +
        (l.audience_type === 'B2B' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700') + '">' +
        l.audience_type + '</span></td>' +
      '<td class="py-1.5 text-xs">' +
        (l.suppressed ? '<span class="text-red-400">Suppressed</span>' :
         l.already_enrolled ? '<span class="text-gray-400">Enrolled</span>' :
         '<span class="text-green-500">Ready</span>') +
      '</td></tr>';
  }).join('');
}

function filterLeads() {
  var q = document.getElementById('enroll-search').value.toLowerCase();
  var filtered = allLeads.filter(function(l) {
    return !q || l.email.toLowerCase().includes(q) ||
      (l.first_name || '').toLowerCase().includes(q) ||
      (l.last_name  || '').toLowerCase().includes(q);
  });
  renderLeads(filtered);
}

function toggleAllLeads(cb) {
  document.querySelectorAll('.lead-check:not(:disabled)').forEach(function(c) { c.checked = cb.checked; });
  updateCount();
}

function updateCount() {
  var n = document.querySelectorAll('.lead-check:checked').length;
  document.getElementById('enroll-count').textContent = n;
}

function enrollSelected() {
  var spId = document.getElementById('enroll-sp').value;
  if (!spId) { alert('Select a salesperson first'); return; }
  var ids = Array.from(document.querySelectorAll('.lead-check:checked')).map(function(c) { return parseInt(c.value); });
  if (!ids.length) { alert('Select at least one contact'); return; }

  fetch('/sequences/api/sequences/' + enrollSeqId + '/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salesperson_id: parseInt(spId), lead_ids: ids }),
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    alert('Enrolled ' + d.enrolled + ' contacts. Skipped: ' + d.skipped);
    closeEnroll();
    location.reload();
  });
}

function viewEnrollments(seqId, seqName) {
  document.getElementById('view-seq-name').textContent = seqName;
  document.getElementById('view-modal').classList.remove('hidden');
  document.getElementById('view-table').innerHTML = '<tr><td colspan="7" class="py-4 text-center text-gray-400">Loading…</td></tr>';

  fetch('/sequences/api/sequences/' + seqId + '/enrollments')
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      if (!rows.length) {
        document.getElementById('view-table').innerHTML = '<tr><td colspan="7" class="py-4 text-center text-gray-400">No enrollments yet</td></tr>';
        return;
      }
      document.getElementById('view-table').innerHTML = rows.map(function(r) {
        var nextSend = r.next_send_at ? new Date(r.next_send_at).toLocaleDateString() : '—';
        var statusColor = r.status === 'active' ? 'text-green-600' : r.status === 'completed' ? 'text-gray-400' : 'text-yellow-600';
        return '<tr class="border-b last:border-0">' +
          '<td class="py-1.5">' + r.email + (r.first_name ? '<br><span class="text-xs text-gray-400">' + r.first_name + ' ' + (r.last_name||'') + '</span>' : '') + '</td>' +
          '<td class="py-1.5 text-xs">' + (r.salesperson_name || '—') + '</td>' +
          '<td class="py-1.5 text-center">' + r.current_step + '</td>' +
          '<td class="py-1.5 text-center">' + r.emails_sent + '</td>' +
          '<td class="py-1.5 ' + statusColor + ' capitalize">' + r.status + (r.paused_reason ? ' (' + r.paused_reason + ')' : '') + '</td>' +
          '<td class="py-1.5 text-xs">' + nextSend + '</td>' +
          '<td class="py-1.5">' +
            (r.status === 'active'
              ? '<button onclick="pauseEnrollment(' + r.id + ', this)" class="text-xs text-yellow-600 hover:underline">Pause</button>'
              : r.status === 'paused'
                ? '<button onclick="resumeEnrollment(' + r.id + ', this)" class="text-xs text-green-600 hover:underline">Resume</button>'
                : '') +
          '</td></tr>';
      }).join('');
    });
}

function pauseEnrollment(id, btn) {
  fetch('/sequences/api/enrollments/' + id + '/pause', { method: 'POST' })
    .then(function() { btn.closest('tr').querySelector('td:nth-child(5)').textContent = 'paused'; btn.remove(); });
}
function resumeEnrollment(id, btn) {
  fetch('/sequences/api/enrollments/' + id + '/resume', { method: 'POST' })
    .then(function() { btn.closest('tr').querySelector('td:nth-child(5)').textContent = 'active'; btn.remove(); });
}

function importCsv() {
  var file = document.getElementById('csv-file').files[0];
  if (!file) { alert('Select a CSV file first'); return; }
  var status = document.getElementById('import-status');
  status.textContent = 'Importing…';

  var reader = new FileReader();
  reader.onload = function(e) {
    fetch('/sequences/api/leads/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: e.target.result,
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      status.textContent = '✓ Imported ' + d.imported + ' contacts. Skipped: ' + d.skipped;
      status.style.color = '#16a34a';
    })
    .catch(function() { status.textContent = 'Import failed'; status.style.color = '#dc2626'; });
  };
  reader.readAsText(file);
}
</script>
</body>
</html>`);
});

module.exports = router;
