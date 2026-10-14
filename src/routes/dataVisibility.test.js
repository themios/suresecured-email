// Spec: specs/2026-10-14-data-visibility.md. Acceptance criteria are numbered AC1..AC14.
// Run: node --test src/routes/dataVisibility.test.js   (no database needed)
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { REGISTRY } = require('../lib/dataRegistry');
const dv = require('../lib/dataVisibility');
const { createDataVisibilityRouter } = require('./data-visibility');

const SECRET = 'test-secret';
const USERS = {
  1: { id: 1, email: 'op@example.test', role: 'operator' },
  2: { id: 2, email: 'owner-a@example.test', role: 'owner', organization_id: 10 },
  3: { id: 3, email: 'admin-a@example.test', role: 'admin', organization_id: 10 },
  4: { id: 4, email: 'rep@example.test', role: 'salesperson', organization_id: 10 },
  5: { id: 5, email: 'owner-b@example.test', role: 'owner', organization_id: 20 },
};
const cookieFor = (id) => `auth_token=${jwt.sign({ id }, SECRET)}`;

const LEADS = [
  { id: 7, created_at: new Date('2026-10-12T10:00:00Z'), business_name: 'Вам перевод 100 руб', contact_name: '', trade: '',
    message: '<script>alert(1)</script> claim at https://scam.example/x', email: 'victim.person@gmail.com', phone: '+1 555 123 4567',
    verify_status: 'pending', confirm_email_status: 'quota_blocked' },
  { id: 8, created_at: new Date('2026-10-12T09:00:00Z'), business_name: 'Acme Roofing', contact_name: 'Pat', trade: 'roofing',
    message: 'Need help with follow up', email: 'pat@acme.example', phone: '', verify_status: 'verified', confirm_email_status: 'sent' },
];

const spy = { audits: [], quotaCalls: [], alerts: [], listCalls: [], tableCalls: [], released: [] };
const state = { auditFails: false, schemaExtra: [], schemaDrop: [], failTable: null, spikeTable: null, dbDown: false, now: Date.now() };

const store = {
  async schema() {
    if (state.dbDown) throw new Error('connection refused');
    return [...Object.keys(REGISTRY).filter(n => !state.schemaDrop.includes(n)).map(name => ({ name, has_created_at: name !== 'schema_migrations' })),
            ...state.schemaExtra.map(name => ({ name, has_created_at: true }))];
  },
  async tableStats(name, hasCreatedAt) {
    spy.tableCalls.push(name);
    if (name === state.failTable) throw new Error('statement timeout');
    if (!hasCreatedAt) return { total: 3, last24h: null, last7d: null, lastHour: null, prior7d: null, newest: null };
    if (name === state.spikeTable || (state.spikeTables || []).includes(name)) return { total: 12000, last24h: 1900, last7d: 10700, lastHour: 120, prior7d: 168, newest: new Date() };
    return { total: 0, last24h: 0, last7d: 0, lastHour: 0, prior7d: 0, newest: null };
  },
  async listSubmissions(f) { spy.listCalls.push(f); return { total: LEADS.length, rows: LEADS }; },
  async getSubmission(id) { if (id > 2147483647) throw new Error('value is out of range for type integer'); const r = LEADS.find(l => l.id === id); return r ? { id: r.id, email: r.email, phone: r.phone } : null; },
};
const quotaCounts = new Map();
async function quota(bucket, windowMs, limit) {
  spy.quotaCalls.push(bucket);
  const n = (quotaCounts.get(bucket) || 0) + 1;
  quotaCounts.set(bucket, n);
  return { allowed: n <= limit, count: n, firstDenial: n === limit + 1 };
}
async function audit(e) { if (state.auditFails) throw new Error('db down'); spy.audits.push({ ...e, at: state.now }); }
// Same contract as createAlertGate: claimed (pending) rows expire after the lease,
// delivered rows suppress for the interval.
const sentAt = new Map();
const gate = {
  async claim(key, intervalMs) {
    const rows = sentAt.get(key) || [];
    const blocked = rows.some(r => (r.delivered ? r.at > state.now - intervalMs : r.at > state.now - dv.LIMITS.ALERT_CLAIM_LEASE_MS));
    if (blocked) return null;
    const claim = { at: state.now, delivered: false };
    sentAt.set(key, [...rows, claim]); return claim;
  },
  async confirm(key, claim) { claim.delivered = true; },
  async release(key, claim) { spy.released.push(key); sentAt.set(key, (sentAt.get(key) || []).filter(r => r !== claim)); },
};
// Same contract as recordRevealIfAllowed: rolling 60 minutes counted from the audit trail.
async function recordReveal({ userId, actorEmail, targetId, ip, limit }) {
  if (state.auditFails) throw new Error('db down');
  const recent = spy.audits.filter(a => a.action === 'form_submissions.reveal' && a.userId === userId && a.at > state.now - 60 * 60_000);
  if (recent.length >= limit) return { allowed: false };
  spy.audits.push({ userId, actorEmail, action: 'form_submissions.reveal', targetType: 'platform_lead', targetId: String(targetId), detail: {}, ip, at: state.now });
  return { allowed: true };
}

