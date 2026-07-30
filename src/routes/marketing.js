const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { leadFormLimiter } = require('../middleware/rateLimit');
const { generateAudit, renderAuditEmail } = require('../lib/audit');
const { sendDirectEmail } = require('../lib/gmail');

// Who the platform sends its own mail as (the audit copy). Prefer an explicit
// PLATFORM_SALESPERSON_ID; otherwise use the first connected, enabled Gmail
// identity (lowest client_id = the owner's own tenant). Returns null if no
// mailbox is connected, in which case we just skip the emailed copy.
async function platformSender() {
  const envSp = parseInt(process.env.PLATFORM_SALESPERSON_ID, 10);
  if (Number.isInteger(envSp)) {
    const { rows } = await pool.query('SELECT client_id FROM salespeople WHERE id = $1', [envSp]);
    if (rows[0]) return { salespersonId: envSp, clientId: rows[0].client_id };
  }
  const { rows } = await pool.query(
    `SELECT ea.salesperson_id, s.client_id
       FROM email_accounts ea
       JOIN salespeople s ON s.id = ea.salesperson_id
      WHERE ea.enabled = true AND ea.oauth_refresh_token IS NOT NULL
      ORDER BY s.client_id ASC, ea.salesperson_id ASC
      LIMIT 1`
  );
  return rows[0] ? { salespersonId: rows[0].salesperson_id, clientId: rows[0].client_id } : null;
}

// Email the prospect their own copy of the estimate, so we land in their inbox
// as a contact. Best effort: never blocks or fails the page response.
async function emailAuditCopy({ to, businessName, audit, origin }) {
  const sender = await platformSender();
  if (!sender) { console.warn('[marketing] no connected mailbox; skipping audit email'); return; }
  const { subject, html, text } = renderAuditEmail(audit, { businessName, origin });
  await sendDirectEmail({
    fromName: 'Sure Secured',
    replyTo: 'sales@suresecured.com',
    to,
    subject,
    htmlBody: html,
    textBody: text,
    salespersonId: sender.salespersonId,
    clientId: sender.clientId,
  });
}

function fmtMoney(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Blog posts. The sitemap and blog routes read from this.
const BLOG_POSTS = require('./blog-posts');

// ─── Public landing page ───────────────────────────────────────────────────

function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.get('host')}`;
}

router.get('/', (req, res) => {
  const submitted = req.query.submitted === '1';
  const formError = req.query.error === '1';
  res.set('Cache-Control', 'no-store');
  res.send(renderLanding({ submitted, formError, origin: originOf(req) }));
});

// SEO: let crawlers and AI answer engines discover and read the site.
router.get('/robots.txt', (req, res) => {
  const origin = originOf(req);
  res.type('text/plain').send(`User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`);
});

router.get('/sitemap.xml', (req, res) => {
  const origin = originOf(req);
  const paths = ['/'];
  if (BLOG_POSTS.length) {
    paths.push('/blog');
    BLOG_POSTS.forEach(p => paths.push(`/blog/${p.slug}`));
  }
  const urls = paths.map(p => `  <url><loc>${origin}${p}</loc></url>`).join('\n');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  );
});

// ─── Blog (SEO cluster) ─────────────────────────────────────────────────────
router.get('/blog', (req, res) => {
  res.set('Cache-Control', 'public, max-age=600');
  res.send(renderBlogIndex(originOf(req)));
});

router.get('/blog/:slug', (req, res) => {
  const post = BLOG_POSTS.find(p => p.slug === req.params.slug);
  if (!post) {
    return res.status(404).send(renderBlogNotFound(originOf(req)));
  }
  res.set('Cache-Control', 'public, max-age=600');
  res.send(renderBlogPost(originOf(req), post));
});

router.post(
  '/get-started',
  leadFormLimiter,
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const {
      business_name,
      contact_name,
      email,
      phone,
      trade,
      list_size,
      deal_value,
      message,
      company_website, // honeypot — real visitors never fill this in
    } = req.body;

    if (company_website) {
      // Bot filled the honeypot. Pretend it worked and move on.
      return res.redirect('/?submitted=1#apply');
    }

    const emailOk = typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    if (!business_name || !business_name.trim() || !emailOk) {
      return res.redirect('/?error=1#apply');
    }

    try {
      await pool.query(
        `INSERT INTO platform_leads (business_name, contact_name, trade, email, phone, list_size, message, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'landing_page')`,
        [
          business_name.trim().slice(0, 255),
          (contact_name || '').trim().slice(0, 255) || null,
          (trade || '').trim().slice(0, 100) || null,
          email.trim().slice(0, 255),
          (phone || '').trim().slice(0, 50) || null,
          (list_size || '').trim().slice(0, 50) || null,
          (message || '').trim().slice(0, 2000) || null,
        ]
      );
    } catch (err) {
      console.error('[marketing] platform_leads insert failed:', err.message);
      return res.redirect('/?error=1#apply');
    }

    // Hand them their recoverable-revenue estimate immediately. Computed from
    // industry + list size, so no manual work. Falls back to the plain thank-you
    // if generation fails for any reason.
    try {
      const audit = await generateAudit(trade, list_size, deal_value);
      // Send them a copy for their inbox (and to put us in their contacts).
      // Fire-and-forget: the page must render even if mail is slow or down.
      emailAuditCopy({ to: email.trim(), businessName: business_name, audit, origin: originOf(req) })
        .catch(err => console.error('[marketing] audit email failed:', err.message));
      return res.send(renderAuditReport(originOf(req), { audit, businessName: business_name }));
    } catch (err) {
      console.error('[marketing] audit generation failed:', err.message);
      return res.redirect('/?submitted=1#apply');
    }
  }
);

// ─── Page ───────────────────────────────────────────────────────────────────

// Social tags + JSON-LD structured data. Structured data is what Google rich
// results and AI answer engines (ChatGPT, Perplexity, AI Overviews) read to
// understand and cite the page, so the FAQ, service, and org are all described.
function seoHead(origin) {
  const url = origin + '/';
  const desc = 'SalesWyze turns the old leads and past customers sitting in your spreadsheet into new sales. Done-for-you email and text follow up that sounds like your business, for any industry. Flat pricing, no long contract.';
  const title = 'SalesWyze — Your old leads are still worth money';

  const org = {
    '@context': 'https://schema.org', '@type': 'Organization',
    name: 'SalesWyze', url, description: desc,
    parentOrganization: { '@type': 'Organization', name: 'SureSecured' },
    areaServed: 'US',
  };
  const site = { '@context': 'https://schema.org', '@type': 'WebSite', name: 'SalesWyze', url };
  const service = {
    '@context': 'https://schema.org', '@type': 'Service',
    name: 'Lead list reactivation for any business',
    serviceType: 'Database reactivation and lead follow-up',
    provider: { '@type': 'Organization', name: 'SalesWyze' },
    areaServed: 'US',
    audience: { '@type': 'Audience', audienceType: 'Any business with a list of old leads and past customers, including auto, legal, retail, home services, and agriculture' },
    description: 'Done-for-you email and phone follow up that reactivates old leads and cold customer lists and books new business, for any industry.',
    offers: { '@type': 'Offer', priceSpecification: { '@type': 'PriceSpecification', description: 'Flat pricing. Fully managed at $499 per month, or $199 per month with a one-time $999 setup.' } },
  };
  const faqPairs = [
    ['Do I need to switch software?', 'No. This runs alongside whatever you already use for scheduling, invoicing, or your CRM.'],
    ['My list is years old and messy. Does that matter?', "Less than you'd think. Addresses get cleaned and verified before anything goes out under your business name."],
    ['Will this make me look like a spammer?', 'No. Every message sends from a real address tied to your business, with a working unsubscribe link. Deliverability is handled, not an afterthought.'],
    ["What if my team doesn't have time to manage this?", "That's the point of it. Nobody on your end has to run anything day to day. Replies land in front of your team, ready to close."],
    ['How fast can this actually start?', 'Send the list and sequences can be live within a few days, sometimes faster.'],
  ];
  const faq = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faqPairs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };

  const ld = [org, site, service, faq]
    .map(o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`)
    .join('\n');

  return `
<link rel="canonical" href="${url}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta name="theme-color" content="#12100e">
<meta property="og:type" content="website">
<meta property="og:site_name" content="SalesWyze">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
${ld}`;
}

