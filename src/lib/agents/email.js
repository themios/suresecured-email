/**
 * Email agent — drafts personalized follow-up emails for the operator to
 * approve. This is the first agent that can cause a send, so it is strictly
 * gated: the agent ONLY writes drafts to agent_proposals (status 'pending').
 * Nothing is ever sent without a human approving it, and the approval path
 * re-checks suppression + unsubscribe before sending.
 *
 * Targets engaged, non-suppressed, non-unsubscribed leads in configured
 * segments, capped per run to keep cost and review load bounded.
 */
const { pool } = require('../../db');
const { runAgent } = require('./runner');
const { emit } = require('./eventBus');
const { sendDirectEmail } = require('../gmail');

const DEFAULT_MAX_DRAFTS = 5;
const DEFAULT_SEGMENTS = ['hot', 'warm'];

function buildDraftPrompt(lead, brandConfig = {}) {
  const brand = brandConfig.name || 'our company';
  const site = brandConfig.website ? ` (${brandConfig.website})` : '';
  return `You are an email copywriter for ${brand}. Write a short, friendly follow-up email to a
prospect who has shown some engagement but hasn't replied yet. Two short paragraphs max, plain
text (no markdown). Warm and helpful, never pushy. End with one light call to action.

Prospect first name: ${lead.first_name || 'there'}
${lead.product_interest ? `Interested in: ${lead.product_interest}` : ''}
Engagement tier: ${lead.segment || 'unknown'}
Company: ${brand}${site}

Respond as strict JSON only, no code fences:
{"subject":"<=80 chars","body":"the email body"}`;
}

/** Leads eligible for a fresh draft: engaged, contactable, not already queued. */
async function candidateLeads(clientId, config = {}) {
  const max = Number.isFinite(Number(config.max_drafts)) ? Number(config.max_drafts) : DEFAULT_MAX_DRAFTS;
  const segments = Array.isArray(config.segments) && config.segments.length ? config.segments : DEFAULT_SEGMENTS;
  const { rows } = await pool.query(
    `SELECT l.id, l.email, l.first_name, l.last_name, l.product_interest, l.segment, l.engagement_score
       FROM leads l
      WHERE l.client_id = $1
        AND l.segment = ANY($2)
        AND l.email IS NOT NULL
        AND COALESCE(l.unsubscribed, false) = false
        AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE LOWER(s.email) = LOWER(l.email))
        AND NOT EXISTS (
          SELECT 1 FROM agent_proposals p
           WHERE p.client_id = $1 AND p.agent = 'email' AND p.kind = 'email_draft'
             AND p.status = 'pending' AND (p.payload->>'lead_id')::int = l.id)
      ORDER BY l.engagement_score DESC NULLS LAST
      LIMIT $3`,
    [clientId, segments, max]
  );
  return rows;
}

