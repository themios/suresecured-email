const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { v4: uuidv4 } = require('uuid');

// Generate tracking links for a batch of leads
// POST /api/generate-links
// Body: { leads: [{ lead_id, salesperson_id, campaign_id, email_step, destination_url }] }
router.post('/generate-links', async (req, res) => {
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

// Record a form submission with attribution
// POST /api/form-submission
router.post('/form-submission', async (req, res) => {
  const { token, salesperson_id, lead_id, form_type, submitter_email, submitter_name, raw_data } = req.body;

  try {
    await pool.query(
      `INSERT INTO form_submissions (token, lead_id, salesperson_id, form_type, submitter_email, submitter_name, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [token || null, lead_id || null, salesperson_id || null, form_type || 'quote', submitter_email, submitter_name, raw_data || {}]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Form submission error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add a salesperson
// POST /api/salespeople
router.post('/salespeople', async (req, res) => {
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

// Add a lead
// POST /api/leads
router.post('/leads', async (req, res) => {
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

// Dashboard data endpoint
// GET /api/stats
router.get('/stats', async (req, res) => {
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

// Get the right destination URL for a lead segment
// GET /api/landing-page?audience_type=B2C&product_interest=door&location_type=la_county&intent_level=normal&angle=product
router.get('/landing-page', async (req, res) => {
  const { audience_type, product_interest, location_type, intent_level, angle } = req.query;

  try {
    // Try progressively broader matches until one is found
    const queries = [
      { audience_type, product_interest, location_type, intent_level, angle },
      { audience_type, product_interest, location_type: null, intent_level, angle },
      { audience_type, product_interest, location_type: null, intent_level: null, angle },
      { audience_type, product_interest: null, location_type, intent_level: null, angle: null },
      { audience_type, product_interest: null, location_type: null, intent_level: 'normal', angle: 'reconnect' },
    ];

    for (const q of queries) {
      const conditions = Object.entries(q)
        .map(([k, v]) => v ? `${k} = '${v}'` : `${k} IS NULL`)
        .join(' AND ');

      const result = await pool.query(
        `SELECT * FROM landing_page_matrix WHERE ${conditions} AND active = true LIMIT 1`
      );
      if (result.rows.length > 0) return res.json(result.rows[0]);
    }

    res.json({ destination_url: '/', label: 'Fallback – homepage' });
  } catch (err) {
    console.error('Landing page matrix error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get full landing page matrix
// GET /api/landing-page/all
router.get('/landing-page/all', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM landing_page_matrix ORDER BY audience_type, product_interest, intent_level');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update a landing page matrix entry
// PUT /api/landing-page/:id
router.put('/landing-page/:id', async (req, res) => {
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

// Upload a list of emails to suppress (existing Shopify customers, unsubscribes)
// POST /api/suppression
// Body: { emails: ['a@b.com', ...], reason: 'existing_customer' }
router.post('/suppression', async (req, res) => {
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

// Check if an email is suppressed before adding to a campaign
// GET /api/suppression/check?email=foo@bar.com
router.get('/suppression/check', async (req, res) => {
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

// ─── Salesperson Tracking Number ──────────────────────────────────────────

// Assign a CallRail tracking number to a salesperson
// PUT /api/salespeople/:id/tracking-number
router.put('/salespeople/:id/tracking-number', async (req, res) => {
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
