/**
 * Default lead ownership.
 *
 * An unowned lead is an unworked lead: enrollment requires a salesperson (the
 * sequence sends *as* that person), so a lead with no owner is silently never
 * followed up. That is exactly how five inbound dealer enquiries sat untouched
 * for three weeks -- they arrived with no tracking token, so nothing assigned
 * them, so nothing enrolled them.
 *
 * Resolved per tenant rather than hardcoded, so it stays correct as reps are
 * added and for every other tenant on the platform.
 */

/**
 * The tenant's fallback owner: their lowest-id active salesperson. For a
 * single-rep tenant this is simply that rep.
 * @returns {Promise<number|null>} null only when the tenant has no active rep.
 */
async function defaultSalespersonId(pool, clientId) {
  if (!clientId) return null;
  const { rows } = await pool.query(
    `SELECT id FROM salespeople
      WHERE client_id = $1 AND active = true
      ORDER BY id LIMIT 1`,
    [clientId]
  );
  return rows[0]?.id || null;
}

/** Prefer an explicit assignment (e.g. from a tracking token); else the default. */
async function resolveOwner(pool, clientId, explicitSalespersonId) {
  return explicitSalespersonId || await defaultSalespersonId(pool, clientId);
}

module.exports = { defaultSalespersonId, resolveOwner };
