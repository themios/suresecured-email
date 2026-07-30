const express  = require('express');
const router   = express.Router();
const { pool } = require('../db');
const { getAuthUrl, exchangeCode, verifyOAuthState } = require('../lib/gmail');
const { getSeedAuthUrl, verifySeedOAuthState } = require('../lib/seedCanary');
const { maybeEncrypt } = require('../lib/crypto');
const { requireAuth, requireTenantContext } = require('../middleware/auth');

// Redirect salesperson to Google consent screen
router.get('/connect/:salespersonId', requireAuth, (req, res) => {
  const url = getAuthUrl(req.params.salespersonId);
  res.redirect(url);
});

// Google redirects back here with ?code=...&state=<signed state>
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.send(`<p>Google denied access. <a href="/admin">Back to Admin</a></p>`);
  if (!code || !state) return res.send('<p>Missing parameters. <a href="/admin">Back to Admin</a></p>');

  // Verify signed, unexpired state — prevents binding a Google account to an
  // arbitrary salesperson id (CSRF / identity hijack).
  const salespersonId = verifyOAuthState(state);
  if (!salespersonId) {
    return res.status(400).send('<p>This connection link is invalid or expired. Please start again from Admin. <a href="/admin">Back to Admin</a></p>');
  }

  try {
    // Confirm the salesperson exists before binding a mailbox to it
    const spCheck = await pool.query('SELECT id FROM salespeople WHERE id = $1', [salespersonId]);
    if (!spCheck.rows.length) {
      return res.status(404).send('<p>Salesperson not found. <a href="/admin">Back to Admin</a></p>');
    }

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
      [salespersonId, email, maybeEncrypt(tokens.refresh_token), maybeEncrypt(tokens.access_token),
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

// ── Seed canary inbox connect ────────────────────────────────────────────
// One monitored inbox per TENANT (not per salesperson) — the address every
// real campaign send also copies to, so a daily check can see where Gmail
// actually filed it. Keyed by client_id, gated to the tenant's own context so
// a user can only connect a seed inbox for their own tenant.
router.get('/seed/connect', requireAuth, requireTenantContext, (req, res) => {
  res.redirect(getSeedAuthUrl(req.user.client_id));
});

router.get('/seed/callback', requireAuth, requireTenantContext, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.send(`<p>Google denied access. <a href="/settings/email">Back to Settings</a></p>`);
  if (!code || !state) return res.send('<p>Missing parameters. <a href="/settings/email">Back to Settings</a></p>');

  const clientId = verifySeedOAuthState(state);
  if (!clientId || Number(clientId) !== req.user.client_id) {
    return res.status(400).send('<p>This connection link is invalid, expired, or was started for a different account. Please start again from Settings. <a href="/settings/email">Back to Settings</a></p>');
  }

  try {
    const { tokens, email } = await exchangeCode(code);

    await pool.query(
      `INSERT INTO seed_accounts (client_id, email, oauth_refresh_token, oauth_access_token, oauth_token_expiry, enabled)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (client_id) DO UPDATE SET
         email = EXCLUDED.email,
         oauth_refresh_token = COALESCE(EXCLUDED.oauth_refresh_token, seed_accounts.oauth_refresh_token),
         oauth_access_token  = EXCLUDED.oauth_access_token,
         oauth_token_expiry  = EXCLUDED.oauth_token_expiry,
         enabled             = true,
         last_error          = NULL,
         connected_at        = NOW()`,
      [req.user.client_id, email, maybeEncrypt(tokens.refresh_token), maybeEncrypt(tokens.access_token),
       tokens.expiry_date ? new Date(tokens.expiry_date) : null]
    );

    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2 style="color:#16a34a">✓ Seed inbox connected</h2>
        <p><strong>${email}</strong> will now receive a copy of every campaign send, and we'll check daily where it landed.</p>
        <a href="/settings/email" style="background:#2563eb;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:16px">Back to Settings</a>
      </body></html>
    `);
  } catch (err) {
    console.error('[gmail-oauth] seed callback error:', err);
    res.send(`<p>Error: ${err.message}. <a href="/settings/email">Back to Settings</a></p>`);
  }
});

router.post('/seed/disconnect', requireAuth, requireTenantContext, async (req, res) => {
  await pool.query(
    'UPDATE seed_accounts SET enabled = false, oauth_refresh_token = NULL, oauth_access_token = NULL WHERE client_id = $1',
    [req.user.client_id]
  );
  res.redirect('/settings/email');
});

module.exports = router;
