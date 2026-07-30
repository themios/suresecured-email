const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { verifyTwilioSignature } = require('./twilio');

// verifyTwilioSignature is the one piece of the Twilio integration that is
// pure logic (no network, no DB) and security-critical -- get this wrong and
// either legitimate webhooks get rejected, or forged ones get accepted.

function sign(url, params, authToken) {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const k of sortedKeys) data += k + params[k];
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

test('a correctly signed request verifies', () => {
  const url = 'https://example.com/twilio-hooks/sms';
  const params = { To: '+15551234567', From: '+15557654321', Body: 'hello' };
  const token = 'test-auth-token';
  const sig = sign(url, params, token);
  assert.strictEqual(verifyTwilioSignature(url, params, token, sig), true);
});

test('a tampered parameter fails verification', () => {
  const url = 'https://example.com/twilio-hooks/sms';
  const token = 'test-auth-token';
  const sig = sign(url, { To: '+15551234567', From: '+15557654321', Body: 'hello' }, token);
  // Same signature, but the body actually received differs (tampered in transit)
  const result = verifyTwilioSignature(url, { To: '+15551234567', From: '+15557654321', Body: 'STOP' }, token, sig);
  assert.strictEqual(result, false);
});

test('the wrong auth token fails verification', () => {
  const url = 'https://example.com/twilio-hooks/sms';
  const params = { To: '+15551234567', From: '+15557654321', Body: 'hello' };
  const sig = sign(url, params, 'real-token');
  assert.strictEqual(verifyTwilioSignature(url, params, 'wrong-token', sig), false);
});

test('a missing signature or auth token is rejected, not thrown', () => {
  assert.strictEqual(verifyTwilioSignature('https://x.com', {}, 'token', undefined), false);
  assert.strictEqual(verifyTwilioSignature('https://x.com', {}, undefined, 'sig'), false);
});

test('a signature of the wrong length is rejected without throwing', () => {
  // timingSafeEqual throws on length mismatch if not guarded
  assert.strictEqual(verifyTwilioSignature('https://x.com', { a: '1' }, 'token', 'short'), false);
});
