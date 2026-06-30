const jwt = require('jsonwebtoken');
const { pool } = require('../db');

async function requireSpAuth(req, res, next) {
  const token = req.cookies?.sp_token;
  if (!token) return res.redirect('/portal/login');

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch fresh salesperson row to get client_id (may not be in token)
    const result = await pool.query(
      'SELECT id, name, email, client_id FROM salespeople WHERE id = $1 AND active = true',
      [payload.id]
    );

    if (!result.rows.length) {
      res.clearCookie('sp_token');
      return res.redirect('/portal/login');
    }

    req.salesperson = result.rows[0];
    next();
  } catch (err) {
    res.clearCookie('sp_token');
    return res.redirect('/portal/login');
  }
}

module.exports = { requireSpAuth };
