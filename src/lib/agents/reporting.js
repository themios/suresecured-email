/**
 * Reporting agent — the cross-agent weekly rollup.
 *
 * Unlike the existing /cron/daily-digest (which summarizes raw email ops daily),
 * this agent's distinct job is to read what the OTHER agents did via the event
 * bus + run log, combine that with 7-day business metrics, and produce one
 * unified "what's working / what needs attention" summary per tenant per week.
 *
 * Read-only: it never sends outreach or spends on the tenant's behalf. Output
 * lands in `agent_reports` (dashboard) and Telegram.
 */
const { pool } = require('../../db');
const { runAgent } = require('./runner');
const { emit, activitySummary } = require('./eventBus');
const { sendTelegram } = require('../telegram');

/** ISO-8601 week key like "2026-W29" — stable idempotency key per tenant/week. */
function isoWeekKey(d = new Date()) {
  // Use UTC components throughout so the key is independent of server timezone.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 7-day business metrics for a tenant, scoped through leads.client_id. */
async function gatherMetrics(clientId) {
  const { rows: [m] } = await pool.query(
    `SELECT
       COUNT(DISTINCT l.id) FILTER (WHERE l.created_at >= NOW() - INTERVAL '7 days')  AS new_leads,
       COUNT(es.id)         FILTER (WHERE es.sent_at   >= NOW() - INTERVAL '7 days')  AS emails_sent,
       COUNT(es.id)         FILTER (WHERE es.bounced = true AND es.sent_at >= NOW() - INTERVAL '7 days') AS bounces,
       COUNT(ce.id) FILTER (
         WHERE ce.status = 'paused' AND ce.paused_reason = 'replied'
           AND ce.replied_at >= NOW() - INTERVAL '7 days')                            AS replies
     FROM clients c
     LEFT JOIN leads l                ON l.client_id = c.id
     LEFT JOIN contact_enrollments ce ON ce.lead_id  = l.id
     LEFT JOIN email_sends es         ON es.lead_id  = l.id
     WHERE c.id = $1`,
    [clientId]
  );
  const emails = Number(m.emails_sent) || 0;
  const replies = Number(m.replies) || 0;
  return {
    new_leads: Number(m.new_leads) || 0,
    emails_sent: emails,
    bounces: Number(m.bounces) || 0,
    replies,
    reply_rate_pct: emails ? Math.round((replies / emails) * 1000) / 10 : 0,
  };
}

/** Per-agent run stats for the week (runs, cost, errors). */
async function gatherRunStats(clientId) {
  const { rows } = await pool.query(
    `SELECT agent,
            COUNT(*)::int AS runs,
            ROUND(SUM(cost_usd)::numeric, 4) AS cost_usd,
            COUNT(*) FILTER (WHERE status = 'error')::int AS errors
       FROM agent_runs
      WHERE client_id = $1 AND started_at >= NOW() - INTERVAL '7 days'
      GROUP BY agent
      ORDER BY runs DESC`,
    [clientId]
  );
  return rows;
}

async function pendingProposalCount(clientId) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM agent_proposals WHERE client_id = $1 AND status = 'pending'`,
    [clientId]
  );
  return r.n;
}

function buildPrompt({ metrics, activity, runStats, pending }, brandConfig = {}) {
  const brand = brandConfig.name || 'the business';
  const activityLine = activity.length
    ? activity.map(a => `${a.agent}:${a.type}×${a.n}`).join(', ')
    : 'no agent activity yet';
  const runLine = runStats.length
    ? runStats.map(r => `${r.agent} ${r.runs} runs${r.errors ? `, ${r.errors} errors` : ''}`).join('; ')
    : 'no agent runs yet';
  return `You are the reporting agent for ${brand}'s AI marketing system. Write a concise weekly
summary (3-5 plain sentences, no markdown, no bullet lists) for the operator. Say what is working,
what needs attention, and call out the single most important next action. If there is little data,
say so plainly rather than inventing detail.

7-day business metrics:
- New leads: ${metrics.new_leads}
- Emails sent: ${metrics.emails_sent}
- Replies: ${metrics.replies} (${metrics.reply_rate_pct}% reply rate)
- Bounces: ${metrics.bounces}

Agent activity this week: ${activityLine}
Agent runs this week: ${runLine}
Proposals awaiting your approval: ${pending}

Write the summary now:`;
}

function fallbackSummary({ metrics, pending }) {
  return `This week: ${metrics.new_leads} new leads, ${metrics.emails_sent} emails sent, ` +
    `${metrics.replies} replies (${metrics.reply_rate_pct}% reply rate), ${metrics.bounces} bounces. ` +
    `${pending} proposal(s) await your approval. (AI summary unavailable — showing raw metrics.)`;
}

/**
 * Run the reporting agent for one tenant. Idempotent per ISO week.
 * @param {number} clientId
 * @param {{trigger?:string, brandConfig?:object, notify?:boolean, now?:Date}} opts
 */
async function runReportingForClient(clientId, opts = {}) {
  const { trigger = 'cron', brandConfig = {}, notify = true, now = new Date() } = opts;
  const period = isoWeekKey(now);

  // Idempotency: one report per tenant per week.
  const existing = await pool.query(
    `SELECT 1 FROM agent_reports WHERE client_id = $1 AND period = $2`,
    [clientId, period]
  );
  if (existing.rows.length) return { skipped: true, reason: 'already_reported', period };

  return runAgent({ clientId, agent: 'reporting', trigger }, async ({ llm }) => {
    const [metrics, activity, runStats, pending] = await Promise.all([
      gatherMetrics(clientId),
      activitySummary(clientId, '7 days'),
      gatherRunStats(clientId),
      pendingProposalCount(clientId),
    ]);

    const input = { metrics, activity, runStats, pending };
    let summary;
    try {
      summary = (await llm(buildPrompt(input, brandConfig), { title: 'Reporting Agent' })).trim();
    } catch (err) {
      summary = fallbackSummary(input);
    }

    await pool.query(
      `INSERT INTO agent_reports (client_id, period, summary, metrics)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (client_id, period)
       DO UPDATE SET summary = EXCLUDED.summary, metrics = EXCLUDED.metrics, created_at = NOW()`,
      [clientId, period, summary, JSON.stringify(input)]
    );

    await emit(clientId, 'reporting', 'report.created', { period });

    if (notify) {
      const brand = brandConfig.name || 'SalesPilot';
      sendTelegram(`📊 <b>${brand} — Weekly Agent Report</b> (${period})\n${summary}`).catch(() => {});
    }

    return { period, new_leads: metrics.new_leads, emails_sent: metrics.emails_sent, pending };
  });
}

module.exports = { runReportingForClient, isoWeekKey, buildPrompt, fallbackSummary };
