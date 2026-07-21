/**
 * Check whether the connected Gmail account can authenticate, WITHOUT sending.
 *
 * sendSequenceEmail() requires a working Gmail auth even when the actual send
 * goes through IONOS SMTP (it uses the Gmail address as reply-to). So a broken
 * Gmail token makes preview fail with "no_account" regardless of IONOS. This
 * tells us which state we are in before anyone clicks Preview.
 *
 * Read-only: getAuthedClient refreshes the token if needed but sends no mail.
 *
 * Run: railway run bash -c 'node scripts/diagnose-gmail.js'
 */
const { pool } = require('../src/db');
const { getAuthedClient } = require('../src/lib/gmail');

(async () => {
  const { rows } = await pool.query(
    `SELECT salesperson_id, email, enabled,
            (oauth_refresh_token IS NOT NULL) AS has_refresh,
            oauth_token_expiry, last_error
     FROM email_accounts ORDER BY salesperson_id`
  );
  if (!rows.length) { console.log('No email_accounts rows.'); await pool.end(); return; }

  for (const a of rows) {
    console.log(`\n=== salesperson ${a.salesperson_id} — ${a.email} ===`);
    console.log(`  enabled: ${a.enabled}   has_refresh_token: ${a.has_refresh}`);
    console.log(`  token_expiry: ${a.oauth_token_expiry}`);
    console.log(`  last_error:   ${a.last_error || '(none)'}`);

    process.stdout.write('  live auth: ');
    try {
      const auth = await getAuthedClient(a.salesperson_id);
      if (!auth) {
        console.log('❌ getAuthedClient returned null — preview would fail with "no_account"');
      } else {
        console.log('✅ authenticated — Gmail is not blocking sends');
      }
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
  }

  await pool.end();
})().catch(e => { console.error('probe crashed:', e.message); process.exit(1); });
