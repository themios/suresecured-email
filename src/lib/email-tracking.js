const { pool } = require('../db');

/**
 * Rewrites all HTTP/HTTPS URLs in body to tracked /e/:token redirect URLs.
 * Inserts one row into email_tracking_tokens per unique URL.
 *
 * IMPORTANT: emailSendId must be a valid email_sends.id — call this AFTER
 * the email_sends INSERT, not before.
 *
 * @param {string} body         - Plain-text resolved email body (before buildHtml)
 * @param {number} emailSendId  - email_sends.id for this send
 * @returns {Promise<string>}   - Body with URLs replaced by tracked redirect URLs
 */
async function rewriteLinks(body, emailSendId) {
  const trackerBase = process.env.TRACKER_URL || 'https://your-app.railway.app';
  const urlRegex = /(https?:\/\/[^\s<>"]+)/g;

  // De-duplicate: each unique URL gets one token row
  const urls = [...new Set(body.match(urlRegex) || [])];
  if (urls.length === 0) return body;

  const tokenMap = {};
  for (const url of urls) {
    const { rows } = await pool.query(
      `INSERT INTO email_tracking_tokens (email_send_id, destination_url)
       VALUES ($1, $2)
       RETURNING token`,
      [emailSendId, url]
    );
    tokenMap[url] = rows[0].token;
  }

  // Replace each URL occurrence with its tracked redirect URL
  return body.replace(urlRegex, url => {
    const tok = tokenMap[url];
    return tok ? `${trackerBase}/e/${tok}` : url;
  });
}

/**
 * Returns true if the Gmail API error message indicates a permanent address failure.
 *
 * SCOPE: API-level errors only. Gmail returns HTTP 200 for recipient-server 550 bounces
 * (DSN emails arrive in the sender's inbox instead). This function only catches cases
 * where the Gmail API itself rejects the send request.
 *
 * Error patterns matched (MEDIUM confidence — Gmail does not document these formally):
 * - '550' in message — permanent SMTP rejection surfaced in API error
 * - '553' in message — mailbox name invalid
 * - 'invalid recipient' — Gmail rejected address at API layer
 * - 'user not found' — recipient does not exist per Google
 * - 'does not exist' — broad existence failure
 * - 'mailbox unavailable' — recipient mailbox permanently unavailable
 * - 'no such user' — SMTP permanent rejection
 * - 'user unknown' — SMTP permanent rejection
 *
 * @param {string} errMsg - err.message from Gmail API catch block
 * @returns {boolean}
 */
const PERM_BOUNCE_PATTERNS = [
  /\b550\b/,
  /\b553\b/,
  /invalid\s+recipient/i,
  /user\s+not\s+found/i,
  /does\s+not\s+exist/i,
  /mailbox\s+unavailable/i,
  /no\s+such\s+user/i,
  /user\s+unknown/i,
];

function isPermanentBounce(errMsg) {
  if (!errMsg || typeof errMsg !== 'string') return false;
  return PERM_BOUNCE_PATTERNS.some(pattern => pattern.test(errMsg));
}

module.exports = { rewriteLinks, isPermanentBounce };
