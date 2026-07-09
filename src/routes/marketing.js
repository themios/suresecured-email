const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { leadFormLimiter } = require('../middleware/rateLimit');

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Public landing page ───────────────────────────────────────────────────

router.get('/', (req, res) => {
  const submitted = req.query.submitted === '1';
  const formError = req.query.error === '1';
  res.set('Cache-Control', 'no-store');
  res.send(renderLanding({ submitted, formError }));
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

    res.redirect('/?submitted=1#apply');
  }
);

// ─── Page ───────────────────────────────────────────────────────────────────

function renderLanding({ submitted, formError }) {
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
      <a href="#deal">The deal</a>
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
        <span class="eyebrow">For roofers, HVAC, electrical, plumbing &amp; security dealers</span>
        <h1 class="h-display">The leads you already paid for are still sitting there.</h1>
        <p class="hero-sub">Every quote you sent and never heard back on is a job somebody else could still close for you. We turn that old list into new work, with follow up written to sound like your business, not a call center.</p>
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
          <p>A folder of quotes nobody ever followed up on.</p>
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
          <h3>You pay when it closes</h3>
          <p>No retainer, no setup fee. We take a cut of what actually sells. Nothing sells, you owe nothing.</p>
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
  <section class="deal" id="deal">
    <div class="wrap">
      <div class="deal-card reveal">
        <h2 class="section-title">The deal, plainly</h2>
        <p>There's no monthly fee and nothing to buy. When a job closes because of this, we take a percentage of that sale. Typical structures start around 10% and improve the more jobs close in a month. You keep every dollar until then.</p>
        <a href="#apply" class="btn btn-ink">Ask about your rate</a>
      </div>
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
            <label>What's your trade?
              <select name="trade">
                <option value="">Select one</option>
                <option value="security">Security &amp; screens</option>
                <option value="roofing">Roofing</option>
                <option value="hvac">HVAC</option>
                <option value="plumbing">Plumbing</option>
                <option value="electrical">Electrical</option>
                <option value="other">Other</option>
              </select>
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
.reveal.in-view{opacity:1;transform:translateY(0);}

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
}
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
  }, {threshold:0.15});
  document.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });

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
