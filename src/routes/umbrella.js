/**
 * Parent-brand site for Wyze Business Solutions (wyzebiz.com).
 *
 * Exists because the Google OAuth consent screen is per-project, not per-product:
 * one client serves DealerWyze, RealtyWyze, ProWyze, and SalesWyze, so the home
 * page, privacy policy, and terms shown at the consent prompt have to be neutral
 * across all four. Pointing them at any one vertical shows the wrong product to
 * the other three.
 *
 * Runs on the same Railway service as the SalesWyze app, gated by Host header —
 * see the mount in index.js. Requests for any other host fall through untouched.
 */
const express = require('express');
const router = express.Router();
const { getDoc } = require('../lib/legalDocs');

const HOST = (process.env.UMBRELLA_HOST || 'wyzebiz.com').toLowerCase();

/** True when this request is for the parent-brand domain (apex or www). */
function isUmbrellaHost(req) {
  const h = String(req.hostname || req.get('host') || '').toLowerCase().split(':')[0];
  return h === HOST || h === `www.${HOST}`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const PRODUCTS = [
  { name: 'DealerWyze', url: 'https://dealerwyze.com', for: 'Independent & used-car dealers',
    blurb: 'Leads, SMS follow-up, inventory, BHPH, and AI assistance in one place.' },
  { name: 'RealtyWyze', url: 'https://realtywyze.us', for: 'Independent real estate agents',
    blurb: 'Every inquiry, listing, and client conversation tracked from first contact to close.' },
  { name: 'ProWyze', url: 'https://prowyze.com', for: 'Independent trades businesses',
    blurb: 'Lead generation, morning brief, scheduling, and dispatch for the whole trade business.' },
  { name: 'SalesWyze', url: 'https://saleswyze.com', for: 'Sales teams and follow-up campaigns',
    blurb: 'Automated email follow-up that turns a stale lead list back into booked revenue.' },
];

const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#fbfaf8; --fg:#17161a; --muted:#5d5b66; --line:#e4e1dc;
  --card:#ffffff; --accent:#1f5f4f; --accent-fg:#ffffff;
}
@media (prefers-color-scheme:dark){
  :root{--bg:#121116;--fg:#ececf0;--muted:#a3a1ad;--line:#2b2933;--card:#1a1922;--accent:#5fd0ac;--accent-fg:#0d1a16}
}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
  padding:0 20px}
.wrap{max-width:760px;margin:0 auto;padding:64px 0 80px}
header{border-bottom:1px solid var(--line);padding-bottom:32px;margin-bottom:40px}
.brand{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 14px}
h1{font-size:clamp(28px,5vw,40px);line-height:1.15;margin:0 0 14px;letter-spacing:-.02em}
.lede{font-size:18px;color:var(--muted);margin:0;max-width:56ch}
h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);
  margin:48px 0 18px;font-weight:600}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:12px;
  padding:20px;text-decoration:none;color:inherit;transition:border-color .15s,transform .15s}
.card:hover{border-color:var(--accent);transform:translateY(-2px)}
.card h3{margin:0 0 4px;font-size:17px;letter-spacing:-.01em}
.card .for{font-size:12.5px;color:var(--accent);font-weight:600;margin:0 0 8px}
.card p{margin:0;font-size:14.5px;color:var(--muted);line-height:1.55}
.prose p{max-width:64ch}
.contact{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;font-size:15px}
.contact a{color:var(--accent)}
footer{margin-top:56px;padding-top:24px;border-top:1px solid var(--line);
  display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;font-size:14px;color:var(--muted)}
footer a{color:var(--muted)}
footer .sp{margin-left:auto}
a{color:var(--accent)}
/* Legal documents */
.doc h1{margin-bottom:8px}
.doc .updated{color:var(--muted);font-size:14px;margin:0 0 32px}
.doc h2{font-size:19px;letter-spacing:-.01em;text-transform:none;color:var(--fg);
  margin:36px 0 12px;font-weight:650}
