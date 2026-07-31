/**
 * Explicit, tenant-editable "which senders count as a lead" allowlist.
 * Ported from a sibling project's proven design (Wyze), adapted for a
 * multi-vertical platform: no hardcoded per-marketplace defaults (Wyze
 * assumes automotive/RE/trades; this platform serves any business), so the
 * list starts empty and the existing automated-sender denylist
 * (lib/emailSources.js's isAutomatedSender) remains the safety net until a
 * tenant adds their own rules.
 *
 * Semantics: an EMPTY matcher list means "capture anything that isn't
 * obviously bulk/automated mail" (today's default, unchanged). A NON-EMPTY
 * list switches that tenant to allowlist mode -- only messages matching a
 * rule are captured, full stop. This is a deliberate, safer mode a tenant
 * opts into, not a second filter stacked on top of the first.
 */
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const DOMAIN_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

/** Guess whether typed text is a full email, a bare domain, or a partial. */
function inferMatcherType(value) {
  const v = normalize(value);
  if (EMAIL_RE.test(v)) return 'exact';
  if (DOMAIN_RE.test(v)) return 'domain';
  return 'contains';
}

function isValidMatcher(matcher) {
  if (!matcher || matcher.value.length > 160) return false;
  if (matcher.type === 'exact') return EMAIL_RE.test(matcher.value);
  if (matcher.type === 'domain') return DOMAIN_RE.test(matcher.value);
  if (matcher.type === 'contains') return matcher.value.length >= 4; // avoid 1-2 char false-positive partials
  return false;
}

/** Coerce+validate a raw input (string or {type,value}) into a clean matcher or null. */
function coerceMatcher(input) {
  if (typeof input === 'string') {
    const value = normalize(input);
    if (!value) return null;
    return { type: inferMatcherType(value), value };
  }
  if (!input || typeof input !== 'object') return null;
  const value = normalize(input.value);
  if (!value) return null;
  const type = ['exact', 'domain', 'contains'].includes(input.type) ? input.type : inferMatcherType(value);
  return { type, value };
}

/** Validate, dedupe, and cap a raw matcher list (e.g. straight from request JSON). */
function sanitizeMatchers(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const m = coerceMatcher(raw);
    if (!m || !isValidMatcher(m)) continue;
    const key = `${m.type}:${m.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
    if (out.length >= 30) break;
  }
  return out;
}

function extractEmail(value) {
  const raw = String(value || '').trim().toLowerCase();
  const m = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : raw;
}

/** Priority: exact match first, then domain (incl. subdomain), then contains. */
function matchSender(fromAddress, matchers) {
  const email = extractEmail(fromAddress);
  if (!email) return null;
  for (const m of matchers) if (m.type === 'exact' && email === m.value) return m;
  for (const m of matchers) {
    if (m.type === 'domain' && (email === m.value || email.endsWith('@' + m.value) || email.endsWith(m.value))) return m;
  }
  for (const m of matchers) if (m.type === 'contains' && email.includes(m.value)) return m;
  return null;
}

/** Gmail search query that fetches only mail from the allowlisted senders. */
function buildGmailQuery(matchers, extra = '') {
  const parts = Array.from(new Set(matchers.map(m => m.value.replace(/["\\]/g, '').trim()).filter(Boolean)))
    .map(v => `from:${v}`);
  if (!parts.length) return extra;
  return `(${parts.join(' OR ')}) ${extra}`.trim();
}

module.exports = { inferMatcherType, sanitizeMatchers, matchSender, extractEmail, buildGmailQuery };
