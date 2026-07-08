const crypto = require('crypto');

function hmacSecret() {
  return process.env.UNSUBSCRIBE_HMAC_SECRET || process.env.JWT_SECRET;
}

function sign(email) {
  const secret = hmacSecret();
  if (!secret) throw new Error('UNSUBSCRIBE_HMAC_SECRET or JWT_SECRET required');
  return crypto
    .createHmac('sha256', secret)
    .update(email.toLowerCase())
    .digest('base64url');
}

function generateToken(email) {
  const encoded = Buffer.from(email.toLowerCase()).toString('base64url');
  return encoded + '.' + sign(email);
}

function verifyToken(token) {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const encoded = token.slice(0, dot);
  const sig     = token.slice(dot + 1);
  try {
    const email = Buffer.from(encoded, 'base64url').toString('utf8');
    if (sign(email) !== sig) return null;
    return email;
  } catch {
    return null;
  }
}

module.exports = { generateToken, verifyToken };
