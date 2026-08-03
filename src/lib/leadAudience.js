/**
 * Classify an inbound contact as B2B (dealer/reseller) or B2C (homeowner) so the
 * autoresponder enrolls them in the right sequence.
 *
 * A prospective dealer dropped into a homeowner sequence gets a pitch about
 * securing their own windows, which reads as a mis-sent email and wastes the
 * best lead type the business gets. Web forms carry an explicit form_type and
 * need no guessing; plain inbound email carries no such signal, so this infers.
 *
 * Order matters: an explicit intent word beats the sender's domain, because
 * someone writing "I want to become a dealer" from a gmail address is stating
 * intent, while the domain is only a proxy for it.
 */

// Consumer mailbox providers. A sender here is a person, not a business — the
// single most reliable B2C signal available without reading the message.
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'aol.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com',
  'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com',
  'mail.com', 'zoho.com', 'yandex.com', 'comcast.net', 'sbcglobal.net',
  'verizon.net', 'att.net', 'cox.net', 'charter.net', 'earthlink.net',
  'bellsouth.net', 'roadrunner.com', 'rr.com', 'optonline.net', 'juno.com',
]);

// Words that signal wholesale intent rather than a homeowner buying one screen.
const B2B_INTENT = /\b(dealer|dealership|reseller|re-?sell|wholesale|distributor|distribut(e|ion)|trade\s*account|bulk\s*(order|pricing|quote)|contractor|installer|franchis(e|ee)|partnership|become\s+a\s+partner|volume\s*(pricing|discount)|b2b)\b/i;

// Words that signal a homeowner. Only consulted to override a business-looking
// domain — a facilities manager emailing about their own house is still B2C.
const B2C_INTENT = /\b(my\s+(home|house|window|door|patio|apartment|condo)|for\s+my\s+(home|house)|homeowner|single\s+(door|window)|one\s+(door|window))\b/i;

/** Bare lowercased domain from an email address, or '' if unparseable. */
function domainOf(email) {
  const at = String(email || '').toLowerCase().trim().lastIndexOf('@');
  return at >= 0 ? String(email).toLowerCase().trim().slice(at + 1) : '';
}

/**
 * @param {object} input
 * @param {string} [input.email]     sender address
 * @param {string} [input.subject]   message subject
 * @param {string} [input.body]      message body (first ~2k chars is plenty)
 * @param {string} [input.formType]  'dealer' | 'quote' from a web form, when known
 * @returns {{audience:'B2B'|'B2C', reason:string}}
 */
function classifyAudience({ email, subject, body, formType } = {}) {
  // A web form states which form was submitted. Never second-guess that.
  if (formType) {
    return String(formType).toLowerCase() === 'dealer'
      ? { audience: 'B2B', reason: 'form_type' }
      : { audience: 'B2C', reason: 'form_type' };
  }

  const text = `${subject || ''}\n${String(body || '').slice(0, 2000)}`;

  if (B2B_INTENT.test(text)) return { audience: 'B2B', reason: 'intent_keyword' };

  const domain = domainOf(email);
  if (!domain)               return { audience: 'B2C', reason: 'no_domain' };
  if (FREE_MAIL.has(domain)) return { audience: 'B2C', reason: 'free_mail_domain' };

  // Business domain, but the message is plainly about their own home.
  if (B2C_INTENT.test(text)) return { audience: 'B2C', reason: 'homeowner_language' };

  return { audience: 'B2B', reason: 'business_domain' };
}

module.exports = { classifyAudience, domainOf, FREE_MAIL, B2B_INTENT, B2C_INTENT };
