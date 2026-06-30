/**
 * SureSecured Commission Tracking Snippet
 *
 * INSTRUCTIONS FOR SHOPIFY DEVELOPER:
 *
 * 1. Open Shopify Admin > Online Store > Themes > Edit Code
 * 2. Open layout/theme.liquid
 * 3. Paste this entire script block just before the closing </body> tag
 * 4. Save. That's it.
 *
 * What this does (invisible to visitors):
 * - Reads attribution data from the URL when a lead clicks an email link
 * - Saves it in a cookie so it persists across pages for 365 days
 * - Injects hidden fields into all forms so submissions carry attribution data
 * - Writes attribution to the cart so purchases are attributed too
 */

<script>
(function() {
  var COOKIE_NAME = 'ss_attribution';
  var COOKIE_DAYS = 365;

  // Read a cookie value by name
  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    if (match) {
      try { return JSON.parse(decodeURIComponent(match[2])); } catch(e) { return null; }
    }
    return null;
  }

  // Write a cookie
  function setCookie(name, value, days) {
    var expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = name + '=' + encodeURIComponent(JSON.stringify(value))
      + '; expires=' + expires
      + '; path=/'
      + '; SameSite=Lax';
  }

  // Read URL params — set when the tracking redirect sends the visitor here
  function getParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  // Check URL for fresh attribution data
  var token = getParam('ss_token');
  var salespersonId = getParam('ss_sp');

  var attribution = getCookie(COOKIE_NAME);

  // If URL has tracking params, update the cookie (fresh click wins)
  if (token) {
    attribution = {
      token: token,
      salesperson_id: salespersonId,
      landed_at: new Date().toISOString(),
      landing_page: window.location.pathname
    };
    setCookie(COOKIE_NAME, attribution, COOKIE_DAYS);
  }

  if (!attribution) return; // No attribution — visitor didn't come from an email

  // Inject hidden fields into every form on the page
  function injectIntoForms() {
    var forms = document.querySelectorAll('form');
    forms.forEach(function(form) {
      var fields = {
        'ss_token': attribution.token,
        'ss_salesperson_id': attribution.salesperson_id,
        'ss_landed_at': attribution.landed_at,
        'ss_lead_id': attribution.lead_id || ''
      };
      Object.keys(fields).forEach(function(name) {
        if (!form.querySelector('input[name="' + name + '"]')) {
          var input = document.createElement('input');
          input.type = 'hidden';
          input.name = name;
          input.value = fields[name] || '';
          form.appendChild(input);
        }
      });
    });
  }

  // Write attribution to Shopify cart note attributes
  // This ensures direct purchases are attributed even without a form submission
  function writeCartAttribution() {
    fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attributes: {
          'ss_token': attribution.token || '',
          'ss_salesperson_id': attribution.salesperson_id || '',
          'ss_lead_id': attribution.lead_id || '',
          'ss_landed_at': attribution.landed_at || ''
        }
      })
    }).catch(function() {}); // Silent fail — attribution is best-effort on cart
  }

  // Run immediately
  injectIntoForms();
  writeCartAttribution();

  // Also run after any dynamic content loads (for embedded forms like Typeform/JotForm)
  var observer = new MutationObserver(function() { injectIntoForms(); });
  observer.observe(document.body, { childList: true, subtree: true });

})();
</script>
