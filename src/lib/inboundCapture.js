/**
 * Inbound lead capture: shared logic for turning a new inbound email into a
 * lead, used by both possible sources (a connected Gmail account, or a
 * tenant's own IMAP mailbox). Kept separate from cron.js so the per-message
 * decision logic (filter, dedup, create, enroll) is identical regardless of
 * which mailbox the message came from.
 */
const { google } = require('googleapis');
const { ImapFlow } = require('imapflow');
const { isAutomatedSender } = require('./emailSources');
const { matchSender, buildGmailQuery } = require('./leadSenderMatchers');
const { notifyNewLead } = require('./telegram');
const { classifyAudience } = require('./leadAudience');

/**
 * Fetch new inbound messages from a connected Gmail account since `sinceDate`.
 * When `senderMatchers` is non-empty, the search itself is narrowed to only
 * those senders (an efficiency win and an extra safety layer, not just a
 * client-side filter) via Gmail's own `from:` query syntax.
 * @returns {Array<{email, name, subject, hasListUnsubscribe}>}
 */
async function fetchGmailInbound(authedClient, ownEmail, sinceDate, senderMatchers = []) {
  const gmail = google.gmail({ version: 'v1', auth: authedClient });
  const sinceEpoch = Math.floor(sinceDate.getTime() / 1000);
  const base = `in:inbox after:${sinceEpoch} -from:me -from:${ownEmail}`;
  const q = senderMatchers.length ? buildGmailQuery(senderMatchers, base) : base;
  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 20 });
  const msgs = list.data.messages || [];

  const out = [];
  for (const m of msgs) {
    const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'List-Unsubscribe'] });
    const headers = msg.data.payload?.headers || [];
    const fromHeader = headers.find(h => h.name === 'From')?.value || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const hasListUnsubscribe = !!headers.find(h => h.name === 'List-Unsubscribe')?.value;

    const emailMatch = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/([^\s]+@[^\s]+)/);
    const email = emailMatch?.[1]?.toLowerCase().trim();
    if (!email) continue;
    const nameMatch = fromHeader.match(/^(.+?)\s*</);
    const name = nameMatch?.[1]?.replace(/"/g, '').trim() || '';
    out.push({ email, name, subject, hasListUnsubscribe });
  }
  return out;
}

/**
 * Fetch new inbound messages from a tenant's own IMAP mailbox (their real
 * business inbox -- e.g. IONOS -- decoupled from whichever Gmail happens to
 * be OAuth-connected for sending). cfg is the DECRYPTED client_email_config
 * shape from lib/gmail.js's getClientEmailConfig().
 * @returns {Array<{email, name, subject, hasListUnsubscribe}>}
 */
async function fetchImapInbound(cfg, sinceDate) {
  if (!cfg?.imap_host || !cfg?.imap_user || !cfg?.imap_pass) return [];

  const client = new ImapFlow({
    host: cfg.imap_host, port: cfg.imap_port || 993, secure: true,
    auth: { user: cfg.imap_user, pass: cfg.imap_pass }, logger: false,
  });

  const out = [];
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const uidsRaw = await client.search({ since: sinceDate });
    const uids = (Array.isArray(uidsRaw) ? uidsRaw : []).slice(-20);
    if (uids.length) {
      for await (const msg of client.fetch(uids, { envelope: true, headers: ['list-unsubscribe'] })) {
        const f = msg.envelope?.from?.[0];
        const email = String(f?.address || '').toLowerCase().trim();
        if (!email || email === cfg.imap_user.toLowerCase()) continue; // skip self-sent
        const hasListUnsubscribe = !!(msg.headers && /^list-unsubscribe\s*:/im.test(msg.headers.toString('utf8')));
        out.push({ email, name: f?.name || '', subject: msg.envelope?.subject || '', hasListUnsubscribe });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return out;
}

/**
 * Turn one inbound message into a lead. Shared by every source so the
 * decision (and the junk-mail protection) can never drift between Gmail and
 * IMAP. Two filtering modes, chosen by whether the tenant has any sender
 * rules configured:
 *   - senderMatchers non-empty: ALLOWLIST mode. Only a message from a
 *     matching sender is ever captured -- the automated-sender check is
 *     skipped entirely, because an explicit rule is a deliberate choice that
 *     should not be second-guessed by a heuristic.
 *   - senderMatchers empty (default): today's behavior -- capture anything
 *     that doesn't look like bulk/automated mail.
 * @returns {{captured: boolean, reason: string, leadId?: number}}
 */
async function captureLeadFromMessage(pool, { clientId, salespersonId, inboundSequenceId, inboundSequenceIdB2b, email, name, subject, body, hasListUnsubscribe, senderMatchers = [] }) {
  if (senderMatchers.length) {
    if (!matchSender(email, senderMatchers)) return { captured: false, reason: 'no_matching_rule' };
  } else if (isAutomatedSender({ email, hasListUnsubscribe })) {
    return { captured: false, reason: 'automated_sender' };
  }

  const { rows: existing } = await pool.query(
    'SELECT id FROM leads WHERE LOWER(email) = LOWER($1) AND client_id = $2', [email, clientId]
  );
  if (existing.length) return { captured: false, reason: 'already_exists' };

  const [firstName, ...rest] = (name || '').split(' ');
  const lastName = rest.join(' ');

  // Route dealers away from the homeowner sequence. Falls back to the B2C
  // sequence when no B2B one is configured, so behavior is unchanged for
  // tenants that never set it.
  const { audience, reason: audienceReason } = classifyAudience({ email, subject, body });
  const sequenceId = audience === 'B2B'
    ? (inboundSequenceIdB2b || inboundSequenceId)
    : inboundSequenceId;

  const { rows: newLead } = await pool.query(`
    INSERT INTO leads (email, first_name, last_name, stage, audience_type, client_id, created_at)
    VALUES ($1, $2, $3, 'new', $4, $5, NOW())
    RETURNING id
  `, [email, firstName || email, lastName || '', audience, clientId]);
  if (!newLead[0]) return { captured: false, reason: 'insert_failed' };
  const leadId = newLead[0].id;

  await pool.query(
    `INSERT INTO lead_notes (lead_id, client_id, author_name, content) VALUES ($1, $2, $3, $4)`,
    [leadId, clientId, 'Inbound', `[Inbound email] ${subject}\n\nFrom: ${name ? name + ' <' + email + '>' : email}\nClassified ${audience} (${audienceReason})`]
  );

  notifyNewLead({ firstName, lastName, email, source: `email · ${audience}` }).catch(() => {});

  if (sequenceId && salespersonId) {
    await pool.query(`
      INSERT INTO contact_enrollments (lead_id, sequence_id, salesperson_id, client_id, status, enrolled_at)
      VALUES ($1, $2, $3, $4, 'active', NOW())
      ON CONFLICT DO NOTHING
    `, [leadId, sequenceId, salespersonId, clientId]);
  }

  return { captured: true, reason: 'ok', leadId, audience };
}

module.exports = { fetchGmailInbound, fetchImapInbound, captureLeadFromMessage };
