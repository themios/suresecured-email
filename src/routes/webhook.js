const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { calculateCommission } = require('../lib/commissions');

// Verify the request actually came from Shopify
function verifyShopifyWebhook(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac || !process.env.SHOPIFY_WEBHOOK_SECRET) return false;

  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64');

  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(digest));
}

// Shopify fires this every time an order is placed
router.post('/shopify/order', express.raw({ type: 'application/json' }), async (req, res) => {
  req.rawBody = req.body;

  if (!verifyShopifyWebhook(req)) {
    return res.status(401).send('Unauthorized');
  }

  let order;
  try {
    order = JSON.parse(req.rawBody.toString());
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  try {
    const customerEmail = order.email;
    const orderAmount = parseFloat(order.total_price);
    const shopifyOrderId = String(order.id);

    // Resolve client from Shopify shop domain header
    const shopDomain = req.headers['x-shopify-shop-domain'] || null;
    let clientId = null;
    if (shopDomain) {
      const clientResult = await pool.query(
        `SELECT id FROM clients WHERE integration_settings->>'shopify_domain' = $1 LIMIT 1`,
        [shopDomain]
      );
      if (clientResult.rows.length > 0) {
        clientId = clientResult.rows[0].id;
      } else {
        console.warn(`Webhook: no client matched shop domain "${shopDomain}" — order will be recorded without client_id, commission skipped.`);
      }
    } else {
      console.warn('Webhook: no x-shopify-shop-domain header present — order will be recorded without client_id, commission skipped.');
    }

    // Look for attribution token in order note attributes (written by Shopify snippet via cart.attributes)
    const attrs = order.note_attributes || [];
    const tokenAttr = attrs.find(a => a.name === 'ss_token');
    const spAttr    = attrs.find(a => a.name === 'ss_salesperson') ||
                      attrs.find(a => a.name === 'ss_salesperson_id'); // legacy fallback

    const token = tokenAttr?.value || null;
    const salespersonId = spAttr?.value ? parseInt(spAttr.value) : null;

    // Find lead by email if no token
    let leadId = null;
    if (token) {
      const tkResult = await pool.query(
        'SELECT lead_id FROM tracking_tokens WHERE token = $1',
        [token]
      );
      if (tkResult.rows.length > 0) leadId = tkResult.rows[0].lead_id;
    }

    if (!leadId && customerEmail) {
      const leadResult = await pool.query(
        'SELECT id, salesperson_id FROM leads WHERE email = $1 LIMIT 1',
        [customerEmail]
      );
      if (leadResult.rows.length > 0) {
        leadId = leadResult.rows[0].id;
      }
    }

    // Resolve salesperson from lead if not on token
    let resolvedSalespersonId = salespersonId;
    if (!resolvedSalespersonId && leadId) {
      const leadResult = await pool.query(
        'SELECT salesperson_id FROM leads WHERE id = $1',
        [leadId]
      );
      if (leadResult.rows.length > 0) {
        resolvedSalespersonId = leadResult.rows[0].salesperson_id;
      }
    }

    // Record the order (with client_id for dashboard scoping)
    const orderResult = await pool.query(
      `INSERT INTO orders (shopify_order_id, token, lead_id, salesperson_id, customer_email, amount, order_data, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (shopify_order_id) DO NOTHING
       RETURNING id`,
      [shopifyOrderId, token, leadId, resolvedSalespersonId, customerEmail, orderAmount, order, clientId]
    );

    // Calculate and record tiered commission if we have both salesperson and client
    if (orderResult.rows.length > 0 && resolvedSalespersonId && clientId) {
      const orderId = orderResult.rows[0].id;

      const [spResult, unitsResult] = await Promise.all([
        pool.query(
          `SELECT s.commission_rate, c.commission_rules
           FROM salespeople s JOIN clients c ON c.id = s.client_id
           WHERE s.id = $1`,
          [resolvedSalespersonId]
        ),
        pool.query(
          `SELECT COUNT(*) AS units
           FROM orders
           WHERE salesperson_id = $1 AND client_id = $2
             AND DATE_TRUNC('month', ordered_at) = DATE_TRUNC('month', NOW())
             AND id != $3`,
          [resolvedSalespersonId, clientId, orderId]
        )
      ]);

      const rules = spResult.rows[0]?.commission_rules || {};
      const flatRate = spResult.rows[0]?.commission_rate || 100;
      const unitsBefore = parseInt(unitsResult.rows[0]?.units || 0);

      const { rate, earned, bonusesTriggered } = calculateCommission(orderAmount, unitsBefore, rules, flatRate);

      await pool.query(
        `INSERT INTO commissions
           (salesperson_id, client_id, source_type, source_id, sale_amount, commission_rate, commission_earned)
         VALUES ($1, $2, 'shopify_order', $3, $4, $5, $6)`,
        [resolvedSalespersonId, clientId, orderId, orderAmount, rate, earned]
      );

      for (const bonus of bonusesTriggered) {
        await pool.query(
          `INSERT INTO commissions
             (salesperson_id, client_id, source_type, source_id, sale_amount, commission_rate, commission_earned)
           VALUES ($1, $2, 'bonus', $3, 0, 0, $4)`,
          [resolvedSalespersonId, clientId, orderId, bonus.amount]
        );
      }
    } else if (orderResult.rows.length > 0 && resolvedSalespersonId && !clientId) {
      console.warn(`Webhook: order ${orderResult.rows[0].id} recorded but commission skipped — no client_id resolved.`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Error');
  }
});

module.exports = router;
