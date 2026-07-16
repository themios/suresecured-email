/**
 * Agent runner — the shared execution wrapper every agent uses.
 *
 * Responsibilities:
 *  - resolve which tenants have a given agent enabled (opt-in, disabled by default)
 *  - open an `agent_runs` row, run the agent's work function, and record
 *    status + token/cost accounting + a detail blob
 *  - provide an `llm()` helper that calls OpenRouter and accumulates usage/cost
 *    onto the current run automatically
 *
 * Agents stay thin: they receive { llm } and return a small detail object.
 */
const { pool } = require('../../db');
const { callOpenRouterRaw } = require('../openrouter');
const { estimateCost } = require('./costs');

/** Is `agent` enabled for this tenant? Defaults false when no row exists. */
async function isAgentEnabled(clientId, agent) {
  const { rows } = await pool.query(
    `SELECT enabled FROM client_agent_settings WHERE client_id = $1 AND agent = $2`,
    [clientId, agent]
  );
  return rows[0]?.enabled === true;
}

/**
 * All active tenants with `agent` enabled, with their brand + per-agent config.
 * This is the fan-out list the cron scheduler iterates.
 */
async function enabledClientsForAgent(agent) {
  const { rows } = await pool.query(
    `SELECT c.id AS client_id, c.brand_config, cas.config
       FROM client_agent_settings cas
       JOIN clients c ON c.id = cas.client_id
      WHERE cas.agent = $1 AND cas.enabled = true AND c.active = true
      ORDER BY c.id`,
    [agent]
  );
  return rows;
}

/**
 * Upsert a tenant's setting for an agent (used by the settings UI/API).
 */
async function setAgentEnabled(clientId, agent, enabled, config = null) {
  const { rows } = await pool.query(
    `INSERT INTO client_agent_settings (client_id, agent, enabled, config)
     VALUES ($1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb))
     ON CONFLICT (client_id, agent)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                   config = COALESCE($4::jsonb, client_agent_settings.config),
                   updated_at = NOW()
     RETURNING id, enabled`,
    [clientId, agent, enabled, config ? JSON.stringify(config) : null]
  );
  return rows[0];
}

/**
 * Run a unit of agent work with full run-logging + cost accounting.
 *
 * @param {{clientId:number, agent:string, trigger?:string}} ctx
 * @param {(tools:{llm:Function, runId:number}) => Promise<object>} fn
 * @returns {Promise<{ok:boolean, runId:number, cost_usd:number, detail?:object, error?:string}>}
 */
async function runAgent({ clientId, agent, trigger = 'cron' }, fn) {
  const { rows } = await pool.query(
    `INSERT INTO agent_runs (client_id, agent, trigger, status)
     VALUES ($1, $2, $3, 'running') RETURNING id`,
    [clientId, agent, trigger]
  );
  const runId = rows[0].id;
  const usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };

  // llm helper: every call is metered onto this run.
  const llm = async (prompt, opts = {}) => {
    const { content, usage: u, model } = await callOpenRouterRaw(prompt, opts);
    usage.tokens_in += u?.prompt_tokens || 0;
    usage.tokens_out += u?.completion_tokens || 0;
    usage.cost_usd += estimateCost(model, u);
    return content;
  };

  try {
    const detail = (await fn({ llm, runId })) || {};
    await pool.query(
      `UPDATE agent_runs
          SET status = 'ok', tokens_in = $2, tokens_out = $3, cost_usd = $4,
              detail = $5::jsonb, finished_at = NOW()
        WHERE id = $1`,
      [runId, usage.tokens_in, usage.tokens_out, usage.cost_usd.toFixed(5), JSON.stringify(detail)]
    );
    return { ok: true, runId, ...usage, detail };
  } catch (err) {
    await pool.query(
      `UPDATE agent_runs
          SET status = 'error', tokens_in = $2, tokens_out = $3, cost_usd = $4,
              error = $5, finished_at = NOW()
        WHERE id = $1`,
      [runId, usage.tokens_in, usage.tokens_out, usage.cost_usd.toFixed(5),
       String(err && err.message ? err.message : err).slice(0, 500)]
    );
    return { ok: false, runId, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  isAgentEnabled,
  enabledClientsForAgent,
  setAgentEnabled,
  runAgent,
};