function renderLanding({ submitted, formError, origin = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SalesWyze — Your old leads are still worth money</title>
<meta name="description" content="SalesWyze turns the quotes and old customers sitting in your spreadsheet into booked jobs. Email and phone follow up that sounds like your business. You only pay when a job closes.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800;900&family=Archivo:ital,wght@0,400;0,500;0,600;0,700;1,500&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
${css()}
</style>
<script>document.documentElement.classList.add('has-js');</script>
${seoHead(origin)}
</head>
<body>
<div class="grain" aria-hidden="true"></div>

<header class="site-nav" id="siteNav">
  <div class="wrap nav-inner">
    <a href="/" class="brand">
      <span class="brand-mark">SW</span>
      <span class="brand-word">SalesWyze</span>
    </a>
    <nav class="nav-links">
      <a href="#how">How it works</a>
      <a href="#pricing">Pricing</a>
      <a href="/blog">Guides</a>
      <a href="/login" class="nav-signin">Client sign in</a>
      <a href="#apply" class="btn btn-small btn-ember">Get started</a>
    </nav>
  </div>
</header>

<main>

  <!-- HERO -->
  <section class="hero">
    <div class="dot-field" aria-hidden="true"></div>
    <div class="wrap hero-grid">
      <div class="hero-copy reveal">
        <span class="eyebrow">For any business sitting on a list of old leads and past customers</span>
        <h1 class="h-display">The leads you already paid for are still sitting there.</h1>
        <p class="hero-sub">Every person who asked about you and never heard back is business somebody else could still win. Auto, legal, retail, home services, agriculture, it does not matter. We turn that old list into new sales, with follow up written to sound like your business, not a call center.</p>
        <div class="hero-actions">
          <a href="#apply" class="btn btn-ember btn-large">Get my free list audit</a>
          <span class="hero-microcopy">No cost. No contract. Takes about two minutes.</span>
        </div>
      </div>

      <div class="hero-visual reveal" style="--delay:120ms">
        <div class="ledger" id="ledger">
          <div class="ledger-head">
            <span>QUICK MATH</span>
            <span class="ledger-tag">example</span>
          </div>
          <div class="ledger-row">
            <span>Old quotes sitting untouched</span>
            <span class="num">500</span>
          </div>
          <div class="ledger-row">
            <span>Average job value</span>
            <span class="num">$2,400</span>
          </div>
          <div class="ledger-row">
            <span>Close rate if you ask again</span>
            <span class="num">5%</span>
          </div>
          <div class="ledger-divider"></div>
          <div class="ledger-row ledger-total">
            <span>Money left on the table</span>
            <span class="num num-total" data-target="60000">$0</span>
          </div>
          <p class="ledger-foot">Not a promise, just what's sitting in a spreadsheet somewhere. Swap in your own numbers. The math doesn't change.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- PROBLEM -->
  <section class="problem">
    <div class="dot-field dot-field-light" aria-hidden="true"></div>
    <div class="wrap">
      <h2 class="section-title reveal">You've got this problem right now</h2>
      <div class="problem-grid">
        <div class="problem-card reveal" style="--delay:0ms">
          ${icon('folder')}
          <p>A list of old leads and past customers nobody ever followed up on.</p>
        </div>
        <div class="problem-card reveal" style="--delay:80ms">
          ${icon('mail')}
          <p>Old customers who got one email, then silence.</p>
        </div>
        <div class="problem-card reveal" style="--delay:160ms">
          ${icon('clock')}
          <p>A slow month, and no clear idea who's actually ready to buy.</p>
        </div>
      </div>
      <p class="problem-line reveal">None of that is a marketing problem. It's a follow up problem, and follow up is the one thing your sales team never has time for.</p>
    </div>
  </section>

  <!-- HOW IT WORKS -->
  <section class="how" id="how">
    <div class="wrap">
      <h2 class="section-title reveal">Here's exactly what happens</h2>
      <div class="steps">
        <div class="step reveal" style="--delay:0ms">
          <span class="step-num">01</span>
          <h3>Send the list</h3>
          <p>CSV, spreadsheet, whatever you've got. Old customers, missed quotes, leads that went cold. It doesn't need to be clean.</p>
        </div>
        <div class="step reveal" style="--delay:80ms">
          <span class="step-num">02</span>
          <h3>We build the follow up</h3>
          <p>Email and phone sequences written to sound like your business, timed so they never feel like a blast. Bad addresses get filtered out before anything goes out under your name.</p>
        </div>
        <div class="step reveal" style="--delay:160ms">
          <span class="step-num">03</span>
          <h3>They raise a hand</h3>
          <p>When someone replies or books a call, it lands straight in your team's inbox, already tagged to the right salesperson.</p>
        </div>
        <div class="step reveal" style="--delay:240ms">
          <span class="step-num">04</span>
          <h3>It keeps working</h3>
          <p>New leads get captured and answered on their own, and we watch that every message actually lands. You just keep taking the calls.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- TRUST -->
  <section class="trust">
    <div class="wrap trust-grid">
      <div class="reveal">
        <h2 class="section-title section-title-light">Why this actually gets replies</h2>
        <p class="trust-story">This started with one list. A security screen door company in Simi Valley had years of quoted jobs nobody had ever followed up on. We loaded the list, wrote the sequences, and let it run. That list is the reason this exists at all.</p>
      </div>
      <ul class="trust-list reveal" style="--delay:120ms">
        <li>${icon('check')} Sends from a real inbox, not a bulk mail server. It looks like a person wrote it, because a person did.</li>
        <li>${icon('check')} You keep your own CRM and your own team. We plug into the gap where follow up should be happening.</li>
        <li>${icon('check')} No dashboard to babysit. We tell you the moment someone's ready to talk.</li>
        <li>${icon('check')} Every unsubscribe is honored automatically. Nobody on your list gets hounded.</li>
      </ul>
    </div>
  </section>

  <!-- DEAL -->
  <section class="pricing" id="pricing">
    <div class="wrap">
      <h2 class="section-title reveal">Clear pricing. Pick how you want to work with us.</h2>
      <p class="pricing-lede reveal">No long-term contract. It starts with a free audit of your list, so you see what is in there before you pay a cent.</p>
      <div class="tiers">

        <div class="tier reveal">
          <span class="tier-tag">Hands-off</span>
          <h3>Fully managed</h3>
          <div class="tier-price"><span class="amt">$499</span><span class="per">/month</span></div>
          <p class="tier-sub">we set it up and maintain it</p>
          <p class="tier-note">We build it and keep it running, start to finish. You never touch it, you just take the calls.</p>
          <ul class="tier-list">
            <li>Everything set up and maintained for you</li>
            <li>List cleaned, sequences written and tuned</li>
            <li>Delivery watched daily, so mail reaches the inbox</li>
            <li>New leads captured and answered on their own</li>
            <li>Replies routed straight to your team</li>
          </ul>
          <a href="#apply" class="btn btn-ink">Get my free list audit</a>
        </div>

        <div class="tier tier-featured reveal" style="--delay:80ms">
          <span class="tier-tag">Most popular</span>
          <h3>We build it, you run it</h3>
          <div class="tier-price"><span class="amt">$199</span><span class="per">/month</span></div>
          <p class="tier-sub">one time setup fee of $999</p>
          <p class="tier-note">We do the whole setup and hand you the keys. Your list cleaned, your sequences written, your sending wired up. You take it from there.</p>
          <ul class="tier-list">
            <li>We build the whole thing for you</li>
            <li>List cleaned and verified first</li>
            <li>Email and text sequences written for you</li>
            <li>You run it day to day</li>
            <li>Cancel anytime</li>
          </ul>
          <a href="#apply" class="btn btn-ember">Get my free list audit</a>
        </div>

        <div class="tier reveal" style="--delay:160ms">
          <span class="tier-tag">Coming soon</span>
          <h3>Self-serve</h3>
          <div class="tier-price"><span class="amt">$199</span><span class="per">/month</span></div>
          <p class="tier-sub">no setup fee</p>
          <p class="tier-note">Run it yourself from day one. The full platform, your own sending, our sequences and tools.</p>
          <ul class="tier-list">
            <li>The whole platform, in your hands</li>
            <li>Unlimited contacts</li>
            <li>Send from your own business inbox</li>
            <li>You set it up and run it</li>
          </ul>
          <a href="#apply" class="btn btn-ink">Join the waitlist</a>
        </div>

      </div>
      <p class="pricing-foot reveal">We start with a free audit and tell you honestly if there is money in your list. You only pay the setup once we have shown you. <a href="#apply">Get the free audit &rarr;</a></p>
    </div>
  </section>

  <!-- FAQ -->
  <section class="faq">
    <div class="dot-field" aria-hidden="true"></div>
    <div class="wrap">
      <h2 class="section-title section-title-light reveal">Questions you're probably already asking</h2>
      <div class="faq-list reveal">
        <details>
          <summary>Do I need to switch software?</summary>
          <p>No. This runs alongside whatever you already use for scheduling, invoicing, or your CRM.</p>
        </details>
        <details>
          <summary>My list is years old and messy. Does that matter?</summary>
          <p>Less than you'd think. Addresses get cleaned and verified before anything goes out under your business name.</p>
        </details>
        <details>
          <summary>Will this make me look like a spammer?</summary>
          <p>No. Every message sends from a real address tied to your business, with a working unsubscribe link. Deliverability is handled, not an afterthought.</p>
        </details>
        <details>
          <summary>What if my team doesn't have time to manage this?</summary>
          <p>That's the point of it. Nobody on your end has to run anything day to day. Replies land in front of your team, ready to close.</p>
        </details>
        <details>
          <summary>How fast can this actually start?</summary>
          <p>Send the list and sequences can be live within a few days, sometimes faster.</p>
        </details>
      </div>
    </div>
  </section>

  <!-- FINAL CTA / FORM -->
  <section class="cta-final" id="apply">
    <div class="wrap">
      <div class="apply-card reveal">
        <div class="apply-header">
          <h2 class="h-display h-display-small">That list isn't getting any younger.</h2>
          <p>Send it over. We'll tell you honestly if there's money in it before you commit to anything.</p>
        </div>

        ${submitted ? `
        <div class="apply-success" role="status">
          ${icon('check')}
          <div>
            <strong>Got it.</strong>
            <span>We'll look at what you sent and get back to you shortly.</span>
          </div>
        </div>` : `
        <form method="POST" action="/get-started" class="apply-form" novalidate>
          ${formError ? `<div class="form-error">Business name and a valid email are required. Give it another shot.</div>` : ''}
          <div class="form-row">
            <label>Business name*
              <input type="text" name="business_name" required maxlength="255" placeholder="Acme Roofing">
            </label>
            <label>Your name
              <input type="text" name="contact_name" maxlength="255" placeholder="Jane Smith">
            </label>
          </div>
          <div class="form-row">
            <label>Email*
              <input type="email" name="email" required maxlength="255" placeholder="jane@acmeroofing.com">
            </label>
            <label>Phone
              <input type="tel" name="phone" maxlength="50" placeholder="(555) 555-0100">
            </label>
          </div>
          <div class="form-row">
            <label>What kind of business?
              <input type="text" name="trade" maxlength="100" placeholder="Auto, legal, retail, agriculture...">
            </label>
            <label>Rough size of your list
              <select name="list_size">
                <option value="">Not sure</option>
                <option value="under_500">Under 500</option>
                <option value="500_2000">500 to 2,000</option>
                <option value="2000_10000">2,000 to 10,000</option>
                <option value="10000_plus">10,000+</option>
              </select>
            </label>
          </div>
          <div class="form-row">
            <label>What is one sale worth to you, on average?
              <input type="text" name="deal_value" maxlength="20" placeholder="$3,000" inputmode="numeric">
              <span class="field-hint">Roughly what you make on a typical sale or job. We use your number, not a guess.</span>
            </label>
            <span></span>
          </div>
          <label class="form-full">Anything else?
            <textarea name="message" maxlength="2000" rows="3" placeholder="Optional"></textarea>
          </label>
          <input type="text" name="company_website" class="hp" tabindex="-1" autocomplete="off">
          <button type="submit" class="btn btn-ember btn-large btn-block">Get my free list audit</button>
        </form>`}
      </div>
    </div>
  </section>

</main>

<footer class="site-footer">
  <div class="wrap footer-inner">
    <span>SalesWyze is built and run by the team behind SureSecured.</span>
    <a href="/login">Client sign in →</a>
  </div>
</footer>

<script>${js()}</script>
</body>
</html>`;
}

// ─── Blog rendering ─────────────────────────────────────────────────────────

function fmtDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function siteNavHtml(active) {
  return `<header class="site-nav" id="siteNav">
  <div class="wrap nav-inner">
    <a href="/" class="brand"><span class="brand-mark">SW</span><span class="brand-word">SalesWyze</span></a>
    <nav class="nav-links">
      <a href="/blog"${active === 'blog' ? ' aria-current="page"' : ''}>Guides</a>
      <a href="/#how">How it works</a>
      <a href="/login" class="nav-signin">Client sign in</a>
      <a href="/#apply" class="btn btn-small btn-ember">Get started</a>
    </nav>
  </div>
</header>`;
}

function siteFooterHtml() {
  return `<footer class="site-footer">
  <div class="wrap footer-inner">
    <span>SalesWyze is built and run by the team behind SureSecured.</span>
    <a href="/login">Client sign in →</a>
  </div>
</footer>`;
}

function blogShell({ title, description, canonical, jsonld = [], bodyClass, content, noindex }) {
  const ld = jsonld.map(o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n');
  const ogType = bodyClass === 'is-post' ? 'article' : 'website';
  const robots = noindex ? 'noindex,nofollow' : 'index,follow,max-image-preview:large';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="${robots}">
<meta name="theme-color" content="#15120e">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="SalesWyze">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800;900&family=Archivo:ital,wght@0,400;0,500;0,600;0,700;1,500&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>${css()}${blogCss()}</style>
${ld}
</head>
<body class="${bodyClass || ''}">
<div class="grain" aria-hidden="true"></div>
${siteNavHtml('blog')}
<main class="blog-main">
${content}
</main>
${siteFooterHtml()}
</body>
</html>`;
}

function renderBlogIndex(origin) {
  const canonical = origin + '/blog';
  const cards = BLOG_POSTS.map(p => `
        <a class="post-card" href="/blog/${p.slug}">
          <span class="post-card-meta">${fmtDate(p.date)}  ·  ${p.read} min read</span>
          <h2>${esc(p.title)}</h2>
          <p>${esc(p.description)}</p>
          <span class="post-card-more">Read the guide →</span>
        </a>`).join('');
  const jsonld = [{
    '@context': 'https://schema.org', '@type': 'Blog', name: 'SalesWyze Guides', url: canonical,
    blogPost: BLOG_POSTS.map(p => ({ '@type': 'BlogPosting', headline: p.title, url: origin + '/blog/' + p.slug, datePublished: p.date })),
  }];
  const content = `
    <div class="wrap blog-wrap">
      <header class="blog-hero">
        <span class="eyebrow">SalesWyze guides</span>
        <h1 class="h-display">Straight answers on follow up and old leads</h1>
        <p class="blog-hero-sub">Plain, practical writing for contractors sitting on a pile of old quotes and cold customers. What to send, when to send it, and how to book jobs from names you already paid for.</p>
      </header>
      <div class="post-list">${cards}</div>
    </div>`;
  return blogShell({
    title: 'Guides on follow up and reactivating old leads | SalesWyze',
    description: 'Practical guides for contractors on reactivating old leads, following up on quotes, email deliverability, and booking more jobs from lists you already have.',
    canonical, jsonld, bodyClass: 'is-index', content,
  });
}

function renderBlogPost(origin, post) {
  const canonical = origin + '/blog/' + post.slug;
  const related = BLOG_POSTS.filter(p => p.slug !== post.slug).slice(0, 3);
  const jsonld = [
    {
      '@context': 'https://schema.org', '@type': 'Article',
      headline: post.title, description: post.description,
      datePublished: post.date, dateModified: post.updated || post.date,
      author: { '@type': 'Organization', name: 'SalesWyze' },
      publisher: { '@type': 'Organization', name: 'SalesWyze' },
      mainEntityOfPage: canonical,
    },
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: origin + '/' },
        { '@type': 'ListItem', position: 2, name: 'Guides', item: origin + '/blog' },
        { '@type': 'ListItem', position: 3, name: post.title, item: canonical },
      ],
    },
  ];
  const rel = related.map(p => `<a href="/blog/${p.slug}"><span>${esc(p.title)}</span><span class="rel-arrow">→</span></a>`).join('');
  const content = `
    <article class="wrap post">
      <nav class="crumbs"><a href="/">Home</a><span>/</span><a href="/blog">Guides</a></nav>
      <header class="post-head">
        <span class="post-card-meta">${fmtDate(post.date)}  ·  ${post.read} min read</span>
        <h1 class="h-display">${esc(post.title)}</h1>
      </header>
      <div class="post-body">${post.body}</div>
      <aside class="post-related">
        <h3>Keep reading</h3>
        <div class="rel-list">${rel}</div>
      </aside>
    </article>`;
  return blogShell({ title: post.title + ' | SalesWyze', description: post.description, canonical, jsonld, bodyClass: 'is-post', content });
}

