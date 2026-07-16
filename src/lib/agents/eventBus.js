/**
 * Agent event bus — the shared spine that lets agents talk to each other.
 * Backed by the `agent_events` table. Strictly tenant-scoped: every call takes
 * a clientId and never reads across tenants.
 *
 * Producers call emit(). Consumers call poll() for unhandled events of the
 * types they care about, process them, then markHandled().
 */
const { pool } = require('../../db');

/**
 * Emit an event onto the bus for a tenant.
 * @returns {Promise<number>} the new event id
 */
async function emit(clientId, agent, type, payload = {}) {
  const { rows } = await pool.query(
    `INSERT INTO agent_events (client_id, agent, type, payload)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [clientId, agent, type, JSON.stringify(payload || {})]
  );
  return rows[0].id;
}

/**
 * Poll unhandled events for a tenant, optionally filtered by type(s).
 * @param {number} clientId
 * @param {{ types?: string[], limit?: number }} opts
 */
async function poll(clientId, { types = null, limit = 200 } = {}) {
  const params = [clientId, limit];
  let typeFilter = '';
  if (types && types.length) {
    params.push(types);
    typeFilter = `AND type = ANY($3)`;
  }
  const { rows } = await pool.query(
    `SELECT id, agent, type, payload, created_at
       FROM agent_events
      WHERE client_id = $1 AND status = 'new' ${typeFilter}
      ORDER BY created_at
      LIMIT $2`,
    params
  );
  return rows;
}

/** Mark a set of events handled. No-op on empty input. */
async function markHandled(ids) {
  if (!ids || !ids.length) return 0;
  const { rowCount } = await pool.query(
    `UPDATE agent_events SET status = 'handled', handled_at = NOW()
      WHERE id = ANY($1) AND status = 'new'`,
    [ids]
  );
  return rowCount;
}

/**
 * Aggregate recent event activity for a tenant (used by the Reporting agent).
 * @returns rows of { agent, type, n }
 */
async function activitySummary(clientId, sinceInterval = '7 days') {
  const { rows } = await pool.query(
    `SELECT agent, type, COUNT(*)::int AS n
       FROM agent_events
      WHERE client_id = $1 AND created_at >= NOW() - $2::interval
      GROUP BY agent, type
      ORDER BY n DESC`,
    [clientId, sinceInterval]
  );
  return rows;
}

module.exports = { emit, poll, markHandled, activitySummary };
