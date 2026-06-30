const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const token = req.cookies?.auth_token;
  if (!token) return res.redirect('/login');

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.clearCookie('auth_token');
    res.redirect('/login');
  }
}

module.exports = { requireAuth };
