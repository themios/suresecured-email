const { google } = require('googleapis');
const nodemailer  = require('nodemailer');
const { pool }    = require('../db');
const { generateToken } = require('./unsubscribe');
const { rewriteLinks, isPermanentBounce }  = require('./email-tracking');
const { decrypt } = require('./crypto');

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
    state: String(salespersonId),
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
    refresh_token: account.oauth_refresh_token,
    access_token:  account.oauth_access_token,
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
        [credentials.access_token, credentials.expiry_date ? new Date(credentials.expiry_date) : null, salespersonId]
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

async function buildRawMessage({ fromName, fromAddress, to, subject, textBody, htmlBody }) {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const info = await composer.sendMail({
    from:    { name: fromName, address: fromAddress },
    to,
    subject,
    text:    textBody,
    html:    htmlBody,
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

async function sendSequenceEmail({ salespersonId, clientId, to, subject, body, vars, enrollmentId, stepId, leadId }, brandConfig = {}) {
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
  const resolvedBody = substituteVars(body, vars) + (signature ? `\n\n${signature}` : '');

  // Pre-generate pixel token
  const pixelToken  = require('crypto').randomUUID();
  const trackerBase = process.env.TRACKER_URL || 'https://your-app.railway.app';
  const pixelUrl    = `${trackerBase}/pixel/${pixelToken}`;

  const gmail          = google.gmail({ version: 'v1', auth: client });
  const fromName       = vars.salesperson_name || `${brandConfig.name || 'SureSecured'} Team`;
  const unsubscribeUrl = buildUnsubscribeUrl(to);

  // INSERT email_sends with status='sending' BEFORE Gmail send
  // This is required: email_tracking_tokens has NOT NULL FK to email_sends.id
  const insertResult = await pool.query(
    `INSERT INTO email_sends
       (enrollment_id, step_id, salesperson_id, lead_id, to_email, subject, status, pixel_token)
     VALUES ($1,$2,$3,$4,$5,$6,'sending',$7)
     RETURNING id`,
    [enrollmentId, stepId, salespersonId, leadId, to, resolvedSubject, pixelToken]
  );
  const emailSendId = insertResult.rows[0].id;

  // Rewrite body links AFTER insert (FK now satisfied)
  const rewrittenBody = await rewriteLinks(resolvedBody, emailSendId);

  const html = buildHtml(rewrittenBody, fromName, unsubscribeUrl, brandConfig, pixelUrl);

  // Load client SMTP config (DB takes priority over env vars)
  const clientCfg = await getClientEmailConfig(clientId);

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
        textBody:    rewrittenBody,
        htmlBody:    html,
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
        textBody:    rewrittenBody,
        htmlBody:    html,
      });
      await pool.query(
        `UPDATE email_sends SET status = 'sent', send_service = 'ses' WHERE id = $1`,
        [emailSendId]
      );
    } else {
      // ── Gmail API path ────────────────────────────────────────────────────
      const gmail = google.gmail({ version: 'v1', auth: client });
      const raw   = await buildRawMessage({
        fromName,
        fromAddress: account.email,
        to,
        subject:     resolvedSubject,
        textBody:    rewrittenBody,
        htmlBody:    html,
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

    return { ok: true };
  } catch (err) {
    const msg = err.message || 'Unknown error';

    // Update status to 'failed' — row already exists from pre-send INSERT
    await pool.query(
      `UPDATE email_sends SET status = 'failed' WHERE id = $1`,
      [emailSendId]
    ).catch(() => {}); // ignore secondary failure

    // Detect permanent bounce and mark the email_sends row
    const isBounce = isPermanentBounce(msg);
    if (isBounce) {
      await pool.query(
        `UPDATE email_sends
         SET bounced = TRUE, bounce_error = $1
         WHERE id = $2`,
        [msg.slice(0, 500), emailSendId]
      ).catch(err2 => console.error('[bounce] db update error:', err2.message));
    }

    await pool.query(
      'UPDATE email_accounts SET last_error = $1 WHERE salesperson_id = $2',
      [msg.slice(0, 500), salespersonId]
    );

    return { ok: false, error: msg, permanentBounce: isBounce };
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

async function sendViaSes({ fromName, fromAddress, replyTo, to, subject, textBody, htmlBody }) {
  const transport = sesTransport();
  if (!transport) throw new Error('SES not configured');
  await transport.sendMail({
    from:    `"${fromName}" <${fromAddress}>`,
    replyTo: replyTo || fromAddress,
    to,
    subject,
    text:    textBody,
    html:    htmlBody,
  });
}

/**
 * Send via a client's saved SMTP config (from client_email_config table).
 * clientCfg comes from getClientEmailConfig().
 */
async function sendViaClientSmtp(clientCfg, { fromName, fromAddress, replyTo, to, subject, textBody, htmlBody }) {
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
async function sendDirectEmail({ fromName, fromAddress, replyTo, to, subject, textBody, htmlBody, salespersonId }) {
  // Try Gmail OAuth first if a salesperson ID is provided
  if (salespersonId) {
    const authed = await getAuthedClient(salespersonId);
    if (authed) {
      const raw = await buildRawMessage({ fromName: fromName || authed.account.email, fromAddress: authed.account.email, to, subject, textBody, htmlBody });
      const gmailApi = google.gmail({ version: 'v1', auth: authed.client });
      await gmailApi.users.messages.send({ userId: 'me', requestBody: { raw } });
      return { ok: true, via: 'gmail' };
    }
  }
  if (sesEnabled()) {
    await sendViaSes({ fromName, fromAddress, replyTo, to, subject, textBody, htmlBody });
    return { ok: true, via: 'ses' };
  }
  throw new Error('No email provider configured. Connect Gmail in Settings → Email.');
}

module.exports = {
  oauthClient, getAuthUrl, exchangeCode,
  buildHtml, buildDigestHtml,
  sendSequenceEmail, sendViaSes, sendViaClientSmtp, sesEnabled, sendDirectEmail,
  checkForReplies, checkForRepliesByAddress,
  sendReplyNotification,
  getAuthedClient, buildRawMessage,
  getClientEmailConfig,
};
