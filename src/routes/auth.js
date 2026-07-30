const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { google } = require('googleapis');
const { pool } = require('../db');
const { signOAuthState, verifyOAuthState } = require('../lib/gmail');

// Issue the app session cookie for an authenticated user row. Shared by the
// password and Google login paths so both behave identically.
function issueSession(res, user) {
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
}

const googleLoginEnabled = () => !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);

// Auto-provision a Google-verified user when their email domain is registered to
// exactly one tenant. Returns the user row to sign in, or null to reject.
// The new user has no usable password (Google-only); role comes from the tenant.
async function provisionByDomain(email, domain) {
  const { rows: dom } = await pool.query(
    `SELECT c.id AS client_id, c.organization_id, d.default_role
       FROM client_auth_domains d JOIN clients c ON c.id = d.client_id
      WHERE d.domain = $1 AND c.active = TRUE`,
    [domain.toLowerCase()]
  );
  if (dom.length !== 1) return null; // unregistered or (impossible) ambiguous
  const { client_id, organization_id, default_role } = dom[0];
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, client_id, organization_id, active)
     VALUES ($1, '', $2, $3, $4, TRUE)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email, role, client_id, organization_id`,
    [email, default_role, client_id, organization_id]
  );
  if (rows[0]) return rows[0];
  // Lost an insert race — fetch the now-existing active user.
  const { rows: existing } = await pool.query(
    `SELECT id, email, role, client_id, organization_id FROM users WHERE LOWER(email) = $1 AND active = TRUE`,
    [email]
  );
  return existing[0] || null;
}

// ─── Login page ────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  const errorMessages = {
    '1': 'Invalid email or password.',
    'google_no_account': 'No account is linked to that Google email. Ask your admin to add you, or sign in with your password.',
    'google_unverified': 'That Google account’s email is not verified.',
    'google_failed': 'Google sign-in failed. Please try again.',
    'google_unconfigured': 'Google sign-in is not available right now.',
  };
  const errMsg = errorMessages[req.query.error];
  const googleButton = googleLoginEnabled() ? `
    <div class="divider">or</div>
    <a href="/auth/google" class="btn-google">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
      Sign in with Google
    </a>` : '';
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Sign in | SalesWyze</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;800;900&family=Archivo:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root{--ink:#15120e;--ink-soft:#221d16;--paper:#f1e8d6;--paper-hi:#faf6ea;--brass-dark:#8f6620;--ember:#b23b27;--ember-hi:#cc4a33;--line:rgba(21,18,14,0.14);}
    *{box-sizing:border-box;}
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--ink);font-family:'Archivo',system-ui,-apple-system,sans-serif;color:var(--ink);}
    .card{width:100%;max-width:392px;background:var(--paper-hi);border-radius:18px;padding:38px 34px;box-shadow:0 30px 72px rgba(0,0,0,.42);}
    .brand{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:24px;}
    .brand-mark{width:34px;height:34px;border-radius:8px;background:var(--ink);color:var(--paper-hi);display:flex;align-items:center;justify-content:center;font-family:'Big Shoulders Display',sans-serif;font-weight:800;font-size:16px;}
    .brand-word{font-family:'Big Shoulders Display',sans-serif;font-weight:800;font-size:24px;letter-spacing:-.01em;}
    h1{font-family:'Big Shoulders Display',sans-serif;font-weight:800;font-size:1.55rem;text-align:center;margin:0 0 4px;}
    .sub{text-align:center;color:var(--brass-dark);font-size:12px;margin:0 0 24px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;}
    label{display:block;font-size:13px;font-weight:600;color:var(--ink-soft);margin:0 0 6px;}
    .field{margin-bottom:15px;}
    input{width:100%;border:1px solid var(--line);background:#fff;border-radius:10px;padding:11px 13px;font-size:15px;font-family:inherit;color:var(--ink);transition:border-color .15s,box-shadow .15s;}
    input:focus{outline:none;border-color:var(--ember);box-shadow:0 0 0 3px rgba(178,59,39,.16);}
    .btn-primary{width:100%;border:none;background:var(--ember);color:#fff;border-radius:10px;padding:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;margin-top:4px;transition:background .15s,transform .1s;}
    .btn-primary:hover{background:var(--ember-hi);}
    .btn-primary:active{transform:translateY(1px);}
    .err{background:rgba(178,59,39,.1);color:var(--ember);font-size:13.5px;border-radius:10px;padding:11px 13px;margin-bottom:18px;font-weight:500;}
    .divider{display:flex;align-items:center;gap:12px;margin:20px 0;color:var(--brass-dark);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;}
    .divider::before,.divider::after{content:"";height:1px;background:var(--line);flex:1;}
    .btn-google{width:100%;display:flex;align-items:center;justify-content:center;gap:10px;border:1px solid var(--line);background:#fff;border-radius:10px;padding:11px;font-size:14.5px;font-weight:600;color:var(--ink);text-decoration:none;transition:background .15s;}
    .btn-google:hover{background:var(--paper);}
    .foot{text-align:center;margin-top:22px;font-size:12.5px;}
    .foot a{color:var(--brass-dark);text-decoration:none;font-weight:600;}
    .foot a:hover{color:var(--ember);}
  </style>
</head>
<body>
  <div class="card">
    <div class="brand"><span class="brand-mark">SW</span><span class="brand-word">SalesWyze</span></div>
    <h1>Welcome back</h1>
    <p class="sub">Client sign in</p>
    ${errMsg ? `<div class="err">${errMsg}</div>` : ''}
    <form method="POST" action="/auth/login">
      <div class="field">
        <label>Email</label>
        <input type="email" name="email" required autocomplete="email">
      </div>
      <div class="field">
        <label>Password</label>
        <input type="password" name="password" required autocomplete="current-password">
      </div>
      <button type="submit" class="btn-primary">Sign in</button>
    </form>
    ${googleButton}
    <p class="foot"><a href="/">&larr; Back to SalesWyze</a></p>
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

      issueSession(res, user);

      if (isJson) return res.status(200).json({ role: user.role });
      return res.redirect('/dashboard');
    } catch (err) {
      console.error('Login error:', err);
      if (isJson) return res.status(500).json({ error: 'Internal server error' });
      return res.redirect('/login?error=1');
    }
  }
);

// ─── Sign in with Google ─────────────────────────────────────────────────────
// Platform-wide capability, resolved per tenant: a Google identity is matched to
// an EXISTING active user row (never auto-provisioned), and that row's client_id
// determines which tenant they enter. A Google account with no matching user is
// rejected, so this can never cross tenants or create unauthorized access.

// Exact-match redirect URI Google requires. Prefer an explicit env var; else
// derive from the (proxied) request host so it works across environments.
function loginRedirectUri(req) {
  if (process.env.GOOGLE_LOGIN_REDIRECT_URI) return process.env.GOOGLE_LOGIN_REDIRECT_URI;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.get('host')}/auth/google/callback`;
}

