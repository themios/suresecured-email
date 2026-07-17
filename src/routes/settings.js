const express    = require('express');
const router     = express.Router();
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const crypto     = require('crypto');
const { google } = require('googleapis');
const { pool }   = require('../db');
const { requireAuth } = require('../middleware/auth');
const { shell } = require('../lib/layout');
const { encrypt, decrypt } = require('../lib/crypto');
const { signOAuthState, verifyOAuthState } = require('../lib/gmail');

const PROVIDERS = {
  ionos:     { label: 'IONOS',                smtp_host: 'smtp.ionos.com',                        smtp_port: 587, imap_host: 'imap.ionos.com',             imap_port: 993, note: 'Use your full IONOS email as username.' },
  google:    { label: 'Google / Gmail',       smtp_host: 'smtp.gmail.com',                        smtp_port: 587, imap_host: 'imap.gmail.com',             imap_port: 993, note: 'Requires a Google App Password (Account → Security → App Passwords).' },
  microsoft: { label: 'Microsoft / Outlook',  smtp_host: 'smtp.office365.com',                    smtp_port: 587, imap_host: 'outlook.office365.com',       imap_port: 993, note: 'Enable SMTP AUTH in Microsoft 365 admin. Use full email as username.' },
  yahoo:     { label: 'Yahoo Mail',           smtp_host: 'smtp.mail.yahoo.com',                   smtp_port: 587, imap_host: 'imap.mail.yahoo.com',         imap_port: 993, note: 'Generate an App Password from Yahoo Account Security.' },
  apple:     { label: 'Apple iCloud',         smtp_host: 'smtp.mail.me.com',                      smtp_port: 587, imap_host: 'imap.mail.me.com',            imap_port: 993, note: 'Use an App-Specific Password from appleid.apple.com.' },
  zoho:      { label: 'Zoho Mail',            smtp_host: 'smtp.zoho.com',                         smtp_port: 587, imap_host: 'imap.zoho.com',              imap_port: 993, note: 'Enable IMAP/SMTP in Zoho Mail settings.' },
  ses:       { label: 'Amazon SES',           smtp_host: 'email-smtp.us-east-1.amazonaws.com',    smtp_port: 587, imap_host: '',                           imap_port: 0,   note: 'No IMAP with SES. Use a separate inbox for reply detection.' },
  smtp:      { label: 'Other / Custom SMTP',  smtp_host: '',                                      smtp_port: 587, imap_host: '',                           imap_port: 993, note: 'Enter your provider\'s SMTP and IMAP details manually.' },
};

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Parse both form and JSON bodies (test endpoints send JSON)
router.use(express.urlencoded({ extended: true }));
router.use(express.json());

// Resolve client_id: prefer JWT claim, fall back to first client in DB.
// This handles admin users created before tenancy was fully wired up.
async function resolveClientId(req) {
  if (req.user?.client_id) return req.user.client_id;
  const { rows } = await pool.query('SELECT id FROM clients ORDER BY id LIMIT 1');
  return rows[0]?.id || null;
}

// ─── GET /settings — hub page ────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  res.redirect('/settings/business');
});

function settingsNav(active) {
  const tabs = [
    { key: 'business', label: 'Business Info' },
    { key: 'email',    label: 'Email' },
    { key: 'phone',    label: 'Phone & SMS' },
    { key: 'email-sources', label: 'Email Sources' },
    { key: 'theme',    label: 'Theme & Branding' },
    { key: 'agents',   label: 'AI Agents' },
  ];
  return `
  <div class="bg-white border-b border-slate-100 mb-6">
    <div class="max-w-3xl mx-auto px-4 flex gap-1">
      ${tabs.map(t => `
      <a href="/settings/${t.key}"
        class="px-4 py-3 text-sm font-medium border-b-2 transition-colors
          ${active === t.key ? 'border-sky-600 text-sky-600' : 'border-transparent text-slate-500 hover:text-slate-700'}">
        ${t.label}
      </a>`).join('')}
    </div>
  </div>`;
}

function pageShell(title, active, body, msg, ok) {
  const content = `
  ${settingsNav(active)}
  <div class="max-w-3xl mx-auto px-6 pb-12">
    <h1 class="text-xl font-bold text-slate-900 mb-1">${esc(title)}</h1>
    ${msg ? `<div class="my-4 px-4 py-3 rounded-lg text-sm ${ok === '1' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}">${esc(msg)}</div>` : '<div class="mb-4"></div>'}
    ${body}
  </div>`;
  return shell(title, 'settings', content, {});
}

// ─── AI Agents ────────────────────────────────────────────────────────────────
// Per-tenant enablement for the AI marketing agents. Everything ships disabled;
// a tenant opts each agent in here. Only agents that are live can be toggled;
// the rest are shown as "coming soon" so operators know what's on the roadmap.
const AGENT_CATALOG = [
  { key: 'reporting',    label: 'Reporting Agent',    live: true,
    desc: 'Weekly cross-agent summary of what is working and what needs attention, delivered to this dashboard and Telegram. Read-only — never sends or spends.' },
  { key: 'segmentation', label: 'Segmentation Agent', live: true,
    desc: 'Sorts your contacts into engagement tiers (hot / warm / cool / cold) so messaging can differ by group. Read-only — labels contacts, never sends.' },
  { key: 'email',        label: 'Email Agent',        live: true,
    desc: 'Drafts personalized follow-ups for engaged contacts. Every draft waits for your approval below — nothing is sent until you click Approve.' },
  { key: 'research',     label: 'Lead Research Agent', live: true,
    desc: 'Enriches your existing contacts — infers missing product interest so segmentation and email drafts are sharper. Read-only.' },
  { key: 'planning',     label: 'Campaign Planning Agent', live: true,
    desc: 'Writes a monthly outreach plan (segments to target, themes, cadence) from your data. A recommendation — it never sends.' },
];