// The instant free-estimate report, rendered as the response to the lead form.
// Same app, same theme, shown in seconds. noindex because it is a per-submission
// result, not a page meant to rank.
function renderAuditReport(origin, { audit, businessName }) {
  const { label, count, deal, rows, narrative, usedTheirValue } = audit;
  const pctLabel = (p) => (p % 1 === 0 ? p : p.toFixed(1)) + '%';
  const rowsHtml = rows.map(r => `
        <tr${r.highlight ? ' class="audit-row-hi"' : ''}>
          <td>${pctLabel(r.pct)} <span class="audit-note">(${r.note})</span></td>
          <td>${r.sales.toLocaleString('en-US')}</td>
          <td class="audit-rev">${fmtMoney(r.revenue)}</td>
        </tr>`).join('');
  const low = rows[0];
  const assume = usedTheirValue
    ? `Based on your own number, about ${fmtMoney(deal)} a sale, and a list of roughly ${count.toLocaleString('en-US')}.`
    : `Based on a typical ${esc(label)} sale of about ${fmtMoney(deal)}, and a list of roughly ${count.toLocaleString('en-US')}. Tell us your real number and we will redo it.`;
  const who = businessName && businessName.trim() ? esc(businessName.trim()) : 'Your list';

  const content = `
    <div class="wrap audit">
      <span class="eyebrow">Your free estimate</span>
      <h1 class="h-display">${who} is worth more than it is doing right now.</h1>
      <p class="audit-lede">${esc(narrative)}</p>

      <table class="audit-table">
        <thead>
          <tr><th>If this many come back</th><th>Sales</th><th>Revenue you recover</th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <p class="audit-assume">${assume} Swap in your own numbers any time. The shape does not change.</p>

      <div class="post-cta">
        <h3>That is money already sitting in your list</h3>
        <p>Even at the ${pctLabel(low.pct)} floor, that is ${fmtMoney(low.revenue)} you are leaving on the table. It runs from $199 a month plus a one-time $999 setup, or fully managed at $499. The follow up pays for itself many times over.</p>
        <a href="/#pricing" class="btn btn-ember btn-large">See the plans</a>
      </div>

      <p class="audit-foot">We saved your details and will reach out to get you set up. Want to talk now? Call or text (747) 688-9992.</p>
    </div>`;

  return blogShell({
    title: 'Your recoverable revenue estimate | SalesWyze',
    description: 'What your old leads and past customers could be worth.',
    canonical: origin + '/',
    bodyClass: 'is-post',
    noindex: true,
    content,
  });
}

