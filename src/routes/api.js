const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { v4: uuidv4 } = require('uuid');
const { requireClientApiKey, requireAdminAuth } = require('../middleware/apiAuth');
const { classifyAudience } = require('../lib/leadAudience');
const { notifyNewLead } = require('../lib/telegram');
const { resolveOwner } = require('../lib/assignment');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Create (or match) a lead for a website form submission and enroll it in the
 * sequence matching the form type. Best effort by design: a failure here must
 * never lose the submission itself, so it returns null and the row is still
 * written.
 *
 * Deliberately NOT reusing captureLeadFromMessage: that guards against bulk and
 * automated senders, which is right for a mailbox but wrong here -- a form fill
 * is an explicit human action and must never be filtered out as "automated."
 */
async function captureLeadFromSubmission({ clientId, salespersonId, formType, email, name }) {
  if (!clientId) return null;
  try {
    const { rows: cfg } = await pool.query(
      `SELECT form_capture_enabled, inbound_sequence_id, inbound_sequence_id_b2b
         FROM client_email_config WHERE client_id = $1`, [clientId]
    );
    if (!cfg[0]?.form_capture_enabled) return null;

    // Without an owner the lead is created but never enrolled -- the exact
    // failure that stranded five dealer enquiries. Fall back to the tenant's
    // default rep when the submission carries no attribution.
    const ownerId = await resolveOwner(pool, clientId, salespersonId);

    const { audience } = classifyAudience({ formType, email });
    const clean = String(email || '').trim().toLowerCase() || null;

    // Match an existing lead first so a repeat submitter is not duplicated and
    // is not re-enrolled from the top of the sequence.
    if (clean) {
      const { rows: hit } = await pool.query(
        'SELECT id FROM leads WHERE LOWER(email) = $1 AND client_id = $2', [clean, clientId]
      );
      if (hit[0]) return hit[0].id;
    }

    const [firstName, ...rest] = String(name || '').trim().split(/\s+/);
    const { rows: created } = await pool.query(`
      INSERT INTO leads (email, first_name, last_name, stage, audience_type, client_id, salesperson_id, created_at)
      VALUES ($1, $2, $3, 'new', $4, $5, $6, NOW())
      RETURNING id
    `, [clean, firstName || clean || 'Website enquiry', rest.join(' ') || '', audience, clientId, ownerId]);
    const leadId = created[0]?.id;
    if (!leadId) return null;

    await pool.query(
      `INSERT INTO lead_notes (lead_id, client_id, author_name, content) VALUES ($1, $2, $3, $4)`,
      [leadId, clientId, 'Website form',
       `[${formType} form] ${name || '(no name)'} <${clean || 'no email supplied'}>\nClassified ${audience} from the form type.` +
       (clean ? '' : '\nNo email address supplied — follow up by phone or social.')]
    );

    notifyNewLead({ firstName: firstName || '', lastName: rest.join(' '), email: clean || '(no email)', source: `${formType} form · ${audience}` }).catch(() => {});

    // No address means nothing to send to; the lead still exists for manual follow-up.
    const sequenceId = audience === 'B2B'
      ? (cfg[0].inbound_sequence_id_b2b || cfg[0].inbound_sequence_id)
      : cfg[0].inbound_sequence_id;
    if (clean && sequenceId && ownerId) {
      await pool.query(`
        INSERT INTO contact_enrollments (lead_id, sequence_id, salesperson_id, client_id, status, enrolled_at)
        VALUES ($1, $2, $3, $4, 'active', NOW()) ON CONFLICT DO NOTHING
      `, [leadId, sequenceId, ownerId, clientId]);
    }
    return leadId;
  } catch (err) {
    console.error('[form-capture] could not create lead:', err.message);
    return null;
  }
}

