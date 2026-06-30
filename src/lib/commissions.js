/**
 * Calculate commission for a single sale given units already completed this month
 * BEFORE this sale (pre-sale unit count).
 *
 * commission_rules JSONB shape:
 * {
 *   "tiers": [
 *     { "from": 0,  "to": 10, "rate": 10 },
 *     { "from": 10, "to": 20, "rate": 15 },
 *     { "from": 20, "to": null, "rate": 20 }
 *   ],
 *   "bonuses": [
 *     { "units": 25, "amount": 500 },
 *     { "units": 50, "amount": 1000 }
 *   ]
 * }
 *
 * tier.from = inclusive lower bound, tier.to = exclusive upper bound (null = no cap)
 * bonus.units = unit count that triggers a one-time bonus, checked at crossing point only
 *
 * @param {number} saleAmount   - Dollar amount of the order
 * @param {number} unitsBefore  - Units completed this month BEFORE this order
 * @param {object} rules        - Parsed commission_rules JSONB { tiers, bonuses }
 * @param {number} flatRate     - Fallback flat % from salespeople.commission_rate
 * @returns {{ rate: number, earned: number, bonusesTriggered: {units:number, amount:number}[] }}
 */
function calculateCommission(saleAmount, unitsBefore, rules, flatRate = 100) {
  const tiers = rules?.tiers;
  if (!tiers || !tiers.length) {
    return { rate: flatRate, earned: (saleAmount * flatRate) / 100, bonusesTriggered: [] };
  }

  const thisUnit = unitsBefore + 1;

  const tier = tiers.find(t =>
    thisUnit > t.from && (t.to === null || thisUnit <= t.to)
  );

  const rate = tier ? tier.rate : tiers[tiers.length - 1].rate;
  const earned = (saleAmount * rate) / 100;

  const bonusesTriggered = (rules?.bonuses || []).filter(
    b => unitsBefore < b.units && thisUnit >= b.units
  );

  return { rate, earned, bonusesTriggered };
}

module.exports = { calculateCommission };
