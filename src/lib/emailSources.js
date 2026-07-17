/**
 * Email intake sources + sender-rule engine.
 *
 * The pure decision logic (evaluateSender) is separated from any I/O so it can
 * be unit-tested without a database or a mailbox. The cron layer loads a
 * tenant's sources + rules and calls evaluateSender for each inbound message.
 */
const { pool } = require('../db');

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
 * @returns {{capture:boolean, reason:string, ruleId?:number, sequenceId?:number, salespersonId?:number, tag?:string}}
 */
function evaluateSender(fromAddress, rules = [], capturePolicy = 'allowlist') {
  const from = parseFrom(fromAddress);
  if (!from.email) return { capture: false, reason: 'no_sender' };

  // Lowest priority number wins; first match decides.
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

  // No rule matched — fall back to the source's default policy.
  if (capturePolicy === 'all') return { capture: true, reason: 'policy_all' };
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

module.exports = { parseFrom, parseFromHeader, ruleMatches, evaluateSender, listEnabledSources, rulesForSource };
