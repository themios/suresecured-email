/**
 * SureSecured Commission Tracking Snippet
 * Version: 1.2
 *
 * ─── SHOPIFY DEVELOPER INSTRUCTIONS ────────────────────────────────────────
 *
 * 1. Shopify Admin → Online Store → Themes → Edit Code
 * 2. Open: layout/theme.liquid
 * 3. Paste the <script> block below just before the closing </body> tag
 * 4. Save
 *
 * That's it. No other files need to change for purchase attribution.
 *
 * ─── WHAT THIS DOES (invisible to visitors) ─────────────────────────────────
 *
 * When a visitor arrives from a SalesPilot email link (URL contains ?ss_token):
 *   1. Saves the attribution token in a 365-day cookie + localStorage on this domain
 *   2. Writes it to the Shopify cart as a note attribute — flows to every order placed
 *   3. Injects it as a hidden field into every form on every page
 *   4. Appends ss_token/ss_sp onto any GoHighLevel form iframe's src, so GHL's
 *      own "fill from URL parameter" hidden fields can pick it up
 *
 * On return visits (no token in URL):
 *   1. Reads saved cookie/localStorage — attribution persists for 365 days
 *   2. Re-injects cart attribute, form fields, and GHL iframe src on every page load
 *
 * ─── ATTRIBUTION CHAIN ───────────────────────────────────────────────────────
 *
 *   Email click → /r/{token} → suresecured.com?ss_token=X&ss_sp=Y
 *       → snippet fires → cookie set → cart attribute written
 *       → customer buys → order has note_attribute ss_token
 *       → SalesPilot webhook fires → commission credited to correct salesperson
 *
 * ─── QUOTE / DEALER FORM NOTE ─────────────────────────────────────────────
 *
 * request-a-quote and become-a-dealer are GoHighLevel forms embedded in a
 * cross-origin <iframe src="https://links.suresecured.com/widget/form/...">.
 * JS on the parent page cannot reach into that iframe's DOM (Same-Origin
 * Policy), so the old "inject hidden fields into every form" approach never
 * reached them. Instead, this snippet rewrites the iframe's own src to add
 * ?ss_token=...&ss_sp=... — GHL's hidden fields are configured (in the GHL
 * form builder) to read those same param names and store them on the
 * contact record, which SalesPilot's webhook then reads.
 *
 * The plain `injectIntoForms()` hidden-field approach below still applies to
 * any genuinely native Shopify/HTML forms elsewhere on the site.
 *
 * ─── ENV VARS REQUIRED IN SALESPILOT (.env) ─────────────────────────────────
 *
 *   SHOPIFY_WEBHOOK_SECRET=  (from Shopify Admin → Settings → Notifications → Webhooks)
 *   SHOPIFY_DOMAIN=suresecured.com
 *
 */