let server, base;
test.before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use('/admin/data', createDataVisibilityRouter({
    store, audit, recordReveal, jwtSecret: SECRET, log: { error() {} },
    loadUser: async (id) => USERS[id] || null,
  }));
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function reset() {
  for (const k of Object.keys(spy)) spy[k].length = 0;
  Object.assign(state, { spikeTables: [], auditFails: false, schemaExtra: [], schemaDrop: [], failTable: null, spikeTable: null, dbDown: false, now: Date.now() });
  quotaCounts.clear(); sentAt.clear();
}
const get = (path, cookie, headers = {}) => fetch(base + path, { headers: { ...(cookie ? { cookie } : {}), ...headers }, redirect: 'manual' });
const post = (path, cookie, headers = {}) => fetch(base + path, { method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...headers }, redirect: 'manual' });

const PATHS = ['/admin/data/health', '/admin/data/form-submissions'];

test('AC1: operator sees every registered table and an unregistered table in the banner', async () => {
  reset(); state.schemaExtra = ['mystery_table'];
  const res = await get('/admin/data/health', cookieFor(1));
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  for (const meta of Object.values(REGISTRY)) assert.ok(html.includes(meta.label.replace(/&/g, '&amp;')), `missing ${meta.label}`);
  assert.match(html, /1 table\(s\) exist that no screen or check covers/);
  assert.match(html, /mystery_table/);
  assert.ok(!spy.tableCalls.includes('mystery_table'), 'an unregistered table is never queried');
});

test('AC2: owner, admin, salesperson and logged-out visitors get 404 and leave no view trace', async () => {
  reset();
  for (const cookie of [cookieFor(2), cookieFor(3), cookieFor(4), null, 'auth_token=garbage', cookieFor(999)]) {
    for (const p of PATHS) {
      const res = await get(p, cookie);
      assert.strictEqual(res.status, 404, `${p} with ${cookie && cookie.slice(0, 20)}`);
    }
    const r = await post('/admin/data/form-submissions/7/reveal', cookie);
    assert.strictEqual(r.status, 404);
  }
  assert.strictEqual(spy.audits.length, 0);
  assert.strictEqual(spy.listCalls.length, 0, 'no data was read for a non-operator');
  assert.strictEqual(spy.quotaCalls.length, 0);
});

test('AC2: a token signed with another secret is refused', async () => {
  reset();
  const forged = `auth_token=${jwt.sign({ id: 1 }, 'not-the-secret')}`;
  assert.strictEqual((await get('/admin/data/health', forged)).status, 404);
});

test('AC3: an organization owner gets 404 whatever the query string says', async () => {
  reset();
  for (const q of ['?role=operator', '?organization_id=20', '?user=1', '?admin=1&role[]=operator']) {
    for (const p of PATHS) assert.strictEqual((await get(p + q, cookieFor(5))).status, 404);
  }
  assert.strictEqual(spy.audits.length, 0);
});

