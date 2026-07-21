const express  = require('express');
const router   = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { shell, ICONS, esc } = require('../lib/layout');

// -- API endpoints ----------------------------------------------------------

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

// NOTE: this MUST stay above the `/:id` route below. Express matches in
// definition order, so `/api/sequences/report` otherwise binds to `:id`
// = "report" and the handler runs WHERE id = 'report', which Postgres
// rejects with "invalid input syntax for type integer". That was the 500.
// Per-sequence deliverability report
// Join path: sequences -> contact_enrollments -> email_sends
// Scoped to req.user.client_id for multi-tenant isolation
router.get('/api/sequences/report', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        seq.id            AS sequence_id,
        seq.name          AS sequence_name,
        COUNT(es.id)      AS total_sends,
        COUNT(es.id) FILTER (WHERE es.open_count  > 0)   AS opened_sends,
        COUNT(es.id) FILTER (WHERE es.click_count > 0)   AS clicked_sends,
        COUNT(es.id) FILTER (WHERE es.bounced = TRUE)    AS bounced_sends,
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
      GROUP BY seq.id, seq.name
      ORDER BY seq.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Sequences report error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
  const { step_number, delay_days, delay_minutes, subject, body } = req.body;
  const dm = delay_minutes != null ? parseInt(delay_minutes) : null;
  const { rows } = await pool.query(
    `INSERT INTO sequence_steps (sequence_id, step_number, delay_days, delay_minutes, subject, body)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (sequence_id, step_number) DO UPDATE
       SET delay_days=$3, delay_minutes=$4, subject=$5, body=$6
     RETURNING *`,
    [req.params.id, step_number, delay_days, dm, subject, body]
  );
  res.json(rows[0]);
});

// Delete a step
router.delete('/api/sequences/:seqId/steps/:stepId', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM sequence_steps WHERE id = $1 AND sequence_id = $2',
    [req.params.stepId, req.params.seqId]);
  res.json({ ok: true });
});

