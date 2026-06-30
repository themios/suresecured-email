const assert = require('node:assert');
const { calculateCommission } = require('./commissions');

const rules = {
  tiers: [
    { from: 0, to: 10, rate: 10 },
    { from: 10, to: 20, rate: 15 },
    { from: 20, to: null, rate: 20 },
  ],
  bonuses: [
    { units: 25, amount: 500 },
    { units: 50, amount: 1000 },
  ],
};

// 1st sale of month (unitsBefore=0, thisUnit=1) -> tier 1, rate 10
{
  const result = calculateCommission(100, 0, rules, 100);
  assert.strictEqual(result.rate, 10, '1st sale should be rate 10');
}

// 10th sale (unitsBefore=9, thisUnit=10) -> boundary, still tier 1 (10 <= 10)
{
  const result = calculateCommission(100, 9, rules, 100);
  assert.strictEqual(result.rate, 10, '10th sale (thisUnit=10) should be rate 10 (tier 1 boundary)');
}

// 11th sale (unitsBefore=10, thisUnit=11) -> tier 2, rate 15
{
  const result = calculateCommission(100, 10, rules, 100);
  assert.strictEqual(result.rate, 15, '11th sale (thisUnit=11) should be rate 15');
}

// 20th sale (unitsBefore=19, thisUnit=20) -> boundary, still tier 2 (20 <= 20)
{
  const result = calculateCommission(100, 19, rules, 100);
  assert.strictEqual(result.rate, 15, '20th sale (thisUnit=20) should be rate 15 (tier 2 boundary)');
}

// 21st sale (unitsBefore=20, thisUnit=21) -> tier 3, rate 20
{
  const result = calculateCommission(100, 20, rules, 100);
  assert.strictEqual(result.rate, 20, '21st sale (thisUnit=21) should be rate 20');
}

// 25th sale (unitsBefore=24, thisUnit=25) -> bonus triggered
{
  const result = calculateCommission(100, 24, rules, 100);
  assert.strictEqual(result.bonusesTriggered.length, 1, '25th sale should trigger exactly one bonus');
  assert.strictEqual(result.bonusesTriggered[0].units, 25);
  assert.strictEqual(result.bonusesTriggered[0].amount, 500);
}

// 26th sale (unitsBefore=25, thisUnit=26) -> bonus does NOT re-trigger
{
  const result = calculateCommission(100, 25, rules, 100);
  assert.strictEqual(result.bonusesTriggered.length, 0, '26th sale should not re-trigger bonus');
}

// rules={} (no tiers) -> falls back to flatRate
{
  const result = calculateCommission(200, 5, {}, 100);
  assert.strictEqual(result.rate, 100, 'empty rules should fall back to flatRate');
  assert.strictEqual(result.earned, 200, 'earned should equal saleAmount at 100% flat rate');
  assert.deepStrictEqual(result.bonusesTriggered, []);
}

// rules=null -> falls back to flatRate without throwing
{
  const result = calculateCommission(200, 5, null, 100);
  assert.strictEqual(result.rate, 100, 'null rules should fall back to flatRate');
  assert.strictEqual(result.earned, 200);
}

// earned computed correctly for non-round numbers
{
  const result = calculateCommission(149.99, 0, rules, 100);
  assert.strictEqual(result.rate, 10);
  assert.ok(Math.abs(result.earned - 14.999) < 1e-9, `earned should be ~14.999, got ${result.earned}`);
}
{
  const result = calculateCommission(149.99, 10, rules, 100);
  assert.strictEqual(result.rate, 15);
  assert.ok(Math.abs(result.earned - 22.4985) < 1e-9, `earned should be ~22.4985, got ${result.earned}`);
}

console.log('All commissions.test.js assertions passed.');
