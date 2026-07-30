// Append-only audit log: auth events + sensitive state changes, for dispute
// investigation and security questionnaires. Logging must never break the
// action it is recording, so every call is best-effort and swallows its own
// errors after logging them to the console.
const { pool } = require('../db');

async function logEvent({ clientId = null, userId = null, actorEmail = null, action, targetType = null, targetId = null, detail = {}, ip = null }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (client_id, user_id, actor_email, action, target_type, target_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [clientId, userId, actorEmail, action, targetType, targetId ? String(targetId) : null, JSON.stringify(detail || {}), ip]
    );
  } catch (err) {
    console.error('[audit] failed to record event:', action, err.message);
  }
}

// Best-effort caller IP: trust proxy is enabled (app.set('trust proxy', 1)),
// so req.ip already reflects X-Forwarded-For.
function ipOf(req) {
  return req?.ip || null;
}

module.exports = { logEvent, ipOf };
