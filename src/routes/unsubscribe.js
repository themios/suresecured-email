const express  = require('express');
const router   = express.Router();
const { pool } = require('../db');
const { verifyToken } = require('../lib/unsubscribe');

// Suppress an email everywhere: add to suppression list, flag lead, pause enrollments.
async function suppressEmail(email) {
  await pool.query(
    `INSERT INTO suppression_list (email, reason) VALUES ($1, 'unsubscribed')
     ON CONFLICT (email) DO UPDATE SET reason = 'unsubscribed', added_at = NOW()`,
    [email]
  );
  await pool.query(
    `UPDATE leads SET unsubscribed = true, unsubscribed_at = NOW() WHERE LOWER(email) = LOWER($1)`,
    [email]
  );
  await pool.query(
    `UPDATE contact_enrollments SET status = 'paused', paused_reason = 'unsubscribed'
     WHERE lead_id IN (SELECT id FROM leads WHERE LOWER(email) = LOWER($1))
       AND status = 'active'`,
    [email]
  );
  console.log(`[unsubscribe] ${email} removed at ${new Date().toISOString()}`);
}

// POST /unsubscribe?t=TOKEN — RFC 8058 one-click (Gmail/Yahoo bulk sender rule).
// Body is `List-Unsubscribe=One-Click`; the token travels in the query string.
router.post('/', express.urlencoded({ extended: false }), async (req, res) => {
  const email = verifyToken(req.query.t || '');
  if (!email) return res.status(400).send('Invalid token');
  try {
    await suppressEmail(email);
    return res.status(200).send('Unsubscribed');
  } catch (err) {
    console.error('[unsubscribe:one-click] error:', err.message);
    return res.status(500).send('Error');
  }
});

// GET /unsubscribe?t=TOKEN
router.get('/', async (req, res) => {
  const token = req.query.t;
  if (!token) return res.status(400).send(page('Invalid link', 'This unsubscribe link is missing or invalid.', false));

  const email = verifyToken(token);
  if (!email) return res.status(400).send(page('Invalid link', 'This unsubscribe link is not valid.', false));

  try {
    await suppressEmail(email);

    res.send(page('You have been unsubscribed', `
      <p><strong>${email}</strong> has been removed from all SureSecured email lists.</p>
      <p>You will not receive any further marketing emails from us.</p>
      <p style="margin-top:24px;color:#6b7280;font-size:13px">
        If this was a mistake or you'd like to re-subscribe, you can contact us at
        <a href="mailto:info@suresecured.com" style="color:#2563eb">info@suresecured.com</a>.
      </p>
    `, true));
  } catch (err) {
    console.error('[unsubscribe] error:', err);
    res.status(500).send(page('Error', 'Something went wrong. Please try again or contact info@suresecured.com.', false));
  }
});

// POST /unsubscribe/resubscribe — admin use only, no auth needed since it's low risk
// (suppression removal is done through admin UI)

function page(title, bodyContent, success) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} – SureSecured</title>
  <style>
    body { margin:0; padding:0; background:#f3f4f6; font-family:Arial,sans-serif; }
    .card {
      max-width:480px; margin:80px auto; background:#fff; border-radius:12px;
      padding:40px; box-shadow:0 1px 8px rgba(0,0,0,.08); text-align:center;
    }
    .icon { font-size:48px; margin-bottom:16px; }
    h1 { color:#111827; font-size:22px; margin:0 0 16px; }
    p { color:#374151; line-height:1.6; margin:0 0 12px; }
    .brand { color:#1e3a5f; font-weight:bold; font-size:18px; margin-bottom:32px; display:block; }
  </style>
</head>
<body>
  <div class="card">
    <span class="brand">SureSecured</span>
    <div class="icon">${success ? '✅' : '⚠️'}</div>
    <h1>${title}</h1>
    ${bodyContent}
  </div>
</body>
</html>`;
}

module.exports = router;
