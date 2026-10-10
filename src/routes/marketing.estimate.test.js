// Regression suite for the 2026-10-10 form relay incident (CAPA-2026-10-10-form-relay).
// Invariant under test: an unverified submission can never produce AI content or an
// estimate email, and the confirmation email it may produce is fixed text and capped.
// Run: node --test src/routes/marketing.estimate.test.js   (no database needed)
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { createMemoryStore } = require('../test/memoryEstimateStore');

const spy = { sent: [], model: [], alerts: [], sendFails: false };
const store = createMemoryStore();

function stub(rel, exports) {
  const abs = require.resolve(path.join(__dirname, rel));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}
stub('../db', { pool: { query: async (sql) => (/FROM email_accounts|FROM salespeople/.test(sql) ? { rows: [{ salesperson_id: 1, client_id: 1 }] } : { rows: [] }) } });
stub('../lib/gmail', { sendDirectEmail: async (m) => { if (spy.sendFails) throw new Error('535 Authentication credentials invalid'); spy.sent.push(m); } });
stub('../lib/openrouter', { callOpenRouter: async (prompt, opts) => { spy.model.push({ prompt, opts }); return 'You are sitting on people who already know your business, and nobody followed up with them.'; } });
stub('../lib/telegram', { sendTelegram: async (t) => { spy.alerts.push(t); } });
const estimateStore = require('../lib/estimateStore');
estimateStore.createPgStore = () => store;

const marketing = require('./marketing');
let server, base, ipSeq = 0;
test.before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/', marketing);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const freshIp = () => `10.1.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
async function submit(fields, { ip = freshIp(), headers = {} } = {}) {
  return fetch(`${base}/get-started`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip, ...headers },
    body: new URLSearchParams({ business_name: 'Acme Roofing', trade: 'roofing', list_size: '500_2000', ...fields }).toString(),
  });
}
const tokenFrom = (msg) => /\/get-started\/confirm\/([A-Za-z0-9_-]{43})/.exec(msg.textBody)[1];
function reset() { spy.sent.length = 0; spy.model.length = 0; spy.alerts.length = 0; spy.sendFails = false; store.leads.length = 0; store.verifications.length = 0; store.quotas.clear(); }

test('unverified submission: no AI call, no estimate email, one fixed-text confirmation', async () => {
  reset();
  const res = await submit({ email: 'a@example.com', message: 'FREE PRIZE click here', contact_name: 'EVIL PAYLOAD' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/?submitted=confirm#apply');
  assert.strictEqual(spy.model.length, 0, 'no model call before verification');
  assert.strictEqual(spy.sent.length, 1);
  const m = spy.sent[0];
  assert.strictEqual(m.subject, 'Confirm your email to see your SalesWyze estimate');
  for (const t of ['Acme Roofing', 'FREE PRIZE', 'EVIL PAYLOAD']) {
    assert.ok(!m.textBody.includes(t) && !m.htmlBody.includes(t) && !m.subject.includes(t), `submitter text "${t}" must not appear in the email`);
  }
  assert.strictEqual(store.leads[0].verify_status, 'pending');
});

test('confirmation link is built from the fixed origin, not the Host header', async () => {
  reset();
  await submit({ email: 'b@example.com' }, { headers: { host: 'evil.example' } });
  assert.match(spy.sent[0].textBody, /^https:\/\/saleswyze\.com\/get-started\/confirm\//m);
  assert.ok(!spy.sent[0].textBody.includes('evil.example'));
});

test('token is stored only as a hash', async () => {
  reset();
  await submit({ email: 'c@example.com' });
  const token = tokenFrom(spy.sent[0]);
  assert.ok(!JSON.stringify(store.verifications).includes(token));
  assert.strictEqual(store.verifications[0].tokenHash, estimateStore.sha256(token));
});

test('GET shows a button and changes nothing; POST verifies, runs the model once; replay is refused', async () => {
  reset();
  await submit({ email: 'd@example.com' });
  const token = tokenFrom(spy.sent[0]);
  const url = `${base}/get-started/confirm/${token}`;
  for (let i = 0; i < 3; i++) { assert.strictEqual((await fetch(url)).status, 200); }
  assert.strictEqual(store.leads[0].verify_status, 'pending', 'GET must not verify');
  assert.strictEqual(spy.model.length, 0);

  const ok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp() }, body: '' });
  assert.strictEqual(ok.status, 200);
  assert.match(await ok.text(), /Acme Roofing/);
  assert.strictEqual(store.leads[0].verify_status, 'verified');
  assert.strictEqual(spy.model.length, 1);
  assert.strictEqual(spy.model[0].opts.title, 'SalesWyze Estimate');
  assert.strictEqual(spy.model[0].opts.maxTokens, 200);

  const replay = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp() }, body: '' });
  assert.strictEqual(replay.status, 410);
  assert.strictEqual(spy.model.length, 1, 'replay must not call the model again');
});

