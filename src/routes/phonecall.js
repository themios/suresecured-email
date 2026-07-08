const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { verifyCallRailWebhook } = require('../lib/webhookVerify');
const { setFirstTouchAttribution } = require('../lib/attribution');

// CallRail fires this webhook every time a tracked call comes in.
router.post('/', async (req, res) => {
  if (!verifyCallRailWebhook(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const {
    tracking_phone_number,  // The unique number in the salesperson's signature
    caller_number,          // The lead's phone number
    duration_seconds,
    duration,               // CallRail sometimes sends this instead
    recording_url,
    id: callrail_id,        // CallRail's unique call ID
    start_time,
  } = req.body;

  try {
    const trackingNum = tracking_phone_number || req.body.tracking_number;
    const callDuration = duration_seconds || duration || 0;

    // Match tracking number to a salesperson
    let salespersonId = null;
    if (trackingNum) {
      const spResult = await pool.query(
        'SELECT id FROM salespeople WHERE tracking_phone_number = $1 AND active = true',
        [trackingNum]
      );
      if (spResult.rows.length > 0) salespersonId = spResult.rows[0].id;
    }

    // Try to match caller to an existing lead by phone number
    let leadId = null;
    if (caller_number) {
      const cleanCaller = caller_number.replace(/\D/g, '');
      const leadResult = await pool.query(
        `SELECT id FROM leads WHERE regexp_replace(phone, '[^0-9]', '', 'g') = $1 LIMIT 1`,
        [cleanCaller]
      );
      if (leadResult.rows.length > 0) leadId = leadResult.rows[0].id;
    }

    // Record the call
    await pool.query(
      `INSERT INTO phone_calls
         (salesperson_id, lead_id, tracking_number, caller_number, duration_seconds, recording_url, callrail_id, called_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (callrail_id) DO NOTHING`,
      [
        salespersonId,
        leadId,
        trackingNum,
        caller_number,
        callDuration,
        recording_url || null,
        callrail_id || null,
        start_time ? new Date(start_time) : new Date(),
      ]
    );

    if (leadId && salespersonId) {
      await setFirstTouchAttribution({
        leadId,
        salespersonId,
        source: 'callrail_call',
      });
    }

    res.status(200).json({ ok: true, salesperson_id: salespersonId, lead_id: leadId });
  } catch (err) {
    console.error('Phone call webhook error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