.doc h3{font-size:16px;margin:26px 0 8px}
.doc p,.doc li{color:var(--fg);font-size:15.5px}
.doc ul,.doc ol{padding-left:22px}
.doc li{margin:6px 0}
.doc hr{border:0;border-top:1px solid var(--line);margin:32px 0}
.doc code{background:var(--card);border:1px solid var(--line);border-radius:4px;
  padding:1px 5px;font-size:13.5px}
.legal-pending{display:inline-block;background:var(--card);border:1px dashed var(--line);
  border-radius:6px;padding:2px 8px;color:var(--muted);font-style:normal;font-size:14px}
`;

function shell({ title, description, canonical, noindex, body, docClass }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="robots" content="${noindex ? 'noindex,nofollow' : 'index,follow'}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Wyze Business Solutions">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<style>${CSS}</style>
</head>
<body>
<div class="wrap${docClass ? ' doc' : ''}">
${body}
<footer>
  <span>© ${new Date().getFullYear()} Sure Secured</span>
  <a href="/">Home</a>
  <a href="/privacy">Privacy</a>
  <a href="/terms">Terms</a>
  <span class="sp"><a href="mailto:support@wyzebiz.com">support@wyzebiz.com</a></span>
</footer>
</div>
</body>
</html>`;
}

function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.get('host')}`;
}

router.get('/', (req, res) => {
  const cards = PRODUCTS.map(p => `
      <a class="card" href="${p.url}">
        <h3>${esc(p.name)}</h3>
        <p class="for">${esc(p.for)}</p>
        <p>${esc(p.blurb)}</p>
      </a>`).join('');

  res.set('Cache-Control', 'public, max-age=600');
  res.send(shell({
    title: 'Wyze Business Solutions — software for independent businesses',
    description: 'Wyze Business Solutions builds CRM and customer follow-up software for independent businesses: DealerWyze, RealtyWyze, ProWyze, and SalesWyze.',
    canonical: originOf(req) + '/',
    body: `
<header>
  <p class="brand">Wyze Business Solutions</p>
  <h1>Software for independent businesses.</h1>
  <p class="lede">We build CRM and customer follow-up tools for owner-operated businesses — the ones without a marketing department, where the person selling is also the person doing the work.</p>
</header>

<h2>Products</h2>
<div class="grid">${cards}</div>

<h2>About</h2>
<div class="prose">
  <p>Every Wyze product runs on shared infrastructure: the same lead handling, email and SMS follow-up, deliverability monitoring, and data-protection controls, tuned for the way each trade actually works.</p>
  <p>Wyze Business Solutions is operated by Sure Secured. One privacy policy and one set of terms cover all four products.</p>
</div>

<h2>Contact</h2>
<div class="contact">
  <a href="mailto:support@wyzebiz.com">support@wyzebiz.com</a><br>
  Sure Secured<br>
  1555 Simi Town Center Way, Simi Valley, CA 93065
</div>`,
  }));
});

// Legal pages. noindex until counsel signs off — Google's reviewer fetches the
// URL directly, so this does not affect verification.
function legalRoute(key) {
  return (req, res) => {
    const doc = getDoc(key);
    if (!doc) return res.status(404).send(shell({
      title: 'Not found — Wyze Business Solutions', description: 'Page not found.',
      canonical: originOf(req) + req.path, noindex: true,
      body: '<header><h1>Not found</h1></header>',
    }));
    res.set('Cache-Control', 'public, max-age=600');
    res.send(shell({
      title: `${doc.title} — Wyze Business Solutions`,
      description: doc.description,
      canonical: originOf(req) + doc.slug,
      noindex: true,
      docClass: true,
      body: `<h1>${esc(doc.title)}</h1>\n${doc.html}`,
    }));
  };
}

router.get('/privacy', legalRoute('wyzebizPrivacy'));
router.get('/terms',   legalRoute('wyzebizTerms'));

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /privacy\nDisallow: /terms\n`);
});

module.exports = { router, isUmbrellaHost, HOST };