test('AC4: parameters naming other tables or columns are ignored', async () => {
  reset();
  const res = await get('/admin/data/form-submissions?table=users&column=password_hash&order=1;drop&page=1', cookieFor(1));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(Object.keys(spy.listCalls[0]).sort(), ['confirmed', 'from', 'page', 'spam', 'to']);
  const health = await get('/admin/data/health?table=users', cookieFor(1));
  assert.strictEqual(health.status, 200);
  assert.ok(spy.tableCalls.every(t => Object.prototype.hasOwnProperty.call(REGISTRY, t)));
});

test('AC5: emails and phones are masked, page size is 50, page 201 is refused', async () => {
  reset();
  const html = await (await get('/admin/data/form-submissions', cookieFor(1))).text();
  assert.ok(!html.includes('victim.person@gmail.com'), 'full email never on the list page');
  assert.ok(!html.includes('555 123 4567'), 'full phone never on the list page');
  assert.ok(html.includes('v•••@gmail.com'));
  assert.ok(html.includes('•••• 4567'));
  // Codex P2 (round 5): a short value is hidden whole, not shown as its own "last digits".
  assert.strictEqual(dv.maskPhone('1234'), '••••');
  assert.strictEqual(dv.maskPhone('ext 123456'), '••••');
  assert.strictEqual(dv.maskPhone('+1 (555) 123-4567'), '•••• 4567');
  assert.strictEqual(dv.maskEmail('ab@example.com'), '•••@example.com');
  assert.strictEqual(dv.maskEmail('abc@example.com'), 'a•••@example.com');
  assert.strictEqual(dv.LIMITS.PAGE_SIZE, 50);
  const over = await get('/admin/data/form-submissions?page=201', cookieFor(1));
  assert.strictEqual(over.status, 400);
  assert.strictEqual(spy.listCalls.length, 1, 'a refused page reads nothing');
  for (const bad of ['0', '-1', 'abc', '1.5']) assert.strictEqual((await get(`/admin/data/form-submissions?page=${bad}`, cookieFor(1))).status, 400);
});

test('AC6: stranger HTML is escaped and links are not clickable', async () => {
  reset();
  const html = await (await get('/admin/data/form-submissions', cookieFor(1))).text();
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('https://scam.example/x'), 'the link text is shown');
  assert.ok(!/href="https:\/\/scam\.example/.test(html), 'but never as a link');
});

test('AC7: reveal shows one record in full, is audited, and the 31st in an hour is refused', async () => {
  reset();
  const res = await post('/admin/data/form-submissions/7/reveal', cookieFor(1));
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('victim.person@gmail.com'));
  assert.ok(!html.includes('pat@acme.example'), 'only the one record');
  const reveals = spy.audits.filter(a => a.action === 'form_submissions.reveal');
  assert.strictEqual(reveals.length, 1);
  assert.strictEqual(reveals[0].targetId, '7');
  assert.strictEqual(reveals[0].userId, 1, 'actor comes from the session');
  for (let i = 0; i < 29; i++) assert.strictEqual((await post('/admin/data/form-submissions/8/reveal', cookieFor(1))).status, 200);
  const refused = await post('/admin/data/form-submissions/8/reveal', cookieFor(1));
  assert.strictEqual(refused.status, 429);
  assert.ok(!(await refused.text()).includes('pat@acme.example'));
  assert.strictEqual(spy.audits.filter(a => a.action === 'form_submissions.reveal').length, 30);
});

test('Codex P2: the reveal limit is a rolling 60 minutes, not a clock hour', async () => {
  reset();
  for (let i = 0; i < 30; i++) assert.strictEqual((await post('/admin/data/form-submissions/8/reveal', cookieFor(1))).status, 200);
  state.now += 2 * 60_000;   // two minutes later, across any clock-hour boundary
  assert.strictEqual((await post('/admin/data/form-submissions/8/reveal', cookieFor(1))).status, 429, 'no fresh allowance at the hour mark');
  state.now += 59 * 60_000;  // the first reveals are now over 60 minutes old
  assert.strictEqual((await post('/admin/data/form-submissions/8/reveal', cookieFor(1))).status, 200);
});

