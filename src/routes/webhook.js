const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');

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

    // Look for attribution token in order note attributes
    const attrs = order.note_attributes || [];
    const tokenAttr = attrs.find(a => a.name === 'ss_token');
    const spAttr = attrs.find(a => a.name === 'ss_salesperson_id');

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

    // Record the order
    const orderResult = await pool.query(
      `INSERT INTO orders (shopify_order_id, token, lead_id, salesperson_id, customer_email, amount, order_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (shopify_order_id) DO NOTHING
       RETURNING id`,
      [shopifyOrderId, token, leadId, resolvedSalespersonId, customerEmail, orderAmount, order]
    );

    // Record commission if we have a salesperson
    if (orderResult.rows.length > 0 && resolvedSalespersonId) {
      const orderId = orderResult.rows[0].id;

      const spResult = await pool.query(
        'SELECT commission_rate FROM salespeople WHERE id = $1',
        [resolvedSalespersonId]
      );

      const rate = spResult.rows[0]?.commission_rate || 100;
      const earned = (orderAmount * rate) / 100;

      await pool.query(
        `INSERT INTO commissions (salesperson_id, source_type, source_id, sale_amount, commission_rate, commission_earned)
         VALUES ($1, 'shopify_order', $2, $3, $4, $5)`,
        [resolvedSalespersonId, orderId, orderAmount, rate, earned]
      );
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Error');
  }
});

module.exports = router;
