// src/routes/retell.js
// Mounted at /retell-hooks — MUST be after express.json() in index.js
const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const { setFirstTouchAttribution } = require('../lib/attribution');
const { verifyRetellWebhook } = require('../lib/webhookVerify');

function retellAuth(req, res, next) {
  if (!verifyRetellWebhook(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * POST /retell-hooks/inbound
 * Retell calls this before connecting the call.
 * Respond with override_agent_id to route to the correct client's agent.
 * Payload: { event: "call_inbound", call: { to_number, from_number, call_id, ... } }
 */
router.post('/inbound', retellAuth, async (req, res) => {
  try {
    const call       = req.body?.call || {};
    const toNumber   = call.to_number;

    const { rows } = await pool.query(
      `SELECT retell_agent_id FROM clients
       WHERE telnyx_phone_number = $1 AND active = true
       LIMIT 1`,
      [toNumber]
    );

    if (!rows[0]?.retell_agent_id) {
      // No client found or agent not yet provisioned — Retell uses default agent
      console.warn(`[retell/inbound] no agent for to_number=${toNumber}`);
      return res.status(200).json({ call_inbound: {} });
    }

    return res.status(200).json({
      call_inbound: { override_agent_id: rows[0].retell_agent_id },
    });
  } catch (err) {
    console.error('[retell/inbound] error:', err.message);
    return res.status(200).json({ call_inbound: {} }); // never 500 — Retell must get a response
  }
});

/**
 * POST /retell-hooks/call-ended
 * Retell sends this after the call ends (registered as agent webhook_url).
 * Payload: { event: "call_ended", call: { from_number, to_number, agent_id, call_id,
 *   start_timestamp, end_timestamp, transcript, disconnection_reason, ... } }
 *
 * Actions:
 *   1. Look up or create lead by from_number
 *   2. Insert call_logs row (ON CONFLICT DO NOTHING on retell_call_id)
 *   3. Auto-enroll lead in the client's default sequence (if any, ON CONFLICT DO NOTHING)
 */
router.post('/call-ended', retellAuth, async (req, res) => {
  try {
    const call = req.body?.call || {};
    if (req.body?.event !== 'call_ended') {
      return res.status(200).json({ ok: true }); // ignore non-call_ended events
    }

    const {
      from_number,
      to_number,
      agent_id,
      call_id: retellCallId,
      start_timestamp,
      end_timestamp,
      transcript = '',
      disconnection_reason = '',
    } = call;

    if (!from_number || !retellCallId) {
      console.warn('[retell/call-ended] missing from_number or call_id');
      return res.status(200).json({ ok: true });
    }

    // Look up client by to_number
    const { rows: clientRows } = await pool.query(
      `SELECT id FROM clients WHERE telnyx_phone_number = $1 AND active = true LIMIT 1`,
      [to_number]
    );
    const clientId = clientRows[0]?.id || null;

    // Extract extension from Retell call analysis (set by Retell LLM custom_analysis_data)
    // Falls back to scanning transcript for digits the caller spoke
    const analysisData = call.call_analysis?.custom_analysis_data || {};
    let spokenExtension = analysisData.extension || null;

    if (!spokenExtension && transcript) {
      // Scan transcript for "extension 101" or "press 1" style patterns
      const extMatch = transcript.match(/extension\s+(\w+)/i) || transcript.match(/\bext\.?\s*(\w+)/i);
      if (extMatch) spokenExtension = extMatch[1];
    }

    // Look up salesperson by voice_extension
    let salespersonId = null;
    if (spokenExtension && clientId) {
      const { rows: spRows } = await pool.query(
        `SELECT id FROM salespeople
         WHERE voice_extension = $1 AND client_id = $2 AND active = true
         LIMIT 1`,
        [spokenExtension, clientId]
      );
      salespersonId = spRows[0]?.id || null;
    }

    // Fall back to first active salesperson for client if no extension matched
    if (!salespersonId && clientId) {
      const { rows: spRows } = await pool.query(
        `SELECT s.id FROM salespeople s
         JOIN users u ON LOWER(u.email) = LOWER(s.email)
         WHERE u.client_id = $1 AND s.active = true
         LIMIT 1`,
        [clientId]
      );
      salespersonId = spRows[0]?.id || null;
    }

    // Duration in seconds (timestamps are ms epoch)
    const durationSeconds = (start_timestamp && end_timestamp)
      ? Math.round((end_timestamp - start_timestamp) / 1000)
      : 0;
    const callStartedAt = start_timestamp ? new Date(start_timestamp).toISOString() : null;
    const callEndedAt   = end_timestamp   ? new Date(end_timestamp).toISOString()   : null;

    // Upsert lead by phone number (idx_leads_phone unique index allows ON CONFLICT target)
    const { rows: leadRows } = await pool.query(
      `INSERT INTO leads (phone, client_id, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (phone) DO NOTHING
       RETURNING id`,
      [from_number, clientId]
    );
    let leadId = leadRows[0]?.id;

    if (!leadId) {
      // Lead already existed — fetch it
      const { rows: existing } = await pool.query(
        `SELECT id FROM leads WHERE phone = $1 AND (client_id = $2 OR client_id IS NULL) LIMIT 1`,
        [from_number, clientId]
      );
      leadId = existing[0]?.id;
    }

    // First-touch attribution for voice outreach
    if (leadId && salespersonId) {
      await setFirstTouchAttribution({
        leadId,
        salespersonId,
        source: 'voice_call',
        clientId,
      });
    }

    // Insert call_log (idempotent on retell_call_id)
    await pool.query(
      `INSERT INTO call_logs
         (client_id, lead_id, salesperson_id, retell_call_id, from_number, to_number, duration_seconds,
          transcript, disconnection_reason, call_started_at, call_ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (retell_call_id) DO NOTHING`,
      [clientId, leadId, salespersonId, retellCallId, from_number, to_number, durationSeconds,
       transcript, disconnection_reason, callStartedAt, callEndedAt]
    );

    // Auto-enroll only when lead has email consent (TCPA/CAN-SPAM)
    if (leadId && clientId && salespersonId) {
      const { rows: consentRows } = await pool.query(
        `SELECT consent_email FROM leads WHERE id = $1`,
        [leadId]
      );
      if (consentRows[0]?.consent_email) {
        const { rows: seqRows } = await pool.query(
          `SELECT id FROM sequences
           WHERE active = true AND client_id = $1
           ORDER BY id ASC LIMIT 1`,
          [clientId]
        );
        if (seqRows[0]) {
          await pool.query(
            `INSERT INTO contact_enrollments
               (lead_id, sequence_id, salesperson_id, client_id, status, next_send_at)
             VALUES ($1, $2, $3, $4, 'active', NOW())
             ON CONFLICT (lead_id, sequence_id) DO NOTHING`,
            [leadId, seqRows[0].id, salespersonId, clientId]
          );
        }
      }
    }

    console.log(`[retell/call-ended] call_id=${retellCallId} lead_id=${leadId} sp_id=${salespersonId} ext=${spokenExtension} duration=${durationSeconds}s`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[retell/call-ended] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
