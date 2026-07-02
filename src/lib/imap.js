const { ImapFlow } = require('imapflow');

function imapEnabled(cfg) {
  if (cfg) return !!(cfg.imap_host && cfg.imap_user && cfg.imap_pass);
  return !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
}

function makeClient(cfg) {
  return new ImapFlow({
    host:   cfg?.imap_host   || process.env.IMAP_HOST,
    port:   cfg?.imap_port   || parseInt(process.env.IMAP_PORT) || 993,
    secure: true,
    auth: {
      user: cfg?.imap_user || process.env.IMAP_USER,
      pass: cfg?.imap_pass || process.env.IMAP_PASS,
    },
    logger: false,
  });
}

/**
 * Search the IMAP inbox for any message FROM leadEmail received after afterDate.
 * cfg = decrypted client email config from getClientEmailConfig(), or null to use env vars.
 * Returns { replied, replyFrom, replySubject, replyText }
 */
async function checkForRepliesViaImap(leadEmail, afterDate, cfg) {
  if (!imapEnabled(cfg)) return { replied: false };

  const client = makeClient(cfg);
  try {
    await client.connect();
    await client.getMailboxLock('INBOX');

    const since = new Date(afterDate);
    // Search for messages FROM the lead received after enrollment date
    const uids = await client.search({ from: leadEmail, since });
    if (!uids || !uids.length) return { replied: false };

    // Fetch the first matching message
    let replyFrom = leadEmail, replySubject = '', replyText = '';
    for await (const msg of client.fetch(uids.slice(0, 1), { envelope: true, bodyParts: ['TEXT'] })) {
      replyFrom    = msg.envelope?.from?.[0]?.address || leadEmail;
      replySubject = msg.envelope?.subject || '';
      const textPart = msg.bodyParts?.get('text');
      if (textPart) {
        replyText = textPart.toString('utf8').slice(0, 600);
      }
    }

    return { replied: true, replyFrom, replySubject, replyText: replyText.trim() };
  } catch (err) {
    console.error('[imap] check failed for', leadEmail, err.message);
    return { replied: false };
  } finally {
    await client.logout().catch(() => {});
  }
}

module.exports = { imapEnabled, checkForRepliesViaImap };