function loginOAuthClient(req) {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    loginRedirectUri(req)
  );
}

router.get('/auth/google', (req, res) => {
  if (!googleLoginEnabled()) return res.redirect('/login?error=google_unconfigured');
  // Bind the OAuth state to a one-time cookie nonce so the callback only counts
  // for the browser that started the flow (closes login-CSRF).
  const nonce = crypto.randomBytes(16).toString('hex');
  res.cookie('g_oauth_nonce', nonce, {
    maxAge: 10 * 60 * 1000, httpOnly: true,
    secure: process.env.NODE_ENV === 'production', sameSite: 'lax',
  });
  const url = loginOAuthClient(req).generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
    scope: ['openid', 'email', 'profile'],
    state: signOAuthState(nonce),   // signed + expiring, and bound to the cookie above
  });
  res.redirect(url);
});

router.get('/auth/google/callback', async (req, res) => {
  if (!googleLoginEnabled()) return res.redirect('/login?error=google_unconfigured');
  try {
    const { code, state } = req.query;
    // Reject forged/stale callbacks, and callbacks that don't match the nonce
    // issued to this browser, before doing any work.
    const stateNonce = verifyOAuthState(state);
    const cookieNonce = req.cookies?.g_oauth_nonce;
    res.clearCookie('g_oauth_nonce');
    if (!code || !stateNonce || !cookieNonce || stateNonce !== cookieNonce) {
      return res.redirect('/login?error=google_failed');
    }

    const client = loginOAuthClient(req);
    const { tokens } = await client.getToken(String(code));
    if (!tokens.id_token) return res.redirect('/login?error=google_failed');

    // Verify the ID token's signature + audience with Google, then trust its claims.
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GMAIL_CLIENT_ID });
    const payload = ticket.getPayload() || {};
    const email = String(payload.email || '').toLowerCase();

    // Only accept a Google-verified email (blocks unverified-email spoofing).
    if (!email || payload.email_verified !== true) return res.redirect('/login?error=google_unverified');

    const result = await pool.query(
      `SELECT id, email, role, client_id, organization_id
       FROM users
       WHERE LOWER(email) = $1 AND active = TRUE`,
      [email]
    );
    if (result.rows.length > 0) {
      issueSession(res, result.rows[0]);
      return res.redirect('/dashboard');
    }

    // No existing user: auto-join only if this email's domain is registered to
    // exactly one tenant (UNIQUE(domain) enforces that at the DB level).
    const domain = email.split('@')[1] || '';
    const provisioned = domain ? await provisionByDomain(email, domain) : null;
    if (provisioned) {
      issueSession(res, provisioned);
      return res.redirect('/dashboard');
    }
    return res.redirect('/login?error=google_no_account');
  } catch (err) {
    console.error('[google-login] callback error:', err.message);
    return res.redirect('/login?error=google_failed');
  }
});

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