function renderBlogNotFound(origin) {
  const content = `
    <div class="wrap post">
      <header class="post-head"><h1 class="h-display">We could not find that guide</h1></header>
      <div class="post-body"><p>It may have moved. <a href="/blog">See all guides</a>, or head <a href="/">back home</a>.</p></div>
    </div>`;
  return blogShell({ title: 'Not found | SalesWyze', description: 'Page not found.', canonical: origin + '/blog', bodyClass: 'is-post', content });
}

function blogCss() {
  return `
.blog-main{background:var(--paper);min-height:70vh;padding:calc(var(--nav-h,72px) + 48px) 0 24px;}
.blog-wrap,.post{max-width:none;}
.blog-hero{max-width:760px;margin:0 auto 8px;padding:0 24px;}
.blog-hero .eyebrow{margin-bottom:14px;}
.blog-hero h1{margin:0 0 18px;font-size:clamp(2.1rem,5vw,3.4rem);line-height:1.02;}
.blog-hero-sub{font-size:1.12rem;line-height:1.7;color:var(--ink-soft);max-width:60ch;}
.post-list{max-width:820px;margin:40px auto 0;padding:0 24px;display:flex;flex-direction:column;gap:18px;}
.post-card{display:block;text-decoration:none;color:var(--ink);background:var(--paper-hi);border:1px solid var(--line);border-radius:14px;padding:26px 28px;transition:transform .18s cubic-bezier(.2,.7,.3,1),box-shadow .18s ease,border-color .18s ease;}
.post-card:hover{transform:translateY(-3px);box-shadow:0 14px 34px rgba(21,18,14,.10);border-color:rgba(21,18,14,.24);}
.post-card-meta{display:inline-block;font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:.04em;color:var(--brass-dark);margin-bottom:10px;text-transform:uppercase;}
.post-card h2{font-family:'Big Shoulders Display',sans-serif;font-weight:800;font-size:1.7rem;line-height:1.05;margin:0 0 10px;letter-spacing:-.01em;}
.post-card p{margin:0 0 14px;color:var(--ink-soft);line-height:1.6;max-width:66ch;}
.post-card-more{font-weight:700;color:var(--ember);font-size:.95rem;}

.post{max-width:720px;margin:0 auto;padding:0 24px;}
.crumbs{display:flex;gap:10px;align-items:center;font-family:'IBM Plex Mono',monospace;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--brass-dark);margin-bottom:22px;}
.crumbs a{color:var(--brass-dark);text-decoration:none;}
.crumbs a:hover{color:var(--ember);}
.post-head{margin-bottom:34px;padding-bottom:26px;border-bottom:1px solid var(--line);}
.post-head h1{margin:12px 0 0;font-size:clamp(2rem,4.6vw,3rem);line-height:1.04;letter-spacing:-.01em;}
.post-body{font-size:1.18rem;line-height:1.78;color:var(--ink-soft);max-width:68ch;}
.post-body p{margin:0 0 1.35em;}
.post-body h2{font-family:'Big Shoulders Display',sans-serif;font-weight:800;color:var(--ink);font-size:1.7rem;line-height:1.1;letter-spacing:-.01em;margin:2em 0 .6em;}
.post-body ul{margin:0 0 1.5em;padding-left:1.1em;}
.post-body li{margin:0 0 .6em;padding-left:.3em;}
.post-body li::marker{color:var(--brass);}
.post-body a{color:var(--ember);text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1.5px;font-weight:600;}
.post-body a:hover{color:var(--ember-hi);}
.post-body strong{color:var(--ink);font-weight:700;}

.post-cta{margin:44px 0 8px;background:var(--ink);color:var(--paper-hi);border-radius:16px;padding:34px 32px;}
.post-cta h3{font-family:'Big Shoulders Display',sans-serif;font-weight:800;font-size:1.6rem;margin:0 0 10px;color:var(--paper-hi);line-height:1.1;}
.post-cta p{margin:0 0 20px;color:rgba(250,246,234,.82);line-height:1.6;max-width:56ch;font-size:1.02rem;}

.post-related{margin-top:52px;padding-top:26px;border-top:1px solid var(--line);}
.post-related h3{font-family:'IBM Plex Mono',monospace;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--brass-dark);margin:0 0 14px;}
.rel-list{display:flex;flex-direction:column;gap:2px;}
.rel-list a{display:flex;justify-content:space-between;align-items:center;gap:16px;text-decoration:none;color:var(--ink);font-weight:600;padding:14px 4px;border-bottom:1px solid var(--line);transition:color .15s ease,padding-left .15s ease;}
.rel-list a:last-child{border-bottom:none;}
.rel-list a:hover{color:var(--ember);padding-left:8px;}
.rel-arrow{color:var(--ember);font-weight:700;}

/* Free estimate report */
.audit{max-width:720px;margin:0 auto;padding:0 24px;}
.audit h1{font-size:clamp(2rem,4.6vw,3rem);line-height:1.05;letter-spacing:-.01em;margin:14px 0 20px;}
.audit-lede{font-size:1.2rem;line-height:1.7;color:var(--ink-soft);margin:0 0 30px;max-width:64ch;}
.audit-table{width:100%;border-collapse:collapse;margin:0 0 14px;}
.audit-table th{text-align:left;font-family:'IBM Plex Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--brass-dark);padding:0 14px 12px;border-bottom:1px solid var(--line);}
.audit-table td{padding:16px 14px;border-bottom:1px solid var(--line);font-size:1.05rem;vertical-align:baseline;}
.audit-table .audit-rev{font-family:'Big Shoulders Display',sans-serif;font-weight:800;font-size:1.55rem;}
.audit-row-hi{background:var(--paper);}
.audit-row-hi .audit-rev{color:var(--ember);}
.audit-note{color:var(--brass-dark);font-size:.85rem;}
.audit-assume{font-size:.92rem;line-height:1.5;color:var(--ink-soft);margin:0 0 8px;}
.audit-foot{font-size:.9rem;color:var(--brass-dark);margin-top:22px;}
.field-hint{display:block;font-size:.78rem;color:var(--brass-dark);margin-top:5px;font-weight:400;line-height:1.4;}
`;
}

