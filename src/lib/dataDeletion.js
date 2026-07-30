// Data deletion for a state privacy law request (CCPA/CPRA and similar):
// "delete everything you hold about me." Deletes the lead's activity/PII
// records and the lead itself; anonymizes (rather than deletes) the orders
// table, since a completed sale is a financial record commonly subject to its
// own retention requirement — the row stays for revenue/commission integrity,
// only the customer's identifying email is cleared.
//
// Always tenant-scoped: every statement carries client_id so this can never
// touch another tenant's data even if called with the wrong lead id.
const { pool } = require('../db');

async function deleteLeadData(leadId, clientId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT id, email FROM leads WHERE id = $1 AND client_id = $2 FOR UPDATE',
      [leadId, clientId]
    );
    const lead = rows[0];
    if (!lead) {
      await client.query('ROLLBACK');
      return { ok: false, error: 'Lead not found for this tenant' };
    }

    // Activity/tracking tables keyed by lead_id: hard delete. None of these are
    // financial records, so nothing requires them to be retained.
    for (const table of ['call_logs', 'clicks', 'email_sends', 'form_submissions', 'phone_calls', 'sms_messages', 'tracking_tokens']) {
      await client.query(`DELETE FROM ${table} WHERE lead_id = $1 AND client_id = $2`, [leadId, clientId]);
    }
    // contact_enrollments and lead_notes cascade on leads' FK (ON DELETE CASCADE).

    // Orders: anonymize the identifying email and detach from the lead being
    // deleted (orders.lead_id has no ON DELETE action, so it must be cleared
    // before the lead row can go), but keep the order itself — revenue and
    // commission history, possibly subject to its own financial retention
    // requirement, independent of the person's PII.
    await client.query(
      `UPDATE orders SET customer_email = NULL, lead_id = NULL WHERE lead_id = $1 AND client_id = $2`,
      [leadId, clientId]
    );

    // Suppress the email so a future import or inbound capture cannot silently
    // recreate the record we just deleted.
    if (lead.email) {
      await client.query(
        `INSERT INTO suppression_list (email, reason, client_id) VALUES ($1, 'data_deletion_request', $2)
         ON CONFLICT (email) DO UPDATE SET reason = 'data_deletion_request'`,
        [lead.email, clientId]
      );
    }

    await client.query('DELETE FROM leads WHERE id = $1 AND client_id = $2', [leadId, clientId]);

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, error: err.message };
  } finally {
    client.release();
  }
}

module.exports = { deleteLeadData };
