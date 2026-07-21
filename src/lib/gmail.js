const { google } = require('googleapis');
const nodemailer  = require('nodemailer');
const { pool }    = require('../db');
const { generateToken } = require('./unsubscribe');
const { rewriteLinks, isPermanentBounce }  = require('./email-tracking');
const crypto = require('crypto');
const { decrypt, maybeEncrypt, safeDecrypt } = require('./crypto');
const { reserveSend } = require('./sendLimits');

/**
 * Load and decrypt a client's email config from DB.
 * Falls back to env vars so existing single-tenant setup keeps working.
 */
async function getClientEmailConfig(clientId) {
  if (!clientId) return null;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM client_email_config WHERE client_id = $1 AND enabled = true',
      [clientId]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      provider:    r.provider,
      smtp_host:   r.smtp_host,
      smtp_port:   r.smtp_port || 587,
      smtp_secure: r.smtp_secure || false,
      smtp_user:   r.smtp_user,
      smtp_pass:   r.smtp_pass_enc ? decrypt(r.smtp_pass_enc) : null,
      from_name:   r.from_name,
      from_email:  r.from_email,
      reply_to:    r.reply_to,
      imap_host:   r.imap_host,
      imap_port:   r.imap_port || 993,
      imap_user:   r.imap_user,
      imap_pass:   r.imap_pass_enc ? decrypt(r.imap_pass_enc) : null,
    };
  } catch (err) {
    console.error('[email-config] failed to load for client', clientId, err.message);
    return null;
  }
}

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI,
  );
}

// ── Signed, expiring OAuth state (CSRF + identity binding) ──────────────────
// state = base64url(JSON payload) + '.' + HMAC-SHA256(secret, payload)
// Binds the connect flow to a specific salesperson for a short window so the
// callback cannot be tricked into binding a Google account to an arbitrary id.
function oauthStateSecret() {
  return process.env.JWT_SECRET || process.env.UNSUBSCRIBE_HMAC_SECRET;
}

function signOAuthState(salespersonId, ttlMs = 10 * 60 * 1000) {
  const secret = oauthStateSecret();
  if (!secret) throw new Error('JWT_SECRET required to sign OAuth state');
  const payload = { sid: String(salespersonId), nonce: crypto.randomBytes(8).toString('hex'), exp: Date.now() + ttlMs };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyOAuthState(state) {
  const secret = oauthStateSecret();
  if (!secret || !state || typeof state !== 'string') return null;
  const dot = state.lastIndexOf('.');
  if (dot < 0) return null;
  const encoded = state.slice(0, dot);
  const sig     = state.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload.sid;
  } catch {
    return null;
  }
}

function getAuthUrl(salespersonId) {
  const client = oauthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state: signOAuthState(salespersonId),
  });
}

async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();

  return { tokens, email: data.email };
}

async function getAuthedClient(salespersonId) {
  const { rows } = await pool.query(
    'SELECT * FROM email_accounts WHERE salesperson_id = $1 AND enabled = true',
    [salespersonId]
  );
  if (!rows[0]) return null;

  const account = rows[0];
  const client  = oauthClient();
  client.setCredentials({
    refresh_token: safeDecrypt(account.oauth_refresh_token),
    access_token:  safeDecrypt(account.oauth_access_token),
    expiry_date:   account.oauth_token_expiry ? new Date(account.oauth_token_expiry).getTime() : undefined,
  });

  // Refresh if expired
  const now = Date.now();
  const expiry = account.oauth_token_expiry ? new Date(account.oauth_token_expiry).getTime() : 0;
  if (expiry < now + 60000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      await pool.query(
        `UPDATE email_accounts
         SET oauth_access_token = $1, oauth_token_expiry = $2, last_error = NULL
         WHERE salesperson_id = $3`,
        [maybeEncrypt(credentials.access_token), credentials.expiry_date ? new Date(credentials.expiry_date) : null, salespersonId]
      );
    } catch (err) {
      await pool.query(
        'UPDATE email_accounts SET last_error = $1 WHERE salesperson_id = $2',
        ['Token refresh failed: ' + err.message, salespersonId]
      );
      return null;
    }
  }

  return { client, account };
}