// Auto-enroll: match all leads by audience_type to this sequence, skip suppressed + already enrolled
router.post('/api/sequences/:id/auto-enroll', requireAuth, async (req, res) => {
  try {
    const { rows: seqRows } = await pool.query(
      `SELECT audience_type FROM sequences WHERE id = $1`,
      [req.params.id]
    );
    if (!seqRows[0]) return res.status(404).json({ error: 'Sequence not found' });

    const audienceType = seqRows[0].audience_type;
    const clientId     = req.session?.clientId || req.user?.client_id || null;
    const salespersonId = req.session?.salespersonId || req.user?.salesperson_id || null;

    const { rows: firstStep } = await pool.query(
      `SELECT delay_days, delay_minutes FROM sequence_steps WHERE sequence_id = $1 AND step_number = 1`,
      [req.params.id]
    );
    const fs1 = firstStep[0];
    const delayMs1 = fs1?.delay_minutes != null
      ? fs1.delay_minutes * 60 * 1000
      : (fs1?.delay_days ?? 0) * 24 * 60 * 60 * 1000;
    const nextSendAt = new Date(Date.now() + delayMs1).toISOString();

    // Find eligible leads: matching audience_type, not suppressed, not already in this sequence
    const { rows: leads } = await pool.query(`
      SELECT l.id, l.salesperson_id
      FROM leads l
      WHERE l.audience_type = $1
        ${clientId ? 'AND l.client_id = $2' : ''}
        AND l.email NOT IN (SELECT email FROM suppression_list)
        AND (l.unsubscribed IS NULL OR l.unsubscribed = false)
        AND NOT EXISTS (
          SELECT 1 FROM contact_enrollments ce
          WHERE ce.lead_id = l.id AND ce.sequence_id = $${clientId ? 3 : 2}
        )
    `, clientId ? [audienceType, clientId, req.params.id] : [audienceType, req.params.id]);

    let enrolled = 0, skipped = 0;
    for (const lead of leads) {
      try {
        const spId = salespersonId || lead.salesperson_id;
        await pool.query(
          `INSERT INTO contact_enrollments (lead_id, sequence_id, salesperson_id, next_send_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (lead_id, sequence_id) DO NOTHING`,
          [lead.id, req.params.id, spId, nextSendAt]
        );
        enrolled++;
      } catch { skipped++; }
    }

    res.json({ ok: true, enrolled, skipped, audience_type: audienceType });
  } catch (err) {
    console.error('[auto-enroll]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Enroll contacts in a sequence
router.post('/api/sequences/:id/enroll', requireAuth, async (req, res) => {
  const { salesperson_id, lead_ids } = req.body;
  if (!lead_ids?.length) return res.status(400).json({ error: 'No lead_ids provided' });

  // Get first step delay to set initial next_send_at
  const { rows: firstStep } = await pool.query(
    `SELECT delay_days, delay_minutes FROM sequence_steps WHERE sequence_id = $1 AND step_number = 1`,
    [req.params.id]
  );
  const fs1 = firstStep[0];
  const delayMs1 = fs1?.delay_minutes != null
    ? fs1.delay_minutes * 60 * 1000
    : (fs1?.delay_days ?? 0) * 24 * 60 * 60 * 1000;
  const nextSendAt = new Date(Date.now() + delayMs1).toISOString();

  let enrolled = 0, skipped = 0;
  for (const leadId of lead_ids) {
    try {
      // Block suppressed or unsubscribed leads
      const { rows: check } = await pool.query(
        `SELECT unsubscribed, email FROM leads WHERE id = $1`, [leadId]
      );
      const lead = check[0];
      if (!lead) { skipped++; continue; }
      if (lead.unsubscribed) { skipped++; continue; }
      const { rows: sup } = await pool.query(
        `SELECT 1 FROM suppression_list WHERE LOWER(email) = LOWER($1)`, [lead.email]
      );
      if (sup.length) { skipped++; continue; }

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

// Contact list for enrollment - all leads with suppression check
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

// Verify unverified leads via ZeroBounce - processes up to 50 at a time
// Suppresses invalid/spamtrap/abuse addresses automatically
router.post('/api/leads/verify-batch', requireAuth, async (req, res) => {
  const { verifyEmail, BLOCK_STATUSES } = require('../lib/zerobounce');

  if (!process.env.ZEROBOUNCE_API_KEY) {
    return res.status(400).json({ error: 'ZEROBOUNCE_API_KEY not configured in environment' });
  }

  const clientId = req.user?.client_id || null;
  const { rows: leads } = await pool.query(
    `SELECT id, email FROM leads
     WHERE email_verified IS NOT TRUE
       ${clientId ? 'AND client_id = $1' : ''}
     LIMIT 50`,
    clientId ? [clientId] : []
  );

  if (leads.length === 0) return res.json({ ok: true, verified: 0, suppressed: 0, message: 'All leads already verified.' });

  let verified = 0, suppressed = 0, errors = 0;

  for (const lead of leads) {
    try {
      const result = await verifyEmail(lead.email);

      await pool.query(
        `UPDATE leads SET email_verified=$1, verification_status=$2, verified_at=NOW() WHERE id=$3`,
        [result.valid, result.status, lead.id]
      );

      if (result.block) {
        // Auto-suppress bad addresses
        await pool.query(
          `INSERT INTO suppression_list (email, reason) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING`,
          [lead.email, result.status]
        );
        await pool.query(
          `UPDATE contact_enrollments SET status='paused', paused_reason='invalid_email'
           WHERE lead_id=$1 AND status='active'`,
          [lead.id]
        );
        suppressed++;
      }

      verified++;
    } catch (err) {
      console.error(`[zerobounce] ${lead.email}:`, err.message);
      errors++;
    }

    // ~3 req/sec - stay well within ZeroBounce rate limits
    await new Promise(r => setTimeout(r, 350));
  }

  const remaining = await pool.query(
    `SELECT COUNT(*) FROM leads WHERE email_verified IS NOT TRUE ${clientId ? 'AND client_id = $1' : ''}`,
    clientId ? [clientId] : []
  );

  res.json({ ok: true, verified, suppressed, errors, remaining: parseInt(remaining.rows[0].count) });
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

    const normalizedEmail = email.toLowerCase();
    const leadValues = [
      normalizedEmail,
      firstIdx   >= 0 ? cols[firstIdx]   : null,
      lastIdx    >= 0 ? cols[lastIdx]     : null,
      phoneIdx   >= 0 ? cols[phoneIdx]    : null,
      cityIdx    >= 0 ? cols[cityIdx]     : null,
      typeIdx    >= 0 ? (cols[typeIdx] || 'B2C') : 'B2C',
      productIdx >= 0 ? cols[productIdx]  : null,
    ];

    try {
      // CSV imports are pre-verified offline — mark send-ready immediately
      const { rowCount: updated } = await pool.query(
        `UPDATE leads SET
           first_name = COALESCE($2, first_name),
           last_name = COALESCE($3, last_name),
           phone = COALESCE($4, phone),
           city = COALESCE($5, city),
           audience_type = COALESCE($6, audience_type),
           product_interest = COALESCE($7, product_interest),
           email_verified = true,
           verification_status = 'preverified',
           verified_at = NOW()
         WHERE LOWER(email) = LOWER($1)`,
        leadValues
      );

      if (updated === 0) {
        await pool.query(
          `INSERT INTO leads (email, first_name, last_name, phone, city, audience_type, product_interest, email_verified, verification_status, verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, true, 'preverified', NOW())`,
          leadValues
        );
      }
      imported++;
    } catch { skipped++; }
  }
  res.json({ ok: true, imported, skipped, preverified: true });
});

// -- Preview: send all steps of a sequence immediately to one email ----------
// POST /sequences/api/sequences/:id/preview
// Body: { email, salesperson_id }
router.post('/api/sequences/:id/preview', requireAuth, async (req, res) => {
  const seqId       = parseInt(req.params.id);
  const { email, salesperson_id } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const { rows: steps } = await pool.query(
    `SELECT * FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_number ASC`,
    [seqId]
  );
  if (!steps.length) return res.status(404).json({ error: 'No steps found' });

  // Get salesperson - use provided or first active one with Gmail connected
  let spId = parseInt(salesperson_id) || null;
  if (!spId) {
    const { rows } = await pool.query(
      `SELECT s.id FROM salespeople s
       JOIN email_accounts ea ON ea.salesperson_id = s.id AND ea.enabled = true
       WHERE s.active = true LIMIT 1`
    );
    spId = rows[0]?.id;
  }
  if (!spId) return res.status(400).json({ error: 'No salesperson with Gmail connected' });

  const { rows: spRows } = await pool.query(
    `SELECT s.*, ea.email AS gmail_email FROM salespeople s
     JOIN email_accounts ea ON ea.salesperson_id = s.id
     WHERE s.id = $1`, [spId]
  );
  const sp = spRows[0];
  if (!sp) return res.status(400).json({ error: 'Salesperson not found' });

  const vars = {
    first_name: 'Preview',
    last_name:  'Recipient',
    city:       'Your City',
    product_interest: 'security doors',
    salesperson_name:  sp.name  || '',
    salesperson_email: sp.email || '',
    salesperson_phone: sp.phone || '',
    salesperson_title: sp.title || '',
    company_name:    'SureSecured',
    company_phone:   '(747) 688-9992',
    company_website: 'suresecured.com',
    company_address: 'Simi Valley, CA',
    cta_url:         'https://suresecured.com/pages/request-a-quote',
  };

  const { sendSequenceEmail } = require('../lib/gmail');
  const clientId = req.user.client_id;

  // Preview sends EVERY step in the sequence to the given address, in the
  // BACKGROUND. We respond immediately and keep sending after the response, so
  // the request can never hit the gateway timeout regardless of step count.
  //
  // Why background and not synchronous: sending all steps in the request is what
  // produced the original 502 -- sequence 7 has 20 steps, and 20 sends inside
  // one HTTP request is slow enough to be killed by the proxy. Gmail API sends
  // are ~0.5s each, but 20+ of them still shouldn't block a response. Each send
  // records its own row in email_sends, so failures surface on /undelivered and
  // the sending-health banner even though the caller already got its 200.
  res.json({
    ok: true,
    queued: steps.length,
    note: `Sending ${steps.length} preview email${steps.length === 1 ? '' : 's'} to ${email}. They'll arrive over the next minute.`,
  });

  ;(async () => {
    let sent = 0, failed = 0;
    for (const step of steps) {
      try {
        const r = await sendSequenceEmail({
          salespersonId: spId,
          clientId,
          to:            email,
          subject:       `[PREVIEW Step ${step.step_number}] ${step.subject}`,
          body:          step.body,
          vars,
          enrollmentId:  null,
          stepId:        step.id,
          leadId:        null,
          preview:       true,
        });
        if (r && r.ok === false) { failed++; console.warn(`[preview] step ${step.step_number} not sent: ${r.error}`); }
        else sent++;
      } catch (err) {
        failed++;
        console.error(`[preview] step ${step.step_number} failed:`, err.message);
      }
      // Space sends slightly so a 20-step preview doesn't burst the Gmail API.
      await new Promise(r => setTimeout(r, 800));
    }
    console.log(`[preview] done: ${sent} sent, ${failed} failed, seq ${seqId} -> ${email}`);
  })();
});

// -- Sequences UI page ------------------------------------------------------

router.get('/', requireAuth, async (req, res) => {
  const [seqRows, spRows] = await Promise.all([
    // COUNT(DISTINCT ...) so the two LEFT JOINs do not multiply each other
    // (steps x enrollments was inflating the step count, e.g. 20 steps x 2
    // enrollments = 40). Only ACTIVE steps count, so retired steps from a
    // shortened sequence are not shown.
    pool.query(`SELECT s.*,
                  COUNT(DISTINCT ss.id) FILTER (WHERE ss.active) AS step_count,
                  COUNT(DISTINCT ce.id) FILTER (WHERE ce.status='active') AS active_enrollments
                FROM sequences s
                LEFT JOIN sequence_steps ss ON ss.sequence_id = s.id
                LEFT JOIN contact_enrollments ce ON ce.sequence_id = s.id
                GROUP BY s.id ORDER BY s.created_at DESC`),
    pool.query('SELECT s.id, s.name, ea.email AS gmail_email, ea.enabled, ea.last_error FROM salespeople s LEFT JOIN email_accounts ea ON ea.salesperson_id = s.id WHERE s.active = true ORDER BY s.name'),
  ]);

  const sequences  = seqRows.rows;
  const salespeople = spRows.rows;

  const content = `
  <div class="px-6 py-8 max-w-7xl mx-auto">

    <div class="mb-6">
      <h1 class="text-2xl font-bold text-slate-900">Sequences</h1>
      <p class="text-sm text-slate-500 mt-0.5">Manage email sequences, Gmail connections, and contact enrollment</p>
    </div>

    <!-- Gmail Connections -->
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden mb-6">
      <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
        <h2 class="font-semibold text-slate-800">Gmail Connections</h2>
        <span class="text-xs text-slate-400">Each salesperson sends from their own Google Workspace inbox</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm data-table">
          <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
            <tr>
              <th class="px-4 py-3 text-left">Salesperson</th>
              <th class="px-4 py-3 text-left">Gmail Account</th>
              <th class="px-4 py-3 text-left">Status</th>
              <th class="px-4 py-3 text-left">Action</th>
            </tr>
          </thead>
          <tbody>
            ${salespeople.map(sp => `
            <tr class="border-t border-slate-100 hover:bg-slate-50 transition-colors">
              <td class="px-4 py-3 font-semibold text-slate-900">${esc(sp.name)}</td>
              <td class="px-4 py-3 text-slate-600">${sp.gmail_email ? esc(sp.gmail_email) : '<span class="text-slate-400 italic">Not connected</span>'}</td>
              <td class="px-4 py-3">
                ${sp.gmail_email && sp.enabled
                  ? `<span class="inline-flex items-center gap-1.5 text-emerald-600 font-medium text-xs">${ICONS.check} Connected</span>`
                  : sp.last_error
                    ? `<span class="inline-flex items-center gap-1.5 text-red-500 text-xs">${ICONS.warning} Error</span>`
                    : `<span class="text-slate-400 text-xs">Not connected</span>`}
              </td>
              <td class="px-4 py-3">
                ${sp.gmail_email
                  ? `<button onclick="disconnectGmail(${sp.id})" class="text-xs px-3 py-1 rounded-lg border border-red-200 text-red-600 bg-red-50 hover:bg-red-100 transition-colors">Disconnect</button>`
                  : `<a href="/gmail/connect/${sp.id}" class="text-xs px-3 py-1.5 rounded-lg bg-sky-600 text-white hover:bg-sky-700 transition-colors">Connect Gmail</a>`}
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Sequences -->
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden mb-6">
      <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
        <h2 class="font-semibold text-slate-800">Email Sequences</h2>
        <button onclick="showCreateSeq()" class="inline-flex items-center gap-1.5 bg-sky-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-sky-700 transition-colors">
          ${ICONS.plus} New Sequence
        </button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm data-table">
          <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
            <tr>
              <th class="px-4 py-3 text-left">Name</th>
              <th class="px-4 py-3 text-left">Audience</th>
              <th class="px-4 py-3 text-center">Steps</th>
              <th class="px-4 py-3 text-center">Active Contacts</th>
              <th class="px-4 py-3 text-left">Status</th>
              <th class="px-4 py-3 text-left">Actions</th>
            </tr>
          </thead>
          <tbody id="seq-table">
            ${sequences.map(s => `
            <tr class="border-t border-slate-100 hover:bg-slate-50 transition-colors" id="seq-row-${s.id}">
              <td class="px-4 py-3">
                <div class="font-semibold text-slate-900">${esc(s.name)}</div>
                <div class="text-xs text-slate-400">${esc(s.description || '')}</div>
              </td>
              <td class="px-4 py-3">
                <span class="px-2 py-0.5 rounded-full text-xs font-medium ${s.audience_type === 'B2B' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}">${esc(s.audience_type)}</span>
              </td>
              <td class="px-4 py-3 text-center text-slate-700">${s.step_count}</td>
              <td class="px-4 py-3 text-center text-slate-700">${s.active_enrollments}</td>
              <td class="px-4 py-3">
                ${s.active
                  ? `<span class="inline-flex items-center gap-1 text-emerald-600 font-medium text-xs">${ICONS.check} Active</span>`
                  : `<span class="text-slate-400 text-xs">Inactive</span>`}
              </td>
              <td class="px-4 py-3">
                <div class="flex gap-2 flex-wrap">
                  <button onclick="editSequence(${s.id})" title="Edit the emails in this sequence: add, remove, reword, or reorder the steps" class="text-xs px-2.5 py-1 rounded-lg border border-sky-200 text-sky-700 bg-sky-50 hover:bg-sky-100 transition-colors">Edit Steps</button>
                  <button onclick="enrollContacts(${s.id}, '${esc(s.name)}')" title="Hand-pick specific contacts to start receiving this sequence" class="text-xs px-2.5 py-1 rounded-lg border border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-colors">Enroll</button>
                  <button onclick="autoEnroll(${s.id}, '${esc(s.name)}', '${esc(s.audience_type)}')" title="Automatically enroll every send-ready lead that matches this audience (${esc(s.audience_type)})" class="text-xs px-2.5 py-1 rounded-lg border border-violet-200 text-violet-700 bg-violet-50 hover:bg-violet-100 transition-colors">Auto-Enroll</button>
                  <button onclick="previewSequence(${s.id})" title="Send yourself every email in this sequence right now, so you can review it before sending to leads" class="text-xs px-2.5 py-1 rounded-lg border border-amber-200 text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors">Preview</button>
                  <button onclick="viewEnrollments(${s.id}, '${esc(s.name)}')" title="See who is enrolled and which step of the sequence each contact is on" class="text-xs px-2.5 py-1 rounded-lg border border-slate-200 text-slate-600 bg-slate-50 hover:bg-slate-100 transition-colors">View</button>
                  <button onclick="deleteSeq(${s.id})" title="Permanently delete this sequence" class="text-xs px-2.5 py-1 rounded-lg border border-red-200 text-red-600 bg-red-50 hover:bg-red-100 transition-colors">Delete</button>
                </div>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Deliverability Report -->
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden mb-6">
      <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
        <h2 class="font-semibold text-slate-800">Deliverability Report</h2>
        <span class="text-xs text-slate-400">Open, click, and bounce rates per sequence</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm data-table" id="report-table">
          <thead class="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
            <tr>
              <th class="px-4 py-3 text-left">Sequence</th>
              <th class="px-4 py-3 text-right">Total Sends</th>
              <th class="px-4 py-3 text-right">Open Rate</th>
              <th class="px-4 py-3 text-right">Click Rate</th>
              <th class="px-4 py-3 text-right">Bounce Rate</th>
            </tr>
          </thead>
          <tbody id="report-body">
            <tr><td colspan="5" class="px-4 py-8 text-center text-slate-400">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Contact Import & Verification -->
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 p-6">
      <h2 class="font-semibold text-slate-800 mb-1">Import Contacts (CSV)</h2>
      <p class="text-sm text-slate-500 mb-4">Upload a <strong>pre-verified</strong> list (clean offline first with MillionVerifier, Bouncer, etc.). Required column: <code class="bg-slate-100 px-1 rounded text-xs">email</code>. Optional: <code class="bg-slate-100 px-1 rounded text-xs">first_name, last_name, phone, city, audience_type, product_interest</code>. Imported contacts are marked <em>send-ready</em> automatically.</p>
      <div class="flex gap-3 items-center flex-wrap mb-5">
        <input type="file" id="csv-file" accept=".csv" class="text-sm border border-slate-200 rounded-lg p-2 text-slate-600">
        <button onclick="importCsv()" class="bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-emerald-700 transition-colors">Upload &amp; Import</button>
        <span id="import-status" class="text-sm text-slate-500"></span>
      </div>
      <div class="border-t border-slate-100 pt-4">
        <div class="flex items-start justify-between flex-wrap gap-3">
          <div>
            <p class="text-sm font-semibold text-slate-700">Email Verification (ZeroBounce)</p>
            <p class="text-xs text-slate-400 mt-0.5">Verifies 50 unverified leads per run. Invalid/spam-trap addresses are auto-suppressed. Requires <code class="bg-slate-100 px-1 rounded">ZEROBOUNCE_API_KEY</code> in environment.</p>
          </div>
          <button onclick="verifyBatch()" class="bg-sky-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-sky-700 transition-colors flex-shrink-0">
            Verify Emails (50)
          </button>
        </div>
        <p id="verify-status" class="text-sm text-slate-500 mt-2"></p>
      </div>
    </div>
  </div>

  <!-- Create/Edit Sequence Modal -->
  <div id="seq-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
    <div class="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6">
      <div class="flex justify-between items-center mb-5">
        <h3 id="seq-modal-title" class="font-bold text-lg text-slate-900">New Sequence</h3>
        <button onclick="closeSeqModal()" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">${ICONS.x}</button>
      </div>

      <input type="hidden" id="seq-id">
      <div class="grid grid-cols-2 gap-4 mb-4">
        <div class="col-span-2">
          <label class="block text-sm font-medium text-slate-700 mb-1">Sequence Name</label>
          <input id="seq-name" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" placeholder="e.g. B2C Door Interest - 20 Email">
        </div>
        <div>
          <label class="block text-sm font-medium text-slate-700 mb-1">Audience</label>
          <select id="seq-audience" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
            <option value="B2C">B2C</option>
            <option value="B2B">B2B</option>
          </select>
        </div>
        <div class="col-span-2">
          <label class="block text-sm font-medium text-slate-700 mb-1">Description (optional)</label>
          <input id="seq-desc" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" placeholder="Short description">
        </div>
      </div>

      <button onclick="saveSequence()" class="bg-sky-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-sky-700 transition-colors mb-6">Save Sequence</button>

      <div id="steps-section" class="hidden">
        <div class="flex justify-between items-center mb-3">
          <h4 class="font-semibold text-slate-700">Email Steps</h4>
          <div class="flex items-center gap-2">
            <button id="test-mode-btn" onclick="toggleTestMode()" class="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 transition-colors">🧪 Test Mode</button>
            <button onclick="addStep()" class="text-sm inline-flex items-center gap-1 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors">${ICONS.plus} Add Step</button>
          </div>
        </div>
        <div id="steps-list" class="space-y-4"></div>
      </div>
    </div>
  </div>

  <!-- Enroll Modal -->
  <div id="enroll-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
    <div class="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6">
      <div class="flex justify-between items-center mb-5">
        <h3 class="font-bold text-lg text-slate-900">Enroll Contacts &mdash; <span id="enroll-seq-name" class="text-sky-600"></span></h3>
        <button onclick="closeEnroll()" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">${ICONS.x}</button>
      </div>

      <div class="flex gap-3 flex-wrap mb-4">
        <select id="enroll-sp" class="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
          <option value="">Select Salesperson</option>
          ${salespeople.filter(s => s.gmail_email && s.enabled).map(s => `<option value="${s.id}">${esc(s.name)} (${esc(s.gmail_email)})</option>`).join('')}
        </select>
        <div class="relative flex-1">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4">${ICONS.search}</span>
          <input id="enroll-search" oninput="filterLeads()" placeholder="Search email or name…" class="w-full border border-slate-200 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
        <label class="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" id="enroll-hide-enrolled" onchange="filterLeads()"> Hide enrolled
        </label>
        <button onclick="enrollSelected()" class="bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-emerald-700 transition-colors">Enroll Selected</button>
      </div>

      <div class="text-sm text-slate-500 mb-2"><span id="enroll-count">0</span> selected</div>
      <div class="overflow-x-auto max-h-96 overflow-y-auto border border-slate-100 rounded-lg">
        <table class="w-full text-sm">
          <thead class="sticky top-0 bg-white border-b border-slate-100">
            <tr class="text-left text-slate-500 text-xs uppercase tracking-wider">
              <th class="px-3 py-2.5"><input type="checkbox" onchange="toggleAllLeads(this)"></th>
              <th class="px-3 py-2.5">Email</th>
              <th class="px-3 py-2.5">Name</th>
              <th class="px-3 py-2.5">Type</th>
              <th class="px-3 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody id="leads-table"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Enrollment View Modal -->
  <div id="view-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
    <div class="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6">
      <div class="flex justify-between items-center mb-5">
        <h3 class="font-bold text-lg text-slate-900">Enrollments &mdash; <span id="view-seq-name" class="text-sky-600"></span></h3>
        <button onclick="document.getElementById('view-modal').classList.add('hidden')" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">${ICONS.x}</button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-xs text-slate-500 uppercase tracking-wider border-b border-slate-100">
            <tr>
              <th class="pb-2 text-left px-2">Contact</th>
              <th class="pb-2 text-left px-2">Salesperson</th>
              <th class="pb-2 text-center px-2">Step</th>
              <th class="pb-2 text-center px-2">Sent</th>
              <th class="pb-2 text-left px-2">Status</th>
              <th class="pb-2 text-left px-2">Next Send</th>
              <th class="pb-2 px-2">Actions</th>
            </tr>
          </thead>
          <tbody id="view-table"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
  var activeSeqId = null;
  var allLeads    = [];

  async function disconnectGmail(spId) {
    if (!await showConfirm('Disconnect this Gmail account?', 'Disconnect Gmail')) return;
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

  function closeSeqModal() {
    document.getElementById('seq-modal').classList.add('hidden');
    testMode = false;
    var btn = document.getElementById('test-mode-btn');
    if (btn) { btn.textContent = '🧪 Test Mode'; btn.className = 'text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 transition-colors'; }
  }

  function saveSequence() {
    var id       = document.getElementById('seq-id').value;
    var name     = document.getElementById('seq-name').value.trim();
    var desc     = document.getElementById('seq-desc').value.trim();
    var audience = document.getElementById('seq-audience').value;

    if (!name) { showToast('Sequence name is required', 'error'); return; }

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
        document.getElementById('seq-modal-title').textContent = 'Edit Steps — ' + seq.name;
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
        document.getElementById('seq-modal-title').textContent = 'Edit — ' + seq.name;
        document.getElementById('steps-section').classList.remove('hidden');
        renderSteps(seq.steps || []);
        document.getElementById('seq-modal').classList.remove('hidden');
      });
  }

  var testMode = false;

  function toggleTestMode() {
    testMode = !testMode;
    var btn = document.getElementById('test-mode-btn');
    btn.textContent = testMode ? '🧪 Test Mode ON (minutes)' : '🧪 Test Mode';
    btn.className = testMode
      ? 'text-xs px-3 py-1.5 rounded-lg border border-amber-400 text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors font-medium'
      : 'text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 transition-colors';
    // Re-render steps so labels update
    var list = document.getElementById('steps-list');
    var blocks = list.querySelectorAll('[id^="step-block-"]');
    blocks.forEach(function(block) {
      var num = block.id.replace('step-block-', '');
      var lbl = block.querySelector('label');
      if (lbl && (lbl.textContent.includes('days') || lbl.textContent.includes('minutes'))) {
        lbl.textContent = testMode ? 'Send after (minutes)' : 'Send after (days)';
      }
    });
  }

  function renderSteps(steps) {
    var list = document.getElementById('steps-list');
    list.innerHTML = '';
    steps.forEach(function(step) {
      // If delay_minutes is set, activate test mode automatically
      if (step.delay_minutes != null) testMode = true;
      var delayVal = step.delay_minutes != null ? step.delay_minutes : (step.delay_days || 0);
      list.innerHTML += buildStepHtml(step.step_number, delayVal, step.subject, step.body, step.id, step.delay_minutes != null);
    });
    // Sync test mode button state
    var btn = document.getElementById('test-mode-btn');
    if (btn) {
      btn.textContent = testMode ? '🧪 Test Mode ON (minutes)' : '🧪 Test Mode';
      btn.className = testMode
        ? 'text-xs px-3 py-1.5 rounded-lg border border-amber-400 text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors font-medium'
        : 'text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 transition-colors';
    }
  }

  function buildStepHtml(stepNum, delayVal, subject, body, stepId, isMinutes) {
    var label = (isMinutes || testMode) ? 'Send after (minutes)' : 'Send after (days)';
    return '<div class="border border-slate-200 rounded-xl p-4" id="step-block-' + stepNum + '">' +
      '<div class="flex justify-between items-center mb-3">' +
        '<span class="font-semibold text-sm text-slate-800">Step ' + stepNum + '</span>' +
        '<button onclick="deleteStep(' + (stepId || 0) + ', ' + stepNum + ')" class="text-xs px-2.5 py-1 rounded-lg border border-red-200 text-red-600 bg-red-50 hover:bg-red-100 transition-colors">Remove</button>' +
      '</div>' +
      '<div class="grid grid-cols-4 gap-3 mb-3">' +
        '<div>' +
          '<label class="block text-xs text-slate-500 mb-1 font-medium">' + label + '</label>' +
          '<input type="number" min="0" value="' + (delayVal || 0) + '" id="step-delay-' + stepNum + '" class="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">' +
        '</div>' +
        '<div class="col-span-3">' +
          '<label class="block text-xs text-slate-500 mb-1 font-medium">Subject line</label>' +
          '<input type="text" value="' + (subject || '').replace(/"/g,'&quot;') + '" id="step-subject-' + stepNum + '" class="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500" placeholder="e.g. Quick question about your security concerns">' +
        '</div>' +
      '</div>' +
      '<label class="block text-xs text-slate-500 mb-1 font-medium">Email body (use {first_name}, {city}, {product_interest})</label>' +
      '<textarea id="step-body-' + stepNum + '" rows="5" class="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500">' + (body || '') + '</textarea>' +
      '<button onclick="saveStep(' + stepNum + (stepId ? ', ' + stepId : '') + ')" class="mt-2 text-xs bg-sky-600 text-white px-3 py-1.5 rounded-lg hover:bg-sky-700 transition-colors">Save Step</button>' +
    '</div>';
  }

  var stepCount = 0;
  function addStep() {
    var list = document.getElementById('steps-list');
    stepCount = list.children.length + 1;
    var defaultDelay = testMode ? 10 : (stepCount === 1 ? 0 : 3);
    list.innerHTML += buildStepHtml(stepCount, defaultDelay, '', '', null, testMode);
    list.lastElementChild.scrollIntoView({ behavior: 'smooth' });
  }

  function saveStep(stepNum, stepId) {
    if (!activeSeqId) { showToast('Save the sequence first', 'warn'); return; }
    var delay   = parseInt(document.getElementById('step-delay-' + stepNum).value) || 0;
    var subject = document.getElementById('step-subject-' + stepNum).value.trim();
    var body    = document.getElementById('step-body-' + stepNum).value;
    if (!subject || !body) { showToast('Subject and body are required', 'error'); return; }

    var payload = { step_number: stepNum, subject: subject, body: body };
    if (testMode) {
      payload.delay_minutes = delay;
      payload.delay_days    = 0;
    } else {
      payload.delay_days    = delay;
      payload.delay_minutes = null;
    }

    fetch('/sequences/api/sequences/' + activeSeqId + '/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    .then(function(r) { return r.json(); })
    .then(function() {
      showToast('Step ' + stepNum + ' saved' + (testMode ? ' (test mode: minutes)' : ''), 'success', 2000);
    });
  }

  async function deleteStep(stepId, stepNum) {
    if (!await showConfirm('Remove step ' + stepNum + '?', 'Delete Step')) return;
    if (stepId && activeSeqId) {
      fetch('/sequences/api/sequences/' + activeSeqId + '/steps/' + stepId, { method: 'DELETE' })
        .then(function() { document.getElementById('step-block-' + stepNum).remove(); });
    } else {
      var el = document.getElementById('step-block-' + stepNum);
      if (el) el.remove();
    }
  }

  async function deleteSeq(id) {
    if (!await showDestruct('Delete this sequence? This cannot be undone.', 'Delete Sequence', 'Delete')) return;
    fetch('/sequences/api/sequences/' + id, { method: 'DELETE' })
      .then(function() {
        var row = document.getElementById('seq-row-' + id);
        if (row) row.remove();
        showToast('Sequence deleted', 'success');
      });
  }

  async function previewSequence(seqId) {
    var email = await showPrompt('Send the full sequence (every step) to which email?', '', 'Preview Sequence');
    if (!email || !email.trim()) return;
    email = email.trim();
    fetch('/sequences/api/sequences/' + seqId + '/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.ok) {
        showToast('Preview failed: ' + (data.error || 'Unknown error'), 'error', 8000);
        return;
      }
      // Sends run in the background; the emails arrive over the next minute.
      showToast(data.note || ('Sending previews to ' + email), 'success', 8000);
    })
    .catch(function(e) { showToast('Request failed: ' + e.message, 'error'); });
  }

  function verifyBatch() {
    var status = document.getElementById('verify-status');
    status.textContent = 'Verifying… (~20 seconds for 50 emails)';
    fetch('/sequences/api/leads/verify-batch', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.error) { status.textContent = 'Error: ' + d.error; showToast('Verification error: ' + d.error, 'error'); return; }
        var msg = 'Verified ' + d.verified + ' emails. Suppressed ' + d.suppressed + ' bad addresses. '
          + (d.remaining > 0 ? d.remaining + ' remaining.' : 'All verified!');
        status.textContent = msg;
        showToast(msg, 'success');
      })
      .catch(function() { status.textContent = 'Request failed.'; showToast('Request failed', 'error'); });
  }

  async function autoEnroll(seqId, seqName, audienceType) {
    var ok = await showConfirm(
      'Auto-enroll all un-enrolled ' + audienceType + ' leads into "' + seqName + '"? Already enrolled and suppressed contacts are skipped.',
      'Auto-Enroll ' + audienceType
    );
    if (!ok) return;

    fetch('/sequences/api/sequences/' + seqId + '/auto-enroll', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok) {
          showToast('Auto-enrolled ' + d.enrolled + ' leads. ' + d.skipped + ' skipped.', 'success');
          setTimeout(function() { location.reload(); }, 1500);
        } else {
          showToast('Error: ' + (d.error || 'Unknown error'), 'error');
        }
      })
      .catch(function() { showToast('Request failed', 'error'); });
  }

  var enrollSeqId = null;

  function enrollContacts(seqId, seqName) {
    enrollSeqId = seqId;
    document.getElementById('enroll-seq-name').textContent = seqName;
    document.getElementById('enroll-modal').classList.remove('hidden');
    document.getElementById('leads-table').innerHTML = '<tr><td colspan="5" class="px-3 py-8 text-center text-slate-400">Loading…</td></tr>';

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
      tbody.innerHTML = '<tr><td colspan="5" class="px-3 py-8 text-center text-slate-400">No contacts found</td></tr>';
      return;
    }
    tbody.innerHTML = filtered.map(function(l) {
      var disabled = l.already_enrolled || l.suppressed;
      return '<tr class="border-t border-slate-100 ' + (disabled ? 'opacity-40' : 'hover:bg-slate-50') + '">' +
        '<td class="px-3 py-2"><input type="checkbox" class="lead-check" value="' + l.id + '"' +
          (disabled ? ' disabled' : '') + ' onchange="updateCount()"></td>' +
        '<td class="px-3 py-2 text-slate-700">' + l.email + '</td>' +
        '<td class="px-3 py-2 text-slate-700">' + (l.first_name || '') + ' ' + (l.last_name || '') + '</td>' +
        '<td class="px-3 py-2"><span class="px-1.5 py-0.5 text-xs rounded-full font-medium ' +
          (l.audience_type === 'B2B' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700') + '">' +
          l.audience_type + '</span></td>' +
        '<td class="px-3 py-2 text-xs">' +
          (l.suppressed ? '<span class="text-red-500 font-medium">Suppressed</span>' :
           l.already_enrolled ? '<span class="text-slate-400">Enrolled</span>' :
           '<span class="text-emerald-600 font-medium">Ready</span>') +
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

  async function enrollSelected() {
    var spId = document.getElementById('enroll-sp').value;
    if (!spId) { showToast('Select a salesperson first', 'warn'); return; }
    var ids = Array.from(document.querySelectorAll('.lead-check:checked')).map(function(c) { return parseInt(c.value); });
    if (!ids.length) { showToast('Select at least one contact', 'warn'); return; }

    fetch('/sequences/api/sequences/' + enrollSeqId + '/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salesperson_id: parseInt(spId), lead_ids: ids }),
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      showToast('Enrolled ' + d.enrolled + ' contacts. Skipped: ' + d.skipped, 'success');
      closeEnroll();
      setTimeout(function() { location.reload(); }, 1500);
    });
  }

  function viewEnrollments(seqId, seqName) {
    document.getElementById('view-seq-name').textContent = seqName;
    document.getElementById('view-modal').classList.remove('hidden');
    document.getElementById('view-table').innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400">Loading…</td></tr>';

    fetch('/sequences/api/sequences/' + seqId + '/enrollments')
      .then(function(r) { return r.json(); })
      .then(function(rows) {
        if (!rows.length) {
          document.getElementById('view-table').innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400">No enrollments yet</td></tr>';
          return;
        }
        document.getElementById('view-table').innerHTML = rows.map(function(r) {
          var nextSend    = r.next_send_at ? new Date(r.next_send_at).toLocaleDateString() : '—';
          var statusColor = r.status === 'active' ? 'text-emerald-600' : r.status === 'completed' ? 'text-slate-400' : 'text-amber-600';
          return '<tr class="border-t border-slate-100 hover:bg-slate-50 transition-colors">' +
            '<td class="px-2 py-2 text-sm text-slate-700">' + r.email + (r.first_name ? '<br><span class="text-xs text-slate-400">' + r.first_name + ' ' + (r.last_name||'') + '</span>' : '') + '</td>' +
            '<td class="px-2 py-2 text-xs text-slate-600">' + (r.salesperson_name || '—') + '</td>' +
            '<td class="px-2 py-2 text-center text-slate-700">' + r.current_step + '</td>' +
            '<td class="px-2 py-2 text-center text-slate-700">' + r.emails_sent + '</td>' +
            '<td class="px-2 py-2 ' + statusColor + ' capitalize text-sm font-medium">' + r.status + (r.paused_reason ? ' <span class="text-slate-400 font-normal text-xs">(' + r.paused_reason + ')</span>' : '') + '</td>' +
            '<td class="px-2 py-2 text-xs text-slate-500">' + nextSend + '</td>' +
            '<td class="px-2 py-2">' +
              (r.status === 'active'
                ? '<button onclick="pauseEnrollment(' + r.id + ', this)" class="text-xs px-2.5 py-1 rounded-lg border border-amber-200 text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors">Pause</button>'
                : r.status === 'paused'
                  ? '<button onclick="resumeEnrollment(' + r.id + ', this)" class="text-xs px-2.5 py-1 rounded-lg border border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-colors">Resume</button>'
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
    if (!file) { showToast('Select a CSV file first', 'warn'); return; }
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
        var msg = 'Imported ' + d.imported + ' contacts. Skipped: ' + d.skipped;
        status.textContent = msg;
        status.style.color = '#059669';
        showToast(msg, 'success');
      })
      .catch(function() { status.textContent = 'Import failed'; status.style.color = '#dc2626'; showToast('Import failed', 'error'); });
    };
    reader.readAsText(file);
  }

  function loadReport() {
    fetch('/sequences/api/sequences/report')
      .then(function(r) { return r.json(); })
      .then(function(rows) {
        var tbody = document.getElementById('report-body');
        if (!rows || !rows.length) {
          tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-8 text-center text-slate-400">No data yet — send some emails first</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(function(r) {
          var openRate   = r.open_rate_pct   != null ? r.open_rate_pct   + '%' : '0.0%';
          var clickRate  = r.click_rate_pct  != null ? r.click_rate_pct  + '%' : '0.0%';
          var bounceRate = r.bounce_rate_pct != null ? r.bounce_rate_pct + '%' : '0.0%';
          var bounceClass = parseFloat(r.bounce_rate_pct) > 5 ? 'text-red-600 font-semibold' : 'text-slate-700';
          return '<tr class="border-t border-slate-100 hover:bg-slate-50 transition-colors">' +
            '<td class="px-4 py-2.5 font-semibold text-slate-800">' + r.sequence_name + '</td>' +
            '<td class="px-4 py-2.5 text-right text-slate-600">' + (r.total_sends || 0) + '</td>' +
            '<td class="px-4 py-2.5 text-right text-emerald-700 font-semibold">' + openRate + '</td>' +
            '<td class="px-4 py-2.5 text-right text-sky-700 font-semibold">'  + clickRate + '</td>' +
            '<td class="px-4 py-2.5 text-right ' + bounceClass + '">' + bounceRate + '</td>' +
          '</tr>';
        }).join('');
      })
      .catch(function() {
        document.getElementById('report-body').innerHTML =
          '<tr><td colspan="5" class="px-4 py-8 text-center text-red-400">Failed to load report</td></tr>';
      });
  }

  loadReport();
  </script>`;

  res.send(shell('Sequences', 'sequences', content, { user: req.user }));
});

module.exports = router;
