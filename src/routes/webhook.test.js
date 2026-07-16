// Unit tests for the Shopify webhook HMAC verification (Phase 6 / 06-05).
// Plain-script style to match commissions.test.js / attribution.test.js.
// Run: node src/routes/webhook.test.js
const assert = require('node:assert');
const crypto = require('crypto');

process.env.SHOPIFY_WEBHOOK_SECRET = 'shpss_test_secret';
const { verifyShopifyWebhook } = require('./webhook');

function signedReq(rawBody, secret = process.env.SHOPIFY_WEBHOOK_SECRET) {
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  return { headers: { 'x-shopify-hmac-sha256': digest }, rawBody };
}

// ── Valid signature passes ─────────────────────────────────────────────────
{
  const body = Buffer.from(JSON.stringify({ id: 123, total_price: '99.00' }));
  assert.strictEqual(verifyShopifyWebhook(signedReq(body)), true, 'valid HMAC accepted');
}

// ── Wrong secret fails ─────────────────────────────────────────────────────
{
  const body = Buffer.from('{"id":1}');
  assert.strictEqual(verifyShopifyWebhook(signedReq(body, 'wrong_secret')), false, 'HMAC from wrong secret rejected');
}

// ── Tampered body fails (signature no longer matches) ──────────────────────
{
  const body = Buffer.from('{"id":1,"total_price":"10.00"}');
  const req = signedReq(body);
  req.rawBody = Buffer.from('{"id":1,"total_price":"1000.00"}'); // attacker inflates amount
  assert.strictEqual(verifyShopifyWebhook(req), false, 'body tamper rejected');
}

// ── Missing header fails ───────────────────────────────────────────────────
{
  assert.strictEqual(
    verifyShopifyWebhook({ headers: {}, rawBody: Buffer.from('{}') }),
    false, 'missing hmac header rejected'
  );
}

// ── Malformed / wrong-length header returns false, does NOT throw ──────────
{
  const req = { headers: { 'x-shopify-hmac-sha256': 'short' }, rawBody: Buffer.from('{}') };
  assert.doesNotThrow(() => verifyShopifyWebhook(req), 'wrong-length header must not throw');
  assert.strictEqual(verifyShopifyWebhook(req), false, 'wrong-length header rejected');
}

// ── No secret configured fails closed ──────────────────────────────────────
{
  const saved = process.env.SHOPIFY_WEBHOOK_SECRET;
  delete process.env.SHOPIFY_WEBHOOK_SECRET;
  const body = Buffer.from('{}');
  assert.strictEqual(
    verifyShopifyWebhook({ headers: { 'x-shopify-hmac-sha256': 'anything' }, rawBody: body }),
    false, 'no secret configured -> fails closed'
  );
  process.env.SHOPIFY_WEBHOOK_SECRET = saved;
}

console.log('webhook.test.js: all assertions passed');
