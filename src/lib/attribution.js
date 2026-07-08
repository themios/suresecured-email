const { pool } = require('../db');

/**
 * First-touch wins unless attribution_locked.
 */
async function setFirstTouchAttribution({ leadId, salespersonId, source, clientId }, db = pool) {
  if (!leadId || !salespersonId || !source) return false;

  const { rowCount } = await db.query(
    `UPDATE leads SET
       attributed_salesperson_id = COALESCE(attributed_salesperson_id, $1),
       attributed_at = COALESCE(attributed_at, NOW()),
       attribution_source = COALESCE(attribution_source, $2),
       salesperson_id = COALESCE(salesperson_id, $1)
     WHERE id = $3
       AND (attribution_locked IS NOT TRUE)
       AND attributed_salesperson_id IS NULL
       ${clientId ? 'AND (client_id = $4 OR client_id IS NULL)' : ''}`,
    clientId ? [salespersonId, source, leadId, clientId] : [salespersonId, source, leadId]
  );

  return rowCount > 0;
}

function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '') || null;
}

/**
 * Resolve commission salesperson for a Shopify order.
 * Returns { salespersonId, path, status } where status is 'credited' | 'pending_review'.
 */
async function resolveSalespersonForOrder({
  token,
  cartSalespersonId,
  customerEmail,
  customerPhone,
  clientId,
}, db = pool) {
  // 1. Cart / note_attributes salesperson
  if (cartSalespersonId) {
    const id = parseInt(cartSalespersonId, 10);
    if (!Number.isNaN(id)) {
      return { salespersonId: id, path: `cart:ss_salesperson:${id}`, status: 'credited' };
    }
  }

  // 2. Tracking token on order
  if (token) {
    const { rows } = await db.query(
      `SELECT lead_id, salesperson_id FROM tracking_tokens WHERE token = $1`,
      [token]
    );
    if (rows[0]?.salesperson_id) {
      return {
        salespersonId: rows[0].salesperson_id,
        path: `token:${token}`,
        status: 'credited',
        leadId: rows[0].lead_id,
      };
    }
  }

  // 3. Lead by email (client-scoped)
  let lead = null;
  if (customerEmail) {
    const params = [customerEmail.toLowerCase()];
    let sql = `SELECT id, attributed_salesperson_id, salesperson_id, client_id
               FROM leads WHERE LOWER(email) = $1`;
    if (clientId) {
      sql += ` AND (client_id = $2 OR client_id IS NULL)`;
      params.push(clientId);
    }
    sql += ' ORDER BY client_id NULLS LAST LIMIT 1';
    const { rows } = await db.query(sql, params);
    lead = rows[0] || null;
  }

  // 4. Lead by phone if no email match
  if (!lead && customerPhone) {
    const digits = normalizePhone(customerPhone);
    if (digits) {
      const params = [digits];
      let sql = `SELECT id, attributed_salesperson_id, salesperson_id, client_id
                 FROM leads WHERE regexp_replace(phone, '[^0-9]', '', 'g') = $1`;
      if (clientId) {
        sql += ` AND (client_id = $2 OR client_id IS NULL)`;
        params.push(clientId);
      }
      sql += ' ORDER BY client_id NULLS LAST LIMIT 1';
      const { rows } = await db.query(sql, params);
      lead = rows[0] || null;
    }
  }

  if (lead) {
    const spId = lead.attributed_salesperson_id || lead.salesperson_id;
    if (spId) {
      const src = lead.attributed_salesperson_id ? 'lead:attributed' : 'lead:salesperson_id';
      return { salespersonId: spId, path: `${src}:${lead.id}`, status: 'credited', leadId: lead.id };
    }
  }

  // 5. Recent inbound voice call by phone
  if (customerPhone) {
    const digits = normalizePhone(customerPhone);
    if (digits) {
      const params = [digits];
      let sql = `
        SELECT cl.salesperson_id, cl.lead_id
        FROM call_logs cl
        WHERE regexp_replace(cl.from_number, '[^0-9]', '', 'g') = $1
          AND cl.call_started_at >= NOW() - INTERVAL '90 days'
          AND cl.salesperson_id IS NOT NULL`;
      if (clientId) {
        sql += ` AND cl.client_id = $2`;
        params.push(clientId);
      }
      sql += ` ORDER BY cl.call_started_at DESC LIMIT 1`;
      const { rows } = await db.query(sql, params);
      if (rows[0]?.salesperson_id) {
        return {
          salespersonId: rows[0].salesperson_id,
          path: `call_logs:phone:${digits}`,
          status: 'credited',
          leadId: rows[0].lead_id,
        };
      }
    }
  }

  return { salespersonId: null, path: 'unresolved', status: 'pending_review', leadId: lead?.id || null };
}

async function logCommissionEvent({
  orderId, salespersonId, clientId, resolutionPath, saleAmount, commissionEarned,
}, db = pool) {
  await db.query(
    `INSERT INTO commission_events
       (order_id, salesperson_id, client_id, resolution_path, sale_amount, commission_earned)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [orderId, salespersonId, clientId, resolutionPath, saleAmount, commissionEarned ?? null]
  );
}

module.exports = {
  setFirstTouchAttribution,
  resolveSalespersonForOrder,
  logCommissionEvent,
  normalizePhone,
};
