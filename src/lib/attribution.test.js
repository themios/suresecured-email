const assert = require('node:assert');
const { resolveSalespersonForOrder, normalizePhone, fuzzyNameMatch } = require('./attribution');

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

// ── Fuzzy name match (Feature C) — suggestions only, never auto-credit ──────
(() => {
  const leads = [
    { id: 1, first_name: 'John', last_name: 'Smith', salesperson_id: 5, attributed_salesperson_id: null },
    { id: 2, first_name: 'Jane', last_name: 'Doe',   salesperson_id: null, attributed_salesperson_id: 8 },
    { id: 3, first_name: 'Bob',  last_name: 'Jones', salesperson_id: null, attributed_salesperson_id: null }, // no owner
  ];
  assert.deepStrictEqual(fuzzyNameMatch('John Smith', leads), { leadId: 1, salespersonId: 5 }, 'exact match suggests owner');
  assert.deepStrictEqual(fuzzyNameMatch('jane  DOE!', leads), { leadId: 2, salespersonId: 8 }, 'case/punct-insensitive, attributed owner');
  assert.deepStrictEqual(fuzzyNameMatch('Smith John', leads), { leadId: 1, salespersonId: 5 }, 'token order does not matter');
  assert.strictEqual(fuzzyNameMatch('John', leads), null, 'single token too weak');
  assert.strictEqual(fuzzyNameMatch('Bob Jones', leads), null, 'owner-less lead never suggested');
  assert.strictEqual(fuzzyNameMatch('Nobody Here', leads), null, 'unknown name → null');
})();

// Ambiguous (same name owned by two reps) → null, never guess
(() => {
  const leads = [
    { id: 1, first_name: 'Chris', last_name: 'Lee', salesperson_id: 5 },
    { id: 2, first_name: 'Chris', last_name: 'Lee', salesperson_id: 9 },
  ];
  assert.strictEqual(fuzzyNameMatch('Chris Lee', leads), null, 'two owners for same name → no suggestion');
})();

console.log('attribution.test.js: all assertions passed');
