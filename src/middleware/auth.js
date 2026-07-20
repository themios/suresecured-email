const jwt = require('jsonwebtoken');
const { pool } = require('../db');

/**
 * Authenticate from the session cookie, then re-read the user row.
 *
 * The token is proof of IDENTITY only. Authorization facts -- role, client_id,
 * active -- are read fresh from the database on every request, because a JWT is
 * a 7-day snapshot and these change underneath it:
 *
 *   - Migration 015 set client_id on a user whose live token still said NULL.
 *     requireTenantContext then 403'd them out of their own app, and the only
 *     workaround was to log out and back in. That is how this fix got written.
 *   - Deactivating a user, demoting them, or moving them between tenants
 *     otherwise has no effect for up to a week.
 *
 * requireSpAuth already did exactly this for the salesperson portal; the main
 * session was the one still trusting stale claims. Cost is one indexed lookup
 * per authenticated request, which is the right trade for authorization that is
 * actually current.
 */
async function requireAuth(req, res, next) {
  const token = req.cookies?.auth_token;
  if (!token) return res.redirect('/login');

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    res.clearCookie('auth_token');
    return res.redirect('/login');
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, email, role, client_id, organization_id
       FROM users WHERE id = $1 AND active = TRUE`,
      [payload.id]
    );
    if (!rows.length) {
      // Deleted or deactivated since the token was issued.
      res.clearCookie('auth_token');
      return res.redirect('/login');
    }
    req.user = rows[0];
    next();
  } catch (err) {
    // A database blip must not silently downgrade authorization, so fall back
    // to the token's claims rather than letting the request through unscoped.
    // Stale is survivable for one request; unauthenticated-but-allowed is not.
    console.error('[auth] user refresh failed, using token claims:', err.message);
    req.user = payload;
    next();
  }
}

// Usage: requireRole('operator') or requireRole(['operator','owner'])
function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient role' });
    }
    next();
  };
}

// Guards routes whose every query must be scoped to a tenant. A session without
// a client_id (platform operator, or a user row predating tenancy) has no tenant
// to act within, so the request is refused instead of falling back to a default
// client — that fallback silently attributes one tenant's writes to another.
function requireTenantContext(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!req.user.client_id) {
    return res.status(403).json({
      error: 'No tenant context. This account is not attached to a client.',
    });
  }
  next();
}

module.exports = { requireAuth, requireRole, requireTenantContext };
