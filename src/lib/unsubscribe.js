const crypto = require('crypto');

function sign(email) {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET)
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
