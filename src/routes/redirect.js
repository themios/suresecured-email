const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Every email link points to /r/:token
// This logs the click, sets the attribution cookie, then redirects to the destination
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

    // Log the click
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

    // Set attribution cookie (365 days)
    const cookieData = JSON.stringify({
      token,
      lead_id: record.lead_id,
      salesperson_id: record.salesperson_id,
      campaign_id: record.campaign_id,
      email_step: record.email_step,
    });

    res.cookie('ss_attribution', cookieData, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: false, // Must be readable by Shopify JS snippet
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      domain: process.env.COOKIE_DOMAIN || undefined,
    });

    // Build destination URL with tracking params appended
    const destination = new URL(
      record.destination_url || process.env.SITE_URL || 'https://suresecured.com'
    );
    destination.searchParams.set('ss_token', token);
    destination.searchParams.set('ss_sp', record.salesperson_id);

    res.redirect(302, destination.toString());
  } catch (err) {
    console.error('Redirect error:', err);
    res.redirect(process.env.SITE_URL || 'https://suresecured.com');
  }
});

module.exports = router;