/** Draft follow-ups for one tenant → pending proposals. Never sends. */
async function runEmailForClient(clientId, opts = {}) {
  const { trigger = 'cron', config = {}, brandConfig = {} } = opts;
  return runAgent({ clientId, agent: 'email', trigger }, async ({ llm }) => {
    const leads = await candidateLeads(clientId, config);
    let drafted = 0;
    for (const lead of leads) {
      let draft;
      try {
        const raw = await llm(buildDraftPrompt(lead, brandConfig), { title: 'Email Agent' });
        draft = JSON.parse(raw.replace(/```[a-z]*\n?/gi, '').trim());
      } catch {
        continue; // skip a lead whose draft failed to generate/parse
      }
      if (!draft || !draft.subject || !draft.body) continue;
      await pool.query(
        `INSERT INTO agent_proposals (client_id, agent, kind, title, summary, payload, status)
         VALUES ($1, 'email', 'email_draft', $2, $3, $4::jsonb, 'pending')`,
        [clientId, String(draft.subject).slice(0, 200), String(draft.body).slice(0, 240),
         JSON.stringify({ lead_id: lead.id, to: lead.email, subject: draft.subject, body: draft.body })]
      );
      drafted++;
    }
    if (drafted > 0) await emit(clientId, 'email', 'email.drafted', { drafted });
    return { candidates: leads.length, drafted };
  });
}

/** Resolve a sending salesperson (Gmail-connected) for a tenant, if any. */
async function resolveSender(clientId) {
  const { rows } = await pool.query(
    `SELECT s.id AS salesperson_id
       FROM salespeople s
       JOIN email_accounts ea ON ea.salesperson_id = s.id AND ea.enabled = true
      WHERE s.client_id = $1 AND s.active = true
      ORDER BY s.id LIMIT 1`,
    [clientId]
  );
  return rows[0]?.salesperson_id || null;
}

/**
 * Send an approved draft. Called only from the human approval route.
 * Re-checks suppression + unsubscribe at send time (defense in depth), sends via
 * the existing provider path, marks the proposal applied, and logs the send.
 * @param {number} proposalId
 * @param {number} clientId
 * @param {string} decidedBy
 * @param {Function} [sender] injectable send fn for testing (defaults to sendDirectEmail)
 */
async function sendApprovedDraft(proposalId, clientId, decidedBy, sender = sendDirectEmail) {
  const { rows } = await pool.query(
    `SELECT * FROM agent_proposals
      WHERE id = $1 AND client_id = $2 AND kind = 'email_draft' AND status = 'pending'`,
    [proposalId, clientId]
  );
  const p = rows[0];
  if (!p) return { ok: false, error: 'not_found_or_already_decided' };
  const payload = p.payload || {};

  // Guard: never send to a suppressed or unsubscribed address.
  const { rows: blocked } = await pool.query(
    `SELECT 1 FROM suppression_list WHERE LOWER(email) = LOWER($1)
     UNION ALL
     SELECT 1 FROM leads WHERE id = $2 AND unsubscribed = true`,
    [payload.to, payload.lead_id]
  );
  if (blocked.length) {
    await pool.query(
      `UPDATE agent_proposals SET status = 'dismissed', decided_at = NOW(), decided_by = $2 WHERE id = $1`,
      [proposalId, decidedBy]
    );
    return { ok: false, error: 'suppressed_or_unsubscribed' };
  }

  const { rows: cr } = await pool.query(`SELECT brand_config FROM clients WHERE id = $1`, [clientId]);
  const brandConfig = cr[0]?.brand_config || {};
  const salespersonId = await resolveSender(clientId);

  const htmlBody = `<div style="font-family:sans-serif;font-size:15px;line-height:1.6;color:#222">${
    String(payload.body).replace(/\n/g, '<br>')}</div>`;

  let result;
  try {
    result = await sender({
      fromName:    brandConfig.name || process.env.SES_FROM_NAME || 'Sales',
      fromAddress: brandConfig.from_email || process.env.SES_FROM_EMAIL || process.env.SES_SMTP_USER,
      to:          payload.to,
      subject:     payload.subject,
      textBody:    payload.body,
      htmlBody,
      salespersonId,
      clientId,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  await pool.query(
    `UPDATE agent_proposals SET status = 'applied', decided_at = NOW(), decided_by = $2 WHERE id = $1`,
    [proposalId, decidedBy]
  );
  await emit(clientId, 'email', 'email.sent', { lead_id: payload.lead_id, via: result?.via });

  if (result?.threadId) {
    await pool.query(
      `UPDATE leads SET direct_email_thread_id = $1, direct_email_salesperson_id = $2 WHERE id = $3`,
      [result.threadId, salespersonId, payload.lead_id]
    ).catch(() => {});
  }
  await pool.query(
    `INSERT INTO lead_notes (lead_id, client_id, author_name, content) VALUES ($1, $2, 'Email Agent', $3)`,
    [payload.lead_id, clientId, `[Agent email — approved by ${decidedBy}] ${payload.subject}\n\n${payload.body}`]
  ).catch(() => {});

  return { ok: true, via: result?.via };
}

/** Reject a pending draft (no send). */
async function rejectDraft(proposalId, clientId, decidedBy) {
  const { rowCount } = await pool.query(
    `UPDATE agent_proposals SET status = 'rejected', decided_at = NOW(), decided_by = $2
      WHERE id = $1 AND client_id = $3 AND status = 'pending'`,
    [proposalId, decidedBy, clientId]
  );
  return { ok: rowCount > 0 };
}

module.exports = {
  runEmailForClient, sendApprovedDraft, rejectDraft, buildDraftPrompt, candidateLeads, resolveSender,
};
