// Verified-recipient flow for the public estimate form.
//
// Rule: nothing that costs money or reaches a third party is triggered by an
// unverified submission, except one fixed-text confirmation email that is itself
// capped by quotas. The model call and the estimate email happen only after the
// recipient uses a single-use token that was sent to the address they gave.
const crypto = require('crypto');

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

// Every cap is a named constant. Changing one is a reviewed code change.
const LIMITS = Object.freeze({
  SUBMIT_GLOBAL_PER_HOUR: 300,          // stored leads, all sources
  CONFIRM_EMAIL_GLOBAL_PER_DAY: 100,    // confirmation emails the platform will send
  CONFIRM_EMAIL_PER_IP_PER_DAY: 5,
  CONFIRM_EMAIL_PER_ADDRESS_PER_DAY: 2, // counted on the canonical address
  CONFIRM_POST_PER_IP_PER_HOUR: 30,
  AI_ESTIMATES_GLOBAL_PER_DAY: 100,     // model calls for estimates
  TOKEN_TTL_MS: DAY,
});

const FIELD_MAX = Object.freeze({
  business_name: 255, contact_name: 255, trade: 100, email: 254,
  phone: 50, list_size: 50, message: 2000, deal_value: 50,
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

// One inbox, one identity: strips Gmail dots and +tags so a single victim inbox
// cannot be hit repeatedly through address variants.
function canonicalAddress(email) {
  const [local0, domain0] = String(email).trim().toLowerCase().split('@');
  let local = local0.split('+')[0];
  let domain = domain0;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

// Strict read of the form body. Anything that is not a plain string within its
// bound rejects the whole submission (repeated keys arrive as arrays).
function readFields(body) {
  if (!body || typeof body !== 'object') return null;
  const out = {};
  for (const [key, max] of Object.entries(FIELD_MAX)) {
    const v = body[key];
    if (v === undefined) { out[key] = ''; continue; }
    if (typeof v !== 'string' || v.length > max) return null;
    out[key] = v.trim();
  }
  if (/[\r\n]/.test(out.email)) return null;
  return out;
}

/**
 * deps:
 *   store            estimateStore interface (see estimateStore.js)
 *   sendConfirmation async ({ to, link }) -> sends the fixed-text confirmation email
 *   generateAudit    async (trade, list_size, deal_value, { useAi }) -> audit
 *   emailAuditCopy   async ({ to, businessName, audit, origin }) (best effort)
 *   renderReport     (origin, { audit, businessName }) -> html
 *   renderConfirm    ({ token, state }) -> html, state: 'ready' | 'invalid'
 *   publicOrigin     () -> string, fixed origin used in emailed links
 *   alert            async (text) -> operator alert
 *   log              console-like
 */
function createEstimateHandlers(deps) {
  const { store, sendConfirmation, generateAudit, emailAuditCopy, renderReport,
          renderConfirm, publicOrigin, alert, log = console } = deps;

  const THANKS = '/?submitted=confirm#apply';

  async function quota(bucket, windowMs, limit, label) {
    const r = await store.consumeQuota(bucket, windowMs, limit);
    if (!r.allowed && r.firstDenial) {
      log.warn(`[abuse] quota tripped: ${label}`);
      alert(`<b>Form quota tripped</b>: ${label} (limit ${limit}). Check /cron/form-abuse-report.`).catch(() => {});
    }
    return r.allowed;
  }

  // At most one operator alert per hour for a given condition.
  function alertOncePerHour(key, text) {
    store.consumeQuota(`alert:${key}:hour`, HOUR, 1).then(r => {
      if (r.allowed) alert(`<b>Estimate form</b>: ${text}`).catch(() => {});
    }).catch(() => {});
  }

  async function submit(req, res) {
    const f = readFields(req.body);
    if (!f) return res.redirect('/?error=1#apply');
    if (typeof req.body.company_website === 'string' && req.body.company_website) {
      return res.redirect(THANKS); // honeypot: noise reduction only, not the boundary
    }
    if (!f.business_name || !EMAIL_RE.test(f.email)) return res.redirect('/?error=1#apply');

    // Bound storage growth. Over the cap the lead is not stored; the visitor sees
    // the same page so the cap does not reveal itself.
    if (!(await quota('submit:global:hour', HOUR, LIMITS.SUBMIT_GLOBAL_PER_HOUR, 'stored submissions per hour'))) {
      return res.redirect(THANKS);
    }

    let leadId;
    try { leadId = await store.insertLead(f); }
    catch (err) {
      log.error('[estimate] lead insert failed:', err.message);
      return res.redirect('/?error=1#apply');
    }

    const ipKey = sha256(req.ip || 'unknown').slice(0, 24);
    const addrKey = sha256(canonicalAddress(f.email)).slice(0, 24);
    const allowed =
      (await quota(`confirm:ip:${ipKey}:day`, DAY, LIMITS.CONFIRM_EMAIL_PER_IP_PER_DAY, 'confirmation emails per source IP')) &&
      (await quota(`confirm:addr:${addrKey}:day`, DAY, LIMITS.CONFIRM_EMAIL_PER_ADDRESS_PER_DAY, 'confirmation emails per address')) &&
      (await quota('confirm:global:day', DAY, LIMITS.CONFIRM_EMAIL_GLOBAL_PER_DAY, 'confirmation emails per day (global)'));
    if (!allowed) {
      await store.setConfirmStatus(leadId, 'quota_blocked').catch(() => {});
      return res.redirect(THANKS);
    }

    const token = newToken();
    try {
      await store.createVerification(leadId, sha256(token), new Date(Date.now() + LIMITS.TOKEN_TTL_MS));
      await sendConfirmation({ to: f.email, link: `${publicOrigin()}/get-started/confirm/${token}` });
      await store.setConfirmStatus(leadId, 'sent');
    } catch (err) {
      // Recorded and alerted, never silent: a form that accepts leads but cannot
      // reach them is a failure the operator must see.
      log.error('[estimate] confirmation email failed:', err.message);
      await store.setConfirmStatus(leadId, 'failed', err.message).catch(() => {});
      alertOncePerHour('confirm-send-failed', `confirmation emails are failing to send (${err.message.slice(0, 120)})`);
    }
    return res.redirect(THANKS);
  }

  function noIndex(res) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
  }

  // GET never changes state: mail scanners and link previewers fetch links.
  async function confirmPage(req, res) {
    noIndex(res);
    const token = req.params.token;
    const ok = TOKEN_RE.test(token) && (await store.peekVerification(sha256(token)));
    return res.status(ok ? 200 : 410).send(renderConfirm({ token, state: ok ? 'ready' : 'invalid' }));
  }

  async function confirmPost(req, res) {
    noIndex(res);
    const token = req.params.token;
    if (!TOKEN_RE.test(token)) return res.status(410).send(renderConfirm({ token, state: 'invalid' }));
    const ipKey = sha256(req.ip || 'unknown').slice(0, 24);
    if (!(await quota(`confirmpost:ip:${ipKey}:hour`, HOUR, LIMITS.CONFIRM_POST_PER_IP_PER_HOUR, 'confirmation attempts per IP'))) {
      return res.status(429).send(renderConfirm({ token, state: 'invalid' }));
    }
    const lead = await store.consumeVerification(sha256(token));
    if (!lead) return res.status(410).send(renderConfirm({ token, state: 'invalid' }));

    const useAi = await quota('ai:estimates:day', DAY, LIMITS.AI_ESTIMATES_GLOBAL_PER_DAY, 'estimate model calls per day');
    const audit = await generateAudit(lead.trade, lead.list_size, lead.deal_value, { useAi });
    const origin = publicOrigin();
    emailAuditCopy({ to: lead.email, businessName: lead.business_name, audit, origin })
      .catch(err => log.error('[estimate] estimate email failed:', err.message));
    return res.send(renderReport(origin, { audit, businessName: lead.business_name }));
  }

  return { submit, confirmPage, confirmPost };
}

// Daily abuse read-out. Real visitors confirm; bots using harvested addresses do
// not. A pile of submissions with almost no confirmations is the incident's signature.
const ABUSE_MIN_SUBMISSIONS = 50;
const ABUSE_MIN_CONFIRM_RATE = 0.1;
function evaluateAbuse(snap) {
  const flags = [];
  if (snap.submitted >= ABUSE_MIN_SUBMISSIONS &&
      snap.verified < Math.max(1, Math.floor(snap.submitted * ABUSE_MIN_CONFIRM_RATE))) {
    flags.push(`SUSPECTED ABUSE: ${snap.submitted} submissions, ${snap.verified} confirmed`);
  }
  if (snap.confirm_failed > 0) flags.push(`${snap.confirm_failed} confirmation emails failed to send`);
  if (snap.quota_blocked > 0) flags.push(`${snap.quota_blocked} submissions hit a send quota`);
  if (snap.tripped && snap.tripped.length) flags.push(`${snap.tripped.length} quota bucket(s) tripped`);
  return flags;
}

module.exports = { evaluateAbuse, ABUSE_MIN_SUBMISSIONS, ABUSE_MIN_CONFIRM_RATE, createEstimateHandlers, LIMITS, FIELD_MAX, canonicalAddress, readFields, sha256, newToken, TOKEN_RE };