// ─── Inline icons (stroke, 20x20) ──────────────────────────────────────────

function icon(name) {
  const paths = {
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
  };
  return `<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}

// ─── CSS ────────────────────────────────────────────────────────────────────

function css() {
  return `
:root{
  --ink:#15120e;
  --ink-soft:#221d16;
  --paper:#f1e8d6;
  --paper-hi:#faf6ea;
  --brass:#b9852c;
  --brass-dark:#8f6620;
  --ember:#b23b27;
  --ember-hi:#cc4a33;
  --pine:#2c3b34;
  --pine-hi:#37493f;
  --line: rgba(21,18,14,0.14);
  --line-light: rgba(241,232,214,0.18);
}
*,*::before,*::after{box-sizing:border-box;}
html{scroll-behavior:smooth;}
body{
  margin:0;
  background:var(--paper);
  color:var(--ink);
  font-family:'Archivo',system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
  line-height:1.5;
}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px;}
h1,h2,h3{margin:0;}
p{margin:0;}
a{color:inherit;text-decoration:none;}
.h-display{
  font-family:'Big Shoulders Display',sans-serif;
  font-weight:800;
  letter-spacing:-0.01em;
  line-height:0.98;
  text-transform:none;
}
.section-title{
  font-family:'Big Shoulders Display',sans-serif;
  font-weight:800;
  font-size:clamp(28px,4vw,42px);
  letter-spacing:-0.01em;
  margin-bottom:28px;
}
.section-title-light{color:var(--paper-hi);}
.num{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums;}

