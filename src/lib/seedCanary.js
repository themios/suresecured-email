/**
 * Seed canary: each tenant connects one monitored inbox in Settings > Email.
 * A copy of every real campaign send also goes to that address; a daily job
 * then checks the seed inbox via the Gmail API and records which folder Gmail
 * filed the message into. This is the proof behind "we watch it land" -- not
 * "we sent it", but "here is where it actually went".
 */
const { google } = require('googleapis');
const { pool } = require('../db');
const { oauthClient, getAuthUrl, exchangeCode, verifyOAuthState, signOAuthState, buildRawMessage } = require('./gmail');
const { maybeEncrypt, safeDecrypt } = require('./crypto');

const SEED_PURPOSE = 'seed';

function getSeedAuthUrl(clientId) {
  return getAuthUrl(clientId, SEED_PURPOSE);
}

function verifySeedOAuthState(state) {
  return verifyOAuthState(state, SEED_PURPOSE);
}

// Mirrors gmail.js's getAuthedClient, but reads/refreshes seed_accounts
// (keyed by client_id) instead of email_accounts (keyed by salesperson_id).
async function getSeedAuthedClient(clientId) {
  const { rows } = await pool.query(
    'SELECT * FROM seed_accounts WHERE client_id = $1 AND enabled = true',
    [clientId]
  );
  if (!rows[0]) return null;

  const account = rows[0];
  const client  = oauthClient();
  client.setCredentials({
    refresh_token: safeDecrypt(account.oauth_refresh_token),
    access_token:  safeDecrypt(account.oauth_access_token),
    expiry_date:   account.oauth_token_expiry ? new Date(account.oauth_token_expiry).getTime() : undefined,
  });

  const now = Date.now();
  const expiry = account.oauth_token_expiry ? new Date(account.oauth_token_expiry).getTime() : 0;
  if (expiry < now + 60000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      await pool.query(
        `UPDATE seed_accounts SET oauth_access_token = $1, oauth_token_expiry = $2, last_error = NULL WHERE client_id = $3`,
        [maybeEncrypt(credentials.access_token), credentials.expiry_date ? new Date(credentials.expiry_date) : null, clientId]
      );
    } catch (err) {
      await pool.query('UPDATE seed_accounts SET last_error = $1 WHERE client_id = $2',
        ['Token refresh failed: ' + err.message, clientId]);
      return null;
    }
  }

  return { client, account };
}

// Fire a copy of a real campaign send to this tenant's seed inbox, from the
// SAME sending identity used for the real send, so placement reflects reality.
// Best-effort: a seed copy failing must never affect the real send it mirrors.
async function sendSeedCopy({ clientId, salespersonAuth, fromName, fromAddress, subject, textBody, htmlBody }) {
  try {
    const { rows } = await pool.query(
      'SELECT email FROM seed_accounts WHERE client_id = $1 AND enabled = true', [clientId]
    );
    const seedEmail = rows[0]?.email;
    if (!seedEmail || !salespersonAuth) return;

    const raw = await buildRawMessage({ fromName, fromAddress, to: seedEmail, subject, textBody, htmlBody });
    const gmailApi = google.gmail({ version: 'v1', auth: salespersonAuth.client });
    await gmailApi.users.messages.send({ userId: 'me', requestBody: { raw } });
  } catch (err) {
    console.warn(`[seed-canary] copy to seed inbox failed for client ${clientId}:`, err.message);
  }
}

// Gmail's own placement signal: CATEGORY_PROMOTIONS / CATEGORY_SOCIAL /
// CATEGORY_UPDATES / CATEGORY_FORUMS mean it landed in the inbox tab-set
// (still visible, just categorized); SPAM is the one that actually matters.
// Absence of INBOX and presence of SPAM is unambiguous; anything else visible
// under a category still counts as "inbox" for the canary's purpose, since the
// recipient sees it without digging.
function classifyLabels(labelIds = []) {
  if (labelIds.includes('SPAM')) return 'spam';
  if (labelIds.includes('CATEGORY_PROMOTIONS')) return 'promotions';
  if (labelIds.includes('INBOX')) return 'inbox';
  return 'inbox'; // any other visible placement (Updates/Social/Forums) still reached them
}

// Check one tenant's seed inbox for the most recent message from `fromEmail`
// within the lookback window, and record where it landed.
async function runSeedCheck(clientId, { fromEmail, lookbackMinutes = 60 * 26 } = {}) {
  const authed = await getSeedAuthedClient(clientId);
  if (!authed) return { ok: false, reason: 'not_connected' };

  try {
    const gmailApi = google.gmail({ version: 'v1', auth: authed.client });
    const afterEpoch = Math.floor((Date.now() - lookbackMinutes * 60 * 1000) / 1000);
    const q = fromEmail ? `from:${fromEmail} after:${afterEpoch}` : `after:${afterEpoch}`;
    // in:anywhere so a message already filed to Spam is still found -- searching
    // the default view excludes Spam/Trash, which would misreport it as missing.
    const list = await gmailApi.users.messages.list({ userId: 'me', q: `${q} in:anywhere`, maxResults: 1 });
    const msg = list.data.messages?.[0];

    if (!msg) {
      await pool.query(
        `INSERT INTO seed_checks (client_id, folder, detail) VALUES ($1, 'not_found', $2)`,
        [clientId, `No message found from ${fromEmail || 'any sender'} in the last ${lookbackMinutes} minutes`]
      );
      return { ok: true, folder: 'not_found' };
    }

    const full = await gmailApi.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject'] });
    const subject = full.data.payload?.headers?.find(h => h.name === 'Subject')?.value || null;
    const folder = classifyLabels(full.data.labelIds || []);

    await pool.query(
      `INSERT INTO seed_checks (client_id, folder, subject) VALUES ($1, $2, $3)`,
      [clientId, folder, subject]
    );
    return { ok: true, folder };
  } catch (err) {
    await pool.query(
      `INSERT INTO seed_checks (client_id, folder, detail) VALUES ($1, 'error', $2)`,
      [clientId, err.message]
    ).catch(() => {});
    return { ok: false, reason: err.message };
  }
}

// Run the check for every tenant with an enabled seed inbox. Called once daily
// by the /cron/seed-check route. fromEmailByClient lets the caller supply each
// tenant's actual sending address (from client_email_config), so the search is
// scoped to mail we actually sent, not just anything arriving in that inbox.
async function runAllSeedChecks() {
  const { rows: accounts } = await pool.query(
    `SELECT sa.client_id, cec.from_email
       FROM seed_accounts sa
       LEFT JOIN client_email_config cec ON cec.client_id = sa.client_id
      WHERE sa.enabled = true`
  );
  const results = [];
  for (const acct of accounts) {
    const result = await runSeedCheck(acct.client_id, { fromEmail: acct.from_email });
    results.push({ clientId: acct.client_id, ...result });
  }
  return results;
}

module.exports = {
  getSeedAuthUrl, verifySeedOAuthState, getSeedAuthedClient,
  sendSeedCopy, runSeedCheck, runAllSeedChecks, classifyLabels,
};
