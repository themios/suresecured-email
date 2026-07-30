/**
 * Two-tenant isolation suite. Seeds two clients (A and B), each with its own
 * owner user and its own leads / sequence / order, then drives the REAL HTTP app
 * as tenant A and asserts A can never see or mutate B's data. This is the guard
 * that keeps the Phase 0 tenant-scoping from silently rotting as routes change.
 *
 * DB-backed, so it is NOT part of the default `npm test` (which runs without a
 * database). Run it with a Postgres available:
 *   DATABASE_URL=postgres://... JWT_SECRET=test node --test src/test/isolation.test.js
 * If it cannot reach a database, every test is skipped rather than failing.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'isolation-test-secret';
process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const jwt = require('jsonwebtoken');
const { pool, initDb } = require('../db');

let server, baseUrl, dbReady = false;
const A = {}, B = {};

async function seedTenant(tag) {
  const org = await pool.query(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Org ${tag}`, `org-${tag}-${Date.now()}`]
  );
  const client = await pool.query(
    `INSERT INTO clients (organization_id, name, slug, active) VALUES ($1, $2, $3, true) RETURNING id`,
    [org.rows[0].id, `Client ${tag}`, `client-${tag}-${Date.now()}`]
  );
  const clientId = client.rows[0].id;
  const user = await pool.query(
    `INSERT INTO users (email, password_hash, role, client_id, active)
     VALUES ($1, 'x', 'owner', $2, true) RETURNING id`,
    [`owner-${tag}-${Date.now()}@example.com`, clientId]
  );
  const userId = user.rows[0].id;
  const lead = await pool.query(
    `INSERT INTO leads (email, first_name, phone, stage, audience_type, product_interest, client_id)
     VALUES ($1, $2, $3, 'new', 'B2C', $4, $5) RETURNING id`,
    [`lead-${tag}@example.com`, `Lead${tag}`, `555000${tag === 'A' ? '1111' : '2222'}`, `interest-${tag}`, clientId]
  );
  const seq = await pool.query(
    `INSERT INTO sequences (client_id, name, audience_type) VALUES ($1, $2, 'B2C') RETURNING id`,
    [clientId, `Sequence ${tag}`]
  );
  await pool.query(
    `INSERT INTO orders (client_id, amount, ordered_at) VALUES ($1, $2, NOW())`,
    [clientId, tag === 'A' ? 1000 : 9999]
  );
  return {
    clientId, userId,
    leadId: lead.rows[0].id,
    seqId: seq.rows[0].id,
    token: jwt.sign({ id: userId }, process.env.JWT_SECRET),
    leadEmail: `lead-${tag}@example.com`,
    interest: `interest-${tag}`,
  };
}

test.before(async () => {
  try {
    await initDb();
    Object.assign(A, await seedTenant('A'));
    Object.assign(B, await seedTenant('B'));
    const { app } = require('../index');
    server = http.createServer(app);
    await new Promise(res => server.listen(0, '127.0.0.1', res));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    dbReady = true;
  } catch (err) {
    console.warn(`[isolation] skipping — no database (${err.message})`);
  }
});

test.after(async () => {
  if (server) await new Promise(res => server.close(res));
  try { await pool.end(); } catch { /* already closed */ }
});

function get(path, token) {
  return fetch(`${baseUrl}${path}`, { headers: { Cookie: `auth_token=${token}` }, redirect: 'manual' });
}
function post(path, token, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Cookie: `auth_token=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    redirect: 'manual',
  });
}

test('leads list shows only the caller\'s tenant leads', async (t) => {
  if (!dbReady) return t.skip('no database');
  const res = await get('/leads', A.token);
  const html = await res.text();
  assert.ok(html.includes(A.leadEmail), 'A should see its own lead');
  assert.ok(!html.includes(B.leadEmail), 'A must NOT see B\'s lead');
});

test('analytics funnel counts only the caller\'s tenant', async (t) => {
  if (!dbReady) return t.skip('no database');
  const res = await get('/analytics/data?days=365', A.token);
  const data = await res.json();
  assert.strictEqual(parseInt(data.funnel.total_leads), 1, 'A sees exactly its 1 lead');
  const revenue = data.revenueByDay.reduce((s, r) => s + parseFloat(r.revenue || 0), 0);
  assert.strictEqual(revenue, 1000, 'A sees only its own $1000, never B\'s $9999');
  assert.ok(!JSON.stringify(data).includes('9999'), 'B\'s revenue must not leak into A\'s analytics');
});

test('sequences list is tenant-scoped', async (t) => {
  if (!dbReady) return t.skip('no database');
  const res = await get('/sequences/api/sequences', A.token);
  const rows = await res.json();
  assert.ok(rows.every(r => r.client_id === A.clientId), 'every sequence belongs to A');
  assert.ok(!rows.some(r => r.id === B.seqId), 'B\'s sequence must not appear');
});

test('opening another tenant\'s lead by id returns 404', async (t) => {
  if (!dbReady) return t.skip('no database');
  const res = await get(`/leads/${B.leadId}`, A.token);
  assert.strictEqual(res.status, 404, 'A must not read B\'s lead detail');
});

test('mutating another tenant\'s lead is refused', async (t) => {
  if (!dbReady) return t.skip('no database');
  const res = await post(`/leads/${B.leadId}/stage`, A.token, { stage: 'won' });
  assert.strictEqual(res.status, 404, 'A must not change B\'s lead stage');
  const { rows } = await pool.query('SELECT stage FROM leads WHERE id = $1', [B.leadId]);
  assert.strictEqual(rows[0].stage, 'new', 'B\'s lead stage is untouched');
});

test('reading another tenant\'s sequence by id returns 404', async (t) => {
  if (!dbReady) return t.skip('no database');
  const res = await get(`/sequences/api/sequences/${B.seqId}`, A.token);
  assert.strictEqual(res.status, 404, 'A must not read B\'s sequence');
});

test('a session with no client_id is refused by tenant routes', async (t) => {
  if (!dbReady) return t.skip('no database');
  const orphan = await pool.query(
    `INSERT INTO users (email, password_hash, role, client_id, active)
     VALUES ($1, 'x', 'owner', NULL, true) RETURNING id`,
    [`orphan-${Date.now()}@example.com`]
  );
  const token = jwt.sign({ id: orphan.rows[0].id }, process.env.JWT_SECRET);
  const res = await get('/leads', token);
  assert.strictEqual(res.status, 403, 'no tenant context => 403');
});