test('Codex P1: the reveal page loads nothing from outside and forbids scripts', async () => {
  reset();
  const res = await post('/admin/data/form-submissions/7/reveal', cookieFor(1));
  const html = await res.text();
  assert.ok(html.includes('victim.person@gmail.com'));
  assert.ok(!/<script/i.test(html), 'no script tag at all');
  assert.ok(!/(src|href)="https?:/i.test(html), 'no external resource');
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'none'/);
  assert.ok(!/script-src/.test(csp), 'no script source allowed');
});

test('AC7: reveal of a missing or malformed id is 404; a cross-site origin is refused', async () => {
  reset();
  assert.strictEqual((await post('/admin/data/form-submissions/99999/reveal', cookieFor(1))).status, 404);
  assert.strictEqual((await post('/admin/data/form-submissions/1e3/reveal', cookieFor(1))).status, 404);
  assert.strictEqual((await post('/admin/data/form-submissions/2147483648/reveal', cookieFor(1))).status, 404, 'Codex final P3: beyond integer range is not found, not an error');
  assert.strictEqual((await post('/admin/data/form-submissions/7/reveal', cookieFor(1), { origin: 'https://evil.example' })).status, 404);
  assert.strictEqual(spy.audits.length, 0);
});

test('AC7/AC8: if the audit entry cannot be written, nothing is shown', async () => {
  reset(); state.auditFails = true;
  const r = await post('/admin/data/form-submissions/7/reveal', cookieFor(1));
  assert.strictEqual(r.status, 503);
  assert.ok(!(await r.text()).includes('victim.person@gmail.com'));
  const l = await get('/admin/data/form-submissions', cookieFor(1));
  assert.strictEqual(l.status, 503);
  assert.strictEqual(spy.listCalls.length, 0, 'no data read when the trace failed');
});

test('AC8: each page view writes one audit entry with no record contents', async () => {
  reset();
  await get('/admin/data/health', cookieFor(1));
  await get('/admin/data/form-submissions?spam=yes&from=2026-10-01', cookieFor(1));
  assert.deepStrictEqual(spy.audits.map(a => a.action), ['data_health.view', 'form_submissions.view']);
  const detail = JSON.stringify(spy.audits);
  assert.ok(!detail.includes('victim') && !detail.includes('Acme'), 'no record contents in the trace');
  assert.strictEqual(spy.audits[1].detail.spam, 'yes');
});

test('AC12: a count that fails shows Unavailable, never 0', async () => {
  reset(); state.failTable = 'leads';
  const html = await (await get('/admin/data/health', cookieFor(1))).text();
  const row = html.split('<tr').find(r => r.includes('Leads (contacts)'));
  assert.match(row, /Unavailable/);
  assert.ok(!/>0</.test(row), 'no zero for a failed count');
});

test('AC9: a spike alerts once, with labels and counts only; a rerun within 6 hours is silent', async () => {
  reset(); state.spikeTable = 'platform_leads';
  const deps = { store, gate, alert: async (t) => spy.alerts.push(t), log: { error() {} } };
  const r1 = await dv.runAnomalyCheck(deps);
  assert.deepStrictEqual(r1.spikes, ['platform_leads']);
  assert.strictEqual(spy.alerts.length, 1);
  assert.match(spy.alerts[0], /Website form submissions/);
  assert.match(spy.alerts[0], /: 120 in the last hour/);
  assert.ok(!/@|victim|Acme/.test(spy.alerts[0]), 'no record contents in an alert');
  await dv.runAnomalyCheck(deps);
  assert.strictEqual(spy.alerts.length, 1, 'no repeat inside the window');
});

test('Codex P2: spike suppression is a rolling 6 hours from the last delivered alert', async () => {
  reset(); state.spikeTable = 'platform_leads';
  const deps = { store, gate, alert: async (t) => spy.alerts.push(t), log: { error() {} } };
  await dv.runAnomalyCheck(deps);
  state.now += 60 * 60_000;        // one hour later, across any clock boundary
  await dv.runAnomalyCheck(deps);
  state.now += 4 * 60 * 60_000;    // five hours after the alert
  await dv.runAnomalyCheck(deps);
  assert.strictEqual(spy.alerts.length, 1, 'still inside the 6 hours');
  state.now += 61 * 60_000;        // just past six hours
  await dv.runAnomalyCheck(deps);
  assert.strictEqual(spy.alerts.length, 2);
});

