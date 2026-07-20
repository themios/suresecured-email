/**
 * Delivery feedback loop — the operator-facing half.
 *
 * Exists because sending can fail silently. The send path records every failure
 * with a reason and class (see classifySendFailure in lib/gmail.js); these two
 * endpoints are what turn that data into something a human notices:
 *
 *   GET /api/sending-health   polled by the banner in every page's shared JS
 *   GET /undelivered          the list of messages that did not arrive, and why
 *
 * Both are tenant-scoped on req.user.client_id. requireTenantContext refuses a
 * session with no tenant rather than falling back to a default client.
 */
const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const { requireAuth, requireTenantContext } = require('../middleware/auth');
const { shell, esc } = require('../lib/layout');

// Operator-facing copy for each failure class. The raw SMTP string is kept and
// shown as detail, but it is never the headline — "535 Authentication
// credentials invalid" means nothing to a dealership owner.
const CLASS_COPY = {
  auth: {
    label: 'Login rejected',
    hint: 'Your mail provider rejected the username or password in Settings → Email. If your provider uses 2FA you probably need an app-specific password rather than your account password.',
  },
  connection: {
    label: 'Server unreachable',
    hint: 'We could not connect to your mail server. Check the host and port in Settings → Email.',
  },
  config: {
    label: 'Sending address not allowed',
    hint: 'The mail provider will not let this account send as your configured "from" address. Verify it as a send-as alias, or change the from address.',
  },
  quota: {
    label: 'Rate limited',
    hint: 'Your provider is throttling sends. This usually clears on its own; these messages will be retried.',
  },
  bounce: {
    label: 'Address rejected permanently',
    hint: 'The recipient mailbox does not exist or refused delivery. This address has been suppressed.',
  },
  recipient: {
    label: 'Recipient refused',
    hint: 'The receiving server rejected this specific address.',
  },
  unknown: {
    label: 'Delivery failed',
    hint: 'The message could not be delivered. The provider response is shown below.',
  },
};

/**
 * Health of the tenant's sending identity. Shared by the banner endpoint and
 * the /undelivered page so the two can never disagree about whether sending is
 * broken.
 *
 * "Healthy" means no failures since the last SUCCESSFUL send -- not "no
 * failures ever". A mailbox that starts working again clears itself on the next
 * success, without anyone dismissing a banner.
 */
async function getSendingHealth(clientId) {
  {
    // Health is DERIVED from the send log, not read from a counter alone.
    //
    // consecutive_failures only starts counting from the moment migration 016
    // added it, so a mailbox that was already broken before deploy reports a
    // perfectly healthy 0 while nothing is being delivered. That is exactly the
    // silence this feature exists to end, so the counter cannot be the only
    // signal. Trailing failures since the last successful send are the ground
    // truth: they survive deploys, need no backfill, and cannot go stale.
    //
    // The counter still matters -- it reacts within one send attempt, whereas
    // the derived count needs a row written. Take whichever is worse.
    // NOTE: this CTE was originally named `trailing`, which is a Postgres
    // reserved word (TRIM(TRAILING ...)). It raised a syntax error that the
    // catch below converted into {healthy:true}, so a broken mailbox reported
    // healthy and the banner never rendered. Keep CTE names non-reserved.
    const { rows } = await pool.query(
      `WITH last_ok AS (
         SELECT MAX(sent_at) AS at
         FROM email_sends
         WHERE client_id = $1 AND status = 'sent'
       ),
       failures_since_ok AS (
         SELECT COUNT(*)::int AS failures,
                MAX(COALESCE(failed_at, sent_at)) AS last_at
         FROM email_sends
         WHERE client_id = $1
           AND status = 'failed'
           AND COALESCE(failed_at, sent_at) > COALESCE((SELECT at FROM last_ok), '-infinity'::timestamptz)
       ),
       latest AS (
         SELECT failure_class, failure_reason
         FROM email_sends
         WHERE client_id = $1 AND status = 'failed'
         ORDER BY COALESCE(failed_at, sent_at) DESC
         LIMIT 1
       )
       SELECT
         COALESCE(cfg.consecutive_failures, 0)              AS counter_failures,
         COALESCE(t.failures, 0)                            AS trailing_failures,
         COALESCE(cfg.last_error_class, l.failure_class)    AS failure_class,
         COALESCE(cfg.last_error, l.failure_reason)         AS last_error,
         COALESCE(cfg.last_success_at, (SELECT at FROM last_ok)) AS last_success_at
       FROM failures_since_ok t
       LEFT JOIN latest l ON TRUE
       LEFT JOIN client_email_config cfg ON cfg.client_id = $1`,
      [clientId]
    );

    const h = rows[0];
    const failureCount = Math.max(h?.counter_failures || 0, h?.trailing_failures || 0);

    // Zero failures since the last success means sending is working, including
    // the case where it was never set up -- that is a setup task, not an outage,
    // and must not paint the red banner.
    if (!h || failureCount === 0) return { healthy: true };

    return {
      healthy: false,
      failureClass: h.failure_class || 'unknown',
      failureCount,
      lastError: h.last_error,
      lastSuccessAt: h.last_success_at,
    };
  }
}

