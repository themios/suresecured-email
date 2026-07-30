// src/routes/twilio.js — Mounted at /twilio-hooks. Twilio POSTs form-encoded
// (not JSON), so each route attaches its own express.urlencoded() rather than
// relying on the app-wide express.json().
//
// Unlike Telnyx (one platform webhook secret), Twilio signature verification
// is per-tenant: each tenant has their own Auth Token, so the tenant must be
// resolved from the request BEFORE the signature can be checked.
const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const { verifyTwilioSignature, sendSms } = require('../lib/twilio');
const { safeDecrypt } = require('../lib/crypto');

const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const HELP_KEYWORDS = new Set(['help', 'info']);

function requestUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.get('host')}${req.originalUrl}`;
}

/**
 * POST /twilio-hooks/sms
 * Inbound SMS. Twilio expects a 200 (empty body is fine; we never reply via
 * TwiML, only via the REST API, so behavior matches the Telnyx path exactly).
 */
router.post('/sms', express.urlencoded({ extended: false }), async (req, res) => {
  const toNumber   = req.body.To;
  const fromNumber = req.body.From;
  const messageText = req.body.Body || '';
  const signature = req.headers['x-twilio-signature'];

  if (!fromNumber || !toNumber) {
    console.warn('[twilio/sms] missing From/To in payload');
    return res.status(200).send('');
  }

  // Resolve the tenant from the Twilio number the SMS was sent TO, then
  // verify the signature with THAT tenant's own Auth Token (BYO credentials,
  // so there is no single platform-wide secret to check against up front).
  const { rows: clientRows } = await pool.query(
    `SELECT id, twilio_auth_token_enc FROM clients WHERE twilio_phone_number = $1 AND sms_provider = 'twilio' AND active = true LIMIT 1`,
    [toNumber]
  );
  const client = clientRows[0];
  if (!client) {
    console.warn(`[twilio/sms] no tenant configured for Twilio number ${toNumber}`);
    return res.status(200).send('');
  }

  const authToken = safeDecrypt(client.twilio_auth_token_enc);
  if (!verifyTwilioSignature(requestUrl(req), req.body, authToken, signature)) {
    console.warn('[twilio/sms] signature verification failed');
    return res.status(401).send('Unauthorized');
  }

  const clientId = client.id;

  // leads.phone is unique per tenant, not globally, so scope the lookup —
  // same lesson as the Telnyx inbound handler.
  const { rows: leadRows } = await pool.query(
    `SELECT id FROM leads WHERE phone = $1 AND client_id = $2 LIMIT 1`,
    [fromNumber, clientId]
  );
  const leadId = leadRows[0]?.id || null;

  await pool.query(
    `INSERT INTO sms_messages
       (lead_id, client_id, direction, from_number, to_number, body, status, provider, twilio_message_sid, sent_at)
     VALUES ($1, $2, 'inbound', $3, $4, $5, 'received', 'twilio', $6, NOW())`,
    [leadId, clientId, fromNumber, toNumber, messageText, req.body.MessageSid || null]
  );

  const keyword = messageText.trim().toLowerCase();
  const twilioCreds = { accountSid: client.twilio_account_sid, authToken, from: toNumber };

  if (STOP_KEYWORDS.has(keyword)) {
    if (leadId) {
      await pool.query(`UPDATE leads SET consent_sms = false, consent_sms_at = NOW() WHERE id = $1`, [leadId]);
      await pool.query(
        `UPDATE contact_enrollments SET status = 'cancelled', paused_reason = 'sms_opt_out' WHERE lead_id = $1 AND status IN ('active', 'paused')`,
        [leadId]
      );
      console.log(`[twilio/sms] STOP received, consent revoked for lead ${leadId}`);
    }
    await sendSms(fromNumber, 'You have been unsubscribed and will not receive further texts. Reply HELP for help.', twilioCreds)
      .catch(err => console.warn('[twilio/sms] STOP confirmation send failed:', err.message));
    return res.status(200).send('');
  }

  if (HELP_KEYWORDS.has(keyword)) {
    await sendSms(fromNumber, 'SalesWyze: msg & data rates may apply. Reply STOP to unsubscribe. Support: support@saleswyze.com', twilioCreds)
      .catch(err => console.warn('[twilio/sms] HELP reply send failed:', err.message));
    return res.status(200).send('');
  }

  if (leadId) {
    const result = await pool.query(
      `UPDATE contact_enrollments SET status = 'paused', paused_reason = 'sms_reply', replied_at = NOW() WHERE lead_id = $1 AND status = 'active'`,
      [leadId]
    );
    if (result.rowCount > 0) console.log(`[twilio/sms] paused ${result.rowCount} enrollment(s) for lead ${leadId} (sms_reply)`);
  }

  console.log(`[twilio/sms] received from=${fromNumber} lead_id=${leadId} chars=${messageText.length}`);
  res.status(200).send('');
});

/**
 * POST /twilio-hooks/status
 * Delivery status callback (set as StatusCallback when sending). Twilio's
 * own Account SID isn't in this payload by default, but MessageSid uniquely
 * identifies the row we already wrote at send time, so no tenant resolution
 * (and therefore no signature verification requiring a decrypted token) is
 * needed to find it -- MessageSid is Twilio's own unguessable identifier.
 */
router.post('/status', express.urlencoded({ extended: false }), async (req, res) => {
  const sid = req.body.MessageSid;
  const status = req.body.MessageStatus; // queued|sent|delivered|undelivered|failed
  if (!sid || !status) return res.status(200).send('');

  try {
    if (status === 'delivered') {
      await pool.query(`UPDATE sms_messages SET status = 'delivered', delivered_at = NOW() WHERE twilio_message_sid = $1`, [sid]);
    } else if (status === 'failed' || status === 'undelivered') {
      const errDetail = req.body.ErrorMessage || req.body.ErrorCode || status;
      await pool.query(`UPDATE sms_messages SET status = 'failed', error_reason = $2 WHERE twilio_message_sid = $1`, [sid, String(errDetail).slice(0, 500)]);
    }
  } catch (err) {
    console.error('[twilio/status] update failed:', err.message);
  }
  res.status(200).send('');
});

module.exports = router;
