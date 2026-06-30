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
  // Brand colors extracted directly from suresecured.com
  // Near-black: #030302  |  Red CTA: #E91111  |  Warm gray: #EDEBE7  |  Info blue: #CBDEE8
  const paragraphs = body.split(/\n\n+/).map(p =>
    '<p style="margin:0 0 18px 0;color:#030302;font-size:15px;line-height:1.75">' +
    p.split('\n').map(line =>
      line.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" style="color:#E91111;font-weight:600;text-decoration:underline">$1</a>')
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

        <!-- Announcement bar — matches site's info bar -->
        <tr><td style="background:#CBDEE8;padding:10px 32px;text-align:center">
          <span style="font-size:12px;color:#030302;font-weight:600;letter-spacing:0.2px">For More Information Call/Text: <a href="tel:7476889992" style="color:#030302;text-decoration:none;font-weight:700">(747) 688-9992</a></span>
        </td></tr>

        <!-- Header — matches site nav (near-black) -->
        <tr><td style="background:#030302;padding:22px 32px">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            <tr>
              <td>
                <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">SureSecured</span>
              </td>
              <td align="right">
                <span style="color:#ffffff;font-size:11px;opacity:0.6;letter-spacing:0.5px">suresecured.com</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Red accent bar — matches site's red CTA strip -->
        <tr><td style="background:#E91111;height:4px;font-size:0;line-height:0">&nbsp;</td></tr>

        <!-- Body — white card, matches site body -->
        <tr><td style="background:#ffffff;padding:36px 40px">
          ${paragraphs}

          <!-- Quote CTA — red button matching site's primary CTA style -->
          <table cellpadding="0" cellspacing="0" role="presentation" style="margin-top:28px">
            <tr>
              <td style="background:#E91111;border-radius:4px">
                <a href="https://suresecured.com/pages/request-a-quote"
                   style="display:inline-block;padding:13px 28px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;letter-spacing:0.2px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
                  Request a Free Quote &rarr;
                </a>
              </td>
              <td width="12"></td>
              <td style="border:2px solid #030302;border-radius:4px">
                <a href="https://suresecured.com"
                   style="display:inline-block;padding:11px 24px;color:#030302;font-size:14px;font-weight:600;text-decoration:none;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
                  Shop Products
                </a>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Signature — warm gray card, matches site card bg -->
        <tr><td style="background:#EDEBE7;padding:24px 40px;border-top:1px solid #d8d6d2">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            <tr>
              <td>
                <p style="margin:0;font-size:14px;color:#030302;font-weight:700;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">${salespersonName}</p>
                <p style="margin:3px 0 0;font-size:12px;color:#5a5a58">Security Specialist &mdash; SureSecured</p>
                <p style="margin:6px 0 0;font-size:12px;color:#5a5a58">
                  <a href="tel:7476889992" style="color:#030302;text-decoration:none;font-weight:600">(747) 688-9992</a>
                  &nbsp;&nbsp;|&nbsp;&nbsp;
                  <a href="https://suresecured.com" style="color:#030302;text-decoration:none;font-weight:600">suresecured.com</a>
                </p>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#EDEBE7;padding:16px 40px 24px;border-top:1px solid #d8d6d2;border-radius:0 0 6px 6px">
          <p style="color:#8a8a88;font-size:11px;margin:0;line-height:1.7;text-align:center;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
            You received this because you requested information from SureSecured.<br>
            SureSecured Security Products &bull; Simi Valley, CA 93063<br>
            <a href="${unsubscribeUrl}" style="color:#8a8a88;text-decoration:underline">Unsubscribe</a>
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
