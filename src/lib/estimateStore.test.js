// DB-backed checks of the estimate store's atomic statements.
// Uses ESTIMATE_TEST_DATABASE_URL only (never DATABASE_URL, so it can not touch production).
// The database needs platform_leads plus migrations/026_estimate_verification.sql applied.
// Skips when the variable is unset. Run:
//   ESTIMATE_TEST_DATABASE_URL=postgres://... node --test src/lib/estimateStore.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { createPgStore, sha256 } = require('./estimateStore');

const url = process.env.ESTIMATE_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'ESTIMATE_TEST_DATABASE_URL not set' };
const pool = url ? new Pool({ connectionString: url }) : null;
const store = pool ? createPgStore(pool) : null;
test.after(() => pool && pool.end());

test('quota: 50 parallel events against a limit of 10 admit exactly 10, and alert once', opts, async () => {
  const bucket = `t:${Date.now()}:${Math.random()}`;
  const results = await Promise.all(Array.from({ length: 50 }, () => store.consumeQuota(bucket, 3600_000, 10)));
  assert.strictEqual(results.filter(r => r.allowed).length, 10);
  assert.strictEqual(results.filter(r => r.firstDenial).length, 1);
});

test('token: 20 parallel claims of one token succeed exactly once, release/complete behave, lead verified', opts, async () => {
  const leadId = await store.insertLead({ business_name: 'T', email: 't@example.com', trade: 'roofing', list_size: '500_2000', deal_value: '3000' });
  const hash = sha256(`tok-${Date.now()}-${Math.random()}`);
  await store.createVerification(leadId, hash, new Date(Date.now() + 60_000));
  assert.strictEqual(await store.peekVerification(hash), true);
  const results = await Promise.all(Array.from({ length: 20 }, () => store.claimVerification(hash, 120000)));
  assert.strictEqual(results.filter(Boolean).length, 1);
  assert.strictEqual(results.find(Boolean).id, leadId);
  assert.strictEqual(await store.peekVerification(hash), true, 'claimed but not completed: still retryable after release');
  await store.releaseVerification(hash);
  assert.ok(await store.claimVerification(hash, 120000), 'released token can be claimed again');
  assert.strictEqual(await store.claimVerification(hash, 120000), null, 'live lease blocks a second claim');
  await store.completeVerification(hash);
  assert.strictEqual(await store.claimVerification(hash, 0), null, 'completed token is dead even with an expired lease');
  assert.strictEqual(await store.peekVerification(hash), false);
  const { rows } = await pool.query('SELECT verify_status, verified_at FROM platform_leads WHERE id=$1', [leadId]);
  assert.strictEqual(rows[0].verify_status, 'verified');
  assert.ok(rows[0].verified_at);
});

test('token: an expired token is refused and the lead stays pending', opts, async () => {
  const leadId = await store.insertLead({ business_name: 'T2', email: 't2@example.com' });
  const hash = sha256(`exp-${Date.now()}-${Math.random()}`);
  await store.createVerification(leadId, hash, new Date(Date.now() - 1000));
  assert.strictEqual(await store.claimVerification(hash, 120000), null);
  const { rows } = await pool.query('SELECT verify_status FROM platform_leads WHERE id=$1', [leadId]);
  assert.strictEqual(rows[0].verify_status, 'pending');
});

test('token: a crashed claim becomes claimable again once the lease has expired', opts, async () => {
  const leadId = await store.insertLead({ business_name: 'T3', email: 't3@example.com' });
  const hash = sha256(`lease-${Date.now()}-${Math.random()}`);
  await store.createVerification(leadId, hash, new Date(Date.now() + 60_000));
  assert.ok(await store.claimVerification(hash, 120000));
  assert.strictEqual(await store.claimVerification(hash, 120000), null);
  await new Promise(r => setTimeout(r, 60));
  assert.ok(await store.claimVerification(hash, 20), 'lease of 20ms has expired');
});

test('abuse snapshot and prune run against the real schema', opts, async () => {
  const snap = await store.abuseSnapshot();
  assert.ok(Number.isInteger(snap.submitted) && Array.isArray(snap.tripped));
  await store.pruneQuota();
});
