/**
 * Probe a few IONOS transport settings with the SAME stored credentials, to
 * separate "wrong port/TLS mode" from "wrong password".
 *
 * Deliberately few attempts: repeated auth failures can get the sending IP
 * temporarily blocked by IONOS. We only vary port/TLS on the known host, since
 * a 535 (auth rejected) already proves the host is a real, reachable SMTP
 * server -- changing the host would test connectivity, which is not the problem.
 *
 * Run: railway run bash -c 'node scripts/diagnose-smtp-variants.js'
 */
const nodemailer = require('nodemailer');
const { pool } = require('../src/db');
const { safeDecrypt } = require('../src/lib/crypto');

(async () => {
  const { rows } = await pool.query(
    `SELECT smtp_host, smtp_user, smtp_pass_enc FROM client_email_config WHERE client_id = 1`
  );
  if (!rows.length) { console.log('no client_email_config row'); await pool.end(); return; }

  const host = rows[0].smtp_host;
  const user = safeDecrypt(rows[0].smtp_user);
  const pass = safeDecrypt(rows[0].smtp_pass_enc);

  console.log(`host: ${host}`);
  console.log(`user: ${user}`);
  console.log(`pass: ${pass ? `(${pass.length} chars)` : '(empty)'}`);
  console.log('');

  // Two transport modes only. 587/STARTTLS is the current (failing) one; 465/SSL
  // is the meaningful alternative. Same credentials for both.
  const variants = [
    { label: '587 STARTTLS (current)', port: 587, secure: false },
    { label: '465 SSL',                port: 465, secure: true  },
  ];

  for (const v of variants) {
    const transport = nodemailer.createTransport({
      host, port: v.port, secure: v.secure,
      auth: { user, pass },
      connectionTimeout: 15000, greetingTimeout: 15000,
    });
    process.stdout.write(`${v.label}: `);
    try {
      await transport.verify();
      console.log('✅ connect + auth OK  <-- use this port/secure setting');
    } catch (err) {
      const kind = err.code === 'EAUTH' ? 'AUTH rejected (creds/mailbox-access, not transport)'
                 : `TRANSPORT problem (${err.code || 'unknown'})`;
      console.log(`❌ ${err.message}  [${kind}]`);
    }
  }

  console.log('');
  console.log('Reading: if BOTH say "AUTH rejected", the transport is fine and the');
  console.log('problem is the password we have or SMTP access on the mailbox -- not');
  console.log('the port. If 465 succeeds, the mailbox is SSL-only; switch to it.');

  await pool.end();
})().catch(e => { console.error('probe crashed:', e.message); process.exit(1); });