<script>
(function () {
  'use strict';

  var COOKIE_NAME  = 'ss_attr';
  var LS_KEY       = 'ss_attribution';
  var COOKIE_DAYS  = 365;

  // ── Storage helpers ────────────────────────────────────────────────────────

  function readAttribution() {
    // Cookie first, localStorage as fallback
    try {
      var match = document.cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]*)'));
      if (match) return JSON.parse(decodeURIComponent(match[1]));
    } catch (e) {}
    try {
      var ls = localStorage.getItem(LS_KEY);
      if (ls) return JSON.parse(ls);
    } catch (e) {}
    return null;
  }

  function writeAttribution(data) {
    try {
      var enc = encodeURIComponent(JSON.stringify(data));
      var exp = new Date(Date.now() + COOKIE_DAYS * 864e5).toUTCString();
      document.cookie = COOKIE_NAME + '=' + enc + '; expires=' + exp + '; path=/; SameSite=Lax';
    } catch (e) {}
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) {}
  }

  // ── Read URL params (set by /r/{token} redirect) ──────────────────────────

  var params = new URLSearchParams(window.location.search);
  var urlToken = params.get('ss_token');
  var urlSp    = params.get('ss_sp');

  var attribution = readAttribution();

  // Fresh click always wins — update stored attribution
  if (urlToken) {
    attribution = {
      token:          urlToken,
      salesperson_id: urlSp || '',
      landed_at:      new Date().toISOString(),
      landing_page:   window.location.pathname,
    };
    writeAttribution(attribution);

    // Clean tracking params from URL bar (cosmetic — doesn't affect attribution)
    try {
      var clean = new URL(window.location.href);
      clean.searchParams.delete('ss_token');
      clean.searchParams.delete('ss_sp');
      window.history.replaceState(null, '', clean.toString());
    } catch (e) {}
  }

  // Nothing to do if this visitor has never come from an email
  if (!attribution) return;

  // ── Cart attribute (purchase path) ────────────────────────────────────────
  // Shopify passes cart.attributes to every order as note_attributes.
  // The SalesPilot webhook reads note_attributes.ss_token to credit commission.

  function writeCartAttribution() {
    fetch('/cart/update.js', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attributes: {
          ss_token:        attribution.token          || '',
          ss_salesperson:  attribution.salesperson_id || '',
          ss_landed_at:    attribution.landed_at      || '',
        }
      })
    }).catch(function () {}); // silent — attribution is best-effort on cart
  }

  writeCartAttribution();

  // Re-write cart attributes after any add-to-cart (SPA stores re-render cart)
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest
      ? e.target.closest('[name="add"], [data-add-to-cart]')
      : null;
    if (btn) setTimeout(writeCartAttribution, 500);
  });

  // ── Form injection (quote / dealer / contact forms) ───────────────────────
  // Injects hidden fields so form submissions carry attribution data.
  // Uses contact[ss_token] format so Shopify native forms include it in the
  // notification email received by the sales team.

  var FIELDS = {
    'contact[ss_token]':       attribution.token          || '',
    'contact[ss_salesperson]': attribution.salesperson_id || '',
    'ss_token':                attribution.token          || '', // catch-all for non-Shopify forms
    'ss_salesperson':          attribution.salesperson_id || '',
  };

  function injectIntoForms() {
    document.querySelectorAll('form').forEach(function (form) {
      Object.keys(FIELDS).forEach(function (name) {
        if (!form.querySelector('input[name="' + name + '"]')) {
          var input    = document.createElement('input');
          input.type   = 'hidden';
          input.name   = name;
          input.value  = FIELDS[name];
          form.appendChild(input);
        }
      });
    });
  }

  injectIntoForms();

  // ── GoHighLevel iframe forms (request-a-quote, become-a-dealer) ───────────
  // These forms live in a cross-origin iframe, so injectIntoForms() above can
  // never reach their fields. GHL's own hidden fields instead read from the
  // iframe's own URL — so we rewrite the iframe src to carry the params.

  var GHL_IFRAME_RE = /links\.suresecured\.com\/widget\/form\//;

  function fixGhlIframes() {
    document.querySelectorAll('iframe').forEach(function (frame) {
      if (!frame.src || !GHL_IFRAME_RE.test(frame.src)) return;
      if (frame.src.indexOf('ss_token=') !== -1) return; // already carries it
      try {
        var url = new URL(frame.src);
        url.searchParams.set('ss_token', attribution.token || '');
        url.searchParams.set('ss_sp', attribution.salesperson_id || '');
        frame.src = url.toString();
      } catch (e) {}
    });
  }

  fixGhlIframes();

  // Watch for dynamically rendered forms/iframes (Typeform, JotForm, GHL embeds,
  // multi-step flows) that aren't present in the DOM at initial script run
  if (window.MutationObserver) {
    new MutationObserver(function () {
      injectIntoForms();
      fixGhlIframes();
    }).observe(document.body, { childList: true, subtree: true });
  }

})();
</script>
