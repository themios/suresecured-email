const test = require('node:test');
const assert = require('node:assert');
const { inferMatcherType, sanitizeMatchers, matchSender, buildGmailQuery } = require('./leadSenderMatchers');

test('inferMatcherType detects a full email as exact', () => {
  assert.strictEqual(inferMatcherType('leads@zillow.com'), 'exact');
});

test('inferMatcherType detects a bare domain as domain', () => {
  assert.strictEqual(inferMatcherType('cargurus.com'), 'domain');
  assert.strictEqual(inferMatcherType('messages.cargurus.com'), 'domain');
});

test('inferMatcherType falls back to contains for a partial word', () => {
  assert.strictEqual(inferMatcherType('cargurus'), 'contains');
});

test('sanitizeMatchers accepts plain strings and infers their type', () => {
  const out = sanitizeMatchers(['cargurus.com', 'leads@zillow.com', 'thumbtack']);
  assert.deepStrictEqual(out, [
    { type: 'domain', value: 'cargurus.com' },
    { type: 'exact', value: 'leads@zillow.com' },
    { type: 'contains', value: 'thumbtack' },
  ]);
});

test('sanitizeMatchers rejects a malformed exact/domain entry and a too-short contains', () => {
  const out = sanitizeMatchers([
    { type: 'exact', value: 'not-an-email' },
    { type: 'domain', value: 'not a domain' },
    { type: 'contains', value: 'ab' },
    { type: 'contains', value: 'angi' },
  ]);
  assert.deepStrictEqual(out, [{ type: 'contains', value: 'angi' }]);
});

test('sanitizeMatchers dedupes identical type+value pairs', () => {
  const out = sanitizeMatchers(['cargurus.com', 'CarGurus.com', 'cargurus.com']);
  assert.strictEqual(out.length, 1);
});

test('sanitizeMatchers caps the list at 30', () => {
  const many = Array.from({ length: 40 }, (_, i) => `partial${i}word`);
  assert.strictEqual(sanitizeMatchers(many).length, 30);
});

test('matchSender prefers exact over domain over contains', () => {
  const matchers = [
    { type: 'contains', value: 'zillow' },
    { type: 'domain', value: 'zillow.com' },
    { type: 'exact', value: 'leads@zillow.com' },
  ];
  const hit = matchSender('Leads <leads@zillow.com>', matchers);
  assert.strictEqual(hit.type, 'exact');
});

test('matchSender: a domain rule catches any subdomain', () => {
  const matchers = [{ type: 'domain', value: 'cargurus.com' }];
  assert.ok(matchSender('dealer-leads@messages.cargurus.com', matchers));
  assert.strictEqual(matchSender('someone@othersite.com', matchers), null);
});

test('matchSender: no matchers means no match (never silently allows)', () => {
  assert.strictEqual(matchSender('anyone@anywhere.com', []), null);
});

test('buildGmailQuery ORs every matcher value as a from: clause', () => {
  const q = buildGmailQuery([{ type: 'domain', value: 'cargurus.com' }, { type: 'exact', value: 'a@b.com' }], 'newer_than:2d');
  assert.strictEqual(q, '(from:cargurus.com OR from:a@b.com) newer_than:2d');
});

test('buildGmailQuery with no matchers returns just the extra clause', () => {
  assert.strictEqual(buildGmailQuery([], 'newer_than:2d'), 'newer_than:2d');
});