router.get('/api/sending-health', requireAuth, requireTenantContext, async (req, res) => {
  try {
    res.json(await getSendingHealth(req.user.client_id));
  } catch (err) {
    console.error('[sending-health] error:', err.message);
    // Fail closed toward "healthy" so a broken health check never paints a false
    // outage across every page. But report `degraded` so the failure is VISIBLE
    // in the response: a bare {healthy:true} here already hid a SQL error once,
    // and a monitor that silently reports "fine" when it is broken is the exact
    // failure mode this whole feature exists to eliminate.
    res.json({ healthy: true, degraded: true, error: err.message });
  }
});

router.get('/undelivered', requireAuth, requireTenantContext, async (req, res) => {
  try {
    const [failures, health] = await Promise.all([
      pool.query(
        `SELECT es.id, es.to_email, es.subject, es.failure_class, es.failure_reason,
                COALESCE(es.failed_at, es.sent_at) AS when_failed,
                l.first_name, l.last_name
         FROM email_sends es
         LEFT JOIN leads l ON l.id = es.lead_id
         WHERE es.status = 'failed' AND es.client_id = $1
         ORDER BY COALESCE(es.failed_at, es.sent_at) DESC
         LIMIT 200`,
        [req.user.client_id]
      ),
      getSendingHealth(req.user.client_id),
    ]);

    const banner = !health.healthy
      ? `<div class="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
           <div class="font-semibold text-red-800 text-sm">
             Sending is currently failing — ${health.failureCount} ${health.failureCount === 1 ? 'message' : 'messages'} not delivered since the last successful send
           </div>
           <p class="text-red-700 text-sm mt-1">${esc((CLASS_COPY[health.failureClass] || CLASS_COPY.unknown).hint)}</p>
           ${health.lastError ? `<p class="text-xs text-red-500 mt-2 font-mono">${esc(health.lastError)}</p>` : ''}
           <a href="/settings/email" class="inline-block mt-3 bg-red-600 text-white text-sm rounded-lg px-4 py-2 hover:bg-red-700">Open email settings</a>
         </div>`
      : `<div class="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mb-6 text-sm text-emerald-800">
           Sending is healthy. Anything listed below already failed and was not retried.
         </div>`;

    const rows = failures.rows.map(f => {
      const copy = CLASS_COPY[f.failure_class] || CLASS_COPY.unknown;
      const name = [f.first_name, f.last_name].filter(Boolean).join(' ');
      return `<tr class="border-b border-slate-100">
        <td class="px-4 py-3 text-sm">
          <div class="font-medium text-slate-800">${esc(f.to_email)}</div>
          ${name ? `<div class="text-xs text-slate-400">${esc(name)}</div>` : ''}
        </td>
        <td class="px-4 py-3 text-sm text-slate-600">${esc(f.subject || '—')}</td>
        <td class="px-4 py-3">
          <span class="text-xs font-medium px-2 py-1 rounded-full bg-red-50 text-red-700">${esc(copy.label)}</span>
        </td>
        <td class="px-4 py-3 text-xs text-slate-500 font-mono max-w-xs truncate" title="${esc(f.failure_reason || '')}">${esc(f.failure_reason || '—')}</td>
        <td class="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">${f.when_failed ? new Date(f.when_failed).toLocaleString() : '—'}</td>
      </tr>`;
    }).join('');

    const content = `
      <div class="p-8 max-w-6xl">
        <h1 class="text-2xl font-bold text-slate-800 mb-1">Undelivered messages</h1>
        <p class="text-sm text-slate-500 mb-6">Messages that were attempted but did not reach the recipient, and why.</p>
        ${banner}
        <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table class="w-full">
            <thead class="bg-slate-50 border-b border-slate-200">
              <tr>
                <th class="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Recipient</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Subject</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Reason</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">Provider response</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">When</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="5" class="px-4 py-12 text-center text-slate-400 text-sm">Nothing has failed to deliver. </td></tr>`}
            </tbody>
          </table>
        </div>
      </div>`;

    res.send(shell('Undelivered', 'sequences', content, { user: req.user }));
  } catch (err) {
    console.error('[undelivered] error:', err.message);
    res.status(500).send('Server error');
  }
});

module.exports = router;
