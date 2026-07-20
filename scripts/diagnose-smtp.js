/**
 * Diagnose the configured client SMTP identity WITHOUT sending mail.
 *
 * nodemailer's verify() opens the connection, runs STARTTLS, and authenticates,
 * then stops. That reproduces every failure mode that kills a send (host, port,
 * TLS, credentials) while guaranteeing no message reaches a recipient.
 *
 * Run:  railway run bash -c 'node scripts/diagnose-smtp.js'
 */
const nodemailer = require('nodemailer');
const { pool } = require('../src/db');
const { safeDecrypt, encryptionEnabled } = require('../src/lib/crypto');

(async () => {
  console.log('ENCRYPTION_KEY configured:', encryptionEnabled());

  const { rows } = await pool.query(
    `SELECT client_id, provider, from_email, from_name,
            smtp_host, smtp_port, smtp_user, smtp_pass_enc AS smtp_pass, smtp_secure
     FROM client_email_config`
  );

  if (!rows.length) {
    console.log('No client_email_config rows.');
    await pool.end();
    return;
  }

  for (const cfg of rows) {
    console.log(`\n=== client_id ${cfg.client_id} (${cfg.provider}) ===`);
    console.log('  from_email :', cfg.from_email);
    console.log('  host       :', cfg.smtp_host);
    console.log('  port       :', cfg.smtp_port);
    console.log('  secure     :', cfg.smtp_secure);

    // Credentials may be encrypted at rest or legacy plaintext; safeDecrypt
    // handles both. Print only the shape, never the secret itself.
    const user = safeDecrypt(cfg.smtp_user);
    const pass = safeDecrypt(cfg.smtp_pass);
    console.log('  user       :', user || '(empty)');
    console.log('  pass       :', pass ? `(${pass.length} chars)` : '(empty)');

    if (!cfg.smtp_host || !user || !pass) {
      console.log('  RESULT: incomplete config — the send path would not take this branch');
      continue;
    }

    const port = parseInt(cfg.smtp_port, 10) || 587;
    const transport = nodemailer.createTransport({
      host: cfg.smtp_host,
      port,
      secure: cfg.smtp_secure ?? port === 465,
      auth: { user, pass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
    });

    try {
      await transport.verify();
      console.log('  RESULT: ✅ connect + auth OK — credentials are good');
      console.log('  → the failure is happening at message level (From address');
      console.log('    not authorised for this mailbox, recipient rejected, or quota)');
    } catch (err) {
      console.log('  RESULT: ❌ FAILED');
      console.log('  error   :', err.message);
      if (err.code)     console.log('  code    :', err.code);
      if (err.response) console.log('  response:', err.response);
    }
  }

  await pool.end();
})().catch(err => {
  console.error('diagnostic crashed:', err.message);
  process.exit(1);
});