/* grain overlay */
.grain{
  position:fixed;inset:0;pointer-events:none;z-index:999;opacity:0.05;mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='140'%20height='140'%3E%3Cfilter%20id='n'%3E%3CfeTurbulence%20type='fractalNoise'%20baseFrequency='0.85'%20numOctaves='2'%20stitchTiles='stitch'/%3E%3CfeColorMatrix%20type='saturate'%20values='0'/%3E%3C/filter%3E%3Crect%20width='100%25'%20height='100%25'%20filter='url(%23n)'/%3E%3C/svg%3E");
}

/* dot field texture */
.dot-field{
  position:absolute;inset:0;pointer-events:none;
  background-image:radial-gradient(var(--line) 1px,transparent 1px);
  background-size:22px 22px;
  mask-image:linear-gradient(to bottom,black,transparent 85%);
}
.dot-field-light{background-image:radial-gradient(rgba(241,232,214,0.16) 1px,transparent 1px);}

/* nav */
.site-nav{
  position:sticky;top:0;z-index:100;
  background:transparent;
  transition:background .25s ease, box-shadow .25s ease, border-color .25s ease;
  border-bottom:1px solid transparent;
}
.site-nav.scrolled{
  background:rgba(241,232,214,0.92);
  backdrop-filter:blur(8px);
  border-bottom-color:var(--line);
  box-shadow:0 2px 18px rgba(21,18,14,0.06);
}
.nav-inner{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;}
.brand{display:flex;align-items:center;gap:10px;}
.brand-mark{
  display:inline-flex;align-items:center;justify-content:center;
  width:34px;height:34px;background:var(--ink);color:var(--paper-hi);
  font-family:'Big Shoulders Display',sans-serif;font-weight:800;font-size:15px;
  border-radius:3px;
}
.brand-word{font-family:'Big Shoulders Display',sans-serif;font-weight:700;font-size:20px;letter-spacing:0.01em;}
.nav-links{display:flex;align-items:center;gap:22px;font-size:14.5px;font-weight:600;}
.nav-links a:not(.btn):hover{color:var(--ember);}
.nav-signin{opacity:0.75;}

/* buttons */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  padding:12px 22px;border-radius:3px;font-weight:700;font-size:15px;
  border:2px solid transparent;cursor:pointer;transition:transform .15s ease, box-shadow .15s ease, background .15s ease;
  white-space:nowrap;
}
.btn:active{transform:translateY(1px);}
.btn-ember{background:var(--ember);color:var(--paper-hi);}
.btn-ember:hover{background:var(--ember-hi);box-shadow:0 6px 18px rgba(178,59,39,0.35);}
.btn-ink{background:var(--ink);color:var(--paper-hi);}
.btn-ink:hover{background:var(--ink-soft);}
.btn-small{padding:9px 16px;font-size:13.5px;}
.btn-large{padding:16px 30px;font-size:16.5px;}
.btn-block{width:100%;}