function substituteVars(text, vars) {
  return text.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

async function buildRawMessage({ fromName, fromAddress, to, subject, textBody, htmlBody, headers }) {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const info = await composer.sendMail({
    from:    { name: fromName, address: fromAddress },
    to,
    subject,
    text:    textBody,
    html:    htmlBody,
    headers: headers || undefined,
  });
  if (!Buffer.isBuffer(info.message)) throw new Error('Failed to compose message');
  return info.message.toString('base64url');
}

function buildUnsubscribeUrl(email) {
  const token = generateToken(email);
  const base  = process.env.TRACKER_URL || 'https://your-app.railway.app';
  return `${base}/unsubscribe?t=${token}`;
}

function buildHtml(body, salespersonName, unsubscribeUrl, brandConfig = {}, pixelUrl = '') {
  const {
    primary_color = '#030302',
    accent_color  = '#E91111',
    bg_color      = '#EDEBE7',
    info_color    = '#CBDEE8',
    name          = 'SureSecured',
    phone         = '(747) 688-9992',
    website       = 'suresecured.com',
    address       = 'SureSecured Security Products • Simi Valley, CA 93063',
    cta_url       = 'https://suresecured.com/pages/request-a-quote',
    cta_label     = 'Request a Quote',
  } = brandConfig;

  const phoneDigits = phone.replace(/\D/g, '');

  const paragraphs = body.split(/\n\n+/).map(p =>
    `<p style="margin:0 0 18px 0;color:${primary_color};font-size:15px;line-height:1.75">` +
    p.split('\n').map(line =>
      line.replace(/(https?:\/\/[^\s<>"]+)/g, `<a href="$1" style="color:${accent_color};font-weight:600;text-decoration:underline">$1</a>`)
    ).join('<br>') +
    '</p>'
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f4f4f2;-webkit-text-size-adjust:100%;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f4f4f2;padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%">

        <!-- Announcement bar -->
        <tr><td style="background:${info_color};padding:10px 32px;text-align:center">
          <span style="font-size:12px;color:${primary_color};font-weight:600;letter-spacing:0.2px">For More Information Call/Text: <a href="tel:${phoneDigits}" style="color:${primary_color};text-decoration:none;font-weight:700">${phone}</a></span>
        </td></tr>

        <!-- Header -->
        <tr><td style="background:${primary_color};padding:22px 32px">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            <tr>
              <td>
                <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">${name}</span>
              </td>
              <td align="right">
                <span style="color:#ffffff;font-size:11px;opacity:0.6;letter-spacing:0.5px">${website}</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Accent bar -->
        <tr><td style="background:${accent_color};height:4px;font-size:0;line-height:0">&nbsp;</td></tr>

        <!-- Body -->
        <tr><td style="background:#ffffff;padding:36px 40px">
          ${paragraphs}

          <!-- CTA -->
          <table cellpadding="0" cellspacing="0" role="presentation" style="margin-top:28px">
            <tr>
              <td style="background:${accent_color};border-radius:4px">
                <a href="${cta_url}"
                   style="display:inline-block;padding:13px 28px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;letter-spacing:0.2px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
                  ${cta_label} &rarr;
                </a>
              </td>
              <td width="12"></td>
              <td style="border:2px solid ${primary_color};border-radius:4px">
                <a href="https://${website}"
                   style="display:inline-block;padding:11px 24px;color:${primary_color};font-size:14px;font-weight:600;text-decoration:none;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
                  Shop Products
                </a>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Signature -->
        <tr><td style="background:${bg_color};padding:24px 40px;border-top:1px solid #d8d6d2">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            <tr>
              <td>
                <p style="margin:0;font-size:14px;color:${primary_color};font-weight:700;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">${salespersonName}</p>
                <p style="margin:3px 0 0;font-size:12px;color:#5a5a58">Security Specialist &mdash; ${name}</p>
                <p style="margin:6px 0 0;font-size:12px;color:#5a5a58">
                  <a href="tel:${phoneDigits}" style="color:${primary_color};text-decoration:none;font-weight:600">${phone}</a>
                  &nbsp;&nbsp;|&nbsp;&nbsp;
                  <a href="https://${website}" style="color:${primary_color};text-decoration:none;font-weight:600">${website}</a>
                </p>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:${bg_color};padding:16px 40px 24px;border-top:1px solid #d8d6d2;border-radius:0 0 6px 6px">
          <p style="color:#8a8a88;font-size:11px;margin:0;line-height:1.7;text-align:center;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
            You received this because you requested information from ${name}.<br>
            ${address}<br>
            <a href="${unsubscribeUrl}" style="color:#8a8a88;text-decoration:underline">Unsubscribe</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
  ${pixelUrl ? `<img src="${pixelUrl}" width="1" height="1" style="display:none;border:0" alt="" aria-hidden="true">` : ''}
</body>
</html>`;
}

// Failure classes where the SENDING IDENTITY is broken, not the recipient.
// Nothing will deliver for anyone until an operator fixes the config, so these
// escalate to the tenant rather than being filed against one lead.
const OPERATOR_FAILURE_CLASSES = new Set(['auth', 'connection', 'config']);

/**
 * Bucket a send error so the UI can say something useful instead of dumping a
 * raw SMTP string at a dealership owner.
 *
 * Ordering matters: nodemailer sets err.code for transport-level problems, and
 * those are checked first because their messages sometimes also contain words
 * that the recipient-level regexes would match.
 */
function classifySendFailure(err, isBounce) {
  const code = err?.code || '';
  const msg = String(err?.message || '').toLowerCase();
  const status = err?.responseCode ?? err?.status ?? err?.code;

  if (code === 'EAUTH' || /535|534|invalid login|authentication (failed|credentials)|username and password not accepted/.test(msg)) {
    return 'auth';
  }
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', ' EHOSTUNREACH', 'ENOTFOUND', 'ESOCKET', 'EDNS'].includes(code)
      || /connection (timed out|refused|closed)|getaddrinfo|self.signed certificate|tls/.test(msg)) {
    return 'connection';
  }
  // Gmail API rejects a From header that is not a verified "Send As" alias.
  if (status === 403 || /precondition check failed|invalid from header|not authorized to send as|delegation denied/.test(msg)) {
    return 'config';
  }
  if (/quota|rate limit|too many|429|throttl|4\.7\.0/.test(msg)) return 'quota';
  if (isBounce) return 'bounce';
  if (/recipient|550|551|553|mailbox (unavailable|full)|does not exist|no such user/.test(msg)) return 'recipient';
  return 'unknown';
}

/**
 * Record an identity-level failure against the tenant's email config.
 *
 * consecutive_failures is what makes this actionable: one failure is noise, a
 * run of them means no mail is going out at all. Reset to 0 on the next success
 * (see recordIdentitySuccess) so a recovered mailbox stops alerting by itself.
 */
async function recordIdentityFailure(clientId, msg, failureClass) {
  if (!clientId) return;
  await pool.query(
    `UPDATE client_email_config
     SET last_error = $1, last_error_class = $2, last_tested_at = NOW(),
         consecutive_failures = consecutive_failures + 1
     WHERE client_id = $3`,
    [String(msg).slice(0, 500), failureClass, clientId]
  ).catch(err => console.error('[send] identity failure record error:', err.message));
}

async function recordIdentitySuccess(clientId) {
  if (!clientId) return;
  await pool.query(
    `UPDATE client_email_config
     SET last_error = NULL, last_error_class = NULL, alerted_at = NULL,
         consecutive_failures = 0, last_success_at = NOW(), last_tested_at = NOW()
     WHERE client_id = $1`,
    [clientId]
  ).catch(err => console.error('[send] identity success record error:', err.message));
}

async function sendSequenceEmail({ salespersonId, clientId, to, subject, body, vars, enrollmentId, stepId, leadId, preview }, brandConfig = {}) {
  // Always need Gmail auth — for reply-to address even when sending via SES
  const auth = await getAuthedClient(salespersonId);
  if (!auth) return { ok: false, error: 'no_account' };

  const { client, account } = auth;

  const resolvedSubject = substituteVars(subject, vars);
  const signature = [
    vars.salesperson_name  || '',
    vars.salesperson_title || '',
    vars.salesperson_phone || vars.company_phone || '',
    vars.salesperson_email || '',
  ].filter(Boolean).join('\n');
  const resolvedBody = substituteVars(body, vars);

  // Pre-generate pixel token
  const pixelToken  = require('crypto').randomUUID();
  const trackerBase = process.env.TRACKER_URL || 'https://your-app.railway.app';
  const pixelUrl    = `${trackerBase}/pixel/${pixelToken}`;

  const gmail          = google.gmail({ version: 'v1', auth: client });
  const fromName       = vars.salesperson_name || `${brandConfig.name || 'SureSecured'} Team`;
  const unsubscribeUrl = buildUnsubscribeUrl(to);

  // Load client SMTP config (DB takes priority over env vars) up front so we can
  // resolve the true sending identity and enforce the daily cap BEFORE creating
  // the email_sends row (avoids dangling 'sending' rows when capped).
  const clientCfg = await getClientEmailConfig(clientId);

  const usingClientSmtp = !!(clientCfg?.smtp_host && clientCfg?.smtp_user && clientCfg?.smtp_pass);
  const sendIdentity = usingClientSmtp
    ? (clientCfg.from_email || account?.email)
    : (sesEnabled() ? (process.env.SES_FROM_EMAIL || account.email) : (clientCfg?.from_email || account.email));

  // Warmup / daily cap gate — protects domain reputation (skipped for previews)
  if (!preview) {
    const reservation = await reserveSend(sendIdentity);
    if (!reservation.ok) {
      return { ok: false, error: 'daily_limit', limited: true, identity: sendIdentity, limit: reservation.limit };
    }
  }

  // One-click unsubscribe headers (Gmail/Yahoo bulk sender requirement)
  const listUnsubHeaders = {
    'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:unsubscribe@${(brandConfig.website || 'suresecured.com').replace(/^https?:\/\//, '')}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };

  // INSERT email_sends with status='sending' BEFORE Gmail send
  // This is required: email_tracking_tokens has NOT NULL FK to email_sends.id
  const insertResult = await pool.query(
    `INSERT INTO email_sends
       (enrollment_id, step_id, salesperson_id, lead_id, to_email, subject, status, pixel_token, client_id)
     VALUES ($1,$2,$3,$4,$5,$6,'sending',$7,$8)
     RETURNING id`,
    // client_id was missing from this INSERT, so every send row was created with
    // client_id = NULL. Migration 015 backfilled the pre-existing rows, but new
    // sends stayed NULL -- which meant the tenant-scoped health/undelivered
    // queries (WHERE client_id = $1) could not see any send after the migration.
    // A successful send therefore never cleared the banner, and new failures
    // never appeared on /undelivered.
    [enrollmentId, stepId, salespersonId, leadId, to, resolvedSubject, pixelToken, clientId || null]
  );
  const emailSendId = insertResult.rows[0].id;

  // Rewrite body links AFTER insert (FK now satisfied)
  // No signature here — buildHtml() renders its own styled signature block.
  const rewrittenBody = await rewriteLinks(resolvedBody, emailSendId);

  const html = buildHtml(rewrittenBody, fromName, unsubscribeUrl, brandConfig, pixelUrl);

  // Plain-text fallback has no styled signature block, so it needs the signature appended.
  const rewrittenBodyText = rewrittenBody + (signature ? `\n\n${signature}` : '');

  // Which service we ATTEMPTED, tracked so the failure path can record it. The
  // column defaults to 'gmail' and was only ever set on success, so a failed
  // IONOS/SES send showed send_service='gmail' and made diagnosis point at the
  // wrong provider.
  let attemptedService = sesEnabled() ? 'ses' : 'gmail';
  if (clientCfg?.smtp_host && clientCfg?.smtp_user && clientCfg?.smtp_pass) {
    attemptedService = clientCfg.provider || 'smtp';
  }

  try {
    if (clientCfg?.smtp_host && clientCfg?.smtp_user && clientCfg?.smtp_pass) {
      // ── Client DB config path ─────────────────────────────────────────────
      const sendFrom  = clientCfg.from_email || account?.email;
      const sendName  = clientCfg.from_name  || fromName;
      const replyToAddr = clientCfg.reply_to || account?.email || sendFrom;
      await sendViaClientSmtp(clientCfg, {
        fromName:    sendName,
        fromAddress: sendFrom,
        replyTo:     replyToAddr,
        to,
        subject:     resolvedSubject,
        textBody:    rewrittenBodyText,
        htmlBody:    html,
        headers:     listUnsubHeaders,
      });
      await pool.query(
        `UPDATE email_sends SET status = 'sent', send_service = $1 WHERE id = $2`,
        [clientCfg.provider || 'smtp', emailSendId]
      );
    } else if (sesEnabled()) {
      // ── Global env-var SES/SMTP fallback ─────────────────────────────────
      const sesFrom = process.env.SES_FROM_EMAIL || account.email;
      const sesName = process.env.SES_FROM_NAME  || fromName;
      await sendViaSes({
        fromName:    sesName,
        fromAddress: sesFrom,
        replyTo:     account?.email,
        to,
        subject:     resolvedSubject,
        textBody:    rewrittenBodyText,
        htmlBody:    html,
        headers:     listUnsubHeaders,
      });
      await pool.query(
        `UPDATE email_sends SET status = 'sent', send_service = 'ses' WHERE id = $1`,
        [emailSendId]
      );
    } else {
      // ── Gmail API path ────────────────────────────────────────────────────
      // Use configured from_email (Send As alias) if set, otherwise fall back to OAuth account email
      const gmailFrom = clientCfg?.from_email || account.email;
      const gmailName = clientCfg?.from_name  || fromName;
      const gmail = google.gmail({ version: 'v1', auth: client });
      const raw   = await buildRawMessage({
        fromName:    gmailName,
        fromAddress: gmailFrom,
        to,
        subject:     resolvedSubject,
        textBody:    rewrittenBodyText,
        htmlBody:    html,
        headers:     listUnsubHeaders,
      });
      const sent = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      await pool.query(
        `UPDATE email_sends
         SET status = 'sent', gmail_message_id = $1, gmail_thread_id = $2, send_service = 'gmail'
         WHERE id = $3`,
        [sent.data.id, sent.data.threadId, emailSendId]
      );
    }

    await pool.query(
      'UPDATE email_accounts SET last_error = NULL WHERE salesperson_id = $1',
      [salespersonId]
    );
    // Clears consecutive_failures and the alert gate, so a mailbox that starts
    // working again stops warning the operator without anyone dismissing it.
    await recordIdentitySuccess(clientId);

    return { ok: true };
  } catch (err) {
    const msg = err.message || 'Unknown error';
    const isBounce = isPermanentBounce(msg);
    const failureClass = classifySendFailure(err, isBounce);

    // Persist the reason for EVERY failure class, not just bounces. The previous
    // version only recorded a reason when isPermanentBounce() was true, so an
    // SMTP auth rejection landed as status='failed' with a NULL reason and the
    // operator had no way to learn why nothing was arriving.
    await pool.query(
      `UPDATE email_sends
       SET status = 'failed', failure_reason = $1, failure_class = $2, failed_at = NOW(), send_service = $4
       WHERE id = $3`,
      [msg.slice(0, 500), failureClass, emailSendId, attemptedService]
    ).catch(err2 => console.error('[send] failure record error:', err2.message));

    if (isBounce) {
      await pool.query(
        `UPDATE email_sends SET bounced = TRUE, bounce_error = $1 WHERE id = $2`,
        [msg.slice(0, 500), emailSendId]
      ).catch(err2 => console.error('[bounce] db update error:', err2.message));
    }

    await pool.query(
      'UPDATE email_accounts SET last_error = $1 WHERE salesperson_id = $2',
      [msg.slice(0, 500), salespersonId]
    ).catch(() => {});

    // Operator-level classes mean the sending identity itself is broken, so
    // nothing will deliver until a human fixes it. Record that against the
    // config the Settings page reads, and count consecutive failures so the
    // alert fires on a real outage rather than one flaky recipient.
    if (OPERATOR_FAILURE_CLASSES.has(failureClass)) {
      await recordIdentityFailure(clientId, msg, failureClass);
    }

    return { ok: false, error: msg, failureClass, permanentBounce: isBounce };
  }
}

async function checkForReplies(salespersonId, gmailThreadId) {
  const auth = await getAuthedClient(salespersonId);
  if (!auth) return { replied: false };

  try {
    const gmail    = google.gmail({ version: 'v1', auth: auth.client });
    const thread   = await gmail.users.threads.get({ userId: 'me', id: gmailThreadId, format: 'full' });
    const messages = thread.data.messages ?? [];
    if (messages.length <= 1) return { replied: false };

    // Last message is the customer reply
    const last    = messages[messages.length - 1];
    const headers = last.payload?.headers || [];
    const from    = headers.find(h => h.name === 'From')?.value    || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '';

    // Extract plain text body
    let replyText = '';
    const findText = (parts) => {
      for (const p of (parts || [])) {
        if (p.mimeType === 'text/plain' && p.body?.data) {
          replyText = Buffer.from(p.body.data, 'base64').toString('utf8').slice(0, 600);
          return;
        }
        if (p.parts) findText(p.parts);
      }
    };
    if (last.payload?.body?.data) {
      replyText = Buffer.from(last.payload.body.data, 'base64').toString('utf8').slice(0, 600);
    } else {
      findText(last.payload?.parts);
    }

    return { replied: true, replyFrom: from, replySubject: subject, replyText: replyText.trim() };
  } catch {
    return { replied: false };
  }
}

async function sendReplyNotification(salespersonId, lead, replyData, brandConfig = {}) {
  const auth = await getAuthedClient(salespersonId);
  if (!auth) return;

  try {
    const { client, account } = auth;
    const brand   = brandConfig.name || 'SalesPilot';
    const appBase = process.env.TRACKER_URL || 'https://your-app.railway.app';
    const leadUrl = `${appBase}/portal/leads/${lead.id}`;

    const textBody = [
      `${lead.first_name || lead.email} replied to your email.`,
      '',
      `From: ${replyData.replyFrom || lead.email}`,
      `Lead: ${lead.first_name || ''} ${lead.last_name || ''} <${lead.email}>`.trim(),
      '',
      replyData.replyText ? `Their message:\n\n${replyData.replyText}` : '',
      '',
      `View lead: ${leadUrl}`,
      '',
      'Their sequence has been paused — follow up manually.',
    ].join('\n');

    const c = replyData.classification;
    const categoryColors = {
      hot_lead: '#16a34a', interested: '#2563eb', needs_quote: '#7c3aed',
      question: '#d97706', not_interested: '#6b7280', unsubscribe: '#dc2626',
      already_purchased: '#0891b2', wrong_person: '#9ca3af', spam: '#9ca3af',
    };
    const categoryLabels = {
      hot_lead: '🔥 Hot Lead', interested: '👍 Interested', needs_quote: '📋 Needs Quote',
      question: '❓ Question', not_interested: '👎 Not Interested', unsubscribe: '🚫 Unsubscribe',
      already_purchased: '✅ Already Purchased', wrong_person: '❌ Wrong Person', spam: '⚠ Spam',
    };
    const urgencyBadge = c?.urgency === 'high'
      ? '<span style="background:#fef2f2;color:#dc2626;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:700">HIGH URGENCY</span>'
      : c?.urgency === 'medium'
      ? '<span style="background:#fffbeb;color:#d97706;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600">Medium</span>'
      : '';

    const htmlBody = `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <h2 style="margin:0 0 12px 0;font-size:18px;color:#111">
          💬 ${lead.first_name || lead.email} replied to your email
        </h2>
        ${c ? `
        <div style="margin:0 0 16px 0;display:flex;align-items:center;gap:8px">
          <span style="background:${categoryColors[c.category] || '#111'};color:#fff;padding:3px 10px;
                border-radius:12px;font-size:13px;font-weight:600">${categoryLabels[c.category] || c.category}</span>
          ${urgencyBadge}
        </div>
        <p style="margin:0 0 16px 0;font-size:14px;color:#374151;background:#f9fafb;
                  padding:10px 14px;border-radius:6px">${c.summary}</p>
        ` : ''}
        ${replyData.replyText ? `
        <div style="background:#f5f5f3;border-left:3px solid #888;padding:12px 16px;margin:0 0 20px 0;
                    font-size:14px;color:#333;line-height:1.6;white-space:pre-wrap">${replyData.replyText}</div>
        ` : ''}
        <p style="margin:0 0 8px 0;font-size:14px;color:#555">
          <strong>Lead:</strong> ${lead.first_name || ''} ${lead.last_name || ''} &lt;${lead.email}&gt;
        </p>
        <p style="margin:0 0 20px 0;font-size:13px;color:#888">Sequence paused — reply to them directly.</p>
        <a href="${leadUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;
           padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">View Lead →</a>
      </div>`;

    const raw = await buildRawMessage({
      fromName:    `${brand} Notifications`,
      fromAddress: account.email,
      to:          account.email,
      subject:     `Reply from ${lead.first_name || lead.email} — action needed`,
      textBody,
      htmlBody,
    });

    const gmailApi = google.gmail({ version: 'v1', auth: client });
    await gmailApi.users.messages.send({ userId: 'me', requestBody: { raw } });
  } catch (err) {
    console.error('[notify] reply notification failed:', err.message);
  }
}

/**
 * buildDigestHtml — operator-facing digest email
 * No pixel, no unsubscribe link, no CTA buttons — internal use only
 */
function buildDigestHtml(bodyText, brandConfig = {}) {
  const {
    primary_color = '#030302',
    accent_color  = '#E91111',
    bg_color      = '#EDEBE7',
    name          = 'SalesPilot',
  } = brandConfig;

  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const paragraphs = bodyText.split(/\n\n+/).map(p =>
    `<p style="margin:0 0 18px 0;color:${primary_color};font-size:15px;line-height:1.75">${p.replace(/\n/g, '<br>')}</p>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f4f4f2;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f4f4f2;padding:32px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%">

        <!-- Header -->
        <tr><td style="background:${primary_color};padding:22px 32px">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            <tr>
              <td>
                <span style="color:#ffffff;font-size:20px;font-weight:700;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">${name}</span>
              </td>
              <td align="right">
                <span style="color:#ffffff;font-size:11px;opacity:0.6">Daily Digest</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Accent bar -->
        <tr><td style="background:${accent_color};height:4px;font-size:0;line-height:0">&nbsp;</td></tr>

        <!-- Date label -->
        <tr><td style="background:#ffffff;padding:16px 40px 0">
          <p style="margin:0;font-size:11px;color:#8a8a88;text-transform:uppercase;letter-spacing:0.8px">${date}</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#ffffff;padding:24px 40px 36px">
          ${paragraphs}
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:${bg_color};padding:16px 40px 24px;border-top:1px solid #d8d6d2;border-radius:0 0 6px 6px">
          <p style="color:#8a8a88;font-size:11px;margin:0;line-height:1.7;text-align:center;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
            SalesPilot operator digest &mdash; ${name}<br>
            This is an internal operational email.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── SES sending via nodemailer SMTP ─────────────────────────────────────────

function sesTransport() {
  if (!process.env.SES_SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SES_SMTP_HOST,
    port: parseInt(process.env.SES_SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SES_SMTP_USER,
      pass: process.env.SES_SMTP_PASS,
    },
  });
}

function sesEnabled() {
  return !!(process.env.SES_SMTP_HOST && process.env.SES_SMTP_USER && process.env.SES_SMTP_PASS);
}

async function sendViaSes({ fromName, fromAddress, replyTo, to, subject, textBody, htmlBody, headers }) {
  const transport = sesTransport();
  if (!transport) throw new Error('SES not configured');
  await transport.sendMail({
    from:    `"${fromName}" <${fromAddress}>`,
    replyTo: replyTo || fromAddress,
    to,
    subject,
    text:    textBody,
    html:    htmlBody,
    headers: headers || undefined,
  });
}

/**
 * Send via a client's saved SMTP config (from client_email_config table).
 * clientCfg comes from getClientEmailConfig().
 */
async function sendViaClientSmtp(clientCfg, { fromName, fromAddress, replyTo, to, subject, textBody, htmlBody, headers }) {
  const transport = nodemailer.createTransport({
    host:   clientCfg.smtp_host,
    port:   clientCfg.smtp_port || 587,
    secure: clientCfg.smtp_secure || false,
    auth:   { user: clientCfg.smtp_user, pass: clientCfg.smtp_pass },
  });
  await transport.sendMail({
    from:    `"${fromName || clientCfg.from_name}" <${fromAddress || clientCfg.from_email}>`,
    replyTo: replyTo || clientCfg.reply_to || fromAddress || clientCfg.from_email,
    to,
    subject,
    text:    textBody,
    html:    htmlBody,
    headers: headers || undefined,
  });
}

// ── Reply detection by lead email address (works for SES + Gmail sends) ─────

async function checkForRepliesByAddress(salespersonId, leadEmail, afterDate) {
  const auth = await getAuthedClient(salespersonId);
  if (!auth) return { replied: false };

  try {
    const gmail = google.gmail({ version: 'v1', auth: auth.client });
    // Search Gmail inbox for messages FROM the lead after the enrollment date
    const after = Math.floor(new Date(afterDate).getTime() / 1000);
    const q     = `from:${leadEmail} after:${after} in:anywhere`;
    const list  = await gmail.users.messages.list({ userId: 'me', q, maxResults: 5 });
    const msgs  = list.data.messages || [];
    if (!msgs.length) return { replied: false };

    // Get the first reply message
    const msg     = await gmail.users.messages.get({ userId: 'me', id: msgs[0].id, format: 'full' });
    const headers = msg.data.payload?.headers || [];
    const from    = headers.find(h => h.name === 'From')?.value    || leadEmail;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';

    let replyText = '';
    const findText = (parts) => {
      for (const p of (parts || [])) {
        if (p.mimeType === 'text/plain' && p.body?.data) {
          replyText = Buffer.from(p.body.data, 'base64').toString('utf8').slice(0, 600);
          return;
        }
        if (p.parts) findText(p.parts);
      }
    };
    if (msg.data.payload?.body?.data) {
      replyText = Buffer.from(msg.data.payload.body.data, 'base64').toString('utf8').slice(0, 600);
    } else {
      findText(msg.data.payload?.parts);
    }

    return { replied: true, replyFrom: from, replySubject: subject, replyText: replyText.trim() };
  } catch {
    return { replied: false };
  }
}

/**
 * Send a direct (non-sequence) email via IONOS SMTP.
 * Used by the lead CRM reply composer.
 */
async function sendDirectEmail({ fromName, fromAddress, replyTo, to, subject, textBody, htmlBody, salespersonId, clientId }) {
  // Try Gmail OAuth first if a salesperson ID is provided
  if (salespersonId) {
    const authed = await getAuthedClient(salespersonId);
    if (authed) {
      // Use configured from_email (e.g. sales@suresecured.com Send-As alias) if set
      let effectiveFrom = authed.account.email;
      let effectiveName = fromName || 'Sales';
      if (clientId) {
        const cfg = await getClientEmailConfig(clientId);
        if (cfg?.from_email) { effectiveFrom = cfg.from_email; effectiveName = cfg.from_name || effectiveName; }
      }
      const raw = await buildRawMessage({ fromName: effectiveName, fromAddress: effectiveFrom, to, subject, textBody, htmlBody });
      const gmailApi = google.gmail({ version: 'v1', auth: authed.client });
      const sent = await gmailApi.users.messages.send({ userId: 'me', requestBody: { raw } });
      return { ok: true, via: 'gmail', threadId: sent.data.threadId, messageId: sent.data.id };
    }
  }
  if (sesEnabled()) {
    await sendViaSes({ fromName, fromAddress, replyTo, to, subject, textBody, htmlBody });
    return { ok: true, via: 'ses' };
  }
  throw new Error('No email provider configured. Connect Gmail in Settings → Email.');
}

module.exports = {
  oauthClient, getAuthUrl, exchangeCode, verifyOAuthState, signOAuthState,
  buildHtml, buildDigestHtml,
  sendSequenceEmail, sendViaSes, sendViaClientSmtp, sesEnabled, sendDirectEmail,
  checkForReplies, checkForRepliesByAddress,
  sendReplyNotification,
  getAuthedClient, buildRawMessage,
  getClientEmailConfig,
  classifySendFailure, recordIdentityFailure, recordIdentitySuccess,
  OPERATOR_FAILURE_CLASSES,
};
