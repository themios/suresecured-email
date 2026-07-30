// src/routes/telnyx.js
// Mounted at /telnyx-hooks — MUST be after express.json() in index.js
//
// 10DLC REQUIRED: US carriers block all A2P SMS until Brand + Campaign are
// registered in Telnyx portal (Messaging > Brands & Campaigns). 3-7 day approval.
// This inbound webhook works immediately; outbound SMS (cron.js) is gated by 10DLC.
const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const { verifyTelnyxWebhook } = require('../lib/webhookVerify');

/**
 * POST /telnyx-hooks/sms
 * Telnyx inbound SMS webhook — fires on message.received events.
 */
router.post('/sms', async (req, res) => {
  if (!verifyTelnyxWebhook(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const eventType = req.body?.data?.event_type;
    if (eventType !== 'message.received') {
      return res.status(200).json({ ok: true }); // ignore status events etc.
    }

    const payload     = req.body.data.payload || {};
    const fromNumber  = payload.from?.phone_number;
    const toNumber    = payload.to?.[0]?.phone_number;
    const messageText = payload.text || '';

    if (!fromNumber) {
      console.warn('[telnyx/sms] missing from_number in payload');
      return res.status(200).json({ ok: true });
    }

    // Resolve the tenant from the Telnyx number the SMS was sent TO (mirrors
    // retell.js's voice pattern). This must happen before the lead lookup:
    // leads.phone is unique per tenant, not globally, so an unscoped lookup
    // could match a different tenant's lead who happens to share that phone
    // number with the real sender.
    const { rows: clientRows } = await pool.query(
      `SELECT id FROM clients WHERE telnyx_phone_number = $1 AND active = true LIMIT 1`,
      [toNumber]
    );
    const clientId = clientRows[0]?.id || null;

    let leadId = null;
    if (clientId) {
      const { rows: leadRows } = await pool.query(
        `SELECT id FROM leads WHERE phone = $1 AND client_id = $2 LIMIT 1`,
        [fromNumber, clientId]
      );
      leadId = leadRows[0]?.id || null;
    }

    // Insert inbound SMS record
    await pool.query(
      `INSERT INTO sms_messages
         (lead_id, client_id, direction, from_number, to_number, body, status, sent_at)
       VALUES ($1, $2, 'inbound', $3, $4, $5, 'received', NOW())`,
      [leadId, clientId, fromNumber, toNumber, messageText]
    );

    // Pause active enrollment (mirrors email reply-pause logic)
    if (leadId) {
      const result = await pool.query(
        `UPDATE contact_enrollments
         SET status = 'paused', paused_reason = 'sms_reply', replied_at = NOW()
         WHERE lead_id = $1 AND status = 'active'`,
        [leadId]
      );
      if (result.rowCount > 0) {
        console.log(`[telnyx/sms] paused ${result.rowCount} enrollment(s) for lead ${leadId} (sms_reply)`);
      }
    }

    console.log(`[telnyx/sms] received from=${fromNumber} lead_id=${leadId} chars=${messageText.length}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[telnyx/sms] error:', err.message);
    return res.status(200).json({ ok: true }); // always 200 so Telnyx doesn't retry
  }
});

module.exports = router;