/* hero */
.hero{position:relative;padding:88px 0 96px;overflow:hidden;}
.hero-grid{display:grid;grid-template-columns:1.15fr 0.85fr;gap:56px;align-items:center;position:relative;z-index:1;}
.eyebrow{
  display:inline-block;font-size:12.5px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;
  color:var(--ember);background:rgba(178,59,39,0.08);border:1px solid rgba(178,59,39,0.28);
  padding:6px 12px;border-radius:2px;margin-bottom:22px;
}
.hero .h-display{font-size:clamp(38px,5.2vw,64px);margin-bottom:22px;}
.hero-sub{font-size:18px;color:var(--ink-soft);max-width:52ch;margin-bottom:34px;}
.hero-actions{display:flex;flex-direction:column;align-items:flex-start;gap:12px;}
.hero-microcopy{font-size:13.5px;color:rgba(21,18,14,0.55);font-weight:600;}

.ledger{
  background:var(--paper-hi);border:1.5px solid var(--ink);border-radius:2px;
  padding:26px 26px 22px;box-shadow:8px 8px 0 rgba(21,18,14,0.9);
  transform:rotate(1.5deg);
}
.ledger-head{display:flex;justify-content:space-between;align-items:center;
  font-family:'Big Shoulders Display',sans-serif;font-weight:700;letter-spacing:0.04em;font-size:14px;
  border-bottom:1.5px dashed var(--line);padding-bottom:12px;margin-bottom:14px;
}
.ledger-tag{font-family:'Archivo',sans-serif;font-weight:600;font-size:11px;text-transform:uppercase;
  color:var(--brass-dark);background:rgba(185,133,44,0.14);padding:3px 8px;border-radius:2px;letter-spacing:0.04em;
}
.ledger-row{display:flex;justify-content:space-between;gap:16px;font-size:14.5px;padding:7px 0;color:var(--ink-soft);}
.ledger-row .num{color:var(--ink);font-weight:600;}
.ledger-divider{border-top:1.5px solid var(--ink);margin:8px 0;}
.ledger-total{font-size:16.5px;font-weight:700;color:var(--ink);}
.num-total{color:var(--ember);font-size:22px;font-weight:600;}
.ledger-foot{font-size:12.5px;color:rgba(21,18,14,0.55);margin-top:14px;line-height:1.5;}

/* problem */
.problem{position:relative;background:var(--ink);color:var(--paper);padding:88px 0;overflow:hidden;}
.problem .section-title{color:var(--paper-hi);}
.problem-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;position:relative;z-index:1;}
.problem-card{
  border:1px solid var(--line-light);padding:26px 22px;border-radius:2px;background:rgba(241,232,214,0.03);
}
.problem-card .icon{color:var(--brass);margin-bottom:16px;}
.problem-card p{font-size:16.5px;color:rgba(241,232,214,0.88);font-weight:500;}
.problem-line{margin-top:38px;font-size:19px;font-weight:600;color:var(--paper-hi);max-width:62ch;position:relative;z-index:1;}

/* how it works */
.how{padding:96px 0;}
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:28px;}
.step{border-top:3px solid var(--brass);padding-top:18px;}
.step-num{
  display:block;font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:13px;color:var(--brass-dark);margin-bottom:10px;
}
.step h3{font-family:'Big Shoulders Display',sans-serif;font-weight:700;font-size:22px;margin-bottom:10px;}
.step p{font-size:15px;color:var(--ink-soft);}

/* trust */
.trust{background:var(--pine);color:var(--paper);padding:96px 0;}
.trust-grid{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:start;}
.trust-story{font-size:18.5px;line-height:1.65;color:rgba(241,232,214,0.9);}
.trust-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:20px;}
.trust-list li{display:flex;gap:14px;align-items:flex-start;font-size:15.5px;color:rgba(241,232,214,0.92);}
.trust-list .icon{flex-shrink:0;color:var(--brass);margin-top:2px;}

/* deal */
.deal{padding:96px 0;}
.deal-card{
  max-width:720px;margin:0 auto;text-align:center;background:var(--paper-hi);
  border:1.5px solid var(--ink);padding:52px 44px;border-radius:2px;
}
.deal-card .section-title{margin-bottom:18px;}
.deal-card p{font-size:17px;color:var(--ink-soft);max-width:56ch;margin:0 auto 30px;}

/* faq */
.faq{position:relative;background:var(--ink);padding:96px 0;overflow:hidden;}
.faq-list{display:flex;flex-direction:column;gap:2px;position:relative;z-index:1;}
.faq-list details{
  background:rgba(241,232,214,0.03);border:1px solid var(--line-light);border-radius:2px;padding:20px 22px;
}
.faq-list summary{
  cursor:pointer;font-weight:700;font-size:16.5px;color:var(--paper-hi);list-style:none;
  display:flex;justify-content:space-between;align-items:center;
}
.faq-list summary::-webkit-details-marker{display:none;}
.faq-list summary::after{content:'+';font-size:22px;color:var(--brass);font-weight:400;}
.faq-list details[open] summary::after{content:'\\2212';}
.faq-list p{margin-top:14px;font-size:15px;color:rgba(241,232,214,0.82);line-height:1.6;}

/* final cta */
.cta-final{padding:96px 0 120px;}
.apply-card{
  max-width:760px;margin:0 auto;background:var(--paper-hi);border:1.5px solid var(--ink);
  padding:48px;border-radius:2px;position:relative;
  clip-path:polygon(0% 0%,3% 1.5%,6% 0%,9% 1.5%,12% 0%,15% 1.5%,18% 0%,21% 1.5%,24% 0%,27% 1.5%,30% 0%,33% 1.5%,36% 0%,39% 1.5%,42% 0%,45% 1.5%,48% 0%,51% 1.5%,54% 0%,57% 1.5%,60% 0%,63% 1.5%,66% 0%,69% 1.5%,72% 0%,75% 1.5%,78% 0%,81% 1.5%,84% 0%,87% 1.5%,90% 0%,93% 1.5%,96% 0%,100% 1.5%,100% 100%,0% 100%);
}
.apply-header{margin-bottom:30px;}
.h-display-small{font-size:clamp(28px,3.6vw,38px);margin-bottom:12px;}
.apply-header p{font-size:16px;color:var(--ink-soft);}
.apply-form{display:flex;flex-direction:column;gap:16px;}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
.apply-form label{display:flex;flex-direction:column;gap:6px;font-size:13.5px;font-weight:700;color:var(--ink-soft);}
.form-full{grid-column:1/-1;}
.apply-form input,.apply-form select,.apply-form textarea{
  font-family:'Archivo',sans-serif;font-size:15px;font-weight:500;color:var(--ink);
  border:1.5px solid var(--line);background:var(--paper);border-radius:2px;padding:11px 12px;
  outline:none;transition:border-color .15s ease;
}
.apply-form input:focus,.apply-form select:focus,.apply-form textarea:focus{border-color:var(--ember);}
.apply-form textarea{resize:vertical;font-weight:400;}
.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0;}
.form-error{background:rgba(178,59,39,0.1);border:1px solid rgba(178,59,39,0.3);color:var(--ember);
  padding:12px 14px;border-radius:2px;font-size:14px;font-weight:600;
}
.apply-success{display:flex;align-items:center;gap:16px;background:rgba(44,59,52,0.06);
  border:1.5px solid var(--pine);padding:22px;border-radius:2px;
}
.apply-success .icon{color:var(--pine);flex-shrink:0;}
.apply-success strong{display:block;font-size:16px;margin-bottom:2px;}
.apply-success span{font-size:14.5px;color:var(--ink-soft);}

