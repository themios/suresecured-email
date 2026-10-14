// Operator-only data pages. Spec: specs/2026-10-14-data-visibility.md
//
//   GET  /admin/data/health                        counts for every registered table
//   GET  /admin/data/form-submissions              website form submissions, masked
//   POST /admin/data/form-submissions/:id/reveal   one record's full email and phone
//
// Anyone who is not a signed-in, active operator gets the app's ordinary 404 (the
// router steps aside), so these pages do not disclose that they exist. Every view and
// every reveal is written to the audit log first; if the trace cannot be written,
// nothing is shown.
//
// These pages load nothing from another server and send a policy that forbids all
// script. The app's shared layout pulls JavaScript from a CDN; a script running on a
// page that lists submission ids could press Reveal itself and read the answer.
const express = require('express');
const jwt = require('jsonwebtoken');
const { esc } = require('../lib/layout');
const dv = require('../lib/dataVisibility');

function createDataVisibilityRouter(deps) {
  const { store, audit, recordReveal, loadUser, jwtSecret, log = console } = deps;
  const router = express.Router();

  // Identity from the session only. Any doubt (no cookie, bad token, inactive user,
  // database error, wrong role) means "not here": fail closed, unlike the general
  // auth middleware, which falls back to token claims on a database error.
  async function operatorOnly(req, res, next) {
    try {
      const token = req.cookies && req.cookies.auth_token;
      if (!token || !jwtSecret) return next('router');
      const payload = jwt.verify(token, jwtSecret);
      const user = await loadUser(payload.id);
      if (!user || user.role !== 'operator') return next('router');
      req.user = user;
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex',
                'Content-Security-Policy': PAGE_CSP });
      return next();
    } catch (err) {
      return next('router');
    }
  }

  // Defence in depth for the one action that writes: the login cookie is SameSite=Lax,
  // and a cross-site Origin is refused as well.
  function sameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (origin) {
      try { if (new URL(origin).host !== req.get('host')) return next('router'); }
      catch { return next('router'); }
    }
    return next();
  }

  const trace = (req, action, detail, targetId) => audit({
    userId: req.user.id, actorEmail: req.user.email, action,
    targetType: targetId ? 'platform_lead' : null, targetId: targetId || null,
    detail, ip: req.ip || null,
  });

  function refuse(res, status, title, text, user) {
    return res.status(status).send(page(title, `<p>${esc(text)}</p>`));
  }

  router.use(operatorOnly);

  router.get('/health', async (req, res) => {
    try { await trace(req, 'data_health.view', {}); }
    catch (err) {
      log.error('[data-health] audit write failed, page withheld:', err.message);
      return refuse(res, 503, 'Data health', 'This view could not be recorded in the audit log, so it is not shown. Try again shortly.', req.user);
    }
    let snap;
    try { snap = await dv.dataHealthSnapshot(store, log); }
    catch (err) {
      log.error('[data-health] snapshot failed:', err.message);
      return refuse(res, 503, 'Data health', 'The table list could not be read. Nothing is shown rather than numbers that might be wrong.', req.user);
    }
    res.send(renderHealth(snap));
  });

  router.get('/form-submissions', async (req, res) => {
    const f = dv.readFilters(req.query);
    if (!dv.pageAllowed(f.page)) {
      return refuse(res, 400, 'Form submissions', `Pages go up to ${dv.LIMITS.MAX_PAGE}. Use the date filters to reach older records.`, req.user);
    }
    try { await trace(req, 'form_submissions.view', { page: f.page, from: f.from, to: f.to, confirmed: f.confirmed, spam: f.spam }); }
    catch (err) {
      log.error('[form-submissions] audit write failed, page withheld:', err.message);
      return refuse(res, 503, 'Form submissions', 'This view could not be recorded in the audit log, so it is not shown. Try again shortly.', req.user);
    }
    let data;
    try { data = await store.listSubmissions(f); }
    catch (err) {
      log.error('[form-submissions] read failed:', err.message);
      return refuse(res, 503, 'Form submissions', 'The submissions could not be read right now.', req.user);
    }
    res.send(renderSubmissions(f, data));
  });

  router.post('/form-submissions/:id/reveal', sameOrigin, async (req, res, next) => {
    const id = req.params.id;
    if (!/^\d{1,10}$/.test(id)) return next('router');
    let rec;
    try { rec = await store.getSubmission(Number(id)); }
    catch (err) {
      log.error('[form-submissions] reveal read failed:', err.message);
      return refuse(res, 503, 'Reveal', 'The record could not be read right now.', req.user);
    }
    if (!rec) return next('router');
    // Rolling 60-minute limit and the audit entry, decided and written in one step.
    let r;
    try {
      r = await recordReveal({ userId: req.user.id, actorEmail: req.user.email, targetId: rec.id,
                               ip: req.ip || null, limit: dv.LIMITS.REVEALS_PER_HOUR });
    } catch (err) {
      log.error('[form-submissions] reveal not recorded, withheld:', err.message);
      return refuse(res, 503, 'Reveal', 'This reveal could not be recorded in the audit log, so it is not shown.', req.user);
    }
    if (!r.allowed) {
      return refuse(res, 429, 'Reveal', `You have revealed ${dv.LIMITS.REVEALS_PER_HOUR} records in the last 60 minutes, which is the limit. Try again later.`, req.user);
    }
    // The full address is on this response only. It is a self-contained page: no
    // third-party script or stylesheet, and a policy that forbids any script at all,
    // so nothing loaded from elsewhere can read the revealed values.
    res.set('Content-Security-Policy', REVEAL_CSP);
    res.send(renderReveal(rec));
  });

  return router;
}

