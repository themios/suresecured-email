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

/**
 * Normalize a phone number to its last 10 digits so that stored values like
 * "8185551234" match order values like "+18185551234" (leading country code).
 */
function normalizePhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Validate that a salesperson id is real, active, and (when clientId is known)
 * belongs to that client. Returns the id when valid, otherwise null.
 * Used to prevent commission theft via forged `ss_salesperson` cart attributes.
 */
async function validateSalesperson(id, clientId, db = pool) {
  const parsed = parseInt(id, 10);
  if (Number.isNaN(parsed)) return null;
  const { rows } = await db.query(
    `SELECT id FROM salespeople
     WHERE id = $1 AND active = true
       AND ($2::int IS NULL OR client_id = $2)`,
    [parsed, clientId || null]
  );
  return rows[0] ? parsed : null;
}

/**
 * Resolve commission salesperson for a Shopify order.
 * Returns { salespersonId, path, status } where status is 'credited' | 'pending_review'.
 *
 * Resolution policy (first-touch wins, tamper-proof signals first):
 *   1. Server-issued tracking token on the order (authoritative — not user-editable)
 *   2. Lead first-touch owner (attributed_salesperson_id) by email/phone
 *   3. Recent inbound voice call by phone (voice first-touch)
 *   4. Cart `ss_salesperson` — a client-side URL-derived HINT only, used to fill
 *      the gap and ONLY after validating the salesperson is active + in-tenant
 *   5. NULL → pending_review (never guess a rep)
 */
async function resolveSalespersonForOrder({
  token,
  cartSalespersonId,
  customerEmail,
  customerPhone,
  clientId,
}, db = pool) {
  // 1. Tracking token on order (server-issued, cannot be forged by the buyer)
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
                 FROM leads WHERE RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1`;
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
        WHERE RIGHT(regexp_replace(cl.from_number, '[^0-9]', '', 'g'), 10) = $1
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

  // 6. Cart ss_salesperson HINT — only used to fill a gap, and only after
  //    validating the salesperson is active and belongs to this tenant.
  //    This value originates from a URL parameter, so it is never authoritative.
  if (cartSalespersonId) {
    const validId = await validateSalesperson(cartSalespersonId, clientId, db);
    if (validId) {
      return {
        salespersonId: validId,
        path: `cart:ss_salesperson:validated:${validId}`,
        status: 'credited',
        leadId: lead?.id || null,
      };
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
  validateSalesperson,
};
