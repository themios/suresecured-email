// Spec: specs/2026-10-14-data-visibility.md, AC13 and AC14.
// Builds an empty database with the app's own migrations (initDb), then checks that
// every table is in the data registry and that the Data health and form submission
// queries run against the real schema.
//
// Uses TEST_DATABASE_URL only, never DATABASE_URL, and refuses a Railway host, so it
// cannot touch production. Skips when the variable is unset. Run:
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/sw_test node --test src/test/dataRegistry.test.js
const test = require('node:test');
const assert = require('node:assert');

const url = process.env.TEST_DATABASE_URL;
const unsafe = url && /railway|rlwy\.net/i.test(url);
const opts = { skip: !url ? 'TEST_DATABASE_URL not set' : unsafe ? 'refusing a Railway database' : false };

let pool, initDb, dv, REGISTRY;
if (url && !unsafe) {
  process.env.DATABASE_URL = url;       // db.js reads it at require time
  process.env.NODE_ENV = 'test';        // no TLS for the local test database
  ({ pool, initDb } = require('../db'));
  dv = require('../lib/dataVisibility');
  ({ REGISTRY } = require('../lib/dataRegistry'));
}
test.after(() => pool && pool.end());

test.before(async () => {
  if (opts.skip) return;
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await initDb();
});

test('AC13: every table in the schema is registered, and every registered table exists', opts, async () => {
  const store = dv.createPgDataStore(pool);
  const tables = (await store.schema()).map(r => r.name);
  const registered = Object.keys(REGISTRY);
  const unregistered = tables.filter(t => !registered.includes(t));
  const ghosts = registered.filter(t => !tables.includes(t));
  assert.deepStrictEqual(unregistered, [], `tables with no registry entry (add a screen or a reason in src/lib/dataRegistry.js): ${unregistered.join(', ')}`);
  assert.deepStrictEqual(ghosts, [], `registry entries for tables that do not exist: ${ghosts.join(', ')}`);
  for (const [name, meta] of Object.entries(REGISTRY)) {
    assert.ok(meta.label, `${name} has no label`);
    assert.ok(meta.visibility === 'screen' ? meta.where : meta.why, `${name} needs a "where" or a written reason`);
  }
});

test('AC14: the Data health snapshot reads every table without error', opts, async () => {
  const errors = [];
  const snap = await dv.dataHealthSnapshot(dv.createPgDataStore(pool), { error: (...a) => errors.push(a.join(' ')) });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(snap.unregistered, []);
  assert.ok(snap.rows.every(r => r.status === 'normal'), JSON.stringify(snap.rows.filter(r => r.status !== 'normal')));
});

test('AC14: form submission queries, spam and confirmed filters, and counts against real rows', opts, async () => {
  const ins = (name, msg, status, ago) => pool.query(
    `INSERT INTO platform_leads (business_name, email, message, verify_status, created_at)
     VALUES ($1, 'x@example.com', $2, $3, now() - $4::interval) RETURNING id`, [name, msg, status, ago]);
  await ins('Вам перевод 100 руб', 'abc DEF ghi', 'pending', '10 minutes');
  await ins('Acme Roofing', 'Need follow up', 'verified', '20 minutes');
  await ins('Plain Co', 'hello', 'pending', '3 days');
  await ins('https://spam.example', 'x', 'pending', '30 minutes');
  const store = dv.createPgDataStore(pool);
  const base = { page: 1, from: null, to: null, confirmed: 'any', spam: 'any' };
  assert.strictEqual((await store.listSubmissions(base)).total, 4);
  const spam = await store.listSubmissions({ ...base, spam: 'yes' });
  assert.deepStrictEqual(spam.rows.map(r => r.business_name).sort(), ['https://spam.example', 'Вам перевод 100 руб']);
  assert.strictEqual((await store.listSubmissions({ ...base, spam: 'no' })).total, 2);
  assert.strictEqual((await store.listSubmissions({ ...base, confirmed: 'yes' })).rows[0].business_name, 'Acme Roofing');
  for (const r of spam.rows) assert.strictEqual(dv.looksLikeSpam(r), true, 'page flag agrees with the filter');
  const first = (await store.listSubmissions(base)).rows[0];
  assert.strictEqual(first.business_name, 'Вам перевод 100 руб', 'newest first');
  const s = await store.tableStats('platform_leads', true);
  assert.deepStrictEqual([s.total, s.last24h, s.lastHour], [4, 3, 3]);
  const rec = await store.getSubmission(first.id);
  assert.strictEqual(rec.email, 'x@example.com');
  assert.strictEqual(await store.getSubmission(999999), null);
});

test('Codex P2: the rolling reveal limit holds under 40 parallel requests', opts, async () => {
  const { rows } = await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ('reveal-op@example.test', 'x', 'operator') RETURNING id`);
  const userId = rows[0].id;
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    dv.recordRevealIfAllowed(pool, { userId, actorEmail: 'reveal-op@example.test', targetId: i + 1, ip: null, limit: 30 })));
  assert.strictEqual(results.filter(r => r.allowed).length, 30);
  const n = (await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND action = 'form_submissions.reveal'`, [userId])).rows[0].n;
  assert.strictEqual(n, 30, 'one audit entry per allowed reveal, none for refused ones');
  await pool.query(`UPDATE audit_log SET created_at = now() - interval '61 minutes' WHERE user_id = $1`, [userId]);
  assert.strictEqual((await dv.recordRevealIfAllowed(pool, { userId, actorEmail: 'x', targetId: 1, ip: null, limit: 30 })).allowed, true, 'entries older than 60 minutes no longer count');
});

test('Codex P1/P2: alert gate is a rolling interval, and a released claim lets the next attempt through', opts, async () => {
  const gate = dv.createAlertGate(pool);
  const key = `test:${Date.now()}`;
  const first = await gate.claim(key, 6 * 3600_000);
  assert.ok(first);
  assert.strictEqual(await gate.claim(key, 6 * 3600_000), null, 'suppressed inside the interval');
  await gate.release(key, first);
  const again = await gate.claim(key, 6 * 3600_000);
  assert.ok(again, 'released claim admits the next attempt');
  await pool.query(`UPDATE form_quota SET window_start = now() - interval '6 hours 1 minute' WHERE bucket = $1`, [`alert-sent:${key}`]);
  assert.ok(await gate.claim(key, 6 * 3600_000), 'due again once the interval has passed');
  const parallel = await Promise.all(Array.from({ length: 10 }, () => gate.claim(`${key}:p`, 3600_000)));
  assert.strictEqual(parallel.filter(Boolean).length, 1, 'ten parallel claims, one alert');
});

test('Codex round 3 P2: a delivered data-health alert is not reported as a tripped spam limit', opts, async () => {
  const { createPgStore } = require('../lib/estimateStore');
  await dv.createAlertGate(pool).claim(`report:${Date.now()}`, 3600_000);
  const snap = await createPgStore(pool).abuseSnapshot();
  assert.ok(!snap.tripped.some(t => String(t.bucket).startsWith('alert-sent:')), JSON.stringify(snap.tripped));
});

test('reads cannot write: the store refuses an unregistered table name', opts, async () => {
  const store = dv.createPgDataStore(pool);
  await assert.rejects(store.tableStats('pg_shadow', false), /unregistered/);
  await assert.rejects(store.tableStats('users"; DROP TABLE users; --', false), /unregistered/);
});
