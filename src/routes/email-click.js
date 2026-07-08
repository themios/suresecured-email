const express = require('express');
const { pool } = require('../db');
const { setFirstTouchAttribution } = require('../lib/attribution');
const { buildAttributionPayload, setAttributionCookie, appendAttributionToUrl } = require('../lib/attributionCookie');

const router = express.Router();

router.get('/:token', async (req, res) => {
  const fallback = process.env.SITE_URL || 'https://suresecured.com';

  let destination;
  let emailSendId;
  let salespersonId;
  let leadId;

  try {
    const { rows } = await pool.query(
      `SELECT ett.destination_url, ett.email_send_id, es.salesperson_id, es.lead_id
       FROM email_tracking_tokens ett
       JOIN email_sends es ON es.id = ett.email_send_id
       WHERE ett.token = $1`,
      [req.params.token]
    );
    if (!rows[0]) return res.redirect(302, fallback);
    destination = rows[0].destination_url;
    emailSendId = rows[0].email_send_id;
    salespersonId = rows[0].salesperson_id;
    leadId = rows[0].lead_id;
  } catch (err) {
    console.error('[email-click] lookup error:', err.message);
    return res.redirect(302, fallback);
  }

  const dest = appendAttributionToUrl(destination, req.params.token, salespersonId);
  setAttributionCookie(res, buildAttributionPayload({
    token: req.params.token,
    salespersonId,
    leadId,
  }));

  res.redirect(302, dest);

  pool.query(
    `UPDATE email_sends SET click_count = click_count + 1 WHERE id = $1`,
    [emailSendId]
  ).catch(err => console.error('[email-click] db update error:', err.message));

  if (leadId && salespersonId) {
    setFirstTouchAttribution({
      leadId,
      salespersonId,
      source: 'email_click',
    }).catch(() => {});
  }
});

module.exports = router;
