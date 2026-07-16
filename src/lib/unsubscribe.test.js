// Unit tests for unsubscribe token sign/verify round-trip (Phase 6 / 06-05).
// Plain-script style to match commissions.test.js / attribution.test.js.
// Run: node src/lib/unsubscribe.test.js
const assert = require('node:assert');

process.env.UNSUBSCRIBE_HMAC_SECRET = 'test-secret-for-unsubscribe';
const { generateToken, verifyToken } = require('./unsubscribe');

// ── Round-trip: a generated token verifies back to the same email ──────────
{
  const email = 'Jane.Doe@Example.com';
  const token = generateToken(email);
  assert.strictEqual(verifyToken(token), 'jane.doe@example.com', 'round-trips and lowercases');
}

// ── Case-insensitivity: tokens for differently-cased same address match ────
{
  assert.strictEqual(
    generateToken('USER@X.COM'),
    generateToken('user@x.com'),
    'token is case-insensitive on the email'
  );
}

// ── Tamper: flipping the payload invalidates the signature ─────────────────
{
  const token = generateToken('a@b.com');
  const [encoded, sig] = token.split('.');
  const tampered = Buffer.from('evil@b.com').toString('base64url') + '.' + sig;
  assert.strictEqual(verifyToken(tampered), null, 'payload tamper rejected');
}

// ── Malformed tokens return null, never throw ──────────────────────────────
{
  assert.strictEqual(verifyToken('no-dot-here'), null, 'missing separator rejected');
  assert.strictEqual(verifyToken(''), null, 'empty token rejected');
  assert.strictEqual(verifyToken('.'), null, 'lone separator rejected');
  assert.strictEqual(verifyToken('Zm9v.bad-signature'), null, 'bad signature rejected');
}

// ── Wrong secret cannot forge a valid token ────────────────────────────────
{
  const token = generateToken('c@d.com');
  process.env.UNSUBSCRIBE_HMAC_SECRET = 'different-secret';
  // clear require cache so the module re-reads the secret
  delete require.cache[require.resolve('./unsubscribe')];
  const { verifyToken: verify2 } = require('./unsubscribe');
  assert.strictEqual(verify2(token), null, 'token signed with old secret is rejected under new secret');
  process.env.UNSUBSCRIBE_HMAC_SECRET = 'test-secret-for-unsubscribe';
}

console.log('unsubscribe.test.js: all assertions passed');
