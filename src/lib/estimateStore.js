// Postgres-backed store for the estimate verification flow. Every write that
// must be race-free (quota counting, token use) is a single SQL statement, so
// two instances or two parallel requests cannot both win.
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function createPgStore(pool) {
  return {
    // Count one event in a fixed window. Returns { allowed, count, firstDenial }.
    // firstDenial is true exactly once per bucket per window, so alerts do not repeat.
    async consumeQuota(bucket, windowMs, limit) {
      const { rows } = await pool.query(
        `INSERT INTO form_quota (bucket, window_start, count)
         VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2::double precision) * $2::double precision), 1)
         ON CONFLICT (bucket, window_start) DO UPDATE SET count = form_quota.count + 1
         RETURNING count, window_start`,
        [bucket, windowMs / 1000]
      );
      const count = rows[0].count;
      if (count <= limit) return { allowed: true, count, firstDenial: false };
      const flagged = await pool.query(
        `UPDATE form_quota SET alerted_at = now()
          WHERE bucket = $1 AND window_start = $2 AND alerted_at IS NULL
          RETURNING 1`,
        [bucket, rows[0].window_start]
      );
      return { allowed: false, count, firstDenial: flagged.rowCount === 1 };
    },

    // Undo one consumeQuota in the current window. Used when the action the quota
    // guarded (an alert) did not happen, so the next attempt is not suppressed.
    async releaseQuota(bucket, windowMs) {
      await pool.query(
        `UPDATE form_quota SET count = GREATEST(count - 1, 0), alerted_at = NULL
          WHERE bucket = $1
            AND window_start = to_timestamp(floor(extract(epoch FROM now()) / $2::double precision) * $2::double precision)`,
        [bucket, windowMs / 1000]
      );
    },

    async insertLead(f) {
      const { rows } = await pool.query(
        `INSERT INTO platform_leads
           (business_name, contact_name, trade, email, phone, list_size, message, deal_value, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'landing_page') RETURNING id`,
        [f.business_name, f.contact_name || null, f.trade || null, f.email, f.phone || null,
         f.list_size || null, f.message || null, f.deal_value || null]
      );
      return rows[0].id;
    },

    async setConfirmStatus(leadId, status, error) {
      await pool.query(
        `UPDATE platform_leads SET confirm_email_status = $2, confirm_email_error = $3 WHERE id = $1`,
        [leadId, status, error ? String(error).slice(0, 300) : null]
      );
    },

    async createVerification(leadId, tokenHash, expiresAt) {
      await pool.query(
        `INSERT INTO estimate_verifications (lead_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
        [leadId, tokenHash, expiresAt]
      );
    },

    // Read-only check used by the confirmation page. Does not claim the token.
    async peekVerification(tokenHash) {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM estimate_verifications
          WHERE token_hash = $1 AND completed_at IS NULL AND expires_at > now()`,
        [tokenHash]
      );
      return rowCount === 1;
    },

    // Claim for a short lease so only one request builds the estimate. Marks the lead
    // verified (inbox ownership is proven at this point). Returns { lead, nonce } or
    // null if the token is unknown, expired, completed, or claimed by a live request.
    // The nonce fences every later write: a request whose lease was taken over by a
    // newer claim can no longer save, complete or release.
    async claimVerification(tokenHash, leaseMs) {
      const nonce = crypto.randomBytes(16).toString('hex');
      const { rows } = await pool.query(
        `WITH t AS (
           UPDATE estimate_verifications SET claimed_at = now(), claim_nonce = $3
            WHERE token_hash = $1 AND completed_at IS NULL AND expires_at > now()
              AND (claimed_at IS NULL OR claimed_at < now() - ($2::double precision * interval '1 millisecond'))
            RETURNING lead_id)
         UPDATE platform_leads l
            SET verify_status = 'verified', verified_at = COALESCE(l.verified_at, now())
           FROM t WHERE l.id = t.lead_id
         RETURNING l.id, l.business_name, l.email, l.trade, l.list_size, l.deal_value, l.estimate_narrative`,
        [tokenHash, leaseMs, nonce]
      );
      return rows[0] ? { lead: rows[0], nonce } : null;
    },

    // Persist the narrative before rendering, so a retry reuses it and never repeats
    // the model call. Returns false if the claim was taken over.
    async saveNarrative(tokenHash, nonce, leadId, narrative) {
      const { rowCount } = await pool.query(
        `UPDATE platform_leads l SET estimate_narrative = $4
           FROM estimate_verifications v
          WHERE v.token_hash = $1 AND v.claim_nonce = $2 AND v.completed_at IS NULL
            AND l.id = v.lead_id AND l.id = $3`,
        [tokenHash, nonce, leadId, narrative]
      );
      return rowCount === 1;
    },

    // The estimate was produced. Only the current claim owner can complete, and only
    // once. Returns false if it was not the owner (the caller must then not send mail).
    async completeVerification(tokenHash, nonce) {
      const { rowCount } = await pool.query(
        `UPDATE estimate_verifications SET completed_at = now()
          WHERE token_hash = $1 AND claim_nonce = $2 AND completed_at IS NULL`,
        [tokenHash, nonce]
      );
      return rowCount === 1;
    },

    // Production of the estimate failed after the claim. Free the token for a retry.
    async releaseVerification(tokenHash, nonce) {
      await pool.query(
        `UPDATE estimate_verifications SET claimed_at = NULL, claim_nonce = NULL
          WHERE token_hash = $1 AND claim_nonce = $2 AND completed_at IS NULL`,
        [tokenHash, nonce]
      );
    },

    // 24h picture used by the daily abuse report.
    async abuseSnapshot() {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS submitted,
                count(*) FILTER (WHERE confirm_email_status = 'sent')::int AS confirm_sent,
                count(*) FILTER (WHERE confirm_email_status = 'failed')::int AS confirm_failed,
                count(*) FILTER (WHERE confirm_email_status = 'quota_blocked')::int AS quota_blocked,
                count(*) FILTER (WHERE verify_status = 'verified')::int AS verified
           FROM platform_leads WHERE created_at > now() - interval '24 hours'`
      );
      const q = await pool.query(
        `SELECT bucket, count FROM form_quota
          WHERE window_start > now() - interval '24 hours' AND alerted_at IS NOT NULL
          ORDER BY count DESC LIMIT 5`
      );
      return { ...rows[0], tripped: q.rows };
    },

    async pruneQuota() {
      await pool.query(`DELETE FROM form_quota WHERE window_start < now() - interval '8 days'`);
    },
  };
}

module.exports = { createPgStore, sha256 };
