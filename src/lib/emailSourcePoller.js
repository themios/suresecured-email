/**
 * Email source poller (increment 3).
 *
 * For each enabled source, fetch recent inbox messages, run each sender through
 * the rule engine, and create leads for captures (routing them to the
 * sequence/owner/tag the rules specify). Reuses the app's existing Gmail-API and
 * IMAP access patterns. Only envelope headers (From/Subject) are read, so no
 * extra body-parsing dependency is needed.
 *
 * Idempotent-ish: dedups on existing lead email, and advances last_polled_at so
 * each run only looks at mail since the previous poll.
 */
const { google } = require('googleapis');
const { ImapFlow } = require('imapflow');
const { pool } = require('../db');
const { decrypt } = require('./crypto');
const { evaluateSender, rulesForSource, parseFromHeader } = require('./emailSources');
const { notifyNewLead } = require('./telegram');

const LOOKBACK_MS = 2 * 60 * 60 * 1000; // first poll (no last_polled_at) looks back 2h
const MAX_PER_RUN = 25;

function sinceFor(source) {
  return source.last_polled_at ? new Date(source.last_polled_at) : new Date(Date.now() - LOOKBACK_MS);
}

/** Gmail source → [{ email, name, subject }] via the readonly token. */
async function fetchGmailMessages(source) {
  const auth = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: decrypt(source.oauth_refresh_enc) }); // auto-refreshes access token
  const gmail = google.gmail({ version: 'v1', auth });
  const afterSec = Math.floor(sinceFor(source).getTime() / 1000);
  const list = await gmail.users.messages.list({
    userId: 'me', maxResults: MAX_PER_RUN, q: `in:inbox after:${afterSec} -from:me`,
  });
  const out = [];
  for (const m of list.data.messages || []) {
    const msg = await gmail.users.messages.get({
      userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject'],
    });
    const headers = msg.data.payload?.headers || [];
    const { email, name } = parseFromHeader(headers.find(h => h.name === 'From')?.value || '');
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    if (email) out.push({ email, name, subject });
  }
  return out;
}

/** IMAP source → [{ email, name, subject }] via envelope only. */
async function fetchImapMessages(source) {
  const client = new ImapFlow({
    host: source.imap_host, port: source.imap_port || 993, secure: true,
    auth: { user: source.imap_user, pass: decrypt(source.imap_pass_enc) }, logger: false,
  });
  const out = [];
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const uidsRaw = await client.search({ since: sinceFor(source) });
    const uids = (Array.isArray(uidsRaw) ? uidsRaw : []).slice(-MAX_PER_RUN);
    if (uids.length) {
      for await (const msg of client.fetch(uids, { envelope: true })) {
        const f = msg.envelope?.from?.[0];
        const email = String(f?.address || '').toLowerCase().trim();
        if (email) out.push({ email, name: f?.name || '', subject: msg.envelope?.subject || '' });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return out;
}

/** Poll one source and ingest captured senders as leads. */
async function ingestFromSource(source) {
  const clientId = source.client_id;
  const rules = await rulesForSource(clientId, source.id);
  const messages = source.type === 'gmail' ? await fetchGmailMessages(source) : await fetchImapMessages(source);

  let captured = 0, ignored = 0, skipped = 0;
  for (const msg of messages) {
    const decision = evaluateSender(msg.email, rules, source.capture_policy);
    if (!decision.capture) { ignored++; continue; }

    // Dedup: don't recreate a lead that already exists for this tenant.
    const { rows: existing } = await pool.query(
      'SELECT id FROM leads WHERE LOWER(email) = LOWER($1) AND client_id = $2 LIMIT 1', [msg.email, clientId]
    );
    if (existing.length) { skipped++; continue; }

    const [firstName, ...rest] = String(msg.name || '').split(' ');
    const salespersonId = decision.salespersonId || source.default_salesperson_id || null;

    const { rows: newLead } = await pool.query(
      `INSERT INTO leads (email, first_name, last_name, stage, audience_type, client_id, salesperson_id, product_interest, created_at)
       VALUES ($1, $2, $3, 'new', 'inbound', $4, $5, $6, NOW())
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [msg.email, firstName || msg.email.split('@')[0], rest.join(' ') || '', clientId, salespersonId, decision.tag || null]
    );
    if (!newLead[0]) { skipped++; continue; }
    const leadId = newLead[0].id;
    captured++;

    await pool.query(
      `INSERT INTO lead_notes (lead_id, client_id, author_name, content) VALUES ($1, $2, 'Email Source', $3)`,
      [leadId, clientId, `[Source: ${source.label}] ${msg.subject || ''}${decision.tag ? `\nTag: ${decision.tag}` : ''}`]
    ).catch(() => {});

    const sequenceId = decision.sequenceId || source.default_sequence_id || null;
    if (sequenceId) {
      await pool.query(
        `INSERT INTO contact_enrollments (lead_id, sequence_id, salesperson_id, client_id, status, enrolled_at)
         VALUES ($1, $2, $3, $4, 'active', NOW()) ON CONFLICT DO NOTHING`,
        [leadId, sequenceId, salespersonId, clientId]
      ).catch(() => {});
    }

    notifyNewLead({ firstName: firstName || '', lastName: rest.join(' ') || '', email: msg.email, source: source.label }).catch(() => {});
  }
  return { scanned: messages.length, captured, ignored, skipped };
}

/** Poll every enabled source across all active tenants. */
async function pollAllSources() {
  const { rows: sources } = await pool.query(
    `SELECT s.* FROM email_sources s JOIN clients c ON c.id = s.client_id
      WHERE s.enabled = true AND c.active = true ORDER BY s.id`
  );
  const results = [];
  for (const source of sources) {
    try {
      const r = await ingestFromSource(source);
      await pool.query('UPDATE email_sources SET last_polled_at = NOW(), last_error = NULL WHERE id = $1', [source.id]);
      results.push({ source_id: source.id, label: source.label, ...r });
    } catch (err) {
      await pool.query('UPDATE email_sources SET last_polled_at = NOW(), last_error = $2 WHERE id = $1',
        [source.id, String(err && err.message ? err.message : err).slice(0, 300)]);
      results.push({ source_id: source.id, label: source.label, error: err && err.message ? err.message : String(err) });
    }
  }
  return results;
}

module.exports = { pollAllSources, ingestFromSource };
