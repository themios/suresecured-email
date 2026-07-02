const express  = require('express');
const router   = express.Router();
const { pool } = require('../db');
const { getAuthUrl, exchangeCode } = require('../lib/gmail');
const { requireAuth } = require('../middleware/auth');

// Redirect salesperson to Google consent screen
router.get('/connect/:salespersonId', requireAuth, (req, res) => {
  const url = getAuthUrl(req.params.salespersonId);
  res.redirect(url);
});

// Google redirects back here with ?code=...&state=salespersonId
router.get('/callback', async (req, res) => {
  const { code, state: salespersonId, error } = req.query;

  if (error) return res.send(`<p>Google denied access: ${error}. <a href="/admin">Back to Admin</a></p>`);
  if (!code || !salespersonId) return res.send('<p>Missing parameters. <a href="/admin">Back to Admin</a></p>');

  try {
    const { tokens, email } = await exchangeCode(code);

    await pool.query(
      `INSERT INTO email_accounts
         (salesperson_id, email, oauth_refresh_token, oauth_access_token, oauth_token_expiry, enabled)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (salesperson_id) DO UPDATE SET
         email = EXCLUDED.email,
         oauth_refresh_token = COALESCE(EXCLUDED.oauth_refresh_token, email_accounts.oauth_refresh_token),
         oauth_access_token  = EXCLUDED.oauth_access_token,
         oauth_token_expiry  = EXCLUDED.oauth_token_expiry,
         enabled             = true,
         last_error          = NULL,
         connected_at        = NOW()`,
      [salespersonId, email, tokens.refresh_token, tokens.access_token,
       tokens.expiry_date ? new Date(tokens.expiry_date) : null]
    );

    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2 style="color:#16a34a">✓ Gmail Connected</h2>
        <p><strong>${email}</strong> is now connected for this salesperson.</p>
        <a href="/admin#tab-sequences" style="background:#2563eb;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:16px">Back to Admin</a>
      </body></html>
    `);
  } catch (err) {
    console.error('[gmail-oauth] callback error:', err);
    res.send(`<p>Error: ${err.message}. <a href="/admin">Back to Admin</a></p>`);
  }
});

// Disconnect a salesperson's Gmail
router.post('/disconnect/:salespersonId', requireAuth, async (req, res) => {
  await pool.query(
    'UPDATE email_accounts SET enabled = false, oauth_refresh_token = NULL, oauth_access_token = NULL WHERE salesperson_id = $1',
    [req.params.salespersonId]
  );
  const back = req.get('Referer') || '/settings/email';
  res.redirect(back);
});

module.exports = router;