router.get('/agents', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const { rows } = await pool.query(
    `SELECT agent, enabled FROM client_agent_settings WHERE client_id = $1`, [clientId]
  );
  const enabledMap = Object.fromEntries(rows.map(r => [r.agent, r.enabled]));

  const cards = AGENT_CATALOG.map(a => {
    const on = enabledMap[a.key] === true;
    const toggle = a.live
      ? `<button type="submit" name="agent" value="${a.key}"
            class="shrink-0 px-4 py-2 rounded-lg text-sm font-semibold ${on
              ? 'bg-emerald-600 text-white hover:bg-emerald-700'
              : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">
            ${on ? 'Enabled — click to disable' : 'Disabled — click to enable'}
          </button>`
      : `<span class="shrink-0 px-3 py-2 rounded-lg text-xs font-medium bg-slate-100 text-slate-400">Coming soon</span>`;
    return `
    <div class="flex items-start gap-4 justify-between border border-slate-100 rounded-xl p-4 ${a.live ? '' : 'opacity-70'}">
      <div>
        <div class="font-semibold text-slate-900">${esc(a.label)}
          ${on ? '<span class="ml-2 align-middle inline-block w-2 h-2 rounded-full bg-emerald-500"></span>' : ''}
        </div>
        <p class="text-sm text-slate-500 mt-1">${esc(a.desc)}</p>
      </div>
      ${toggle}
    </div>`;
  }).join('');

  // Pending approvals — email drafts awaiting the operator's decision.
  const { rows: proposals } = await pool.query(
    `SELECT id, title, summary, payload, created_at
       FROM agent_proposals
      WHERE client_id = $1 AND agent = 'email' AND kind = 'email_draft' AND status = 'pending'
      ORDER BY created_at DESC LIMIT 50`, [clientId]
  );
  const proposalsHtml = proposals.length ? `
    <div class="mt-8">
      <h2 class="text-lg font-bold text-slate-900 mb-1">Pending email drafts</h2>
      <p class="text-sm text-slate-500 mb-4">Review each draft. Approve to send it now, or reject to discard. Nothing sends automatically.</p>
      <div class="space-y-4">
        ${proposals.map(p => `
        <div class="border border-slate-200 rounded-xl p-4">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="font-semibold text-slate-900 truncate">${esc(p.title)}</div>
              <div class="text-xs text-slate-400">To ${esc(p.payload?.to || '')} · drafted ${new Date(p.created_at).toLocaleString('en-US')}</div>
            </div>
            <div class="flex gap-2 shrink-0">
              <form method="post" action="/settings/agents/proposals/${p.id}/approve">
                <button class="px-3 py-1.5 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700">Approve &amp; send</button>
              </form>
              <form method="post" action="/settings/agents/proposals/${p.id}/reject">
                <button class="px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-100 text-slate-600 hover:bg-slate-200">Reject</button>
              </form>
            </div>
          </div>
          <pre class="mt-3 text-sm text-slate-700 whitespace-pre-wrap font-sans bg-slate-50 rounded-lg p-3">${esc(p.payload?.body || p.summary || '')}</pre>
        </div>`).join('')}
      </div>
    </div>` : '';

  // Latest monthly campaign plan (read-only recommendation).
  const { rows: planRows } = await pool.query(
    `SELECT period, plan, created_at FROM agent_plans WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [clientId]
  );
  const planHtml = planRows.length ? `
    <div class="mt-8">
      <h2 class="text-lg font-bold text-slate-900 mb-1">Monthly campaign plan</h2>
      <p class="text-xs text-slate-400 mb-3">${esc(planRows[0].period)} · generated ${new Date(planRows[0].created_at).toLocaleDateString('en-US')}</p>
      <pre class="text-sm text-slate-700 whitespace-pre-wrap font-sans bg-slate-50 rounded-lg p-4 border border-slate-100">${esc(planRows[0].plan)}</pre>
    </div>` : '';

  const body = `
  <p class="text-sm text-slate-500 mb-5">Turn AI marketing agents on for your account. All agents are off by default,
    and no agent sends email or spends money without your approval.</p>
  <form method="post" action="/settings/agents" class="space-y-3">${cards}</form>
  ${proposalsHtml}
  ${planHtml}`;

  res.send(pageShell('AI Agents', 'agents', body, req.query.msg, req.query.ok));
});

router.post('/agents', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const agent = String(req.body.agent || '');
  const catalogEntry = AGENT_CATALOG.find(a => a.key === agent && a.live);
  if (!clientId || !catalogEntry) {
    return res.redirect('/settings/agents?ok=0&msg=' + encodeURIComponent('Unknown or unavailable agent.'));
  }
  const { rows } = await pool.query(
    `SELECT enabled FROM client_agent_settings WHERE client_id = $1 AND agent = $2`, [clientId, agent]
  );
  const nextEnabled = !(rows[0]?.enabled === true);
  const { setAgentEnabled } = require('../lib/agents/runner');
  await setAgentEnabled(clientId, agent, nextEnabled);
  res.redirect('/settings/agents?ok=1&msg=' +
    encodeURIComponent(`${catalogEntry.label} ${nextEnabled ? 'enabled' : 'disabled'}.`));
});

// Approve a pending email draft → sends it now (with suppression/unsubscribe guards).
router.post('/agents/proposals/:id/approve', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const id = parseInt(req.params.id, 10);
  const decidedBy = req.user?.email || req.user?.name || 'operator';
  const { sendApprovedDraft } = require('../lib/agents/email');
  let r;
  try { r = await sendApprovedDraft(id, clientId, decidedBy); }
  catch (err) { r = { ok: false, error: err.message }; }
  const msg = r.ok
    ? 'Draft approved and sent.'
    : `Could not send: ${r.error === 'suppressed_or_unsubscribed' ? 'recipient is unsubscribed/suppressed (draft discarded)' : r.error}`;
  res.redirect(`/settings/agents?ok=${r.ok ? 1 : 0}&msg=${encodeURIComponent(msg)}`);
});

// Reject a pending email draft → discarded, never sent.
router.post('/agents/proposals/:id/reject', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const id = parseInt(req.params.id, 10);
  const decidedBy = req.user?.email || req.user?.name || 'operator';
  const { rejectDraft } = require('../lib/agents/email');
  const r = await rejectDraft(id, clientId, decidedBy);
  res.redirect(`/settings/agents?ok=1&msg=${encodeURIComponent(r.ok ? 'Draft rejected.' : 'Draft already decided.')}`);
});

// ─── Email Sources (multiple intake inboxes + sender rules) ───────────────────
// Per-tenant. Connect several Gmail (OAuth) or IMAP inboxes as lead sources,
// each with a capture policy and sender rules. Credentials are encrypted and
// scoped by client_id. Polling happens in the cron (next increment).

function sourceRedirectUri(req) {
  if (process.env.GOOGLE_SOURCE_REDIRECT_URI) return process.env.GOOGLE_SOURCE_REDIRECT_URI;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.get('host')}/settings/email-sources/gmail/callback`;
}
function sourceOAuthClient(req) {
  return new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, sourceRedirectUri(req));
}
const gmailSourceEnabled = () => !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);

function renderRule(r, salespeople, sequences) {
  const seq = sequences.find(s => String(s.id) === String(r.sequence_id));
  const sp  = salespeople.find(s => String(s.id) === String(r.assign_salesperson_id));
  const bits = [];
  if (r.action === 'ignore') bits.push('ignore');
  else {
    bits.push('capture');
    if (seq) bits.push(`→ sequence “${esc(seq.name)}”`);
    if (sp)  bits.push(`→ assign ${esc(sp.name)}`);
    if (r.tag) bits.push(`→ tag “${esc(r.tag)}”`);
  }
  return `
  <div class="flex items-center justify-between gap-3 text-sm py-1.5 border-t border-slate-100 first:border-0">
    <div class="text-slate-600">
      <span class="font-mono text-xs bg-slate-100 rounded px-1.5 py-0.5">${esc(r.match_type)}</span>
      <span class="font-medium text-slate-800">${esc(r.match_value)}</span>
      <span class="text-slate-400">${bits.join(' ')}</span>
    </div>
    <form method="post" action="/settings/email-sources/rules/${r.id}/delete">
      <button class="text-xs text-red-500 hover:text-red-600">remove</button>
    </form>
  </div>`;
}