// ─── Rendering ──────────────────────────────────────────────────────────────
// Every value from the database is escaped. Stranger input is never turned into links.
// Styles are inline in the page; no script and no third-party resource is loaded.
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const REVEAL_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

const STYLE = `*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#0f172a;margin:0}
main{max-width:1200px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 6px}h2{font-size:14px;color:#334155;margin:28px 0 8px}
nav{display:flex;gap:16px;font-size:14px;margin:0 0 18px}a{color:#2563eb}p{font-size:14px;color:#475569;line-height:1.5}
.wrap{overflow-x:auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:13px}th{background:#f1f5f9;color:#64748b;text-transform:uppercase;font-size:11px;text-align:left;padding:8px 10px}
td{border-top:1px solid #f1f5f9;padding:8px 10px;vertical-align:top}.n{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:#64748b;font-size:12px}.mono{font-family:monospace;font-size:12px;white-space:nowrap}.wrapt{max-width:320px;word-break:break-word}
.b{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold}
.ok{background:#ecfdf5;color:#047857}.bad{background:#fef2f2;color:#b91c1c}.warn{background:#fffbeb;color:#92400e}.off{background:#f1f5f9;color:#475569}
.banner{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;padding:12px;font-size:14px;margin:16px 0}
form.f{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;font-size:13px;margin:12px 0}
input,select{border:1px solid #cbd5e1;border-radius:4px;padding:5px 6px;font-size:13px}
button{background:#2563eb;color:#fff;border:0;border-radius:4px;padding:7px 12px;font-size:13px;cursor:pointer}
button.link{background:none;color:#2563eb;padding:0;text-decoration:underline}`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} | Data</title><style>${STYLE}</style></head><body><main>
<h1>${esc(title)}</h1>
<nav><a href="/admin">Back to Admin</a><a href="/admin/data/health">Data health</a><a href="/admin/data/form-submissions">Form submissions</a></nav>
${body}
</main></body></html>`;
}

const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const when = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

function statusBadge(r) {
  const map = { normal: ['Normal', 'ok'], spike: ['Spike', 'bad'], unavailable: ['Unavailable', 'warn'], missing: ['Not in database', 'off'] };
  const [label, cls] = map[r.status] || map.unavailable;
  return `<span class="b ${cls}">${label}</span>`;
}

function renderHealth(snap) {
  const banner = snap.unregistered.length
    ? `<div class="banner"><b>${snap.unregistered.length} table(s) exist that no screen or check covers:</b>
        ${snap.unregistered.map(n => `<code>${esc(n)}</code>`).join(', ')}. Add each one to the data registry with a screen or a reason.</div>`
    : '';
  const groups = [['screen', 'Shown on a page'], ['counts', 'Counts only'], ['internal', 'Internal plumbing']];
  const tables = groups.map(([vis, heading]) => {
    const rows = snap.rows.filter(r => r.visibility === vis);
    return `<h2>${heading}</h2><div class="wrap"><table>
      <thead><tr><th>Data</th><th class="n">Records</th><th class="n">Last 24h</th><th class="n">Last 7 days</th>
        <th>Newest</th><th>Status</th><th>${vis === 'screen' ? 'Where to see it' : 'Why no detail page'}</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td><b>${esc(r.label)}</b></td><td class="n">${num(r.total)}</td>
        <td class="n">${num(r.last24h)}</td><td class="n">${num(r.last7d)}</td><td class="mono">${when(r.newest)}</td>
        <td>${statusBadge(r)}</td><td class="muted">${esc(r.where || r.why || '')}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }).join('');
  return page('Data health', `
    <p>Every table the platform stores, with counts only. Record contents are never shown here.
    "Spike" means the last hour brought more than ${dv.LIMITS.ANOMALY_MIN_PER_HOUR} records and over ${dv.LIMITS.ANOMALY_MULTIPLIER} times the normal hourly rate.
    "—" means the table has no creation time, so only the total is known.</p>${banner}${tables}`);
}

