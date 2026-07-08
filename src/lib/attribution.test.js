const assert = require('node:assert');
const { resolveSalespersonForOrder, normalizePhone } = require('./attribution');

// Minimal mock pg client. Routes queries by a substring of the SQL to a handler.
function makeDb(handlers) {
  return {
    query: async (sql, params) => {
      for (const [needle, fn] of handlers) {
        if (sql.includes(needle)) return fn(params);
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// ── normalizePhone: strips country code to last 10 digits ───────────────────
assert.strictEqual(normalizePhone('+1 (818) 555-1234'), '8185551234', 'US 11-digit → last 10');
assert.strictEqual(normalizePhone('8185551234'), '8185551234', '10-digit unchanged');
assert.strictEqual(normalizePhone(''), null, 'empty → null');

// ── C1: forged cart salesperson for a non-existent/foreign rep is NOT paid ──
(async () => {
  const db = makeDb([
    ['FROM salespeople', () => ({ rows: [] })],       // validateSalesperson: not found/inactive
    ['FROM tracking_tokens', () => ({ rows: [] })],
    ['FROM leads WHERE LOWER(email)', () => ({ rows: [] })],
    ['FROM call_logs', () => ({ rows: [] })],
  ]);
  const r = await resolveSalespersonForOrder(
    { cartSalespersonId: '999', customerEmail: 'x@y.com', clientId: 1 }, db
  );
  assert.strictEqual(r.salespersonId, null, 'forged cart rep must not be credited');
  assert.strictEqual(r.status, 'pending_review', 'unresolved → pending_review');
})();

// ── C1: valid cart hint (active, in-tenant) with no stronger signal IS paid ─
(async () => {
  const db = makeDb([
    ['FROM salespeople', () => ({ rows: [{ id: 5 }] })], // validateSalesperson: valid
    ['FROM tracking_tokens', () => ({ rows: [] })],
    ['FROM leads WHERE LOWER(email)', () => ({ rows: [] })],
    ['FROM call_logs', () => ({ rows: [] })],
  ]);
  const r = await resolveSalespersonForOrder(
    { cartSalespersonId: '5', customerEmail: 'x@y.com', clientId: 1 }, db
  );
  assert.strictEqual(r.salespersonId, 5, 'validated cart rep credited');
  assert.ok(r.path.startsWith('cart:ss_salesperson:validated'), 'path notes validation');
})();

// ── C2: server-issued token beats the cart value ───────────────────────────
(async () => {
  const db = makeDb([
    ['FROM tracking_tokens', () => ({ rows: [{ lead_id: 2, salesperson_id: 7 }] })],
    ['FROM salespeople', () => { throw new Error('cart must not be consulted when token wins'); }],
  ]);
  const r = await resolveSalespersonForOrder(
    { token: 'tok', cartSalespersonId: '999', clientId: 1 }, db
  );
  assert.strictEqual(r.salespersonId, 7, 'token salesperson wins over cart');
  assert.strictEqual(r.path, 'token:tok');
})();

// ── C2: lead first-touch owner beats the cart hint ─────────────────────────
(async () => {
  const db = makeDb([
    ['FROM tracking_tokens', () => ({ rows: [] })],
    ['FROM leads WHERE LOWER(email)', () => ({ rows: [{ id: 3, attributed_salesperson_id: 8, salesperson_id: null, client_id: 1 }] })],
    ['FROM salespeople', () => { throw new Error('cart must not be consulted when first-touch exists'); }],
  ]);
  const r = await resolveSalespersonForOrder(
    { cartSalespersonId: '999', customerEmail: 'x@y.com', clientId: 1 }, db
  );
  assert.strictEqual(r.salespersonId, 8, 'first-touch owner wins over cart');
  assert.ok(r.path.startsWith('lead:attributed'), 'path notes first-touch');
})();

console.log('attribution.test.js: all assertions passed');
