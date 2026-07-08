const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('./auth');

const ADMIN_ROLES = ['operator', 'owner', 'admin'];

function timingSafeEqualStr(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Validates X-Client-Api-Key against CLIENT_API_KEY env or clients.integration_settings.api_key.
 */
async function requireClientApiKey(req, res, next) {
  const key = req.headers['x-client-api-key'];
  if (!key) {
    return res.status(401).json({ error: 'X-Client-Api-Key required' });
  }

  if (process.env.CLIENT_API_KEY && timingSafeEqualStr(key, process.env.CLIENT_API_KEY)) {
    req.apiClientId = null;
    return next();
  }

  try {
    const { rows } = await pool.query(
      `SELECT id FROM clients
       WHERE active = true
         AND integration_settings->>'api_key' = $1
       LIMIT 1`,
      [key]
    );
    if (rows.length) {
      req.apiClientId = rows[0].id;
      return next();
    }
  } catch (err) {
    console.error('[apiAuth] client key lookup failed:', err.message);
  }

  return res.status(401).json({ error: 'Invalid API key' });
}

function requireAdminAuth(req, res, next) {
  requireAuth(req, res, () => {
    requireRole(...ADMIN_ROLES)(req, res, next);
  });
}

module.exports = { requireClientApiKey, requireAdminAuth, timingSafeEqualStr };
