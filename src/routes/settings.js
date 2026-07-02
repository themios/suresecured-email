const express    = require('express');
const router     = express.Router();
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { pool }   = require('../db');
const { requireAuth } = require('../middleware/auth');
const { navHtml } = require('./analytics');
const { encrypt, decrypt } = require('../lib/crypto');

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

// Parse URL-encoded form bodies for all POST routes in this router
router.use(express.urlencoded({ extended: true }));

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
    { key: 'theme',    label: 'Theme & Branding' },
  ];
  return `
  <div class="bg-white border-b mb-6">
    <div class="max-w-3xl mx-auto px-4 flex gap-1">
      ${tabs.map(t => `
      <a href="/settings/${t.key}"
        class="px-4 py-3 text-sm font-medium border-b-2 transition
          ${active === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}">
        ${t.label}
      </a>`).join('')}
    </div>
  </div>`;
}

function pageShell(title, active, body, msg, ok) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} – Sales Tracker</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 min-h-screen">
  ${navHtml('settings')}
  ${settingsNav(active)}
  <div class="max-w-3xl mx-auto px-4 pb-12">
    <h1 class="text-xl font-bold text-gray-800 mb-1">${esc(title)}</h1>
    ${msg ? `<div class="my-4 px-4 py-3 rounded-lg text-sm ${ok === '1' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}">${esc(msg)}</div>` : '<div class="mb-4"></div>'}
    ${body}
  </div>
