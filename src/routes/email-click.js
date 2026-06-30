const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /e/:token
// Public — no auth. Redirects to destination URL and increments click_count.
router.get('/:token', async (req, res) => {
  const fallback = process.env.SITE_URL || 'https://suresecured.com';

  let destination;
  let emailSendId;

  try {
    const { rows } = await pool.query(
      `SELECT ett.destination_url, ett.email_send_id
       FROM email_tracking_tokens ett
       WHERE ett.token = $1`,
      [req.params.token]
    );
    if (!rows[0]) return res.redirect(302, fallback);
    destination = rows[0].destination_url;
    emailSendId = rows[0].email_send_id;
  } catch (err) {
    console.error('[email-click] lookup error:', err.message);
    return res.redirect(302, fallback);
  }

  // Redirect immediately — fire-and-forget click_count increment
  res.redirect(302, destination);

  pool.query(
    `UPDATE email_sends SET click_count = click_count + 1 WHERE id = $1`,
    [emailSendId]
  ).catch(err => console.error('[email-click] db update error:', err.message));
});

module.exports = router;
