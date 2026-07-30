/**
 * Free "recoverable revenue" estimate for a prospect. Computed from two things
 * they give on the landing form: their industry and their list size. No list
 * upload, no verification, no manual labor, so it scales to any number of leads.
 *
 * The numbers are ALWAYS computed here in code. The AI only writes the short
 * narrative around them, and never touches the math (LLMs cannot be trusted with
 * arithmetic). Honest framing: this is a projection based on industry averages,
 * not a scan of their actual list.
 */
const { callOpenRouter } = require('./openrouter');

// Average value of one sale/job per industry, matched by keyword against the
// free-text "what kind of business" field. These are starting defaults meant to
// be tuned by the owner. Revenue per sale (gross), not profit, to match the
// landing page's quick-math framing.
const INDUSTRY_BENCHMARKS = [
  { match: /(auto|car|vehicle|dealer|motors|truck)/i,          label: 'auto',              deal: 3500 },
  { match: /(hvac|heating|air ?condition|furnace|cooling)/i,    label: 'HVAC',              deal: 8000 },
  { match: /(roof)/i,                                          label: 'roofing',           deal: 10000 },
  { match: /(solar)/i,                                         label: 'solar',             deal: 15000 },
  { match: /(pool|spa)/i,                                      label: 'pools and spas',    deal: 15000 },
  { match: /(remodel|renovat|construct|contractor|build)/i,     label: 'remodeling',        deal: 12000 },
  { match: /(plumb)/i,                                         label: 'plumbing',          deal: 4000 },
  { match: /(electric)/i,                                      label: 'electrical',        deal: 4000 },
  { match: /(landscap|lawn|hardscape)/i,                        label: 'landscaping',       deal: 3000 },
  { match: /(law|legal|attorney|firm|counsel)/i,               label: 'legal',             deal: 3000 },
  { match: /(dental|dentist|orthodon)/i,                        label: 'dental',            deal: 1200 },
  { match: /(med ?spa|aesthet|clinic|health|medical|therapy)/i, label: 'medical',           deal: 1500 },
  { match: /(real ?estate|realtor|broker|mortgage)/i,           label: 'real estate',       deal: 9000 },
  { match: /(insur)/i,                                         label: 'insurance',         deal: 800 },
  { match: /(agricult|farm|crop|ranch|equipment)/i,            label: 'agriculture',       deal: 5000 },
  { match: /(security|screen|door|window|fence|gate)/i,         label: 'security screens',  deal: 2400 },
  { match: /(retail|store|shop|boutique|ecommerce|e-commerce)/i, label: 'retail',            deal: 300 },
];
const DEFAULT_BENCHMARK = { label: 'your industry', deal: 2400 };

function benchmarkFor(text) {
  const t = String(text || '');
  for (const b of INDUSTRY_BENCHMARKS) if (b.match.test(t)) return b;
  return DEFAULT_BENCHMARK;
}

// The landing form collects list size as a range. Map to a representative count.
const LIST_COUNTS = { under_500: 300, '500_2000': 1200, '2000_10000': 6000, '10000_plus': 15000 };
function listCount(v) { return LIST_COUNTS[v] || 2000; }

// The three reactivation rates the report shows: floor, typical, good list.
const RATES = [
  { rate: 0.01,  note: 'worst case' },
  { rate: 0.025, note: 'typical', highlight: true },
  { rate: 0.05,  note: 'a good list' },
];

function auditMath(count, deal) {
  return RATES.map(r => ({
    pct: r.rate * 100,
    note: r.note,
    highlight: !!r.highlight,
    sales: Math.round(count * r.rate),
    revenue: Math.round(count * r.rate) * deal,
  }));
}

function fallbackNarrative(label, count) {
  return `You are sitting on roughly ${count.toLocaleString('en-US')} people who once raised their hand about ${label} and never heard back. They already know who you are, which makes them worth far more than a cold lead. The only thing missing is the follow up, and follow up is the one thing that never gets done.`;
}

function sanitize(text) {
  return String(text || '')
    .replace(/[—–]/g, ', ')  // em/en dashes to commas
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

async function generateNarrative(label, count) {
  const prompt = `Write a short intro for a free "recoverable revenue" report for a business in ${label}.
They have about ${count} old leads and past customers they never followed up on.
Write 2 to 3 short, plain, human sentences. Be direct. No hype, no cliches, no em dashes.
Move from the money sitting idle, to the fact these people already know the business, to follow up being the gap.
Do NOT state any dollar figures or percentages (a table handles the numbers).
Do NOT use the words delve, unlock, leverage, robust, seamless, elevate, or supercharge.
Return only the sentences, no heading.`;
  // Reject AI output that smells like AI. If it slips any of these, or an em
  // dash the sanitizer missed, we use the plain human fallback instead.
  const LINGO = /\b(delve|unlock|leverage|robust|seamless|elevate|supercharge|crucial|comprehensive|furthermore|moreover|utilize|realm|tapestry|foster|bolster|effortless|cutting.edge|revolutioniz|empower|streamline|harness|game.chang|unleash|elevate)\b/i;
  try {
    const text = await Promise.race([
      callOpenRouter(prompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
    ]);
    const clean = sanitize(text);
    if (clean && clean.length > 30 && !LINGO.test(clean) && !/[—–]/.test(clean)) return clean;
  } catch (err) {
    console.warn('[audit] narrative AI failed, using fallback:', err.message);
  }
  return fallbackNarrative(label, count);
}

// Parse a money-ish input like "$3,000" or "3000" into a number, or null.
function parseMoney(v) {
  const n = parseFloat(String(v || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function generateAudit(trade, list_size, dealInput) {
  const b = benchmarkFor(trade);
  const count = listCount(list_size);
  // Prefer the value they typed in. Everyone's business is different, and their
  // own number makes the estimate legitimate. Fall back to the industry average
  // only when they leave it blank.
  const provided = parseMoney(dealInput);
  const deal = provided || b.deal;
  return {
    label: b.label,
    count,
    deal,
    usedTheirValue: !!provided,
    rows: auditMath(count, deal),
    narrative: await generateNarrative(b.label, count),
  };
}

module.exports = { generateAudit, benchmarkFor, listCount, auditMath, parseMoney };
