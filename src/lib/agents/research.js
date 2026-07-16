/**
 * Lead Research / Enrichment agent — the B2B, self-contained equivalent of the
 * video's "product research" agent. Rather than scrape external sources, it
 * enriches the tenant's EXISTING leads: for records missing product_interest,
 * it infers a likely interest from the signals on hand (name, email domain) via
 * the LLM and writes it back. This feeds the Segmentation and Email agents.
 *
 * Bounded + idempotent: only processes leads with product_interest IS NULL and
 * enriched_at IS NULL, capped per run, and always stamps enriched_at so a lead
 * is never re-spent on. Read/label only — no sends.
 */
const { pool } = require('../../db');
const { runAgent } = require('./runner');
const { emit } = require('./eventBus');

const DEFAULT_MAX_ENRICH = 10;

function buildEnrichPrompt(lead, brandConfig = {}) {
  const brand = brandConfig.name || 'a company';
  const catalog = brandConfig.products || 'the company\'s products';
  return `You enrich CRM leads for ${brand}. Based only on the signals below, infer the single most
likely product interest for this lead. Keep it short (2-4 words). If you genuinely cannot tell,
use "general".

Lead name: ${lead.first_name || ''} ${lead.last_name || ''}
Email: ${lead.email || ''}
Known context: ${lead.product_interest || 'none'}; audience ${lead.audience_type || 'unknown'}
Company sells: ${catalog}

Respond as strict JSON only, no code fences:
{"product_interest":"...","audience_type":"B2B or B2C or unknown"}`;
}

async function candidateLeads(clientId, config = {}) {
  const max = Number.isFinite(Number(config.max_enrich)) ? Number(config.max_enrich) : DEFAULT_MAX_ENRICH;
  const { rows } = await pool.query(
    `SELECT id, email, first_name, last_name, product_interest, audience_type
       FROM leads
      WHERE client_id = $1
        AND product_interest IS NULL
        AND enriched_at IS NULL
        AND email IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [clientId, max]
  );
  return rows;
}

async function runResearchForClient(clientId, opts = {}) {
  const { trigger = 'cron', config = {}, brandConfig = {} } = opts;
  return runAgent({ clientId, agent: 'research', trigger }, async ({ llm }) => {
    const leads = await candidateLeads(clientId, config);
    let enriched = 0;
    for (const lead of leads) {
      let out;
      try {
        const raw = await llm(buildEnrichPrompt(lead, brandConfig), { title: 'Research Agent' });
        out = JSON.parse(raw.replace(/```[a-z]*\n?/gi, '').trim());
      } catch {
        // Still stamp enriched_at so we don't retry a lead that keeps failing.
        await pool.query(`UPDATE leads SET enriched_at = NOW() WHERE id = $1 AND client_id = $2`, [lead.id, clientId]);
        continue;
      }
      const interest = out && out.product_interest ? String(out.product_interest).slice(0, 100) : null;
      const audience = out && /^(B2B|B2C)$/i.test(out.audience_type || '') ? out.audience_type.toUpperCase() : null;
      await pool.query(
        `UPDATE leads
            SET product_interest = COALESCE(product_interest, $3),
                audience_type    = COALESCE($4, audience_type),
                enriched_at      = NOW()
          WHERE id = $1 AND client_id = $2`,
        [lead.id, clientId, interest, audience]
      );
      if (interest) enriched++;
    }
    if (enriched > 0) await emit(clientId, 'research', 'lead.enriched', { enriched });
    return { candidates: leads.length, enriched };
  });
}

module.exports = { runResearchForClient, buildEnrichPrompt, candidateLeads };