function ruleForm(sourceId, salespeople, sequences) {
  const spOpts  = salespeople.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const seqOpts = sequences.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const inp = 'border border-slate-200 rounded px-2 py-1 text-xs';
  return `
  <form method="post" action="/settings/email-sources/${sourceId}/rules" class="flex flex-wrap items-end gap-2 mt-2 pt-2 border-t border-slate-100">
    <select name="match_type" class="${inp}"><option value="domain">domain</option><option value="email">email</option></select>
    <input name="match_value" placeholder="cargurus.com" required class="${inp}" style="min-width:150px">
    <select name="action" class="${inp}"><option value="capture">capture</option><option value="ignore">ignore</option></select>
    <select name="sequence_id" class="${inp}"><option value="">— sequence —</option>${seqOpts}</select>
    <select name="assign_salesperson_id" class="${inp}"><option value="">— assign —</option>${spOpts}</select>
    <input name="tag" placeholder="tag" class="${inp}" style="width:80px">
    <button class="text-xs font-semibold bg-slate-700 text-white rounded px-3 py-1.5 hover:bg-slate-800">Add rule</button>
  </form>`;
}

function renderSource(src, rules, salespeople, sequences) {
  const typeBadge = src.type === 'gmail'
    ? '<span class="text-xs font-medium px-2 py-0.5 rounded-full bg-red-50 text-red-600">Gmail</span>'
    : '<span class="text-xs font-medium px-2 py-0.5 rounded-full bg-sky-50 text-sky-600">IMAP</span>';
  const on = src.enabled;
  const srcRules = rules.filter(r => String(r.source_id) === String(src.id) || r.source_id === null);
  return `
  <div class="border border-slate-200 rounded-xl p-4 ${on ? '' : 'opacity-60'}">
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-semibold text-slate-900 truncate">${esc(src.label)}</span> ${typeBadge}
          ${src.last_error ? `<span class="text-xs text-red-500" title="${esc(src.last_error)}">⚠ error</span>` : ''}
        </div>
        <div class="text-xs text-slate-400 mt-0.5">${esc(src.email_address || src.imap_user || '')}
          · last poll ${src.last_polled_at ? new Date(src.last_polled_at).toLocaleString('en-US') : 'never'}</div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <form method="post" action="/settings/email-sources/${src.id}/policy">
          <select name="capture_policy" onchange="this.form.submit()" class="text-xs border border-slate-200 rounded px-2 py-1">
            <option value="allowlist" ${src.capture_policy === 'allowlist' ? 'selected' : ''}>Only allowlisted senders</option>
            <option value="all" ${src.capture_policy === 'all' ? 'selected' : ''}>Capture all senders</option>
          </select>
        </form>
        <form method="post" action="/settings/email-sources/${src.id}/toggle">
          <button class="text-xs font-semibold px-3 py-1.5 rounded-lg ${on ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}">${on ? 'On' : 'Off'}</button>
        </form>
        <form method="post" action="/settings/email-sources/${src.id}/delete" onsubmit="return confirm('Remove this email source?')">
          <button class="text-xs text-red-500 hover:text-red-600 px-2">Remove</button>
        </form>
      </div>
    </div>
    <div class="mt-3">
      <div class="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Sender rules</div>
      ${srcRules.length ? srcRules.map(r => renderRule(r, salespeople, sequences)).join('') : '<p class="text-xs text-slate-400">No rules yet. With “Only allowlisted senders,” add a capture rule so this inbox pulls in leads.</p>'}
      ${ruleForm(src.id, salespeople, sequences)}
    </div>
  </div>`;
}

router.get('/email-sources', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const [{ rows: sources }, { rows: rules }, { rows: salespeople }, { rows: sequences }] = await Promise.all([
    pool.query('SELECT * FROM email_sources WHERE client_id = $1 ORDER BY id', [clientId]),
    pool.query('SELECT * FROM email_source_rules WHERE client_id = $1 ORDER BY source_id NULLS FIRST, priority, id', [clientId]),
    pool.query('SELECT id, name FROM salespeople WHERE client_id = $1 AND active = true ORDER BY name', [clientId]),
    pool.query('SELECT id, name FROM sequences WHERE client_id = $1 OR client_id IS NULL ORDER BY name', [clientId]),
  ]);

  const body = `
  <p class="text-sm text-slate-500 mb-5">Connect one or more inboxes to pull in leads. For each, choose whether to capture
    every sender or only the senders you allow, and add rules to route or ignore specific senders. You can add as many as you need.</p>

  <div class="flex flex-wrap gap-3 mb-6">
    ${gmailSourceEnabled() ? `
    <a href="/settings/email-sources/gmail/connect"
      class="inline-flex items-center gap-2 border border-slate-300 rounded-lg px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
      <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
      Connect a Gmail inbox
    </a>` : ''}
  </div>

  <details class="mb-6 border border-slate-200 rounded-xl p-4">
    <summary class="text-sm font-medium text-slate-700 cursor-pointer">Add an IMAP inbox (IONOS, Outlook, other)</summary>
    <form method="post" action="/settings/email-sources/imap" class="grid grid-cols-2 gap-3 mt-4">
      <div><label class="block text-xs text-slate-500 mb-1">Label</label><input name="label" required placeholder="Sales inbox" class="w-full border rounded-lg px-3 py-2 text-sm"></div>
      <div><label class="block text-xs text-slate-500 mb-1">Email address</label><input name="email_address" type="email" placeholder="sales@example.com" class="w-full border rounded-lg px-3 py-2 text-sm"></div>
      <div><label class="block text-xs text-slate-500 mb-1">IMAP host</label><input name="imap_host" required placeholder="imap.ionos.com" class="w-full border rounded-lg px-3 py-2 text-sm"></div>
      <div><label class="block text-xs text-slate-500 mb-1">Port</label><input name="imap_port" type="number" value="993" class="w-full border rounded-lg px-3 py-2 text-sm"></div>
      <div><label class="block text-xs text-slate-500 mb-1">Username</label><input name="imap_user" required placeholder="sales@example.com" class="w-full border rounded-lg px-3 py-2 text-sm"></div>
      <div><label class="block text-xs text-slate-500 mb-1">Password</label><input name="imap_pass" type="password" required class="w-full border rounded-lg px-3 py-2 text-sm"></div>
      <div class="col-span-2 flex justify-end"><button class="bg-sky-600 text-white rounded-lg px-5 py-2 text-sm font-medium hover:bg-sky-700">Add IMAP inbox</button></div>
    </form>
  </details>

  <div class="space-y-4">
    ${sources.length ? sources.map(s => renderSource(s, rules, salespeople, sequences)).join('') : '<p class="text-sm text-slate-400">No inboxes connected yet. Add one above to start pulling in leads.</p>'}
  </div>`;

  res.send(pageShell('Email Sources', 'email-sources', body, req.query.msg, req.query.ok));
});

// Add an IMAP source
router.post('/email-sources/imap', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const { label, email_address, imap_host, imap_port, imap_user, imap_pass } = req.body;
  if (!clientId || !label || !imap_host || !imap_user || !imap_pass) {
    return res.redirect('/settings/email-sources?ok=0&msg=' + encodeURIComponent('Missing required IMAP fields.'));
  }
  await pool.query(
    `INSERT INTO email_sources (client_id, label, type, email_address, imap_host, imap_port, imap_user, imap_pass_enc)
     VALUES ($1, $2, 'imap', $3, $4, $5, $6, $7)`,
    [clientId, label.trim(), (email_address || imap_user).trim(), imap_host.trim(),
     parseInt(imap_port, 10) || 993, imap_user.trim(), encrypt(imap_pass)]
  );
  res.redirect('/settings/email-sources?ok=1&msg=' + encodeURIComponent('IMAP inbox added.'));
});