test('Codex P1: data pages load nothing from another server and forbid script', async () => {
  reset();
  for (const p of PATHS) {
    const res = await get(p, cookieFor(1));
    const html = await res.text();
    assert.ok(!/<script/i.test(html), `${p}: no script tag`);
    assert.ok(!/(src|href)="(https?:)?\/\//i.test(html), `${p}: no third-party resource`);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'none'/, p);
    assert.ok(!/script-src/.test(csp), `${p}: no script source allowed`);
  }
});

test('Codex final P2: an alert claimed by a process that died mid-send is retried after the lease', async () => {
  reset(); state.spikeTable = 'platform_leads';
  // Simulate the crash: a claim exists, never confirmed or released.
  await gate.claim('data-spike:platform_leads', dv.LIMITS.ANOMALY_REPEAT_MS);
  const deps = { store, gate, alert: async (t) => spy.alerts.push(t), log: { error() {} } };
  await dv.runAnomalyCheck(deps);
  assert.strictEqual(spy.alerts.length, 0, 'inside the lease: another sender may still be delivering');
  state.now += dv.LIMITS.ALERT_CLAIM_LEASE_MS + 60_000;
  await dv.runAnomalyCheck(deps);
  assert.strictEqual(spy.alerts.length, 1, 'after the lease the alert goes out instead of waiting 6 hours');
});

test('Codex final P2: the health snapshot stays inside its time budget when tables are slow', async () => {
  reset();
  const slow = { ...store, tableStats: async (n, h) => { await new Promise(r => setTimeout(r, 200)); return store.tableStats(n, h); } };
  const t0 = Date.now();
  const snap = await dv.dataHealthSnapshot(slow, { error() {} }, { budgetMs: 250, concurrency: 4 });
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `took ${ms} ms; serial would take about ${46 * 200} ms`);
  const unavailable = snap.rows.filter(r => r.status === 'unavailable').length;
  assert.ok(unavailable >= 30, `${unavailable} tables marked Unavailable, never shown as 0`);
  assert.strictEqual(snap.rows.length, Object.keys(REGISTRY).length, 'every table still has a row, in registry order');
  assert.strictEqual(snap.rows[0].name, Object.keys(REGISTRY)[0]);
});

test('Codex P2 (round 5): several spiking tables go out as one message; a failure releases every claim', async () => {
  reset(); state.spikeTables = ['platform_leads', 'leads', 'orders'];
  let fail = true, sends = 0;
  const deps = { store, gate, alert: async (t) => { sends++; if (fail) throw new Error('telegram timeout'); spy.alerts.push(t); }, log: { error() {} } };
  await dv.runAnomalyCheck(deps);
  assert.strictEqual(sends, 1, 'one delivery attempt for three tables');
  assert.deepStrictEqual(spy.released.sort(), ['data-spike:leads', 'data-spike:orders', 'data-spike:platform_leads']);
  fail = false;
  await dv.runAnomalyCheck(deps);
  assert.strictEqual(spy.alerts.length, 1);
  assert.match(spy.alerts[0], /sudden growth in 3 table/);
  assert.match(spy.alerts[0], /Website form submissions/);
  await dv.runAnomalyCheck(deps);
  assert.strictEqual(spy.alerts.length, 1, 'all three confirmed, so all three are suppressed');
});

test('Codex P2 (round 5): "check could not run" alerts at most once an hour, and retries after a failed delivery', async () => {
  let t = 0, sent = 0, fail = false;
  const a = dv.createCheckFailureAlerter(async () => { if (fail) throw new Error('down'); sent++; }, { now: () => t, log: { error() {} } });
  assert.strictEqual(await a(), 'sent');
  t += 5 * 60_000;
  assert.strictEqual(await a(), 'suppressed', 'a manual retry five minutes later stays quiet');
  t += 56 * 60_000;
  fail = true;
  assert.strictEqual(await a(), 'failed');
  fail = false;
  assert.strictEqual(await a(), 'sent', 'a failed delivery does not start a quiet hour');
  assert.strictEqual(sent, 2);
});

