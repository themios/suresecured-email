const crypto = require('crypto');
const { timingSafeEqualStr } = require('../middleware/apiAuth');

/**
 * CallRail — shared secret via Authorization: Bearer or X-CallRail-Signature header.
 */
function verifyCallRailWebhook(req) {
  const secret = process.env.CALLRAIL_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[webhook] CALLRAIL_WEBHOOK_SECRET not set — rejecting CallRail webhook');
    return false;
  }
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ') && timingSafeEqualStr(auth.slice(7), secret)) return true;
  const sig = req.headers['x-callrail-signature'] || req.headers['x-webhook-secret'];
  return timingSafeEqualStr(sig, secret);
}

/**
 * Retell — HMAC-SHA256 of raw JSON body with API key.
 * Header: x-retell-signature
 */
function verifyRetellWebhook(req, rawBody) {
  const apiKey = process.env.RETELL_API_KEY;
  const signature = req.headers['x-retell-signature'];
  if (!apiKey || !signature) {
    const fallback = process.env.RETELL_WEBHOOK_SECRET;
    if (fallback) {
      const auth = req.headers.authorization || '';
      return auth.startsWith('Bearer ') && timingSafeEqualStr(auth.slice(7), fallback);
    }
    console.warn('[webhook] RETELL_API_KEY or RETELL_WEBHOOK_SECRET not set');
    return false;
  }
  const body = rawBody || JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', apiKey).update(body).digest('hex');
  return timingSafeEqualStr(signature, expected);
}

/**
 * Telnyx — shared secret fallback; full Ed25519 verify when TELNYX_PUBLIC_KEY is set.
 */
function verifyTelnyxWebhook(req, rawBody) {
  const secret = process.env.TELNYX_WEBHOOK_SECRET;
  if (secret) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ') && timingSafeEqualStr(auth.slice(7), secret)) return true;
    const sig = req.headers['telnyx-signature-ed25519'] || req.headers['x-telnyx-signature'];
    if (timingSafeEqualStr(sig, secret)) return true;
  }

  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  const signature = req.headers['telnyx-signature-ed25519'];
  const timestamp = req.headers['telnyx-timestamp'];
  if (!publicKey || !signature || !timestamp) {
    console.warn('[webhook] Telnyx verification failed — configure TELNYX_WEBHOOK_SECRET or TELNYX_PUBLIC_KEY');
    return false;
  }

  try {
    const payload = `${timestamp}|${rawBody || JSON.stringify(req.body || {})}`;
    return crypto.verify(
      null,
      Buffer.from(payload),
      { key: publicKey, format: 'pem', type: 'spki' },
      Buffer.from(signature, 'base64')
    );
  } catch (err) {
    console.error('[webhook] Telnyx Ed25519 verify error:', err.message);
    return false;
  }
}

module.exports = { verifyCallRailWebhook, verifyRetellWebhook, verifyTelnyxWebhook };