test('expired, unknown and malformed tokens are refused with no side effects', async () => {
  reset();
  await submit({ email: 'e@example.com' });
  const token = tokenFrom(spy.sent[0]);
  store.verifications[0].expiresAt = new Date(Date.now() - 1000);
  const post = (t) => fetch(`${base}/get-started/confirm/${t}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp() }, body: '' });
  assert.strictEqual((await post(token)).status, 410);
  assert.strictEqual((await post('A'.repeat(43))).status, 410);
  assert.strictEqual((await post('short')).status, 410);
  assert.strictEqual(spy.model.length, 0);
  assert.strictEqual(store.leads[0].verify_status, 'pending');
});

test('per-address cap: dotted, +tagged and googlemail variants are one inbox and share the cap of 2', async () => {
  reset();
  for (const e of ['vic.tim@gmail.com', 'victim+1@gmail.com', 'v.i.c.t.i.m@gmail.com', 'victim+zz@googlemail.com']) await submit({ email: e });
  assert.strictEqual(spy.sent.length, 2, 'four variants of one inbox produce two emails at most');
  await submit({ email: 'someone.else@gmail.com' });
  assert.strictEqual(spy.sent.length, 3, 'a different inbox is unaffected');
});

test('per-IP cap: one source gets at most 5 confirmation emails a day', async () => {
  reset();
  const ip = freshIp();
  for (let i = 0; i < 9; i++) await submit({ email: `ip${i}@example.com` }, { ip });
  assert.strictEqual(spy.sent.length, 5);
  assert.ok(spy.alerts.some(a => /per source IP/.test(a)), 'operator is alerted when a cap trips');
});

test('global cap: a distributed flood (many IPs, many addresses) sends at most 100 emails', async () => {
  reset();
  for (let i = 0; i < 130; i++) await submit({ email: `flood${i}@example.com` });
  assert.strictEqual(spy.sent.length, 100);
  assert.strictEqual(spy.model.length, 0, 'flood causes zero model calls');
  assert.ok(store.leads.some(l => l.confirm_email_status === 'quota_blocked'));
  assert.strictEqual(spy.alerts.filter(a => /\(global\)/.test(a)).length, 1, 'one alert per window, not one per request');
});

test('AI cap: when the daily model budget is spent, a verified visitor still gets the estimate without a model call', async () => {
  reset();
  for (let i = 0; i < 100; i++) await store.consumeQuota('ai:estimates:day', 24 * 3600 * 1000, 100);
  await submit({ email: 'g@example.com' });
  const token = tokenFrom(spy.sent[0]);
  const res = await fetch(`${base}/get-started/confirm/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp() }, body: '' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(spy.model.length, 0);
});

test('malformed input is rejected, not stored, and never a 500', async () => {
  reset();
  const body = 'business_name=a&business_name=b&email=h%40example.com';
  const res = await fetch(`${base}/get-started`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp() }, body });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/?error=1#apply');
  const long = await submit({ email: 'i@example.com', message: 'x'.repeat(2001) });
  assert.strictEqual(long.headers.get('location'), '/?error=1#apply');
  const crlf = await submit({ email: 'j@example.com\r\nBcc: x@y.z' });
  assert.strictEqual(crlf.headers.get('location'), '/?error=1#apply');
  assert.strictEqual(store.leads.length, 0);
  assert.strictEqual(spy.sent.length, 0);
});

