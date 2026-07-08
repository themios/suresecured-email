const crypto = require('crypto');

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(text) {
  if (!text) return null;
  const key = getKey();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(encoded) {
  if (!encoded) return null;
  const key = getKey();
  const buf = Buffer.from(encoded, 'base64');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString('utf8') + decipher.final('utf8');
}

/**
 * Whether encryption is configured (ENCRYPTION_KEY present and valid length).
 */
function encryptionEnabled() {
  const hex = process.env.ENCRYPTION_KEY;
  return !!(hex && hex.length === 64);
}

/**
 * Encrypt only if a key is configured; otherwise return the plaintext unchanged.
 * Lets deploys without ENCRYPTION_KEY keep working (values stay plaintext).
 */
function maybeEncrypt(text) {
  if (!text) return text ?? null;
  return encryptionEnabled() ? encrypt(text) : text;
}

/**
 * Decrypt a value that may be either ciphertext (this scheme) or legacy plaintext.
 * Ciphertext is base64 of [12b iv][16b tag][ciphertext] = min 28 bytes and decodes
 * cleanly under the GCM key. If decryption fails, assume the value predates
 * encryption and return it as-is. Safe for a mixed-state column during rollout.
 */
function safeDecrypt(value) {
  if (!value) return null;
  if (!encryptionEnabled()) return value;
  try {
    return decrypt(value);
  } catch {
    return value; // legacy plaintext row
  }
}

module.exports = { encrypt, decrypt, maybeEncrypt, safeDecrypt, encryptionEnabled };
