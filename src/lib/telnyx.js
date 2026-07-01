// src/lib/telnyx.js
// Telnyx REST API wrapper — plain https.request (no SDK)
// Requires env: TELNYX_API_KEY, TELNYX_PHONE_NUMBER
const https = require('https');

function telnyxRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telnyx.com',
      path: `/v2${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
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
    req.write(payload);
    req.end();
  });
}

/**
 * Send outbound SMS via Telnyx.
 * NOTE: 10DLC (Brand + Campaign) registration in Telnyx portal is required
 * before any SMS will deliver to US numbers. Approval takes 3-7 business days.
 *
 * @param {string} to   - Recipient E.164 number e.g. '+13125550001'
 * @param {string} body - SMS message text
 * @returns {{ ok: boolean, messageId?: string, error?: string }}
 */
async function sendSms(to, body) {
  const result = await telnyxRequest('POST', '/messages', {
    from: process.env.TELNYX_PHONE_NUMBER,
    to,
    text: body,
  });
  if (result.status === 200) {
    return { ok: true, messageId: result.body.data?.id };
  }
  return { ok: false, error: JSON.stringify(result.body.errors || result.body) };
}

module.exports = { sendSms };