</body>
</html>`;
}

// ─── Business Info ────────────────────────────────────────────────────────────
router.get('/business', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const { rows } = await pool.query('SELECT brand_config FROM clients WHERE id = $1', [clientId]);
  const bc = rows[0]?.brand_config || {};

  const body = `
  <form method="POST" action="/settings/business">
    <div class="bg-white rounded-xl shadow-sm p-6 space-y-4">
      <h2 class="font-semibold text-gray-700 text-sm uppercase tracking-wide">Business Identity</h2>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Business Name</label>
          <input name="name" value="${esc(bc.name)}" placeholder="SureSecured"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Website</label>
          <input name="website" value="${esc(bc.website)}" placeholder="suresecured.com"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
      </div>

      <h2 class="font-semibold text-gray-700 text-sm uppercase tracking-wide pt-2">Contact Information</h2>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Phone</label>
          <input name="phone" value="${esc(bc.phone)}" placeholder="(747) 688-9992"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Support Email</label>
          <input name="support_email" type="email" value="${esc(bc.support_email)}" placeholder="info@suresecured.com"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
      </div>

      <h2 class="font-semibold text-gray-700 text-sm uppercase tracking-wide pt-2">Address</h2>
      <div>
        <label class="block text-xs font-medium text-gray-500 mb-1">Street Address</label>
        <input name="address_street" value="${esc(bc.address_street)}" placeholder="1234 Main St"
          class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      </div>
      <div class="grid grid-cols-3 gap-4">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">City</label>
          <input name="address_city" value="${esc(bc.address_city)}" placeholder="Simi Valley"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">State</label>
          <input name="address_state" value="${esc(bc.address_state)}" placeholder="CA"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">ZIP</label>
          <input name="address_zip" value="${esc(bc.address_zip)}" placeholder="93063"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
      </div>

      <h2 class="font-semibold text-gray-700 text-sm uppercase tracking-wide pt-2">Email Footer</h2>
      <div>
        <label class="block text-xs font-medium text-gray-500 mb-1">Footer Address Line (shown in email footers)</label>
        <input name="address" value="${esc(bc.address)}" placeholder="SureSecured Security Products • Simi Valley, CA 93063"
          class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        <p class="text-xs text-gray-400 mt-1">Auto-generated from fields above if left blank on next save.</p>
      </div>

      <h2 class="font-semibold text-gray-700 text-sm uppercase tracking-wide pt-2">Email CTA</h2>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">CTA Button Label</label>
          <input name="cta_label" value="${esc(bc.cta_label)}" placeholder="Request a Quote"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">CTA URL</label>
          <input name="cta_url" value="${esc(bc.cta_url)}" placeholder="https://suresecured.com/pages/request-a-quote"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
      </div>
    </div>

    <div class="flex justify-end mt-4">
      <button type="submit" class="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700">Save Business Info</button>
    </div>
  </form>`;

  res.send(pageShell('Business Info', 'business', body, req.query.msg, req.query.ok));
});

router.post('/business', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const { rows } = await pool.query('SELECT brand_config FROM clients WHERE id = $1', [clientId]);
  const existing = rows[0]?.brand_config || {};

  const { name, website, phone, support_email, address_street, address_city, address_state, address_zip, address, cta_label, cta_url } = req.body;

  const footerAddress = address?.trim() ||
    [name, [address_street, address_city, address_state, address_zip].filter(Boolean).join(', ')].filter(Boolean).join(' • ');

  const updated = {
    ...existing,
    name, website, phone, support_email,
    address_street, address_city, address_state, address_zip,
    address: footerAddress,
    cta_label, cta_url,
  };

  await pool.query('UPDATE clients SET brand_config = $1 WHERE id = $2', [JSON.stringify(updated), clientId]);
  res.redirect('/settings/business?ok=1&msg=Business+info+saved.');
});

// ─── Email Settings ───────────────────────────────────────────────────────────
router.get('/email', requireAuth, async (req, res) => {
  const clientId = await resolveClientId(req);
  const { rows } = await pool.query('SELECT * FROM client_email_config WHERE client_id = $1', [clientId]);
  const cfg = rows[0] || {};

  const body = `
  <form method="POST" action="/settings/email" id="email-form">

    <!-- Provider selector -->
    <div class="bg-white rounded-xl shadow-sm p-6 mb-4">
      <h2 class="font-semibold text-gray-700 text-sm uppercase tracking-wide mb-3">Email Provider</h2>
      <div class="grid grid-cols-2 gap-2 mb-3">
        ${Object.entries(PROVIDERS).map(([key, p]) => `
        <button type="button" onclick="selectProvider('${key}')" data-provider="${key}"
          class="provider-btn text-left px-3 py-2.5 rounded-lg border text-sm transition
            ${(cfg.provider || 'smtp') === key
              ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
              : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}">
          ${esc(p.label)}
        </button>`).join('')}
      </div>
      <input type="hidden" name="provider" id="provider-value" value="${esc(cfg.provider || 'smtp')}">
      <div id="provider-note" class="text-xs text-blue-700 bg-blue-50 border border-blue-100 px-3 py-2 rounded-lg mt-2 hidden"></div>
    </div>

    <!-- SMTP -->
    <div class="bg-white rounded-xl shadow-sm p-6 mb-4">
      <h2 class="font-semibold text-gray-700 text-sm uppercase tracking-wide mb-3">Outgoing Mail (SMTP)</h2>
      <div class="grid grid-cols-3 gap-3 mb-3">
        <div class="col-span-2">
          <label class="block text-xs font-medium text-gray-500 mb-1">SMTP Host</label>
          <input name="smtp_host" id="smtp_host" value="${esc(cfg.smtp_host)}" placeholder="smtp.example.com"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Port</label>
          <input name="smtp_port" id="smtp_port" type="number" value="${cfg.smtp_port || 587}"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Username / Email</label>
          <input name="smtp_user" value="${esc(cfg.smtp_user)}" placeholder="you@domain.com"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Password / App Password</label>
          <input type="password" name="smtp_pass" placeholder="${cfg.smtp_pass_enc ? '••••••••••••  (saved)' : 'Enter password'}"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          ${cfg.smtp_pass_enc ? '<p class="text-xs text-gray-400 mt-1">Leave blank to keep existing</p>' : ''}
        </div>
      </div>
      <label class="flex items-center gap-2 mb-3 text-sm text-gray-600 cursor-pointer">
        <input type="checkbox" name="smtp_secure" value="1" ${cfg.smtp_secure ? 'checked' : ''} class="rounded">
        Use SSL on port 465 (leave unchecked for STARTTLS on 587)
      </label>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">From Name</label>
          <input name="from_name" value="${esc(cfg.from_name)}" placeholder="SureSecured Sales"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">From Email</label>
          <input name="from_email" type="email" value="${esc(cfg.from_email)}" placeholder="sales@domain.com"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
      </div>
      <div class="mb-4">
        <label class="block text-xs font-medium text-gray-500 mb-1">Reply-To (optional)</label>
        <input name="reply_to" type="email" value="${esc(cfg.reply_to)}" placeholder="Leave blank to use From Email"
          class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      </div>
      <button type="button" onclick="testSmtp()"
        class="text-sm text-blue-600 border border-blue-200 bg-blue-50 px-4 py-1.5 rounded-lg hover:bg-blue-100">
        Test SMTP Connection
      </button>
      <span id="smtp-test-result" class="text-sm ml-3 hidden"></span>
    </div>

    <!-- IMAP -->
    <div class="bg-white rounded-xl shadow-sm p-6 mb-4" id="imap-section">
      <h2 class="font-semibold text-gray-700 text-sm uppercase tracking-wide mb-1">Incoming Mail (IMAP)</h2>
      <p class="text-xs text-gray-400 mb-3">Used to detect when leads reply to your emails.</p>
      <div class="grid grid-cols-3 gap-3 mb-3">
        <div class="col-span-2">
          <label class="block text-xs font-medium text-gray-500 mb-1">IMAP Host</label>
          <input name="imap_host" id="imap_host" value="${esc(cfg.imap_host)}" placeholder="imap.example.com"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Port</label>
          <input name="imap_port" id="imap_port" type="number" value="${cfg.imap_port || 993}"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3 mb-4">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Username / Email</label>
          <input name="imap_user" value="${esc(cfg.imap_user)}" placeholder="Same as SMTP username"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Password / App Password</label>
          <input type="password" name="imap_pass" placeholder="${cfg.imap_pass_enc ? '••••••••••••  (saved)' : 'Enter password'}"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
          ${cfg.imap_pass_enc ? '<p class="text-xs text-gray-400 mt-1">Leave blank to keep existing</p>' : ''}
        </div>
      </div>
      <button type="button" onclick="testImap()"
        class="text-sm text-blue-600 border border-blue-200 bg-blue-50 px-4 py-1.5 rounded-lg hover:bg-blue-100">
        Test IMAP Connection
      </button>
      <span id="imap-test-result" class="text-sm ml-3 hidden"></span>
    </div>

    <div class="flex justify-end">
      <button type="submit" class="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700">Save Email Settings</button>
    </div>
  </form>

  <script>
    const PRESETS = ${JSON.stringify(PROVIDERS)};
    function selectProvider(key) {
      document.getElementById('provider-value').value = key;
      document.querySelectorAll('.provider-btn').forEach(btn => {
        const active = btn.dataset.provider === key;
        btn.className = 'provider-btn text-left px-3 py-2.5 rounded-lg border text-sm transition ' +
          (active ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300');
      });
      const p = PRESETS[key]; if (!p) return;
      if (p.smtp_host !== undefined) document.querySelector('[name=smtp_host]').value = p.smtp_host;
      if (p.smtp_port) document.querySelector('[name=smtp_port]').value = p.smtp_port;
      if (p.imap_host !== undefined) document.querySelector('[name=imap_host]').value = p.imap_host;
      if (p.imap_port) document.querySelector('[name=imap_port]').value = p.imap_port;
      document.getElementById('imap-section').style.display = key === 'ses' ? 'none' : '';
      const noteEl = document.getElementById('provider-note');
      noteEl.textContent = p.note || '';
      noteEl.classList.toggle('hidden', !p.note);
    }
    selectProvider(document.getElementById('provider-value').value);

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
  const { provider, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, from_name, from_email, reply_to, imap_host, imap_port, imap_user, imap_pass } = req.body;
  try {
    const { rows } = await pool.query('SELECT smtp_pass_enc, imap_pass_enc FROM client_email_config WHERE client_id = $1', [clientId]);
    const existing = rows[0] || {};
    const smtpPassEnc = smtp_pass?.trim() ? encrypt(smtp_pass.trim()) : existing.smtp_pass_enc || null;
    const imapPassEnc = imap_pass?.trim() ? encrypt(imap_pass.trim()) : existing.imap_pass_enc || null;
    await pool.query(`
      INSERT INTO client_email_config (client_id,provider,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_pass_enc,from_name,from_email,reply_to,imap_host,imap_port,imap_user,imap_pass_enc,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
      ON CONFLICT (client_id) DO UPDATE SET
        provider=EXCLUDED.provider, smtp_host=EXCLUDED.smtp_host, smtp_port=EXCLUDED.smtp_port,
        smtp_secure=EXCLUDED.smtp_secure, smtp_user=EXCLUDED.smtp_user, smtp_pass_enc=EXCLUDED.smtp_pass_enc,
        from_name=EXCLUDED.from_name, from_email=EXCLUDED.from_email, reply_to=EXCLUDED.reply_to,
        imap_host=EXCLUDED.imap_host, imap_port=EXCLUDED.imap_port, imap_user=EXCLUDED.imap_user,
        imap_pass_enc=EXCLUDED.imap_pass_enc, updated_at=NOW()
    `, [clientId, provider||'smtp', smtp_host, parseInt(smtp_port)||587, smtp_secure==='1', smtp_user, smtpPassEnc, from_name, from_email, reply_to||null, imap_host, parseInt(imap_port)||993, imap_user, imapPassEnc]);
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
    const t = nodemailer.createTransport({ host: smtp_host, port: parseInt(smtp_port)||587, secure: smtp_secure===true||smtp_secure==='true', auth:{ user: smtp_user, pass } });
    await t.verify();
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
      <h2 class="font-semibold text-gray-700 text-sm uppercase tracking-wide">SMS Provider (Telnyx)</h2>
      <p class="text-xs text-gray-400">Used for outbound SMS sequences. Get your credentials from telnyx.com.</p>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Telnyx API Key</label>
          <input name="telnyx_api_key" value="${esc(bc.telnyx_api_key)}" placeholder="KEY0..."
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Telnyx Phone Number</label>
          <input name="telnyx_phone" value="${esc(bc.telnyx_phone)}" placeholder="+17476889992"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
      </div>

      <h2 class="font-semibold text-gray-700 text-sm uppercase tracking-wide pt-2">Business Phone</h2>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Primary Phone (shown in emails)</label>
          <input name="phone" value="${esc(bc.phone)}" placeholder="(747) 688-9992"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">10DLC Campaign ID (optional)</label>
          <input name="telnyx_campaign_id" value="${esc(bc.telnyx_campaign_id)}" placeholder="Campaign registered ID"
            class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
      </div>
    </div>
    <div class="flex justify-end mt-4">
      <button type="submit" class="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700">Save Phone & SMS</button>
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
      <h2 class="font-semibold text-gray-700 text-sm uppercase tracking-wide">Email Colors</h2>
      <p class="text-xs text-gray-400">These colors are used in your outgoing email templates.</p>
      <div class="grid grid-cols-3 gap-4">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Primary Color</label>
          <div class="flex gap-2">
            <input type="color" name="primary_color" value="${esc(bc.primary_color || '#030302')}"
              class="h-9 w-12 rounded border cursor-pointer p-0.5">
            <input type="text" id="primary_color_hex" value="${esc(bc.primary_color || '#030302')}"
              oninput="document.querySelector('[name=primary_color]').value=this.value"
              class="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500">
          </div>
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Accent Color</label>
          <div class="flex gap-2">
            <input type="color" name="accent_color" value="${esc(bc.accent_color || '#E91111')}"
              class="h-9 w-12 rounded border cursor-pointer p-0.5"
              oninput="document.getElementById('accent_hex').value=this.value">
            <input type="text" id="accent_hex" value="${esc(bc.accent_color || '#E91111')}"
              oninput="document.querySelector('[name=accent_color]').value=this.value"
              class="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500">
          </div>
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Background Color</label>
          <div class="flex gap-2">
            <input type="color" name="bg_color" value="${esc(bc.bg_color || '#EDEBE7')}"
              class="h-9 w-12 rounded border cursor-pointer p-0.5"
              oninput="document.getElementById('bg_hex').value=this.value">
            <input type="text" id="bg_hex" value="${esc(bc.bg_color || '#EDEBE7')}"
              oninput="document.querySelector('[name=bg_color]').value=this.value"
              class="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500">
          </div>
        </div>
      </div>

      <!-- Live preview -->
      <div>
        <label class="block text-xs font-medium text-gray-500 mb-2">Preview</label>
        <div id="preview-bar" class="rounded-lg p-4 flex items-center gap-3" style="background:${esc(bc.primary_color || '#030302')}">
          <span style="color:#fff;font-size:16px;font-weight:700">${esc(bc.name || 'Your Business')}</span>
          <span id="preview-btn" class="ml-auto px-4 py-1.5 rounded text-white text-sm font-semibold" style="background:${esc(bc.accent_color || '#E91111')}">${esc(bc.cta_label || 'Request a Quote')}</span>
        </div>
      </div>

      <h2 class="font-semibold text-gray-700 text-sm uppercase tracking-wide pt-2">Logo</h2>
      <div>
        <label class="block text-xs font-medium text-gray-500 mb-1">Logo URL</label>
        <input name="logo_url" value="${esc(bc.logo_url)}" placeholder="https://yoursite.com/logo.png"
          class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
        <p class="text-xs text-gray-400 mt-1">Hosted image URL. Used in email headers and the app.</p>
        ${bc.logo_url ? `<img src="${esc(bc.logo_url)}" class="mt-2 h-10 object-contain rounded border bg-gray-50 p-1" onerror="this.style.display='none'">` : ''}
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-500 mb-1">Favicon URL (optional)</label>
        <input name="favicon_url" value="${esc(bc.favicon_url)}" placeholder="https://yoursite.com/favicon.ico"
          class="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      </div>
    </div>

    <div class="flex justify-end mt-4">
      <button type="submit" class="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700">Save Theme</button>
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
