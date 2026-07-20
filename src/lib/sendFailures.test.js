const test = require('node:test');
const assert = require('node:assert');
const { classifySendFailure } = require('./gmail');

// The classifier decides whether a failure is the OPERATOR's problem (nothing
// will send until config is fixed) or a per-recipient problem. Getting that
// wrong either spams the operator about one bad address, or stays silent while
// the entire mailbox is down — which is exactly what happened in production.

test('IONOS auth rejection is an operator problem', () => {
  // Verbatim from production: every send failed this way for days, silently.
  const err = Object.assign(new Error('Invalid login: 535 Authentication credentials invalid'), { code: 'EAUTH' });
  assert.strictEqual(classifySendFailure(err, false), 'auth');
});

test('bare 535 without a code still classifies as auth', () => {
  assert.strictEqual(classifySendFailure(new Error('535 5.7.8 Authentication failed'), false), 'auth');
});

test('Gmail app-password rejection classifies as auth', () => {
  assert.strictEqual(
    classifySendFailure(new Error('534-5.7.9 Username and Password not accepted'), false),
    'auth'
  );
});

test('unreachable host is a connection problem', () => {
  const err = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:587'), { code: 'ECONNREFUSED' });
  assert.strictEqual(classifySendFailure(err, false), 'connection');
});

test('DNS failure is a connection problem', () => {
  const err = Object.assign(new Error('getaddrinfo ENOTFOUND smtp.typo.com'), { code: 'ENOTFOUND' });
  assert.strictEqual(classifySendFailure(err, false), 'connection');
});

test('Gmail unverified From alias is a config problem, not a bounce', () => {
  // 403 from the Gmail API when from_email is not a verified Send As alias.
  const err = Object.assign(new Error('Precondition check failed.'), { status: 403 });
  assert.strictEqual(classifySendFailure(err, false), 'config');
});

test('rate limiting is transient, not an operator misconfiguration', () => {
  assert.strictEqual(classifySendFailure(new Error('Too many messages, rate limit exceeded'), false), 'quota');
});

test('a genuine bounce stays a bounce and is NOT escalated to the operator', () => {
  const { OPERATOR_FAILURE_CLASSES } = require('./gmail');
  const cls = classifySendFailure(new Error('550 5.1.1 User unknown'), true);
  assert.strictEqual(cls, 'bounce');
  assert.ok(!OPERATOR_FAILURE_CLASSES.has(cls), 'one bad address must not alarm the operator');
});

test('recipient rejection is per-lead, not an outage', () => {
  const { OPERATOR_FAILURE_CLASSES } = require('./gmail');
  const cls = classifySendFailure(new Error('550 mailbox unavailable'), false);
  assert.strictEqual(cls, 'recipient');
  assert.ok(!OPERATOR_FAILURE_CLASSES.has(cls));
});

test('an unrecognised error is recorded rather than dropped', () => {
  // The old code silently discarded anything that was not a permanent bounce.
  // 'unknown' still carries the raw message through to the operator.
  assert.strictEqual(classifySendFailure(new Error('something we have never seen'), false), 'unknown');
});

test('auth and connection escalate; quota and unknown do not', () => {
  const { OPERATOR_FAILURE_CLASSES } = require('./gmail');
  assert.ok(OPERATOR_FAILURE_CLASSES.has('auth'));
  assert.ok(OPERATOR_FAILURE_CLASSES.has('connection'));
  assert.ok(OPERATOR_FAILURE_CLASSES.has('config'));
  assert.ok(!OPERATOR_FAILURE_CLASSES.has('quota'));
  assert.ok(!OPERATOR_FAILURE_CLASSES.has('unknown'));
});