// Toggle enabled
router.post('/email-sources/:id/toggle', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  await pool.query('UPDATE email_sources SET enabled = NOT enabled, updated_at = NOW() WHERE id = $1 AND client_id = $2',
    [parseInt(req.params.id, 10), clientId]);
  res.redirect('/settings/email-sources');
});

// Set capture policy
router.post('/email-sources/:id/policy', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const policy = req.body.capture_policy === 'all' ? 'all' : 'allowlist';
  await pool.query('UPDATE email_sources SET capture_policy = $1, updated_at = NOW() WHERE id = $2 AND client_id = $3',
    [policy, parseInt(req.params.id, 10), clientId]);
  res.redirect('/settings/email-sources');
});

// Delete a source
router.post('/email-sources/:id/delete', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  await pool.query('DELETE FROM email_sources WHERE id = $1 AND client_id = $2', [parseInt(req.params.id, 10), clientId]);
  res.redirect('/settings/email-sources?ok=1&msg=' + encodeURIComponent('Inbox removed.'));
});

// Add a sender rule
router.post('/email-sources/:id/rules', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const sourceId = parseInt(req.params.id, 10);
  const { match_type, match_value, action, sequence_id, assign_salesperson_id, tag } = req.body;
  // Confirm the source belongs to this tenant before attaching a rule.
  const { rows } = await pool.query('SELECT id FROM email_sources WHERE id = $1 AND client_id = $2', [sourceId, clientId]);
  if (!rows.length || !match_value) return res.redirect('/settings/email-sources?ok=0&msg=' + encodeURIComponent('Could not add rule.'));
  await pool.query(
    `INSERT INTO email_source_rules (client_id, source_id, match_type, match_value, action, sequence_id, assign_salesperson_id, tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [clientId, sourceId,
     match_type === 'email' ? 'email' : 'domain',
     String(match_value).toLowerCase().trim(),
     action === 'ignore' ? 'ignore' : 'capture',
     sequence_id ? parseInt(sequence_id, 10) : null,
     assign_salesperson_id ? parseInt(assign_salesperson_id, 10) : null,
     tag ? String(tag).trim() : null]
  );
  res.redirect('/settings/email-sources?ok=1&msg=' + encodeURIComponent('Rule added.'));
});

// Delete a rule
router.post('/email-sources/rules/:ruleId/delete', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  await pool.query('DELETE FROM email_source_rules WHERE id = $1 AND client_id = $2', [parseInt(req.params.ruleId, 10), clientId]);
  res.redirect('/settings/email-sources');
});

// Start Gmail-source OAuth (read-only, offline for refresh token)
router.get('/email-sources/gmail/connect', requireAuth, (req, res) => {
  if (!gmailSourceEnabled()) return res.redirect('/settings/email-sources?ok=0&msg=' + encodeURIComponent('Gmail connect is not configured.'));
  const nonce = crypto.randomBytes(16).toString('hex');
  res.cookie('es_gmail_nonce', nonce, { maxAge: 10 * 60 * 1000, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
  const url = sourceOAuthClient(req).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.readonly', 'openid', 'email'],
    state: signOAuthState(nonce),
  });
  res.redirect(url);
});

// Gmail-source OAuth callback → store tokens on a new source row
router.get('/email-sources/gmail/callback', requireAuth, async (req, res) => {
  if (!gmailSourceEnabled()) return res.redirect('/settings/email-sources?ok=0&msg=' + encodeURIComponent('Gmail connect is not configured.'));
  const clientId = await resolveClientId(req);
  try {
    const { code, state } = req.query;
    const stateNonce = verifyOAuthState(state);
    const cookieNonce = req.cookies?.es_gmail_nonce;
    res.clearCookie('es_gmail_nonce');
    if (!code || !stateNonce || stateNonce !== cookieNonce) {
      return res.redirect('/settings/email-sources?ok=0&msg=' + encodeURIComponent('Google connection failed, please retry.'));
    }
    const oauth = sourceOAuthClient(req);
    const { tokens } = await oauth.getToken(String(code));
    let email = '';
    if (tokens.id_token) {
      const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GMAIL_CLIENT_ID });
      email = String(ticket.getPayload()?.email || '').toLowerCase();
    }
    if (!tokens.refresh_token) {
      return res.redirect('/settings/email-sources?ok=0&msg=' + encodeURIComponent('No refresh token returned — remove app access in your Google account and reconnect.'));
    }
    await pool.query(
      `INSERT INTO email_sources (client_id, label, type, email_address, oauth_refresh_enc, oauth_access_enc, oauth_expiry)
       VALUES ($1, $2, 'gmail', $3, $4, $5, $6)`,
      [clientId, email || 'Gmail inbox', email,
       encrypt(tokens.refresh_token), tokens.access_token ? encrypt(tokens.access_token) : null,
       tokens.expiry_date ? new Date(tokens.expiry_date) : null]
    );
    res.redirect('/settings/email-sources?ok=1&msg=' + encodeURIComponent(`Connected ${email || 'Gmail inbox'}.`));
  } catch (err) {
    console.error('[email-sources] gmail connect error:', err.message);
    res.redirect('/settings/email-sources?ok=0&msg=' + encodeURIComponent('Google connection failed, please retry.'));
  }
});

// ─── Business Info ────────────────────────────────────────────────────────────
router.get('/business', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const { rows } = await pool.query('SELECT brand_config, integration_settings FROM clients WHERE id = $1', [clientId]);
  const bc = rows[0]?.brand_config || {};
  const isg = rows[0]?.integration_settings || {};
  const { rows: authDomains } = await pool.query(
    'SELECT id, domain, default_role FROM client_auth_domains WHERE client_id = $1 ORDER BY domain', [clientId]
  );

  const body = `
  <form method="POST" action="/settings/business">
    <div class="bg-white rounded-xl shadow-sm p-6 space-y-4">
      <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide">Business Identity</h2>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Business Name</label>
          <input name="name" value="${esc(bc.name)}" placeholder="SureSecured"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Website</label>
          <input name="website" value="${esc(bc.website)}" placeholder="suresecured.com"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
      </div>

      <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide pt-2">Contact Information</h2>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Phone</label>
          <input name="phone" value="${esc(bc.phone)}" placeholder="(747) 688-9992"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Support Email</label>
          <input name="support_email" type="email" value="${esc(bc.support_email)}" placeholder="info@suresecured.com"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
      </div>

      <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide pt-2">Address</h2>
      <div>
        <label class="block text-xs font-medium text-slate-500 mb-1">Street Address</label>
        <input name="address_street" value="${esc(bc.address_street)}" placeholder="1234 Main St"
          class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
      </div>
      <div class="grid grid-cols-3 gap-4">
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">City</label>
          <input name="address_city" value="${esc(bc.address_city)}" placeholder="Simi Valley"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">State</label>
          <input name="address_state" value="${esc(bc.address_state)}" placeholder="CA"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">ZIP</label>
          <input name="address_zip" value="${esc(bc.address_zip)}" placeholder="93063"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
      </div>

      <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide pt-2">Email Footer</h2>
      <div>
        <label class="block text-xs font-medium text-slate-500 mb-1">Footer Address Line (shown in email footers)</label>
        <input name="address" value="${esc(bc.address)}" placeholder="SureSecured Security Products • Simi Valley, CA 93063"
          class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        <p class="text-xs text-slate-400 mt-1">Auto-generated from fields above if left blank on next save.</p>
      </div>

      <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide pt-2">Email CTA</h2>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">CTA Button Label</label>
          <input name="cta_label" value="${esc(bc.cta_label)}" placeholder="Request a Quote"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">CTA URL</label>
          <input name="cta_url" value="${esc(bc.cta_url)}" placeholder="https://suresecured.com/pages/request-a-quote"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
      </div>

      <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide pt-2">Store Connection (Shopify)</h2>
      <div>
        <label class="block text-xs font-medium text-slate-500 mb-1">Shopify store domain</label>
        <input name="shopify_domain" value="${esc(isg.shopify_domain)}" placeholder="suresecured.myshopify.com"
          class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        <p class="text-xs text-slate-400 mt-1">
          Your permanent <strong>.myshopify.com</strong> address (Shopify admin → Settings → Domains).
          This links incoming orders to your account so sales and commissions get recorded. Required for commission tracking.
        </p>
      </div>
    </div>

    <div class="flex justify-end mt-4">
      <button type="submit" class="bg-sky-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-sky-700">Save Business Info</button>
    </div>
  </form>

  <div class="mt-6 bg-white rounded-xl shadow-sm p-6">
    <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide mb-1">Team Google Sign-in</h2>
    <p class="text-xs text-slate-500 mb-4">Anyone with an email on these domains can sign in with Google and automatically get a seat on your account.
      Leave empty to require that each teammate be added manually first. Public providers (gmail.com, outlook.com, etc.) can’t be used.</p>
    <div class="space-y-2 mb-4">
      ${authDomains.map(d => `
      <div class="flex items-center justify-between border border-slate-100 rounded-lg px-3 py-2 text-sm">
        <span><span class="font-medium text-slate-800">@${esc(d.domain)}</span> <span class="text-slate-400">→ joins as ${esc(d.default_role)}</span></span>
        <form method="post" action="/settings/business/auth-domains/${d.id}/delete"><button class="text-xs text-red-500 hover:text-red-600">remove</button></form>
      </div>`).join('') || '<p class="text-xs text-slate-400">No domains yet — teammates must be added manually.</p>'}
    </div>
    <form method="post" action="/settings/business/auth-domains" class="flex flex-wrap items-end gap-2">
      <div><label class="block text-xs text-slate-500 mb-1">Domain</label><input name="domain" required placeholder="yourcompany.com" class="border rounded-lg px-3 py-2 text-sm"></div>
      <div><label class="block text-xs text-slate-500 mb-1">Joins as</label>
        <select name="default_role" class="border rounded-lg px-3 py-2 text-sm">
          <option value="salesperson">Salesperson</option><option value="operator">Operator</option><option value="owner">Owner</option><option value="admin">Admin</option>
        </select></div>
      <button class="bg-slate-700 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-slate-800">Add domain</button>
    </form>
  </div>`;

  res.send(pageShell('Business Info', 'business', body, req.query.msg, req.query.ok));
});

// Public/free email providers can't be claimed as auto-join domains.
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me',
  'protonmail.com', 'gmx.com', 'zoho.com', 'yandex.com', 'mail.com',
]);

router.post('/business/auth-domains', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const domain = String(req.body.domain || '').toLowerCase().trim()
    .replace(/^@/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const role = ['salesperson', 'operator', 'owner', 'admin'].includes(req.body.default_role) ? req.body.default_role : 'salesperson';
  if (!clientId || !domain || !domain.includes('.') || /\s/.test(domain)) {
    return res.redirect('/settings/business?ok=0&msg=' + encodeURIComponent('Enter a valid company domain.'));
  }
  if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
    return res.redirect('/settings/business?ok=0&msg=' + encodeURIComponent('Public email providers can’t be used for auto-join.'));
  }
  try {
    await pool.query('INSERT INTO client_auth_domains (client_id, domain, default_role) VALUES ($1, $2, $3)', [clientId, domain, role]);
    res.redirect('/settings/business?ok=1&msg=' + encodeURIComponent(`Domain @${domain} added.`));
  } catch (err) {
    res.redirect('/settings/business?ok=0&msg=' + encodeURIComponent(`@${domain} is already registered.`));
  }
});

router.post('/business/auth-domains/:id/delete', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  await pool.query('DELETE FROM client_auth_domains WHERE id = $1 AND client_id = $2', [parseInt(req.params.id, 10), clientId]);
  res.redirect('/settings/business?ok=1&msg=' + encodeURIComponent('Domain removed.'));
});

router.post('/business', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const { rows } = await pool.query('SELECT brand_config, integration_settings FROM clients WHERE id = $1', [clientId]);
  const existing = rows[0]?.brand_config || {};
  const existingIntegrations = rows[0]?.integration_settings || {};

  const { name, website, phone, support_email, address_street, address_city, address_state, address_zip, address, cta_label, cta_url, shopify_domain } = req.body;

  const footerAddress = address?.trim() ||
    [name, [address_street, address_city, address_state, address_zip].filter(Boolean).join(', ')].filter(Boolean).join(' • ');

  const updated = {
    ...existing,
    name, website, phone, support_email,
    address_street, address_city, address_state, address_zip,
    address: footerAddress,
    cta_label, cta_url,
  };

  // Normalize the Shopify domain to the bare host Shopify sends in the
  // x-shopify-shop-domain header (e.g. "suresecured.myshopify.com").
  const normalizedDomain = String(shopify_domain || '')
    .trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const updatedIntegrations = { ...existingIntegrations, shopify_domain: normalizedDomain };

  await pool.query(
    'UPDATE clients SET brand_config = $1, integration_settings = $2 WHERE id = $3',
    [JSON.stringify(updated), JSON.stringify(updatedIntegrations), clientId]
  );
  res.redirect('/settings/business?ok=1&msg=Business+info+saved.');
});

// ─── Email Settings ───────────────────────────────────────────────────────────
router.get('/email', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const [{ rows }, { rows: gmailRows }, { rows: seqRows }] = await Promise.all([
    pool.query('SELECT * FROM client_email_config WHERE client_id = $1', [clientId]),
    pool.query('SELECT email FROM email_accounts WHERE salesperson_id = $1 AND enabled = true', [req.user?.id]),
    pool.query('SELECT id, name FROM sequences WHERE active = true ORDER BY name'),
  ]);
  const cfg = rows[0] || {};
  const gmailAccount = gmailRows[0] || null;
  const sequences = seqRows;

  const body = `
    ${gmailAccount ? `
    <!-- Gmail connected banner — OUTSIDE the settings form to avoid nested form issue -->
    <div class="bg-green-50 border border-green-200 rounded-xl p-4 mb-4 flex items-center justify-between">
      <div>
        <p class="text-sm font-semibold text-green-800">✓ Gmail Connected — outbound email active</p>
        <p class="text-xs text-green-700 mt-0.5">
          Sending as <strong>${esc(cfg.from_email || gmailAccount.email)}</strong> via Gmail OAuth
          ${cfg.from_email && cfg.from_email !== gmailAccount.email ? `<span class="text-green-600">(Send As alias — Gmail account: ${esc(gmailAccount.email)})</span>` : ''}.
          SMTP settings below are ignored for outbound.
        </p>
      </div>
      <button onclick="disconnectGmail()" class="text-xs text-red-600 border border-red-200 px-3 py-1.5 rounded-lg hover:bg-red-50">Disconnect</button>
    </div>` : ''}

  <form method="POST" action="/settings/email" id="email-form">

    <!-- Provider selector -->
    <div class="bg-white rounded-xl shadow-sm p-6 mb-4">
      <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide mb-3">Email Provider</h2>
      <div class="grid grid-cols-2 gap-2 mb-3">
        ${Object.entries(PROVIDERS).map(([key, p]) => key === 'google' ? `
        <a href="/gmail/connect/${esc(String(req.user?.id || ''))}" data-provider="google"
          class="provider-btn text-left px-3 py-2.5 rounded-lg border text-sm transition
            ${(cfg.provider || 'smtp') === 'google'
              ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-200'}">
          ${esc(p.label)} →
        </a>` : `
        <button type="button" onclick="selectProvider('${key}')" data-provider="${key}"
          class="provider-btn text-left px-3 py-2.5 rounded-lg border text-sm transition
            ${(cfg.provider || 'smtp') === key
              ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-200'}">
          ${esc(p.label)}
        </button>`).join('')}
      </div>
      <input type="hidden" name="provider" id="provider-value" value="${esc(cfg.provider || 'smtp')}">
      <div id="provider-note" class="text-xs text-blue-700 bg-blue-50 border border-blue-100 px-3 py-2 rounded-lg mt-2 hidden"></div>
    </div>

    <!-- SMTP -->
    <div class="bg-white rounded-xl shadow-sm p-6 mb-4">
      <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide mb-3">Outgoing Mail (SMTP)</h2>
      <div class="grid grid-cols-3 gap-3 mb-3">
        <div class="col-span-2">
          <label class="block text-xs font-medium text-slate-500 mb-1">SMTP Host</label>
          <input name="smtp_host" id="smtp_host" value="${esc(cfg.smtp_host)}" placeholder="smtp.example.com"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Port</label>
          <input name="smtp_port" id="smtp_port" type="number" value="${cfg.smtp_port || 587}"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Username / Email</label>
          <input name="smtp_user" value="${esc(cfg.smtp_user)}" placeholder="you@domain.com"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Password / App Password</label>
          <input type="password" name="smtp_pass" placeholder="${cfg.smtp_pass_enc ? '••••••••••••  (saved)' : 'Enter password'}"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
          ${cfg.smtp_pass_enc ? '<p class="text-xs text-slate-400 mt-1">Leave blank to keep existing</p>' : ''}
        </div>
      </div>
      <label class="flex items-center gap-2 mb-3 text-sm text-slate-600 cursor-pointer">
        <input type="checkbox" name="smtp_secure" value="1" ${cfg.smtp_secure ? 'checked' : ''} class="rounded">
        Use SSL on port 465 (leave unchecked for STARTTLS on 587)
      </label>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">From Name</label>
          <input name="from_name" value="${esc(cfg.from_name)}" placeholder="SureSecured Sales"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">From Email</label>
          <input name="from_email" type="email" value="${esc(cfg.from_email)}" placeholder="sales@domain.com"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
      </div>
      <div class="mb-4">
        <label class="block text-xs font-medium text-slate-500 mb-1">Reply-To (optional)</label>
        <input name="reply_to" type="email" value="${esc(cfg.reply_to)}" placeholder="Leave blank to use From Email"
          class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
      </div>
      ${gmailAccount ? `<p class="text-xs text-slate-400 italic">SMTP not used — Gmail OAuth is active for outbound.</p>` : `
      <button type="button" onclick="testSmtp()"
        class="text-sm text-blue-600 border border-blue-200 bg-blue-50 px-4 py-1.5 rounded-lg hover:bg-blue-100">
        Test SMTP Connection
      </button>
      <span id="smtp-test-result" class="text-sm ml-3 hidden"></span>`}
    </div>

    <!-- IMAP -->
    <div class="bg-white rounded-xl shadow-sm p-6 mb-4" id="imap-section">
      <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide mb-1">Incoming Mail (IMAP)</h2>
      <p class="text-xs text-slate-400 mb-3">Used to detect when leads reply to your emails.</p>
      <div class="grid grid-cols-3 gap-3 mb-3">
        <div class="col-span-2">
          <label class="block text-xs font-medium text-slate-500 mb-1">IMAP Host</label>
          <input name="imap_host" id="imap_host" value="${esc(cfg.imap_host)}" placeholder="imap.example.com"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Port</label>
          <input name="imap_port" id="imap_port" type="number" value="${cfg.imap_port || 993}"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3 mb-4">
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Username / Email</label>
          <input name="imap_user" value="${esc(cfg.imap_user)}" placeholder="Same as SMTP username"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Password / App Password</label>
          <input type="password" name="imap_pass" placeholder="${cfg.imap_pass_enc ? '••••••••••••  (saved)' : 'Enter password'}"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
          ${cfg.imap_pass_enc ? '<p class="text-xs text-slate-400 mt-1">Leave blank to keep existing</p>' : ''}
        </div>
      </div>
      <button type="button" onclick="testImap()"
        class="text-sm text-blue-600 border border-blue-200 bg-blue-50 px-4 py-1.5 rounded-lg hover:bg-blue-100">
        Test IMAP Connection
      </button>
      <span id="imap-test-result" class="text-sm ml-3 hidden"></span>
    </div>

    <!-- Inbound Lead Capture -->
    <div class="bg-white rounded-xl shadow-sm p-6 mb-4">
      <div class="flex items-center justify-between mb-3">
        <div>
          <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide">Inbound Lead Capture</h2>
          <p class="text-xs text-slate-400 mt-0.5">Automatically create a lead when someone emails you who isn't already in your database.</p>
        </div>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" name="inbound_capture_enabled" value="1" ${cfg.inbound_capture_enabled ? 'checked' : ''}
            class="w-4 h-4 rounded accent-sky-600">
          <span class="text-sm text-slate-600">Enabled</span>
        </label>
      </div>
      <div>
        <label class="block text-xs font-medium text-slate-500 mb-1">Auto-enroll new leads into sequence (optional)</label>
        <select name="inbound_sequence_id" class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
          <option value="">— Don't auto-enroll —</option>
          ${sequences.map(s => `<option value="${s.id}" ${cfg.inbound_sequence_id == s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
        <p class="text-xs text-slate-400 mt-1">Requires Gmail to be connected above. Runs every 15 minutes.</p>
      </div>
    </div>

    <div class="flex justify-end">
      <button type="submit" class="bg-sky-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-sky-700">Save Email Settings</button>
    </div>
  </form>

  <script>
    const PRESETS = ${JSON.stringify(PROVIDERS)};
    function selectProvider(key, fillFields = true) {
      document.getElementById('provider-value').value = key;
      document.querySelectorAll('.provider-btn').forEach(btn => {
        const active = btn.dataset.provider === key;
        btn.className = 'provider-btn text-left px-3 py-2.5 rounded-lg border text-sm transition ' +
          (active ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-200');
      });
      const p = PRESETS[key]; if (!p) return;
      if (fillFields) {
        if (p.smtp_host !== undefined) document.querySelector('[name=smtp_host]').value = p.smtp_host;
        if (p.smtp_port) document.querySelector('[name=smtp_port]').value = p.smtp_port;
        if (p.imap_host !== undefined) document.querySelector('[name=imap_host]').value = p.imap_host;
        if (p.imap_port) document.querySelector('[name=imap_port]').value = p.imap_port;
      }
      document.getElementById('imap-section').style.display = key === 'ses' ? 'none' : '';
      const noteEl = document.getElementById('provider-note');
      noteEl.textContent = p.note || '';
      noteEl.classList.toggle('hidden', !p.note);
    }
    // On load: highlight active provider button only — don't overwrite saved field values
    selectProvider(document.getElementById('provider-value').value, false);

    async function disconnectGmail() {
      await fetch('/gmail/disconnect/${esc(String(req.user?.id || ''))}', { method: 'POST' });
      location.reload();
    }

    async function testSmtp() {
      const btn = event.target; btn.disabled = true; btn.textContent = 'Testing…';
      const result = document.getElementById('smtp-test-result'); result.classList.add('hidden');
      const r = await fetch('/settings/email/test-smtp', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ smtp_host: document.querySelector('[name=smtp_host]').value,
          smtp_port: document.querySelector('[name=smtp_port]').value,
          smtp_secure: document.querySelector('[name=smtp_secure]').checked,
          smtp_user: document.querySelector('[name=smtp_user]').value,
          smtp_pass: document.querySelector('[name=smtp_pass]').value }) });
      const d = await r.json();
      result.classList.remove('hidden'); result.textContent = d.ok ? '✓ Connected' : '✗ ' + d.error;
      result.className = 'text-sm ml-3 ' + (d.ok ? 'text-green-600' : 'text-red-600');
      btn.disabled = false; btn.textContent = 'Test SMTP Connection';
    }
    async function testImap() {
      const btn = event.target; btn.disabled = true; btn.textContent = 'Testing…';
      const result = document.getElementById('imap-test-result'); result.classList.add('hidden');
      const r = await fetch('/settings/email/test-imap', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ imap_host: document.querySelector('[name=imap_host]').value,
          imap_port: document.querySelector('[name=imap_port]').value,
          imap_user: document.querySelector('[name=imap_user]').value,
          imap_pass: document.querySelector('[name=imap_pass]').value }) });
      const d = await r.json();
      result.classList.remove('hidden'); result.textContent = d.ok ? '✓ Connected' : '✗ ' + d.error;
      result.className = 'text-sm ml-3 ' + (d.ok ? 'text-green-600' : 'text-red-600');
      btn.disabled = false; btn.textContent = 'Test IMAP Connection';
    }
  </script>`;

  res.send(pageShell('Email Settings', 'email', body, req.query.msg, req.query.ok));
});

router.post('/email', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const { provider, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, from_name, from_email, reply_to, imap_host, imap_port, imap_user, imap_pass, inbound_capture_enabled, inbound_sequence_id } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM client_email_config WHERE client_id = $1', [clientId]);
    const ex = rows[0] || {};
    // Preserve existing value for any field left blank
    const val = (v, fallback) => v?.trim() || fallback || null;
    const smtpPassEnc = smtp_pass?.trim() ? encrypt(smtp_pass.trim()) : ex.smtp_pass_enc || null;
    const imapPassEnc = imap_pass?.trim() ? encrypt(imap_pass.trim()) : ex.imap_pass_enc || null;
    await pool.query(`
      INSERT INTO client_email_config (client_id,provider,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_pass_enc,from_name,from_email,reply_to,imap_host,imap_port,imap_user,imap_pass_enc,inbound_capture_enabled,inbound_sequence_id,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
      ON CONFLICT (client_id) DO UPDATE SET
        provider=EXCLUDED.provider, smtp_host=EXCLUDED.smtp_host, smtp_port=EXCLUDED.smtp_port,
        smtp_secure=EXCLUDED.smtp_secure, smtp_user=EXCLUDED.smtp_user, smtp_pass_enc=EXCLUDED.smtp_pass_enc,
        from_name=EXCLUDED.from_name, from_email=EXCLUDED.from_email, reply_to=EXCLUDED.reply_to,
        imap_host=EXCLUDED.imap_host, imap_port=EXCLUDED.imap_port, imap_user=EXCLUDED.imap_user,
        imap_pass_enc=EXCLUDED.imap_pass_enc,
        inbound_capture_enabled=EXCLUDED.inbound_capture_enabled,
        inbound_sequence_id=EXCLUDED.inbound_sequence_id,
        updated_at=NOW()
    `, [
      clientId,
      val(provider, ex.provider) || 'smtp',
      val(smtp_host, ex.smtp_host),
      parseInt(smtp_port) || ex.smtp_port || 587,
      smtp_secure === '1' ? true : (smtp_port ? false : ex.smtp_secure || false),
      val(smtp_user, ex.smtp_user),
      smtpPassEnc,
      val(from_name, ex.from_name),
      val(from_email, ex.from_email),
      val(reply_to, ex.reply_to),
      val(imap_host, ex.imap_host),
      parseInt(imap_port) || ex.imap_port || 993,
      val(imap_user, ex.imap_user),
      imapPassEnc,
      inbound_capture_enabled === '1',
      inbound_sequence_id ? parseInt(inbound_sequence_id) : null,
    ]);
    res.redirect('/settings/email?ok=1&msg=Email+settings+saved.');
  } catch (err) {
    res.redirect('/settings/email?ok=0&msg=' + encodeURIComponent('Save failed: ' + err.message));
  }
});