test('P1 review finding: display-name, list and comment syntax is rejected, so one inbox cannot be reached under many quota keys', async () => {
  reset();
  for (const bad of ['a<victim@example.com>', 'b<victim@example.com>', '"x"@example.com', 'x,victim@example.com', 'x;victim@example.com', 'victim@example.com (c)', 'victim@example.com>', '<victim@example.com>', 'victim@@example.com', 'victim@example']) {
    const res = await submit({ email: bad });
    assert.strictEqual(res.headers.get('location'), '/?error=1#apply', `must reject ${bad}`);
  }
  assert.strictEqual(store.leads.length, 0);
  assert.strictEqual(spy.sent.length, 0);
});

test('P1: the address that is counted is the address that is mailed', async () => {
  reset();
  await submit({ email: 'Real.Person+tag@Example.com' });
  assert.strictEqual(spy.sent.length, 1);
  assert.strictEqual(spy.sent[0].to, 'Real.Person+tag@Example.com');
  assert.ok(!/[<>,;"]/.test(spy.sent[0].to));
});

test('P2 review finding: a failure after the token is claimed releases it, and the visitor can retry', async () => {
  reset();
  await submit({ email: 'retry@example.com' });
  const token = tokenFrom(spy.sent[0]);
  const url = `${base}/get-started/confirm/${token}`;
  const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp() }, body: '' });
  const audit = require('../lib/audit'); const real = audit.generateAudit;
  // generateAudit is captured by reference in marketing.js, so fail the model layer instead
  const orig = store.consumeQuota; let boom = true;
  store.consumeQuota = async (b, w, l) => { if (boom && b === 'ai:estimates:day') { boom = false; throw new Error('db blip'); } return orig(b, w, l); };
  try {
    assert.strictEqual((await post()).status, 500, 'first attempt fails');
    assert.strictEqual(store.verifications[0].completedAt, null);
    assert.strictEqual(store.verifications[0].claimedAt, null, 'claim released');
    const second = await post();
    assert.strictEqual(second.status, 200, 'retry succeeds, visitor is not stranded');
    assert.strictEqual((await post()).status, 410, 'after success the token is dead');
  } finally { store.consumeQuota = orig; audit.generateAudit = real; }
});

test('a request that crashed mid-claim is blocked while the lease is live and works after it expires', async () => {
  reset();
  await submit({ email: 'lease@example.com' });
  const token = tokenFrom(spy.sent[0]);
  const hash = estimateStore.sha256(token);
  await store.claimVerification(hash, 120000); // a request that then died
  const post = () => fetch(`${base}/get-started/confirm/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': freshIp() }, body: '' });
  assert.strictEqual((await post()).status, 410, 'live lease blocks');
  store.verifications[0].claimedAt = Date.now() - 3 * 60_000;
  assert.strictEqual((await post()).status, 200, 'expired lease allows a retry');
});

test('mail failure is recorded and alerted, and the visitor sees the same page', async () => {
  reset(); spy.sendFails = true;
  const res = await submit({ email: 'k@example.com' });
  assert.strictEqual(res.headers.get('location'), '/?submitted=confirm#apply');
  assert.strictEqual(store.leads[0].confirm_email_status, 'failed');
  assert.match(store.leads[0].confirm_email_error, /535/);
  await new Promise(r => setTimeout(r, 20));
  assert.ok(spy.alerts.some(a => /failing to send/.test(a)));
});

test('the honeypot is not the boundary: a bot that skips it still triggers nothing beyond the capped confirmation', async () => {
  reset();
  await submit({ email: 'l@example.com' });
  assert.strictEqual(spy.model.length, 0);
  assert.strictEqual(spy.sent.length, 1);
});

test('abuse evaluator flags the incident signature and stays quiet for normal traffic', () => {
  const { evaluateAbuse } = require('../lib/estimateFlow');
  const incident = { submitted: 2000, confirm_sent: 100, confirm_failed: 0, quota_blocked: 1900, verified: 0, tripped: [{ bucket: 'confirm:global:day' }] };
  assert.ok(evaluateAbuse(incident).some(f => /SUSPECTED ABUSE/.test(f)));
  assert.deepStrictEqual(evaluateAbuse({ submitted: 4, confirm_sent: 4, confirm_failed: 0, quota_blocked: 0, verified: 2, tripped: [] }), []);
  assert.ok(evaluateAbuse({ submitted: 3, confirm_sent: 0, confirm_failed: 3, quota_blocked: 0, verified: 0, tripped: [] }).some(f => /failed to send/.test(f)));
});
