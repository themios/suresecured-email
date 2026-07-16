/**
 * Campaign Planning agent — the B2B equivalent of the video's "content planning"
 * agent. Once a month it reads the tenant's segment distribution and recent
 * performance and produces a concise outreach plan (which segments to target,
 * themes, cadence) for the operator. Idempotent per calendar month.
 *
 * Output is a recommendation stored in agent_plans and surfaced in the dashboard
 * / settings — it does not itself send anything.
 */
const { pool } = require('../../db');
const { runAgent } = require('./runner');
const { emit } = require('./eventBus');

/** Calendar-month key, e.g. "2026-07" (UTC). */
function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function gatherInputs(clientId) {
  const { rows: seg } = await pool.query(
    `SELECT COALESCE(segment, 'unsegmented') AS seg, COUNT(*)::int AS n
       FROM leads WHERE client_id = $1 GROUP BY 1 ORDER BY n DESC`,
    [clientId]
  );
  const { rows: [m] } = await pool.query(
    `SELECT
       COUNT(DISTINCT l.id) FILTER (WHERE l.created_at >= NOW() - INTERVAL '30 days') AS new_leads_30d,
       COUNT(es.id)         FILTER (WHERE es.sent_at   >= NOW() - INTERVAL '30 days') AS emails_30d,
       COUNT(ce.id) FILTER (WHERE ce.status='paused' AND ce.paused_reason='replied'
                              AND ce.replied_at >= NOW() - INTERVAL '30 days')        AS replies_30d
     FROM clients c
     LEFT JOIN leads l                ON l.client_id = c.id
     LEFT JOIN contact_enrollments ce ON ce.lead_id  = l.id
     LEFT JOIN email_sends es         ON es.lead_id  = l.id
     WHERE c.id = $1`,
    [clientId]
  );
  const segments = Object.fromEntries(seg.map(r => [r.seg, r.n]));
  return {
    segments,
    new_leads_30d: Number(m.new_leads_30d) || 0,
    emails_30d: Number(m.emails_30d) || 0,
    replies_30d: Number(m.replies_30d) || 0,
  };
}

function buildPlanPrompt(input, brandConfig = {}) {
  const brand = brandConfig.name || 'the business';
  const segLine = Object.entries(input.segments).map(([k, v]) => `${k}: ${v}`).join(', ') || 'no segments yet';
  return `You are the campaign planning agent for ${brand}. Using the data below, write a concise
one-month outreach plan for the operator. 4-6 plain sentences (no markdown, no bullet lists).
Recommend which engagement segments to prioritize, 2-3 message themes, and a sensible sending
cadence. Be realistic about the data volume; if it's thin, say so and suggest a lead-building focus.

Contact segments (count): ${segLine}
Last 30 days — new leads: ${input.new_leads_30d}, emails sent: ${input.emails_30d}, replies: ${input.replies_30d}

Write the plan now:`;
}

function fallbackPlan(input) {
  const total = Object.values(input.segments).reduce((a, b) => a + b, 0);
  return `Plan (auto): ${total} contacts across segments ${JSON.stringify(input.segments)}. ` +
    `Last 30 days: ${input.new_leads_30d} new leads, ${input.emails_30d} emails, ${input.replies_30d} replies. ` +
    `Prioritize hot/warm segments with a light 2-3 touch cadence. (AI plan unavailable — showing summary.)`;
}

async function runPlanningForClient(clientId, opts = {}) {
  const { trigger = 'cron', brandConfig = {}, notify = true, now = new Date() } = opts;
  const period = monthKey(now);

  const existing = await pool.query(
    `SELECT 1 FROM agent_plans WHERE client_id = $1 AND period = $2`, [clientId, period]
  );
  if (existing.rows.length) return { skipped: true, reason: 'already_planned', period };

  return runAgent({ clientId, agent: 'planning', trigger }, async ({ llm }) => {
    const input = await gatherInputs(clientId);
    let plan;
    try {
      plan = (await llm(buildPlanPrompt(input, brandConfig), { title: 'Planning Agent' })).trim();
    } catch {
      plan = fallbackPlan(input);
    }

    await pool.query(
      `INSERT INTO agent_plans (client_id, period, plan, detail)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (client_id, period)
       DO UPDATE SET plan = EXCLUDED.plan, detail = EXCLUDED.detail, created_at = NOW()`,
      [clientId, period, plan, JSON.stringify(input)]
    );
    await emit(clientId, 'planning', 'plan.created', { period });

    if (notify) {
      const { sendTelegram } = require('../telegram');
      sendTelegram(`🗓️ <b>${brandConfig.name || 'SalesPilot'} — Monthly Plan</b> (${period})\n${plan}`).catch(() => {});
    }
    return { period, segments: input.segments };
  });
}

module.exports = { runPlanningForClient, monthKey, buildPlanPrompt, fallbackPlan, gatherInputs };
