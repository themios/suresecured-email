/**
 * Show which send branch sendSequenceEmail() will take for client 1, and why.
 * Read-only: loads config and evaluates the branch conditions, sends nothing.
 *
 * The send path picks in this order:
 *   1. client SMTP  if clientCfg.smtp_host && smtp_user && smtp_pass
 *   2. SES          else if SES_SMTP_* env vars present
 *   3. Gmail        else
 *
 * Production sends are landing on Gmail (which times out from Railway) instead
 * of IONOS SMTP (which the variant probe proved works from Railway). This tells
 * us which condition is knocking it off branch 1.
 */
const { pool } = require('../src/db');
const { getClientEmailConfig, sesEnabled } = require('../src/lib/gmail');

(async () => {
  let cfg;
  try {
    cfg = await getClientEmailConfig(1);
  } catch (err) {
    console.log('getClientEmailConfig THREW:', err.message);
    console.log('-> clientCfg would be null -> branch 1 skipped');
    await pool.end();
    return;
  }

  if (!cfg) {
    console.log('getClientEmailConfig(1) returned NULL.');
    console.log('Likely cause: enabled=false, or decrypt(smtp_pass_enc) threw inside');
    console.log('the function\'s try/catch. Either way branch 1 is skipped.');
  } else {
    console.log('getClientEmailConfig(1) returned a config:');
    console.log('  provider   :', cfg.provider);
    console.log('  smtp_host  :', cfg.smtp_host || '(empty)');
    console.log('  smtp_user  :', cfg.smtp_user || '(empty)');
    console.log('  smtp_pass  :', cfg.smtp_pass ? `present (${cfg.smtp_pass.length} chars)` : 'NULL  <-- this knocks it off branch 1');
    console.log('  from_email :', cfg.from_email);
    const branch1 = !!(cfg.smtp_host && cfg.smtp_user && cfg.smtp_pass);
    console.log('  branch 1 (SMTP) condition met:', branch1);
  }

  console.log('');
  console.log('sesEnabled():', sesEnabled(), sesEnabled() ? '(branch 2 would take it before Gmail)' : '(so it falls through to Gmail)');
  console.log('');
  console.log('Predicted branch:',
    (cfg && cfg.smtp_host && cfg.smtp_user && cfg.smtp_pass) ? 'SMTP (IONOS)'
    : sesEnabled() ? 'SES'
    : 'Gmail');

  await pool.end();
})().catch(e => { console.error('probe crashed:', e.message); process.exit(1); });
