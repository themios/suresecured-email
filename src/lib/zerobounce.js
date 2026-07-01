/**
 * ZeroBounce email verification — native https, no SDK
 * Docs: https://www.zerobounce.net/docs/email-validation-api-quickstart/
 *
 * Statuses returned:
 *   valid       — deliverable
 *   invalid     — undeliverable, suppress
 *   catch-all   — domain accepts everything, unknown deliverability (warn)
 *   unknown     — could not determine (warn)
 *   spamtrap    — spam trap address, suppress
 *   abuse       — known complainer, suppress
 *   do_not_mail — role/disposable address, suppress
 */
const https = require('https');

const BLOCK_STATUSES = new Set(['invalid', 'spamtrap', 'abuse', 'do_not_mail']);

function verifyEmail(email) {
  return new Promise((resolve, reject) => {
    const key = process.env.ZEROBOUNCE_API_KEY;
    if (!key) return reject(new Error('ZEROBOUNCE_API_KEY not set'));

    const path = `/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}&ip_address=`;

    const req = https.request({
      hostname: 'api.zerobounce.net',
      path,
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({
            status:     parsed.status || 'unknown',
            subStatus:  parsed.sub_status || '',
            valid:      parsed.status === 'valid',
            block:      BLOCK_STATUSES.has(parsed.status),
          });
        } catch {
          reject(new Error('ZeroBounce parse error: ' + data.slice(0, 100)));
        }
      });
    });

    req.setTimeout(10000, () => { req.destroy(); reject(new Error('ZeroBounce timeout')); });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { verifyEmail, BLOCK_STATUSES };
