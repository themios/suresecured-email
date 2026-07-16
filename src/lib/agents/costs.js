/**
 * Rough per-model cost estimation from OpenRouter usage.
 * Prices are USD per 1M tokens and are ESTIMATES for budgeting/telemetry only —
 * not billing. Update as OpenRouter pricing changes. Unknown models cost 0 so a
 * missing entry never blocks a run; it just under-reports until added.
 */
const PRICING = {
  // model: [inputPerM, outputPerM]
  'google/gemini-2.5-flash': [0.30, 2.50],
  'google/gemini-2.5-flash-lite': [0.10, 0.40],
  'google/gemini-2.5-pro': [1.25, 10.0],
  'anthropic/claude-3.5-haiku': [0.80, 4.0],
};

function estimateCost(model, usage = {}) {
  const [inM, outM] = PRICING[model] || [0, 0];
  const inTok = usage.prompt_tokens || 0;
  const outTok = usage.completion_tokens || 0;
  return (inTok / 1e6) * inM + (outTok / 1e6) * outM;
}

module.exports = { estimateCost, PRICING };