test('AC10: normal traffic sends nothing', async () => {
  reset();
  const r = await dv.runAnomalyCheck({ store, gate, alert: async (t) => spy.alerts.push(t), log: { error() {} } });
  assert.deepStrictEqual(r.spikes, []);
  assert.strictEqual(spy.alerts.length, 0);
});

test('AC9: spike rule needs both more than 50 an hour and more than 5x the 7-day average hour', () => {
  assert.strictEqual(dv.isSpike({ lastHour: 51, prior7d: 0 }), true);
  assert.strictEqual(dv.isSpike({ lastHour: 50, prior7d: 0 }), false, 'floor');
  assert.strictEqual(dv.isSpike({ lastHour: 400, prior7d: 168 * 100 }), false, 'busy table, 4x is normal');
  assert.strictEqual(dv.isSpike({ lastHour: 501, prior7d: 168 * 100 }), true);
  assert.strictEqual(dv.isSpike({ lastHour: null, prior7d: null }), false, 'no creation time, no rule');
});

test('AC11: an unregistered table and an unreadable count each alert; a failed delivery is reported', async () => {
  reset(); state.schemaExtra = ['mystery_table']; state.failTable = 'orders';
  const r = await dv.runAnomalyCheck({ store, gate, alert: async () => { throw new Error('telegram 401'); }, log: { error() {} } });
  assert.deepStrictEqual(r.unregistered, ['mystery_table']);
  assert.deepStrictEqual(r.unavailable, ['orders']);
  assert.strictEqual(r.alertErrors.length, 2, 'undelivered alerts are reported, not swallowed');
});

test('Codex P1: a failed alert gives its slot back, so the next hourly run retries', async () => {
  reset(); state.spikeTable = 'platform_leads';
  let fail = true;
  const deps = { store, gate, alert: async (t) => { if (fail) throw new Error('telegram timeout'); spy.alerts.push(t); }, log: { error() {} } };
  const r1 = await dv.runAnomalyCheck(deps);
  assert.strictEqual(r1.alertErrors.length, 1);
  assert.deepStrictEqual(spy.released, ['data-spike:platform_leads']);
  fail = false;
  const r2 = await dv.runAnomalyCheck(deps);
  assert.deepStrictEqual(r2.alerted, ['data-spike:platform_leads'], 'retried and delivered on the next run');
  assert.strictEqual(spy.alerts.length, 1);
});

test('Codex P1: a registered table missing from the database alerts', async () => {
  reset(); state.schemaDrop = ['orders'];
  const r = await dv.runAnomalyCheck({ store, gate, alert: async (t) => spy.alerts.push(t), log: { error() {} } });
  assert.deepStrictEqual(r.missing, ['orders']);
  assert.strictEqual(spy.alerts.length, 1);
  assert.match(spy.alerts[0], /expected tables are missing/);
});

test('AC11: when the database is down the check throws so the cron endpoint reports failure', async () => {
  reset(); state.dbDown = true;
  await assert.rejects(dv.runAnomalyCheck({ store, gate, alert: async () => {}, log: { error() {} } }));
});

test('filters accept only known values', () => {
  assert.deepStrictEqual(dv.readFilters({ page: ['1', '2'], confirmed: 'maybe', spam: 'yes', from: '2026-13-45', to: "2026-10-01'" }),
    { page: 1, from: null, to: null, confirmed: 'any', spam: 'yes' });
  // Codex P2: calendar-invalid dates are dropped, not passed to the database.
  for (const bad of ['2026-02-31', '2026-04-31', '2025-02-29', '2026-00-10']) assert.strictEqual(dv.readFilters({ from: bad }).from, null, bad);
  assert.strictEqual(dv.readFilters({ from: '2024-02-29' }).from, '2024-02-29', 'a real leap day is kept');
});
