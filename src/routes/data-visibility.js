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
const express = require('express');
const jwt = require('jsonwebtoken');
const { shell, esc } = require('../lib/layout');
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
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
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
    return res.status(status).send(shell(title, 'data', page(title, `<p class="text-slate-700">${esc(text)}</p>`), { user }));
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
    res.send(shell('Data health', 'data', renderHealth(snap), { user: req.user }));
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
    res.send(shell('Form submissions', 'data', renderSubmissions(f, data), { user: req.user }));
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
    res.set('Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.send(renderReveal(rec));
  });

  return router;
}

// ─── Rendering ──────────────────────────────────────────────────────────────
// Every value from the database is escaped. Stranger input is never turned into links.
function page(title, body) {
  return `<main class="max-w-6xl mx-auto px-4 sm:px-6 py-8">
  <h1 class="text-xl font-bold text-slate-900 mb-1">${esc(title)}</h1>
  <nav class="text-sm mb-6 flex gap-4">
    <a class="text-blue-600 underline" href="/admin/data/health">Data health</a>
    <a class="text-blue-600 underline" href="/admin/data/form-submissions">Form submissions</a>
  </nav>
  ${body}
</main>`;
}

const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const when = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

function statusBadge(r) {
  const map = {
    normal: ['Normal', 'bg-emerald-50 text-emerald-700'],
    spike: ['Spike', 'bg-red-50 text-red-700'],
    unavailable: ['Unavailable', 'bg-amber-50 text-amber-800'],
    missing: ['Not in database', 'bg-slate-100 text-slate-600'],
  };
  const [label, cls] = map[r.status] || map.unavailable;
  return `<span class="px-2 py-0.5 rounded text-xs font-semibold ${cls}">${label}</span>`;
}

