/**
 * Agent scheduler — the cron entrypoint that fans out over tenants.
 *
 * Iterates every tenant that has a given agent enabled and runs it. Each tenant
 * runs independently: one tenant's failure never aborts the batch. This is the
 * multi-tenant "fan-out" the plan calls for — cron fires once, we dispatch per
 * enabled tenant.
 *
 * Phase 07 wires the Reporting agent. Later phases register their agents in
 * AGENT_DISPATCH below.
 */
const { enabledClientsForAgent } = require('./runner');
const { runReportingForClient } = require('./reporting');
const { runSegmentationForClient } = require('./segmentation');
const { runEmailForClient } = require('./email');

// Map of agent name -> per-tenant runner. Each runner: (client, ctx) => Promise
const AGENT_DISPATCH = {
  segmentation: (client, ctx) =>
    runSegmentationForClient(client.client_id, { ...ctx, config: client.config || {} }),
  email: (client, ctx) =>
    runEmailForClient(client.client_id, { ...ctx, config: client.config || {}, brandConfig: client.brand_config || {} }),
  reporting: (client, ctx) =>
    runReportingForClient(client.client_id, { ...ctx, brandConfig: client.brand_config || {} }),
};

/**
 * Run one agent across all tenants that have it enabled.
 * @param {string} agent
 * @param {{trigger?:string}} ctx
 * @returns {Promise<{agent:string, tenants:number, ok:number, skipped:number, errors:number, cost_usd:number, details:Array}>}
 */
async function runAgentForAllTenants(agent, ctx = {}) {
  const runner = AGENT_DISPATCH[agent];
  if (!runner) throw new Error(`unknown agent: ${agent}`);

  const clients = await enabledClientsForAgent(agent);
  const result = { agent, tenants: clients.length, ok: 0, skipped: 0, errors: 0, cost_usd: 0, details: [] };

  for (const client of clients) {
    try {
      const r = await runner(client, { trigger: ctx.trigger || 'cron' });
      if (r?.skipped) result.skipped++;
      else if (r?.ok === false) result.errors++;
      else result.ok++;
      if (r?.cost_usd) result.cost_usd += Number(r.cost_usd);
      result.details.push({ client_id: client.client_id, ...summarize(r) });
    } catch (err) {
      result.errors++;
      result.details.push({ client_id: client.client_id, error: err.message });
    }
  }
  result.cost_usd = Math.round(result.cost_usd * 100000) / 100000;
  return result;
}

function summarize(r) {
  if (!r) return { status: 'noop' };
  if (r.skipped) return { status: 'skipped', reason: r.reason };
  if (r.ok === false) return { status: 'error', error: r.error };
  return { status: 'ok', ...(r.detail || {}) };
}

/**
 * Cron tick: run all scheduled agents across all tenants.
 * Phase 07: reporting only. Add agents here as later phases land.
 */
async function runDueAgents(ctx = {}) {
  const results = [];
  // Order matters: segmentation first (labels leads), then email (drafts by
  // segment), then reporting so the weekly rollup sees both agents' events.
  for (const agent of ['segmentation', 'email', 'reporting']) {
    results.push(await runAgentForAllTenants(agent, ctx));
  }
  return results;
}

module.exports = { runAgentForAllTenants, runDueAgents, AGENT_DISPATCH };
