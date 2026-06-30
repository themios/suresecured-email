/**
 * Lead engagement scoring — additive formula, 0-100 cap
 *
 * Formula:
 *   opens >= 1  -> +20  (confirmed active)
 *   opens >= 3  -> +10  (repeated engagement bonus)
 *   clicks >= 1 -> +25  (high intent signal)
 *   clicks >= 3 -> +10  (very high intent bonus)
 *   replied     -> +25  (strongest signal)
 *   stepReached >= 3 -> +10  (survived multi-step sequence)
 *
 * Maximum possible: 100
 * Minimum possible: 0
 *
 * @param {number} openCount    - total opens across all email_sends for this lead
 * @param {number} clickCount   - total clicks across all email_sends for this lead
 * @param {boolean} replied     - true if any enrollment has paused_reason = 'replied'
 * @param {number} stepReached  - highest current_step reached across enrollments
 * @returns {number} integer 0-100
 */
function computeScore(openCount, clickCount, replied, stepReached) {
  let score = 0;

  if (openCount  >= 1) score += 20;
  if (openCount  >= 3) score += 10;
  if (clickCount >= 1) score += 25;
  if (clickCount >= 3) score += 10;
  if (replied)         score += 25;
  if (stepReached >= 3) score += 10;

  return Math.min(100, Math.max(0, score));
}

module.exports = { computeScore };
