const jwt = require('jsonwebtoken');

function requireSpAuth(req, res, next) {
  const token = req.cookies?.sp_token;
  if (!token) return res.redirect('/portal/login');

  try {
    req.salesperson = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.clearCookie('sp_token');
    res.redirect('/portal/login');
  }
}

module.exports = { requireSpAuth };
