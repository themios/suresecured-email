const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { v4: uuidv4 } = require('uuid');
const { requireClientApiKey, requireAdminAuth } = require('../middleware/apiAuth');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
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
    await pool.query(
      `INSERT INTO form_submissions (token, lead_id, salesperson_id, form_type, submitter_email, submitter_name, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [safeToken, safeLeadId, safeSalespersonId, form_type || 'quote', submitter_email || null, submitter_name || null, raw_data || {}]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Form submission error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Generate tracking links for a batch of leads
router.post('/generate-links', requireAdminAuth, async (req, res) => {
  const { leads } = req.body;
  if (!Array.isArray(leads) || leads.length === 0) {
    return res.status(400).json({ error: 'leads array required' });
  }

  try {
    const results = [];
    for (const lead of leads) {
      const token = uuidv4();
      await pool.query(
        `INSERT INTO tracking_tokens (token, lead_id, salesperson_id, campaign_id, email_step, destination_url)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          token,
          lead.lead_id,
          lead.salesperson_id,
          lead.campaign_id || null,
          lead.email_step || 1,
          lead.destination_url || process.env.SITE_URL,
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
  const { name, email, commission_rate } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO salespeople (name, email, commission_rate) VALUES ($1, $2, $3) RETURNING *`,
      [name, email, commission_rate || 100]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Add salesperson error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/leads', requireAdminAuth, async (req, res) => {
  const { email, first_name, last_name, phone, city, audience_type, product_interest, salesperson_id } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO leads (email, first_name, last_name, phone, city, audience_type, product_interest, salesperson_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [email, first_name, last_name, phone, city, audience_type || 'B2C', product_interest, salesperson_id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Add lead error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/stats', requireAdminAuth, async (req, res) => {
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
        WHERE s.active = true
        GROUP BY s.id, s.name, s.email, s.commission_rate
        ORDER BY total_revenue DESC
      `),
      pool.query(`
        SELECT o.*, s.name AS salesperson_name
        FROM orders o
        LEFT JOIN salespeople s ON s.id = o.salesperson_id
        ORDER BY o.ordered_at DESC LIMIT 20
      `),
      pool.query(`
        SELECT fs.*, s.name AS salesperson_name
        FROM form_submissions fs
        LEFT JOIN salespeople s ON s.id = fs.salesperson_id
        ORDER BY fs.submitted_at DESC LIMIT 20
      `),
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
        await pool.query(
          `INSERT INTO suppression_list (email, reason) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`,
          [clean, reason || 'existing_customer']
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
  const { tracking_phone_number, callrail_number_id } = req.body;
  try {
    const result = await pool.query(
      `UPDATE salespeople SET tracking_phone_number = $1, callrail_number_id = $2
       WHERE id = $3 RETURNING id, name, email, tracking_phone_number`,
      [tracking_phone_number, callrail_number_id || null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
