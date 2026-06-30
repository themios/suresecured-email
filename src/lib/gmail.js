const { google } = require('googleapis');
const nodemailer  = require('nodemailer');
const { pool }    = require('../db');

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

function buildHtml(body, salespersonName) {
  const paragraphs = body.split(/\n\n+/).map(p =>
    '<p>' + p.split('\n').map(line =>
      line.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" style="color:#2563eb">$1</a>')
    ).join('<br>') + '</p>'
  ).join('\n');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%">
        <tr><td style="background:#1e3a5f;padding:20px 32px">
          <span style="color:#ffffff;font-size:18px;font-weight:bold">SureSecured</span>
        </td></tr>
        <tr><td style="padding:32px;color:#374151;font-size:15px;line-height:1.6">
          ${paragraphs}
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
          <p style="color:#6b7280;font-size:13px;margin:0">${salespersonName}<br>SureSecured Security Products<br>Simi Valley, CA</p>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb">
          <p style="color:#9ca3af;font-size:12px;margin:0">
            You are receiving this because you previously contacted SureSecured or requested information.
            To unsubscribe, reply with "unsubscribe" in the subject line.
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

  const gmail    = google.gmail({ version: 'v1', auth: client });
  const fromName = vars.salesperson_name || 'SureSecured Team';
  const html     = buildHtml(resolvedBody, fromName);

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
