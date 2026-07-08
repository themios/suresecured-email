/** Shared Shopify attribution cookie + redirect query params (matches shopify-handoff/snippet.js). */
const COOKIE_NAME = 'ss_attr';

function buildAttributionPayload({ token, salespersonId, leadId }) {
  return {
    token:          token || '',
    salesperson_id: salespersonId != null ? String(salespersonId) : '',
    lead_id:        leadId != null ? String(leadId) : '',
    landed_at:      new Date().toISOString(),
  };
}

function setAttributionCookie(res, payload) {
  res.cookie(COOKIE_NAME, JSON.stringify(payload), {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    domain: process.env.COOKIE_DOMAIN || undefined,
  });
}

function appendAttributionToUrl(destinationUrl, token, salespersonId) {
  const destination = new URL(
    destinationUrl || process.env.SITE_URL || 'https://suresecured.com'
  );
  if (token) destination.searchParams.set('ss_token', token);
  if (salespersonId != null) destination.searchParams.set('ss_sp', String(salespersonId));
  return destination.toString();
}

module.exports = { COOKIE_NAME, buildAttributionPayload, setAttributionCookie, appendAttributionToUrl };
