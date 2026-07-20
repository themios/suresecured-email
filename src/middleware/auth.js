const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const token = req.cookies?.auth_token;
  if (!token) return res.redirect('/login');
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // payload: { id, email, role, client_id, organization_id }
    req.user = payload;
    next();
  } catch (err) {
    res.clearCookie('auth_token');
    return res.redirect('/login');
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