/* footer */
.site-footer{background:var(--ink);padding:26px 0;color:rgba(241,232,214,0.6);font-size:13.5px;}
.footer-inner{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;}
.footer-inner a:hover{color:var(--paper-hi);}

/* reveal animation — hidden only once JS confirms it can reveal them again (progressive enhancement, see html.has-js) */
.reveal{transition:opacity .6s ease, transform .6s ease;transition-delay:var(--delay,0ms);}
html.has-js .reveal{opacity:0;transform:translateY(18px);}
html.has-js .reveal.in-view{opacity:1;transform:translateY(0);}

/* responsive */
@media (max-width:920px){
  .hero-grid{grid-template-columns:1fr;gap:44px;}
  .ledger{transform:none;max-width:440px;}
  .problem-grid{grid-template-columns:1fr;}
  .steps{grid-template-columns:1fr 1fr;}
  .trust-grid{grid-template-columns:1fr;gap:36px;}
  .nav-links a:not(.btn-small):not(.nav-signin){display:none;}
}
@media (max-width:640px){
  .steps{grid-template-columns:1fr;}
  .form-row{grid-template-columns:1fr;}
  .apply-card{padding:32px 22px;}
  .deal-card{padding:36px 24px;}
  .nav-signin{display:none;}
  .tier-featured{transform:none;}
}

/* Pricing */
.pricing{background:var(--paper);padding:clamp(64px,9vw,112px) 0;}
.pricing .section-title{text-align:center;}
.pricing-lede{text-align:center;color:var(--ink-soft);max-width:52ch;margin:14px auto 0;font-size:1.05rem;line-height:1.6;}
.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(272px,1fr));gap:20px;max-width:1040px;margin:48px auto 0;align-items:stretch;}
.tiers-2{max-width:760px;}
.tier-sub{margin:-8px 0 16px;font-size:.9rem;font-weight:500;color:var(--brass-dark);}
.tier-featured .tier-sub{color:rgba(250,246,234,.7);}
.tier{background:var(--paper-hi);border:1px solid var(--line);border-radius:18px;padding:32px 28px;display:flex;flex-direction:column;}
.tier-featured{background:var(--ink);color:var(--paper-hi);border-color:var(--ink);box-shadow:0 26px 62px rgba(21,18,14,.30);transform:translateY(-8px);}
.tier-tag{display:inline-block;font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--brass-dark);margin-bottom:16px;font-weight:600;}
.tier-featured .tier-tag{color:var(--brass);}
.tier h3{font-family:'Big Shoulders Display',sans-serif;font-weight:800;font-size:1.85rem;margin:0 0 10px;line-height:1;}
.tier-price{display:flex;align-items:baseline;gap:5px;margin-bottom:14px;}
.tier-price .amt{font-family:'Big Shoulders Display',sans-serif;font-weight:900;font-size:3rem;line-height:1;letter-spacing:-.02em;}
.tier-price .per{font-size:1rem;color:var(--ink-soft);font-weight:600;}
.tier-featured .tier-price .per{color:rgba(250,246,234,.72);}
.tier-note{font-size:.98rem;line-height:1.55;color:var(--ink-soft);margin:0 0 22px;}
.tier-featured .tier-note{color:rgba(250,246,234,.84);}
.tier-list{list-style:none;margin:0 0 26px;padding:0;display:flex;flex-direction:column;gap:11px;flex:1;}
.tier-list li{position:relative;padding-left:26px;font-size:.96rem;line-height:1.45;}
.tier-list li::before{content:"\\2713";position:absolute;left:0;top:0;color:var(--ember);font-weight:800;}
.tier-featured .tier-list li::before{color:var(--brass);}
.tier .btn{width:100%;justify-content:center;margin-top:auto;}
.pricing-foot{text-align:center;color:var(--ink-soft);margin:34px auto 0;font-size:1rem;}
.pricing-foot a{color:var(--ember);font-weight:700;text-decoration:none;}
.pricing-foot a:hover{text-decoration:underline;}
`;
}

// ─── JS ─────────────────────────────────────────────────────────────────────

function js() {
  return `
(function(){
  var nav = document.getElementById('siteNav');
  function onScroll(){
    if(window.scrollY > 12){ nav.classList.add('scrolled'); } else { nav.classList.remove('scrolled'); }
  }
  document.addEventListener('scroll', onScroll, {passive:true});
  onScroll();

  var io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){ e.target.classList.add('in-view'); io.unobserve(e.target); }
    });
  }, {threshold:0, rootMargin:'0px 0px -10px 0px'});
  document.querySelectorAll('.reveal').forEach(function(el){
    io.observe(el);
    var rect = el.getBoundingClientRect();
    if(rect.top < window.innerHeight && rect.bottom > 0){
      el.classList.add('in-view');
    }
  });

  var counterEl = document.querySelector('.num-total');
  if(counterEl){
    var done = false;
    var cIo = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if(e.isIntersecting && !done){
          done = true;
          var target = parseInt(counterEl.getAttribute('data-target'), 10) || 0;
          var start = null;
          var duration = 1300;
          function step(ts){
            if(!start) start = ts;
            var progress = Math.min((ts - start) / duration, 1);
            var eased = 1 - Math.pow(1 - progress, 3);
            var val = Math.round(eased * target);
            counterEl.textContent = '$' + val.toLocaleString('en-US');
            if(progress < 1) requestAnimationFrame(step);
          }
          requestAnimationFrame(step);
          cIo.unobserve(counterEl);
        }
      });
    }, {threshold:0.4});
    cIo.observe(counterEl);
  }
})();
`;
}

module.exports = router;
