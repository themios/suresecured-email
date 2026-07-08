const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

// ─── Login page ────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>SureSecured — Sales Tracker Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2/dist/tailwind.min.css" rel="stylesheet">
</head>
<body class="bg-gray-900 min-h-screen flex items-center justify-center">
  <div class="bg-white rounded-xl shadow-lg p-8 w-full max-w-sm">
    <div class="text-center mb-6">
      <h1 class="text-2xl font-bold text-gray-800">SureSecured</h1>
      <p class="text-gray-500 text-sm mt-1">Sales Tracker</p>
    </div>
    ${req.query.error ? `<div class="bg-red-50 text-red-600 text-sm rounded p-3 mb-4">Invalid email or password.</div>` : ''}
    <form method="POST" action="/auth/login" class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Email</label>
        <input type="email" name="email" required
          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Password</label>
        <input type="password" name="password" required
          class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      </div>
      <button type="submit"
        class="w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-blue-700 transition">
        Sign In
      </button>
    </form>
  </div>
</body>
</html>`);
});

// ─── Unified login — form-encoded or JSON ─────────────────────────────────

router.post(
  '/auth/login',
  express.urlencoded({ extended: false }),
  express.json(),
  async (req, res) => {
    const { email, password } = req.body;
    const isJson = req.headers['content-type']?.includes('application/json');

    if (!email || !password) {
      if (isJson) return res.status(400).json({ error: 'Email and password required' });
      return res.redirect('/login?error=1');
    }

    try {
      const result = await pool.query(
        `SELECT id, email, password_hash, role, client_id, organization_id
         FROM users
         WHERE email = $1 AND active = TRUE`,
        [email]
      );

      if (result.rows.length === 0) {
        if (isJson) return res.status(401).json({ error: 'Invalid credentials' });
        return res.redirect('/login?error=1');
      }

      const user = result.rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        if (isJson) return res.status(401).json({ error: 'Invalid credentials' });
        return res.redirect('/login?error=1');
      }

      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: user.role,
          client_id: user.client_id,
          organization_id: user.organization_id,
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.cookie('auth_token', token, {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
      });

      if (isJson) return res.status(200).json({ role: user.role });
      return res.redirect('/dashboard');
    } catch (err) {
      console.error('Login error:', err);
      if (isJson) return res.status(500).json({ error: 'Internal server error' });
      return res.redirect('/login?error=1');
    }
  }
);

// ─── Logout ────────────────────────────────────────────────────────────────

router.get('/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.redirect('/login');
});

// Keep legacy /logout route for backward compatibility
router.get('/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.redirect('/login');
});

// ─── Operator seed (dev only) ──────────────────────────────────────────────

if (process.env.SEED_OPERATOR === '1' && process.env.NODE_ENV !== 'production') {
  const { pool: seedPool } = require('../db');
  bcrypt.hash('operator123', 10).then(hash => {
    seedPool.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'operator') ON CONFLICT (email) DO NOTHING`,
      ['operator@suresecured.com', hash]
    ).catch(() => {});
  });
}

module.exports = router;
