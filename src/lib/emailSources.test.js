// Unit tests for the sender-rule engine (Phase: email sources).
// Pure logic, no DB. Run: node src/lib/emailSources.test.js
const assert = require('node:assert');
const { parseFrom, ruleMatches, evaluateSender } = require('./emailSources');

// ── parseFrom ──────────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(parseFrom('Bob@Example.COM'), { email: 'bob@example.com', domain: 'example.com' });
  assert.deepStrictEqual(parseFrom(''), { email: '', domain: '' });
  assert.deepStrictEqual(parseFrom('  a@b.co '), { email: 'a@b.co', domain: 'b.co' });
}

// ── ruleMatches: email + domain (incl. subdomain) ───────────────────────────
{
  const from = parseFrom('lead@mail.cargurus.com');
  assert.strictEqual(ruleMatches({ match_type: 'email',  match_value: 'lead@mail.cargurus.com' }, from), true);
  assert.strictEqual(ruleMatches({ match_type: 'email',  match_value: 'other@x.com' }, from), false);
  assert.strictEqual(ruleMatches({ match_type: 'domain', match_value: 'cargurus.com' }, from), true,  'subdomain matches');
  assert.strictEqual(ruleMatches({ match_type: 'domain', match_value: 'mail.cargurus.com' }, from), true, 'exact domain matches');
  assert.strictEqual(ruleMatches({ match_type: 'domain', match_value: 'gurus.com' }, from), false, 'partial suffix does not match');
  assert.strictEqual(ruleMatches({ match_type: 'domain', match_value: '' }, from), false);
}

// ── evaluateSender: allowlist policy (only matched capture rules get in) ─────
{
  const rules = [{ id: 1, match_type: 'domain', match_value: 'cargurus.com', action: 'capture', sequence_id: 7, priority: 100 }];
  const hit = evaluateSender('sales@cargurus.com', rules, 'allowlist');
  assert.strictEqual(hit.capture, true);
  assert.strictEqual(hit.sequenceId, 7);
  assert.strictEqual(hit.reason, 'rule_capture');

  const miss = evaluateSender('random@gmail.com', rules, 'allowlist');
  assert.strictEqual(miss.capture, false);
  assert.strictEqual(miss.reason, 'policy_allowlist_no_match');
}

// ── evaluateSender: 'all' policy captures unmatched senders ─────────────────
{
  const r = evaluateSender('anyone@nowhere.com', [], 'all');
  assert.strictEqual(r.capture, true);
  assert.strictEqual(r.reason, 'policy_all');
}

// ── evaluateSender: ignore rule beats capture, and priority ordering ────────
{
  const rules = [
    { id: 1, match_type: 'domain', match_value: 'spam.com', action: 'ignore',  priority: 10 },
    { id: 2, match_type: 'domain', match_value: 'spam.com', action: 'capture', priority: 50 },
  ];
  const r = evaluateSender('x@spam.com', rules, 'all');
  assert.strictEqual(r.capture, false, 'lower-priority ignore rule wins');
  assert.strictEqual(r.reason, 'rule_ignore');
  assert.strictEqual(r.ruleId, 1);
}

// ── evaluateSender: a specific email capture overrides a broad domain ignore ─
{
  const rules = [
    { id: 1, match_type: 'email',  match_value: 'vip@partner.com', action: 'capture', assign_salesperson_id: 3, priority: 10 },
    { id: 2, match_type: 'domain', match_value: 'partner.com',     action: 'ignore',   priority: 20 },
  ];
  const vip = evaluateSender('vip@partner.com', rules, 'allowlist');
  assert.strictEqual(vip.capture, true);
  assert.strictEqual(vip.salespersonId, 3);
  const other = evaluateSender('noise@partner.com', rules, 'allowlist');
  assert.strictEqual(other.capture, false, 'rest of the domain still ignored');
}

// ── empty / malformed sender never captures ─────────────────────────────────
{
  assert.strictEqual(evaluateSender('', [], 'all').capture, false);
  assert.strictEqual(evaluateSender(null, [], 'all').capture, false);
}

console.log('emailSources.test.js: all assertions passed');