// Record a form submission with attribution (Shopify Flow / server-to-server)
// POST /api/form-submission — requires X-Client-Api-Key
router.post('/form-submission', requireClientApiKey, async (req, res) => {
  const { token, salesperson_id, lead_id, form_type, submitter_email, submitter_name, raw_data } = req.body;

  // External callers (e.g. GHL merge tags) may send unresolved placeholders or
  // empty strings instead of omitting the field — validate shape before it hits
  // the UUID/integer columns, since those crash the query rather than reject cleanly.
  const safeToken = typeof token === 'string' && UUID_RE.test(token) ? token : null;
  const safeSalespersonId = toInt(salesperson_id);
  const safeLeadId = toInt(lead_id);

  try {
    // req.apiClientId is the tenant behind the API key (null only for the shared
    // platform key). Stamp it so the submission is owned by the right tenant.
    // Turn the submission into a lead. A quote or become-a-dealer form is the
    // highest-intent contact the business gets and the person is expressly
    // asking to be contacted -- but until this existed the row landed in
    // form_submissions and nothing else, so inbound dealer enquiries sat
    // unassigned and unanswered. The mailbox poller could never cover this:
    // forms arrive as a server-to-server POST and never touch an inbox.
    const leadId = safeLeadId || await captureLeadFromSubmission({
      clientId: req.apiClientId,
      salespersonId: safeSalespersonId,
      formType: form_type || 'quote',
      email: submitter_email,
      name: submitter_name,
    });

    await pool.query(
      `INSERT INTO form_submissions (token, lead_id, salesperson_id, form_type, submitter_email, submitter_name, raw_data, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [safeToken, leadId, safeSalespersonId, form_type || 'quote', submitter_email || null, submitter_name || null, raw_data || {}, req.apiClientId]
    );
    res.json({ ok: true, lead_id: leadId });
  } catch (err) {
    console.error('Form submission error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Generate tracking links for a batch of leads
router.post('/generate-links', requireAdminAuth, async (req, res) => {
  const cid = req.user.client_id;
  if (!cid) return res.status(403).json({ error: 'No tenant context' });
  const { leads } = req.body;
  if (!Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'leads array required' });
  }

  try {
    const results = [];
    for (const lead of leads) {
      const token = uuidv4();
      await pool.query(
        `INSERT INTO tracking_tokens (token, lead_id, salesperson_id, campaign_id, email_step, destination_url, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          token,
          lead.lead_id,
          lead.salesperson_id,
          lead.campaign_id || null,
          lead.email_step || 1,
          lead.destination_url || process.env.SITE_URL,
          cid,
        ]
      );
      results.push({
        lead_id: lead.lead_id,
        token,
        tracking_url: `${process.env.TRACKER_URL}/r/${token}`,
      });
    }
    res.json({ links: results });
  } catch (err) {
    console.error('Generate links error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/salespeople', requireAdminAuth, async (req, res) => {
  const cid = req.user.client_id;
  if (!cid) return res.status(403).json({ error: 'No tenant context' });
  const { name, email, commission_rate } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO salespeople (name, email, commission_rate, client_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, email, commission_rate || 100, cid]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Add salesperson error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/leads', requireAdminAuth, async (req, res) => {
  const cid = req.user.client_id;
  if (!cid) return res.status(403).json({ error: 'No tenant context' });
  const { email, first_name, last_name, phone, city, audience_type, product_interest, salesperson_id } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO leads (email, first_name, last_name, phone, city, audience_type, product_interest, salesperson_id, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [email, first_name, last_name, phone, city, audience_type || 'B2C', product_interest, salesperson_id, cid]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Add lead error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/stats', requireAdminAuth, async (req, res) => {
  const cid = req.user.client_id;
  if (!cid) return res.status(403).json({ error: 'No tenant context' });
  try {
    const [spStats, recentOrders, recentForms] = await Promise.all([
      pool.query(`
        SELECT
          s.id,
          s.name,
          s.email,
          s.commission_rate,
          COUNT(DISTINCT l.id) AS total_leads,
          COUNT(DISTINCT c.id) AS total_clicks,
          COUNT(DISTINCT fs.id) AS form_submissions,
          COUNT(DISTINCT o.id) AS orders,
          COALESCE(SUM(o.amount), 0) AS total_revenue,
          COALESCE(SUM(cm.commission_earned), 0) AS total_commission
        FROM salespeople s
        LEFT JOIN leads l ON l.salesperson_id = s.id
        LEFT JOIN clicks c ON c.salesperson_id = s.id
        LEFT JOIN form_submissions fs ON fs.salesperson_id = s.id
        LEFT JOIN orders o ON o.salesperson_id = s.id
        LEFT JOIN commissions cm ON cm.salesperson_id = s.id
        WHERE s.active = true AND s.client_id = $1
        GROUP BY s.id, s.name, s.email, s.commission_rate
        ORDER BY total_revenue DESC
      `, [cid]),
      pool.query(`
        SELECT o.*, s.name AS salesperson_name
        FROM orders o
        LEFT JOIN salespeople s ON s.id = o.salesperson_id
        WHERE o.client_id = $1
        ORDER BY o.ordered_at DESC LIMIT 20
      `, [cid]),
      pool.query(`
        SELECT fs.*, s.name AS salesperson_name
        FROM form_submissions fs
        LEFT JOIN salespeople s ON s.id = fs.salesperson_id
        WHERE fs.client_id = $1
        ORDER BY fs.submitted_at DESC LIMIT 20
      `, [cid]),
    ]);

    res.json({
      salespeople: spStats.rows,
      recent_orders: recentOrders.rows,
      recent_form_submissions: recentForms.rows,
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Landing Page Matrix ───────────────────────────────────────────────────

async function findLandingPageMatch(criteria) {
  const queries = [
    criteria,
    { ...criteria, location_type: null },
    { ...criteria, location_type: null, intent_level: null },
    { ...criteria, product_interest: null, location_type: criteria.location_type, intent_level: null, angle: null },
    { audience_type: criteria.audience_type, product_interest: null, location_type: null, intent_level: 'normal', angle: 'reconnect' },
  ];

  for (const q of queries) {
    const parts = ['active = true'];
    const params = [];
    let n = 1;
    for (const col of ['audience_type', 'product_interest', 'location_type', 'intent_level', 'angle']) {
      if (q[col] != null && q[col] !== '') {
        parts.push(`${col} = $${n++}`);
        params.push(q[col]);
      } else {
        parts.push(`${col} IS NULL`);
      }
    }
    const result = await pool.query(
      `SELECT * FROM landing_page_matrix WHERE ${parts.join(' AND ')} LIMIT 1`,
      params
    );
    if (result.rows.length > 0) return result.rows[0];
  }
  return null;
}

router.get('/landing-page', requireAdminAuth, async (req, res) => {
  const { audience_type, product_interest, location_type, intent_level, angle } = req.query;

  try {
    const row = await findLandingPageMatch({
      audience_type: audience_type || null,
      product_interest: product_interest || null,
      location_type: location_type || null,
      intent_level: intent_level || null,
      angle: angle || null,
    });
    if (row) return res.json(row);
    res.json({ destination_url: '/', label: 'Fallback – homepage' });
  } catch (err) {
    console.error('Landing page matrix error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/landing-page/all', requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM landing_page_matrix ORDER BY audience_type, product_interest, intent_level');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/landing-page/:id', requireAdminAuth, async (req, res) => {
  const { destination_url, label, active } = req.body;
  try {
    const result = await pool.query(
      `UPDATE landing_page_matrix SET destination_url = COALESCE($1, destination_url),
       label = COALESCE($2, label), active = COALESCE($3, active)
       WHERE id = $4 RETURNING *`,
      [destination_url, label, active, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Suppression List ──────────────────────────────────────────────────────

router.post('/suppression', requireAdminAuth, async (req, res) => {
  const cid = req.user.client_id;
  const { emails, reason } = req.body;
  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'emails array required' });
  }

  try {
    let added = 0;
    let skipped = 0;
    for (const email of emails) {
      const clean = (email || '').trim().toLowerCase();
      if (!clean || !clean.includes('@')) { skipped++; continue; }
      try {
        // Global suppression list, tagged with the acting tenant.
        await pool.query(
          `INSERT INTO suppression_list (email, reason, client_id) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING`,
          [clean, reason || 'existing_customer', cid]
        );
        added++;
      } catch { skipped++; }
    }
    res.json({ added, skipped, total: emails.length });
  } catch (err) {
    console.error('Suppression upload error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/suppression/check', requireAdminAuth, async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const result = await pool.query(
      'SELECT * FROM suppression_list WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    res.json({ suppressed: result.rows.length > 0, reason: result.rows[0]?.reason || null });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/salespeople/:id/tracking-number', requireAdminAuth, async (req, res) => {
  const cid = req.user.client_id;
  if (!cid) return res.status(403).json({ error: 'No tenant context' });
  const { tracking_phone_number, callrail_number_id } = req.body;
  try {
    const result = await pool.query(
      `UPDATE salespeople SET tracking_phone_number = $1, callrail_number_id = $2
       WHERE id = $3 AND client_id = $4 RETURNING id, name, email, tracking_phone_number`,
      [tracking_phone_number, callrail_number_id || null, req.params.id, cid]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
