const { google } = require('googleapis');
const nodemailer  = require('nodemailer');
const { pool }    = require('../db');
const { generateToken } = require('./unsubscribe');

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

function buildHtml(body, salespersonName, unsubscribeUrl) {
  const paragraphs = body.split(/\n\n+/).map(p =>
    '<p style="margin:0 0 16px 0">' +
    p.split('\n').map(line =>
      line.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" style="color:#c8922a;font-weight:600">$1</a>')
    ).join('<br>') +
    '</p>'
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f0f2f5;padding:40px 16px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width:600px;width:100%">

        <!-- Header -->
        <tr><td style="background:#0d2d52;border-radius:10px 10px 0 0;padding:28px 40px">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            <tr>
              <td>
                <span style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.5px">SURE<span style="color:#c8922a">SECURED</span></span>
                <br>
                <span style="color:#8bafd4;font-size:11px;letter-spacing:1.5px;text-transform:uppercase">Marine-Grade Security Screen Doors &amp; Windows</span>
              </td>
              <td align="right">
                <span style="color:#c8922a;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase">Simi Valley, CA</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Gold accent bar -->
        <tr><td style="background:#c8922a;height:3px;font-size:0;line-height:0">&nbsp;</td></tr>

        <!-- Body -->
        <tr><td style="background:#ffffff;padding:36px 40px;color:#2d3748;font-size:15px;line-height:1.7">
          ${paragraphs}

          <!-- Signature divider -->
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:28px;border-top:2px solid #c8922a">
            <tr><td style="padding-top:20px">
              <p style="margin:0;font-size:14px;color:#2d3748;font-weight:700">${salespersonName}</p>
              <p style="margin:4px 0 0;font-size:13px;color:#64748b">Security Specialist &mdash; SureSecured</p>
              <p style="margin:4px 0 0;font-size:13px;color:#64748b">📞 (805) 527-3511 &nbsp;|&nbsp; 🌐 <a href="https://suresecured.com" style="color:#0d2d52;text-decoration:none">suresecured.com</a></p>
              <p style="margin:12px 0 0;font-size:13px;color:#64748b">
                <a href="https://suresecured.com/pages/request-a-quote"
                   style="display:inline-block;background:#0d2d52;color:#ffffff;padding:10px 22px;border-radius:5px;text-decoration:none;font-weight:700;font-size:13px">
                  Request a Free Quote →
                </a>
              </p>
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f8f9fb;border-top:1px solid #e2e8f0;border-radius:0 0 10px 10px;padding:20px 40px">
          <p style="color:#94a3b8;font-size:11px;margin:0;line-height:1.6;text-align:center">
            You are receiving this email because you previously requested information from SureSecured.<br>
            <strong style="color:#64748b">SureSecured Security Products</strong> &bull; Simi Valley, CA 93063<br>
            <a href="${unsubscribeUrl}" style="color:#94a3b8;text-decoration:underline">Unsubscribe</a>
            &nbsp;&bull;&nbsp;
            <a href="https://suresecured.com" style="color:#94a3b8;text-decoration:underline">suresecured.com</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendSequenceEmail({ salespersonId, to, subject, body, vars, enrollmentId, stepId, leadId }) {
  const auth = await getAuthedClient(salespersonId);
  if (!auth) return { ok: false, error: 'no_account' };

  const { client, account } = auth;

  const resolvedSubject = substituteVars(subject, vars);
  const resolvedBody    = substituteVars(body, vars);

  const gmail          = google.gmail({ version: 'v1', auth: client });
  const fromName       = vars.salesperson_name || 'SureSecured Team';
  const unsubscribeUrl = buildUnsubscribeUrl(to);
  const html           = buildHtml(resolvedBody, fromName, unsubscribeUrl);

  try {
    const raw = await buildRawMessage({
      fromName,
      fromAddress: account.email,
      to,
      subject: resolvedSubject,
      textBody: resolvedBody,
      htmlBody: html,
    });

    const sent = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

    await pool.query(
      `INSERT INTO email_sends
         (enrollment_id, step_id, salesperson_id, lead_id, to_email, subject, gmail_message_id, gmail_thread_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'sent')`,
      [enrollmentId, stepId, salespersonId, leadId, to, resolvedSubject,
       sent.data.id, sent.data.threadId]
    );

    await pool.query(
      'UPDATE email_accounts SET last_error = NULL WHERE salesperson_id = $1',
      [salespersonId]
    );

    return { ok: true, messageId: sent.data.id };
  } catch (err) {
    const msg = err.message || 'Unknown error';
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

module.exports = { oauthClient, getAuthUrl, exchangeCode, sendSequenceEmail, checkForReplies };
