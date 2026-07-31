/**
 * Email intake sources + sender-rule engine.
 *
 * The pure decision logic (evaluateSender) is separated from any I/O so it can
 * be unit-tested without a database or a mailbox. The cron layer loads a
 * tenant's sources + rules and calls evaluateSender for each inbound message.
 */
const { pool } = require('../db');

// Local-part tokens that mark a sender as automated/bulk mail rather than a
// genuine inbound inquiry. Matched as a delimited token (on -, _, or .
// boundaries) so it catches compound local-parts like "messages-noreply" or
// "jobalerts-noreply", not just an exact local-part match.
const AUTOMATED_LOCAL_TOKEN = /(^|[-_.+])(no-?reply|do-?not-?reply|notifications?|notify|bounces?|mailer-daemon|postmaster|auto-?reply|alerts?|digest|newsletter|jobalerts?|editorialstaff|invoice|billing|statements?)([-_.+]|$)/i;

/**
 * Is this inbound message almost certainly bulk/automated mail rather than a
 * genuine inquiry? Two independent signals, either one is enough:
 *   1. A List-Unsubscribe header -- the standard, legally-required marker for
 *      bulk mail. Catches the overwhelming majority (newsletters, marketing,
 *      social-network digests) regardless of how the From address looks.
 *   2. A local-part token that only automated systems use (no-reply,
 *      notifications, jobalerts, invoice, etc).
 *
 * Known, honest limitation: mail deliberately written to look personal (a
 * SaaS "hi, I'm Emily from the team!" onboarding email with no unsubscribe
 * header and a human-looking From name) will not be caught by either signal.
 * No header/pattern check can distinguish that from a genuine inquiry.
 */
function isAutomatedSender({ email, hasListUnsubscribe }) {
  if (hasListUnsubscribe) return true;
  const local = String(email || '').split('@')[0] || '';
  return AUTOMATED_LOCAL_TOKEN.test(local);
}

/** Split a raw From address into a lowercased email + bare domain. */
function parseFrom(fromAddress) {
  const email = String(fromAddress || '').toLowerCase().trim();
  const at = email.lastIndexOf('@');
  return { email, domain: at >= 0 ? email.slice(at + 1) : '' };
}

/** Parse a raw "Name <email>" From header into { email, name }. */
function parseFromHeader(fromHeader) {
  const raw = String(fromHeader || '');
  const m = raw.match(/<([^>]+)>/) || raw.match(/([^\s"]+@[^\s">]+)/);
  const email = (m ? m[1] : '').toLowerCase().trim();
  const nameMatch = raw.match(/^\s*"?([^"<]+?)"?\s*</);
  const name = nameMatch ? nameMatch[1].trim() : '';
  return { email, name };
}

/** Does a single rule match this sender? Domain rules also match subdomains. */
function ruleMatches(rule, from) {
  const val = String(rule.match_value || '').toLowerCase().trim();
  if (!val) return false;
  if (rule.match_type === 'email')  return from.email === val;
  if (rule.match_type === 'domain') return from.domain === val || from.domain.endsWith('.' + val);
  return false;
}

/**
 * Decide what to do with an inbound email from `fromAddress`.
 *
 * @param {string} fromAddress
 * @param {Array}  rules  rows from email_source_rules (any order)
 * @param {'all'|'allowlist'} capturePolicy  source default when no rule matches
 * @param {{hasListUnsubscribe?: boolean}} meta  header signals for the automated-sender check
 * @returns {{capture:boolean, reason:string, ruleId?:number, sequenceId?:number, salespersonId?:number, tag?:string}}
 */
function evaluateSender(fromAddress, rules = [], capturePolicy = 'allowlist', meta = {}) {
  const from = parseFrom(fromAddress);
  if (!from.email) return { capture: false, reason: 'no_sender' };

  // Lowest priority number wins; first match decides. A rule is a deliberate,
  // explicit choice by the tenant, so it overrides the automated-sender check
  // below -- if they specifically allowlisted a domain, honor it.
  const sorted = [...rules].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  for (const rule of sorted) {
    if (!ruleMatches(rule, from)) continue;
    if (rule.action === 'ignore') return { capture: false, reason: 'rule_ignore', ruleId: rule.id };
    return {
      capture: true,
      reason: 'rule_capture',
      ruleId: rule.id,
      sequenceId: rule.sequence_id || null,
      salespersonId: rule.assign_salesperson_id || null,
      tag: rule.tag || null,
    };
  }

  // No rule matched — fall back to the source's default policy. 'all' was
  // never meant to include obvious bulk/automated mail, so filter it even
  // on the permissive policy.
  if (capturePolicy === 'all') {
    if (isAutomatedSender({ email: from.email, hasListUnsubscribe: meta.hasListUnsubscribe })) {
      return { capture: false, reason: 'automated_sender' };
    }
    return { capture: true, reason: 'policy_all' };
  }
  return { capture: false, reason: 'policy_allowlist_no_match' };
}

// ── DB helpers (used by the cron layer in the next increment) ───────────────

/** All enabled sources for a tenant. */
async function listEnabledSources(clientId) {
  const { rows } = await pool.query(
    `SELECT * FROM email_sources WHERE client_id = $1 AND enabled = true ORDER BY id`,
    [clientId]
  );
  return rows;
}

/** Rules that apply to a given source (source-specific + tenant-wide). */
async function rulesForSource(clientId, sourceId) {
  const { rows } = await pool.query(
    `SELECT * FROM email_source_rules
      WHERE client_id = $1 AND (source_id = $2 OR source_id IS NULL)
      ORDER BY priority, id`,
    [clientId, sourceId]
  );
  return rows;
}

module.exports = { parseFrom, parseFromHeader, ruleMatches, evaluateSender, isAutomatedSender, listEnabledSources, rulesForSource };
