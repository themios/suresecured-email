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
const { sendSms } = require('../lib/telnyx');

// Standard CTIA-recognized keywords. Case-insensitive, exact match on the
// trimmed body (a message that merely CONTAINS "stop" mid-sentence must not
// trigger this — only the keyword itself, matching how carriers require it).
const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const HELP_KEYWORDS = new Set(['help', 'info']);

/**
 * POST /telnyx-hooks/sms
 * Telnyx inbound SMS webhook — fires on message.received (inbound text) and
 * message.finalized (outbound delivery status) events.
 */
router.post('/sms', async (req, res) => {
  if (!verifyTelnyxWebhook(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const eventType = req.body?.data?.event_type;

    // Outbound delivery status: update the matching sms_messages row so a
    // failed delivery is visible the same way a failed email is, instead of
    // sitting silently as status='sent' forever.
    if (eventType === 'message.finalized') {
      const payload = req.body.data.payload || {};
      const telnyxId = payload.id;
      const toStatus = payload.to?.[0]?.status; // 'delivered' | 'sending_failed' | 'delivery_failed' etc.
      if (telnyxId && toStatus) {
        if (toStatus === 'delivered') {
          await pool.query(
            `UPDATE sms_messages SET status = 'delivered', delivered_at = NOW() WHERE telnyx_message_id = $1`,
            [telnyxId]
          );
        } else if (toStatus.includes('fail')) {
          const errDetail = payload.errors?.[0]?.detail || toStatus;
          await pool.query(
            `UPDATE sms_messages SET status = 'failed', error_reason = $2 WHERE telnyx_message_id = $1`,
            [telnyxId, String(errDetail).slice(0, 500)]
          );
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (eventType !== 'message.received') {
      return res.status(200).json({ ok: true }); // ignore other status events
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

    const keyword = messageText.trim().toLowerCase();

    // STOP: revoke consent immediately and permanently. Reusing consent_sms
    // (rather than a parallel opted-out flag) means cron.js's existing
    // consent gate on outbound sends closes automatically -- there is only
    // one flag to check, so it cannot drift out of sync with a second one.
    // This must work even if leadId could not be resolved to a specific lead
    // (no client match), so the confirmation reply always goes out regardless.
    if (STOP_KEYWORDS.has(keyword)) {
      if (leadId) {
        await pool.query(
          `UPDATE leads SET consent_sms = false, consent_sms_at = NOW() WHERE id = $1`,
          [leadId]
        );
        await pool.query(
          `UPDATE contact_enrollments SET status = 'cancelled', paused_reason = 'sms_opt_out' WHERE lead_id = $1 AND status IN ('active', 'paused')`,
          [leadId]
        );
        console.log(`[telnyx/sms] STOP received, consent revoked for lead ${leadId}`);
      }
      // Carrier best practice: confirm the opt-out so the sender is not left
      // wondering whether it worked. Best-effort -- a failed confirmation must
      // never re-throw and skip recording the opt-out above.
      await sendSms(fromNumber, 'You have been unsubscribed and will not receive further texts. Reply HELP for help.', toNumber)
        .catch(err => console.warn('[telnyx/sms] STOP confirmation send failed:', err.message));
      return res.status(200).json({ ok: true });
    }

    if (HELP_KEYWORDS.has(keyword)) {
      await sendSms(fromNumber, 'SalesWyze: msg & data rates may apply. Reply STOP to unsubscribe. Support: support@saleswyze.com', toNumber)
        .catch(err => console.warn('[telnyx/sms] HELP reply send failed:', err.message));
      return res.status(200).json({ ok: true });
    }

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
