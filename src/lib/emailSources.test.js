// Unit tests for the sender-rule engine (Phase: email sources).
// Pure logic, no DB. Run: node src/lib/emailSources.test.js
const assert = require('node:assert');
const { parseFrom, parseFromHeader, ruleMatches, evaluateSender, isAutomatedSender } = require('./emailSources');

// ── parseFromHeader: "Name <email>" variants ────────────────────────────────
{
  assert.deepStrictEqual(parseFromHeader('Jane Doe <jane@x.com>'), { email: 'jane@x.com', name: 'Jane Doe' });
  assert.deepStrictEqual(parseFromHeader('"Sales, Team" <sales@x.com>'), { email: 'sales@x.com', name: 'Sales, Team' });
  assert.deepStrictEqual(parseFromHeader('bare@x.com'), { email: 'bare@x.com', name: '' });
  assert.deepStrictEqual(parseFromHeader('LEAD@X.COM'), { email: 'lead@x.com', name: '' });
  assert.deepStrictEqual(parseFromHeader(''), { email: '', name: '' });
}

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

// ── isAutomatedSender: regression test against the real senders that got
// captured as junk leads in production on 2026-07-31 (30 in about a day, via
// a personal Gmail inbox with inbound capture enabled). Documents both what
// IS caught and the known, honest misses -- growth-hacky mail written to look
// personal (no List-Unsubscribe, no automated-looking local-part) cannot be
// caught by header/pattern heuristics alone. ─────────────────────────────────
{
  // Caught via List-Unsubscribe header (the common case for real bulk mail --
  // marketing platforms are legally required to include it).
  const bulkSenders = [
    'no-reply@is.email.nextdoor.com', 'noreply@redditmail.com',
    'ae-best-care-market26@deals.aliexpress.com', 'email@email.etsy.com',
    'business@ms.email.nextdoor.com', 'mail@eg.expedia.com',
    'shop@email.stackcommerce.com', 'noreply@r.groupon.com',
    'deals@d.slickdeals.net', 'reply@rs.email.nextdoor.com',
    'todaystimecapsule@mail.beehiiv.com',
  ];
  for (const email of bulkSenders) {
    assert.strictEqual(isAutomatedSender({ email, hasListUnsubscribe: true }), true, `${email} should be caught with List-Unsubscribe present`);
  }

  // Caught via local-part pattern alone, even with no header (covers the
  // common automated-sender naming conventions).
  const patternSenders = [
    'no-reply@n.dribbble.com', 'notifications-noreply@linkedin.com',
    'noreply@email.openai.com', 'donotreply@match.indeed.com',
    'notification@service.tiktok.com', 'jobalerts-noreply@linkedin.com',
    'invoice+statements+acct_1n1wqlblyttfcdqg@stripe.com',
  ];
  for (const email of patternSenders) {
    assert.strictEqual(isAutomatedSender({ email, hasListUnsubscribe: false }), true, `${email} should be caught by local-part pattern alone`);
  }

  // Known, honest limitation: mail designed to look personal (a human name,
  // no unsubscribe header) is NOT caught by either signal. No header/pattern
  // check can distinguish "Emily from Clerk" onboarding mail from a genuine
  // inquiry -- that is the real ceiling of this approach, not a bug in it.
  assert.strictEqual(isAutomatedSender({ email: 'emily@clerk.com', hasListUnsubscribe: false }), false);
  assert.strictEqual(isAutomatedSender({ email: 'team@framer.com', hasListUnsubscribe: false }), false);
}

// ── evaluateSender: 'all' policy still filters automated senders, but a
// tenant's own explicit rule overrides the filter (a deliberate allowlist
// entry should never be silently blocked by the heuristic). ─────────────────
{
  const blocked = evaluateSender('no-reply@is.email.nextdoor.com', [], 'all', { hasListUnsubscribe: true });
  assert.strictEqual(blocked.capture, false);
  assert.strictEqual(blocked.reason, 'automated_sender');

  const rules = [{ id: 9, match_type: 'email', match_value: 'no-reply@is.email.nextdoor.com', action: 'capture', priority: 10 }];
  const overridden = evaluateSender('no-reply@is.email.nextdoor.com', rules, 'all', { hasListUnsubscribe: true });
  assert.strictEqual(overridden.capture, true, 'an explicit rule overrides the automated-sender filter');
  assert.strictEqual(overridden.reason, 'rule_capture');
}

console.log('emailSources.test.js: all assertions passed');
