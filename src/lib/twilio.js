// src/lib/twilio.js — Twilio REST API wrapper, mirrors lib/telnyx.js's shape
// so cron.js can dispatch to either provider through the same interface.
// Unlike Telnyx (one platform account, tenants get an assigned number),
// Twilio credentials are BYO per tenant: each tenant supplies their own
// Account SID, Auth Token, and phone number in Settings > Phone & SMS.
const https = require('https');
const crypto = require('crypto');

function twilioRequest(accountSid, authToken, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const req = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Send outbound SMS via a tenant's own Twilio account.
 * @param {string} to - Recipient E.164 number
 * @param {string} body - SMS message text
 * @param {{accountSid: string, authToken: string, from: string}} creds
 * @returns {{ ok: boolean, messageId?: string, error?: string }}
 */
async function sendSms(to, body, creds) {
  if (!creds?.accountSid || !creds?.authToken || !creds?.from) {
    return { ok: false, error: 'Twilio is not configured for this account.' };
  }
  const params = { To: to, From: creds.from, Body: body };
  // Delivery receipts: without this Twilio never calls back, and sent SMS
  // stays at status='sent' forever with no delivered/failed signal.
  const statusCallback = process.env.TRACKER_URL
    ? `${process.env.TRACKER_URL}/twilio-hooks/status`
    : null;
  if (statusCallback) params.StatusCallback = statusCallback;
  const result = await twilioRequest(creds.accountSid, creds.authToken, params);
  if (result.status >= 200 && result.status < 300) {
    return { ok: true, messageId: result.body.sid };
  }
  return { ok: false, error: result.body?.message || JSON.stringify(result.body) };
}

/**
 * Verify an inbound Twilio webhook request came from Twilio, per Twilio's
 * documented signature algorithm: HMAC-SHA1(authToken, url + sorted-and-
 * concatenated POST params), base64-encoded, compared to X-Twilio-Signature.
 * Verification is per-tenant (each tenant's own authToken), so the caller
 * must resolve the tenant from the request BEFORE calling this.
 */
function verifyTwilioSignature(url, params, authToken, signature) {
  if (!authToken || !signature) return false;
  const sortedKeys = Object.keys(params || {}).sort();
  let data = url;
  for (const key of sortedKeys) data += key + params[key];
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { sendSms, verifyTwilioSignature };
