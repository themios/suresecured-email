const { google } = require('googleapis');
const nodemailer  = require('nodemailer');
const { pool }    = require('../db');
const { generateToken } = require('./unsubscribe');
const { rewriteLinks }  = require('./email-tracking');

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

async function sendSequenceEmail({ salespersonId, to, subject, body, vars, enrollmentId, stepId, leadId }, brandConfig = {}) {
  const auth = await getAuthedClient(salespersonId);
  if (!auth) return { ok: false, error: 'no_account' };

  const { client, account } = auth;

  const resolvedSubject = substituteVars(subject, vars);
  const resolvedBody    = substituteVars(body, vars);

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

  try {
    const raw = await buildRawMessage({
      fromName,
      fromAddress: account.email,
      to,
      subject: resolvedSubject,
      textBody: rewrittenBody,
      htmlBody: html,
    });

    const sent = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

    // Update status to 'sent' with Gmail message/thread IDs
    await pool.query(
      `UPDATE email_sends
       SET status = 'sent', gmail_message_id = $1, gmail_thread_id = $2
       WHERE id = $3`,
      [sent.data.id, sent.data.threadId, emailSendId]
    );

    await pool.query(
      'UPDATE email_accounts SET last_error = NULL WHERE salesperson_id = $1',
      [salespersonId]
    );

    return { ok: true, messageId: sent.data.id };
  } catch (err) {
    const msg = err.message || 'Unknown error';

    // Update status to 'failed' — row already exists from pre-send INSERT
    await pool.query(
      `UPDATE email_sends SET status = 'failed' WHERE id = $1`,
      [emailSendId]
    ).catch(() => {}); // ignore secondary failure

    await pool.query(
      'UPDATE email_accounts SET last_error = $1 WHERE salesperson_id = $2',
      [msg.slice(0, 500), salespersonId]
    );

    return { ok: false, error: msg };
  }
}

async function checkForReplies(salespersonId, gmailThreadId) {
  const auth = await getAuthedClient(salespersonId);
  if (!auth) return false;

  try {
    const gmail = google.gmail({ version: 'v1', auth: auth.client });
    const thread = await gmail.users.threads.get({ userId: 'me', id: gmailThreadId });
    const messages = thread.data.messages ?? [];
    // If more than 1 message in thread, the customer replied
    return messages.length > 1;
  } catch {
    return false;
  }
}

module.exports = { oauthClient, getAuthUrl, exchangeCode, buildHtml, sendSequenceEmail, checkForReplies };