router.post('/email/test-smtp', requireAuth, async (req, res) => {
  const { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass } = req.body;
  let pass = smtp_pass;
  if (!pass) {
    const clientId = await resolveClientId(req);
    const { rows } = await pool.query('SELECT smtp_pass_enc FROM client_email_config WHERE client_id=$1',[clientId]);
    if (rows[0]?.smtp_pass_enc) pass = decrypt(rows[0].smtp_pass_enc);
  }
  try {
    const t = nodemailer.createTransport({
      host: smtp_host, port: parseInt(smtp_port)||587,
      secure: smtp_secure===true||smtp_secure==='true',
      auth: { user: smtp_user, pass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 10000,
    });
    await Promise.race([
      t.verify(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out after 10s — check host/port or firewall')), 10000)),
    ]);
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

router.post('/email/test-imap', requireAuth, async (req, res) => {
  const { imap_host, imap_port, imap_user, imap_pass } = req.body;
  let pass = imap_pass;
  if (!pass) {
    const clientId = await resolveClientId(req);
    const { rows } = await pool.query('SELECT imap_pass_enc FROM client_email_config WHERE client_id=$1',[clientId]);
    if (rows[0]?.imap_pass_enc) pass = decrypt(rows[0].imap_pass_enc);
  }
  const client = new ImapFlow({ host: imap_host, port: parseInt(imap_port)||993, secure:true, auth:{ user: imap_user, pass }, logger:false });
  try { await client.connect(); await client.logout(); res.json({ ok: true }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

// ─── Phone & SMS ──────────────────────────────────────────────────────────────
router.get('/phone', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const { rows } = await pool.query('SELECT brand_config FROM clients WHERE id = $1', [clientId]);
  const bc = rows[0]?.brand_config || {};

  const body = `
  <form method="POST" action="/settings/phone">
    <div class="bg-white rounded-xl shadow-sm p-6 space-y-4">
      <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide">SMS Provider (Telnyx)</h2>
      <p class="text-xs text-slate-400">Used for outbound SMS sequences. Get your credentials from telnyx.com.</p>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Telnyx API Key</label>
          <input name="telnyx_api_key" value="${esc(bc.telnyx_api_key)}" placeholder="KEY0..."
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Telnyx Phone Number</label>
          <input name="telnyx_phone" value="${esc(bc.telnyx_phone)}" placeholder="+17476889992"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
      </div>

      <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide pt-2">Business Phone</h2>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Primary Phone (shown in emails)</label>
          <input name="phone" value="${esc(bc.phone)}" placeholder="(747) 688-9992"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">10DLC Campaign ID (optional)</label>
          <input name="telnyx_campaign_id" value="${esc(bc.telnyx_campaign_id)}" placeholder="Campaign registered ID"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        </div>
      </div>
    </div>
    <div class="flex justify-end mt-4">
      <button type="submit" class="bg-sky-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-sky-700">Save Phone & SMS</button>
    </div>
  </form>`;

  res.send(pageShell('Phone & SMS', 'phone', body, req.query.msg, req.query.ok));
});

router.post('/phone', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const { rows } = await pool.query('SELECT brand_config FROM clients WHERE id = $1', [clientId]);
  const existing = rows[0]?.brand_config || {};
  const { phone, telnyx_api_key, telnyx_phone, telnyx_campaign_id } = req.body;
  const updated = { ...existing, phone, telnyx_api_key, telnyx_phone, telnyx_campaign_id };
  await pool.query('UPDATE clients SET brand_config = $1 WHERE id = $2', [JSON.stringify(updated), clientId]);
  res.redirect('/settings/phone?ok=1&msg=Phone+%26+SMS+settings+saved.');
});

// ─── Theme & Branding ─────────────────────────────────────────────────────────
router.get('/theme', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const { rows } = await pool.query('SELECT brand_config FROM clients WHERE id = $1', [clientId]);
  const bc = rows[0]?.brand_config || {};

  const body = `
  <form method="POST" action="/settings/theme">
    <div class="bg-white rounded-xl shadow-sm p-6 space-y-4">
      <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide">Email Colors</h2>
      <p class="text-xs text-slate-400">These colors are used in your outgoing email templates.</p>
      <div class="grid grid-cols-3 gap-4">
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Primary Color</label>
          <div class="flex gap-2">
            <input type="color" name="primary_color" value="${esc(bc.primary_color || '#030302')}"
              class="h-9 w-12 rounded border cursor-pointer p-0.5">
            <input type="text" id="primary_color_hex" value="${esc(bc.primary_color || '#030302')}"
              oninput="document.querySelector('[name=primary_color]').value=this.value"
              class="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500">
          </div>
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Accent Color</label>
          <div class="flex gap-2">
            <input type="color" name="accent_color" value="${esc(bc.accent_color || '#E91111')}"
              class="h-9 w-12 rounded border cursor-pointer p-0.5"
              oninput="document.getElementById('accent_hex').value=this.value">
            <input type="text" id="accent_hex" value="${esc(bc.accent_color || '#E91111')}"
              oninput="document.querySelector('[name=accent_color]').value=this.value"
              class="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500">
          </div>
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-500 mb-1">Background Color</label>
          <div class="flex gap-2">
            <input type="color" name="bg_color" value="${esc(bc.bg_color || '#EDEBE7')}"
              class="h-9 w-12 rounded border cursor-pointer p-0.5"
              oninput="document.getElementById('bg_hex').value=this.value">
            <input type="text" id="bg_hex" value="${esc(bc.bg_color || '#EDEBE7')}"
              oninput="document.querySelector('[name=bg_color]').value=this.value"
              class="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-sky-500">
          </div>
        </div>
      </div>

      <!-- Live preview -->
      <div>
        <label class="block text-xs font-medium text-slate-500 mb-2">Preview</label>
        <div id="preview-bar" class="rounded-lg p-4 flex items-center gap-3" style="background:${esc(bc.primary_color || '#030302')}">
          <span style="color:#fff;font-size:16px;font-weight:700">${esc(bc.name || 'Your Business')}</span>
          <span id="preview-btn" class="ml-auto px-4 py-1.5 rounded text-white text-sm font-semibold" style="background:${esc(bc.accent_color || '#E91111')}">${esc(bc.cta_label || 'Request a Quote')}</span>
        </div>
      </div>

      <h2 class="font-semibold text-slate-700 text-sm uppercase tracking-wide pt-2">Logo</h2>
      <div>
        <label class="block text-xs font-medium text-slate-500 mb-1">Logo URL</label>
        <input name="logo_url" value="${esc(bc.logo_url)}" placeholder="https://yoursite.com/logo.png"
          class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
        <p class="text-xs text-slate-400 mt-1">Hosted image URL. Used in email headers and the app.</p>
        ${bc.logo_url ? `<img src="${esc(bc.logo_url)}" class="mt-2 h-10 object-contain rounded border bg-slate-50 p-1" onerror="this.style.display='none'">` : ''}
      </div>
      <div>
        <label class="block text-xs font-medium text-slate-500 mb-1">Favicon URL (optional)</label>
        <input name="favicon_url" value="${esc(bc.favicon_url)}" placeholder="https://yoursite.com/favicon.ico"
          class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500">
      </div>
    </div>

    <div class="flex justify-end mt-4">
      <button type="submit" class="bg-sky-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-sky-700">Save Theme</button>
    </div>
  </form>

  <script>
    document.querySelector('[name=primary_color]').addEventListener('input', e => {
      document.getElementById('primary_color_hex').value = e.target.value;
      document.getElementById('preview-bar').style.background = e.target.value;
    });
    document.querySelector('[name=accent_color]').addEventListener('input', e => {
      document.getElementById('accent_hex').value = e.target.value;
      document.getElementById('preview-btn').style.background = e.target.value;
    });
  </script>`;

  res.send(pageShell('Theme & Branding', 'theme', body, req.query.msg, req.query.ok));
});

router.post('/theme', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const { rows } = await pool.query('SELECT brand_config FROM clients WHERE id = $1', [clientId]);
  const existing = rows[0]?.brand_config || {};
  const { primary_color, accent_color, bg_color, logo_url, favicon_url } = req.body;
  const updated = { ...existing, primary_color, accent_color, bg_color, logo_url, favicon_url };
  await pool.query('UPDATE clients SET brand_config = $1 WHERE id = $2', [JSON.stringify(updated), clientId]);
  res.redirect('/settings/theme?ok=1&msg=Theme+saved.');
});

module.exports = router;
