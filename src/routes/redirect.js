const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { setFirstTouchAttribution } = require('../lib/attribution');
const { buildAttributionPayload, setAttributionCookie, appendAttributionToUrl } = require('../lib/attributionCookie');

router.get('/:token', async (req, res) => {
  const { token } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM tracking_tokens WHERE token = $1',
      [token]
    );

    if (result.rows.length === 0) {
      return res.redirect(process.env.SITE_URL || 'https://suresecured.com');
    }

    const record = result.rows[0];

    await pool.query(
      `INSERT INTO clicks (token, lead_id, salesperson_id, ip_address, user_agent, referrer)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        token,
        record.lead_id,
        record.salesperson_id,
        req.ip,
        req.headers['user-agent'],
        req.headers['referer'] || null,
      ]
    );

    if (record.lead_id && record.salesperson_id) {
      setFirstTouchAttribution({
        leadId: record.lead_id,
        salespersonId: record.salesperson_id,
        source: 'tracking_click',
        clientId: record.client_id,
      }).catch(() => {});
    }

    const payload = buildAttributionPayload({
      token,
      salespersonId: record.salesperson_id,
      leadId: record.lead_id,
    });
    setAttributionCookie(res, payload);

    const dest = appendAttributionToUrl(
      record.destination_url,
      token,
      record.salesperson_id
    );
    res.redirect(302, dest);
  } catch (err) {
    console.error('Redirect error:', err);
    res.redirect(process.env.SITE_URL || 'https://suresecured.com');
  }
});

module.exports = router;