function renderHealth(snap) {
  const banner = snap.unregistered.length
    ? `<div class="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        <b>${snap.unregistered.length} table(s) exist that no screen or check covers:</b>
        ${snap.unregistered.map(n => `<code>${esc(n)}</code>`).join(', ')}.
        Add each one to the data registry with a screen or a reason.</div>`
    : '';
  const groups = [['screen', 'Shown on a page'], ['counts', 'Counts only'], ['internal', 'Internal plumbing']];
  const tables = groups.map(([vis, heading]) => {
    const rows = snap.rows.filter(r => r.visibility === vis);
    return `<h2 class="text-sm font-bold text-slate-700 mt-8 mb-2">${heading}</h2>
    <div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
    <table class="min-w-full text-sm">
      <thead class="bg-slate-50 text-slate-500 text-xs uppercase"><tr>
        <th class="text-left px-3 py-2">Data</th><th class="text-right px-3 py-2">Records</th>
        <th class="text-right px-3 py-2">Last 24h</th><th class="text-right px-3 py-2">Last 7 days</th>
        <th class="text-left px-3 py-2">Newest</th><th class="text-left px-3 py-2">Status</th>
        <th class="text-left px-3 py-2">${vis === 'screen' ? 'Where to see it' : 'Why no detail page'}</th>
      </tr></thead>
      <tbody>${rows.map(r => `<tr class="border-t border-slate-100">
        <td class="px-3 py-2 font-medium text-slate-800">${esc(r.label)}</td>
        <td class="px-3 py-2 text-right tabular-nums">${num(r.total)}</td>
        <td class="px-3 py-2 text-right tabular-nums">${num(r.last24h)}</td>
        <td class="px-3 py-2 text-right tabular-nums">${num(r.last7d)}</td>
        <td class="px-3 py-2 whitespace-nowrap">${when(r.newest)}</td>
        <td class="px-3 py-2">${statusBadge(r)}</td>
        <td class="px-3 py-2 text-slate-500">${esc(r.where || r.why || '')}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }).join('');
  return page('Data health', `
    <p class="text-sm text-slate-600">Every table the platform stores, with counts only. Record contents are never shown here.
    "Spike" means the last hour brought more than ${dv.LIMITS.ANOMALY_MIN_PER_HOUR} records and over ${dv.LIMITS.ANOMALY_MULTIPLIER} times the normal hourly rate.
    "—" means the table has no creation time, so only the total is known.</p>
    ${banner}${tables}`);
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
  const sel = (name, value) => ['any', 'yes', 'no'].map(v =>
    `<option value="${v}"${value === v ? ' selected' : ''}>${v === 'any' ? 'Any' : v === 'yes' ? 'Yes' : 'No'}</option>`).join('');
  const pages = Math.max(1, Math.ceil(data.total / dv.LIMITS.PAGE_SIZE));
  const rows = data.rows.map(r => {
    const spam = dv.looksLikeSpam(r);
    return `<tr class="border-t border-slate-100 align-top">
      <td class="px-3 py-2 whitespace-nowrap text-xs text-slate-500">${when(r.created_at)}<br>#${esc(r.id)}</td>
      <td class="px-3 py-2"><div class="font-medium text-slate-800 break-words max-w-[220px]">${esc(r.business_name)}</div>
        <div class="text-xs text-slate-500">${esc(r.contact_name || '')}${r.trade ? ' · ' + esc(r.trade) : ''}</div></td>
      <td class="px-3 py-2 text-slate-700 break-words max-w-[320px]">${esc(String(r.message || '').slice(0, 400))}</td>
      <td class="px-3 py-2 font-mono text-xs whitespace-nowrap">${esc(dv.maskEmail(r.email))}<br>${esc(dv.maskPhone(r.phone))}</td>
      <td class="px-3 py-2 text-xs whitespace-nowrap">${esc(r.confirm_email_status || 'none')}<br>${r.verify_status === 'verified' ? '<b class="text-emerald-700">Confirmed</b>' : 'Not confirmed'}</td>
      <td class="px-3 py-2 text-xs">${spam ? '<span class="px-2 py-0.5 rounded bg-red-50 text-red-700 font-semibold">Likely spam</span>' : ''}</td>
      <td class="px-3 py-2"><form method="POST" action="/admin/data/form-submissions/${esc(r.id)}/reveal">
        <button class="text-xs text-blue-700 underline" type="submit">Reveal</button></form></td>
    </tr>`;
  }).join('');
  return page('Website form submissions', `
    <p class="text-sm text-slate-600 mb-4">Everything typed into the estimate form on saleswyze.com. Email and phone are hidden.
    Reveal shows one record in full and is recorded in the audit log (limit ${dv.LIMITS.REVEALS_PER_HOUR} an hour).
    "Likely spam" is a sorting aid only. Nothing is hidden or deleted here.</p>
    <form method="GET" class="flex flex-wrap gap-3 items-end text-sm mb-4">
      <label>From<br><input class="border rounded px-2 py-1" type="date" name="from" value="${esc(f.from || '')}"></label>
      <label>To<br><input class="border rounded px-2 py-1" type="date" name="to" value="${esc(f.to || '')}"></label>
      <label>Confirmed<br><select class="border rounded px-2 py-1" name="confirmed">${sel('confirmed', f.confirmed)}</select></label>
      <label>Likely spam<br><select class="border rounded px-2 py-1" name="spam">${sel('spam', f.spam)}</select></label>
      <button class="bg-blue-600 text-white rounded px-3 py-1.5" type="submit">Filter</button>
    </form>
    <p class="text-sm text-slate-700 mb-2"><b>${num(data.total)}</b> matching records. Page ${f.page} of ${num(pages)}.</p>
    <div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
    <table class="min-w-full text-sm">
      <thead class="bg-slate-50 text-slate-500 text-xs uppercase"><tr>
        <th class="text-left px-3 py-2">Received</th><th class="text-left px-3 py-2">Business</th>
        <th class="text-left px-3 py-2">Message</th><th class="text-left px-3 py-2">Contact</th>
        <th class="text-left px-3 py-2">Confirmation</th><th class="text-left px-3 py-2">Flag</th><th></th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="px-3 py-6 text-center text-slate-500">No records match.</td></tr>'}</tbody>
    </table></div>
    <p class="mt-4 flex gap-4 text-sm">
      ${f.page > 1 ? `<a class="text-blue-600 underline" href="/admin/data/form-submissions${qs({ page: f.page - 1 })}">Newer</a>` : ''}
      ${f.page < Math.min(pages, dv.LIMITS.MAX_PAGE) ? `<a class="text-blue-600 underline" href="/admin/data/form-submissions${qs({ page: f.page + 1 })}">Older</a>` : ''}
    </p>`);
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