function renderSubmissions(f, data) {
  const qs = (over) => {
    const p = new URLSearchParams();
    const m = { ...f, ...over };
    if (m.page > 1) p.set('page', m.page);
    if (m.from) p.set('from', m.from);
    if (m.to) p.set('to', m.to);
    if (m.confirmed !== 'any') p.set('confirmed', m.confirmed);
    if (m.spam !== 'any') p.set('spam', m.spam);
    const s = p.toString();
    return s ? `?${esc(s)}` : '';
  };
  const sel = (value) => ['any', 'yes', 'no'].map(v =>
    `<option value="${v}"${value === v ? ' selected' : ''}>${v === 'any' ? 'Any' : v === 'yes' ? 'Yes' : 'No'}</option>`).join('');
  const pages = Math.max(1, Math.ceil(data.total / dv.LIMITS.PAGE_SIZE));
  const rows = data.rows.map(r => `<tr>
      <td class="mono">${when(r.created_at)}<br><span class="muted">#${esc(r.id)}</span></td>
      <td class="wrapt"><b>${esc(r.business_name)}</b><br><span class="muted">${esc(r.contact_name || '')}${r.trade ? ' · ' + esc(r.trade) : ''}</span></td>
      <td class="wrapt">${esc(String(r.message || '').slice(0, 400))}</td>
      <td class="mono">${esc(dv.maskEmail(r.email))}<br>${esc(dv.maskPhone(r.phone))}</td>
      <td class="muted">${esc(r.confirm_email_status || 'none')}<br>${r.verify_status === 'verified' ? '<b style="color:#047857">Confirmed</b>' : 'Not confirmed'}</td>
      <td>${dv.looksLikeSpam(r) ? '<span class="b bad">Likely spam</span>' : ''}</td>
      <td><form method="POST" action="/admin/data/form-submissions/${esc(r.id)}/reveal"><button class="link" type="submit">Reveal</button></form></td>
    </tr>`).join('');
  return page('Website form submissions', `
    <p>Everything typed into the estimate form on saleswyze.com. Email and phone are hidden.
    Reveal shows one record in full and is recorded in the audit log (limit ${dv.LIMITS.REVEALS_PER_HOUR} in any 60 minutes).
    "Likely spam" is a sorting aid only. Nothing is hidden or deleted here.</p>
    <form class="f" method="GET">
      <label>From<br><input type="date" name="from" value="${esc(f.from || '')}"></label>
      <label>To<br><input type="date" name="to" value="${esc(f.to || '')}"></label>
      <label>Confirmed<br><select name="confirmed">${sel(f.confirmed)}</select></label>
      <label>Likely spam<br><select name="spam">${sel(f.spam)}</select></label>
      <button type="submit">Filter</button>
    </form>
    <p><b>${num(data.total)}</b> matching records. Page ${f.page} of ${num(pages)}.</p>
    <div class="wrap"><table>
      <thead><tr><th>Received</th><th>Business</th><th>Message</th><th>Contact</th><th>Confirmation</th><th>Flag</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">No records match.</td></tr>'}</tbody>
    </table></div>
    <nav style="margin-top:16px">
      ${f.page > 1 ? `<a href="/admin/data/form-submissions${qs({ page: f.page - 1 })}">Newer</a>` : ''}
      ${f.page < Math.min(pages, dv.LIMITS.MAX_PAGE) ? `<a href="/admin/data/form-submissions${qs({ page: f.page + 1 })}">Older</a>` : ''}
    </nav>`);
}

function renderReveal(rec) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Submission #${esc(rec.id)} | Data</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:40px 16px}
main{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:24px}
h1{font-size:18px;margin:0 0 16px}dl{display:grid;grid-template-columns:90px 1fr;gap:8px;margin:0}
dt{color:#64748b}dd{margin:0;font-family:monospace;word-break:break-all}
p{font-size:13px;color:#64748b;margin:16px 0 0}a{color:#2563eb}</style></head>
<body><main><h1>Submission #${esc(rec.id)}</h1>
<dl><dt>Email</dt><dd>${esc(rec.email)}</dd><dt>Phone</dt><dd>${esc(rec.phone || '—')}</dd></dl>
<p>This reveal was recorded in the audit log.</p>
<p><a href="/admin/data/form-submissions">Back to form submissions</a></p></main></body></html>`;
}

// ─── Production wiring ──────────────────────────────────────────────────────
function defaultRouter() {
  const { pool } = require('../db');
  return createDataVisibilityRouter({
    store: dv.createPgDataStore(pool),
    recordReveal: (args) => dv.recordRevealIfAllowed(pool, args),
    // Strict: throws when the trace cannot be written, so the caller withholds the data.
    audit: async ({ userId, actorEmail, action, targetType, targetId, detail, ip }) => {
      await pool.query(
        `INSERT INTO audit_log (client_id, user_id, actor_email, action, target_type, target_id, detail, ip)
         VALUES (NULL, $1, $2, $3, $4, $5, $6, $7)`,
        [userId, actorEmail, action, targetType, targetId, JSON.stringify(detail || {}), ip]);
    },
    loadUser: async (id) => {
      const { rows } = await pool.query(
        'SELECT id, email, role, client_id, organization_id FROM users WHERE id = $1 AND active = TRUE', [id]);
      return rows[0] || null;
    },
    jwtSecret: process.env.JWT_SECRET,
  });
}

module.exports = { createDataVisibilityRouter, defaultRouter, renderHealth, renderSubmissions };
