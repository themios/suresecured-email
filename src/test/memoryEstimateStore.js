// In-memory twin of estimateStore.js with the same semantics, for tests that
// run without a database. The DB-backed test checks the real store's atomicity.
const { sha256 } = require('../lib/estimateStore');

function createMemoryStore() {
  const quotas = new Map(), leads = [], verifications = [];
  let nextId = 1, nonceSeq = 0;
  return {
    leads, verifications, quotas,
    async consumeQuota(bucket, windowMs, limit) {
      const key = `${bucket}|${Math.floor(Date.now() / windowMs)}`;
      const e = quotas.get(key) || { count: 0, alerted: false };
      e.count += 1; quotas.set(key, e);
      if (e.count <= limit) return { allowed: true, count: e.count, firstDenial: false };
      const first = !e.alerted; e.alerted = true;
      return { allowed: false, count: e.count, firstDenial: first };
    },
    async insertLead(f) {
      const row = { id: nextId++, ...f, verify_status: 'pending', confirm_email_status: null, confirm_email_error: null };
      leads.push(row); return row.id;
    },
    async setConfirmStatus(id, status, error) {
      const l = leads.find(x => x.id === id); l.confirm_email_status = status; l.confirm_email_error = error || null;
    },
    async createVerification(leadId, tokenHash, expiresAt) {
      verifications.push({ leadId, tokenHash, expiresAt, claimedAt: null, completedAt: null });
    },
    async peekVerification(tokenHash) {
      const v = verifications.find(x => x.tokenHash === tokenHash);
      return !!v && !v.completedAt && v.expiresAt > new Date();
    },
    async claimVerification(tokenHash, leaseMs) {
      const v = verifications.find(x => x.tokenHash === tokenHash);
      if (!v || v.completedAt || v.expiresAt <= new Date()) return null;
      if (v.claimedAt && Date.now() - v.claimedAt < leaseMs) return null;
      v.claimedAt = Date.now(); v.nonce = `n${++nonceSeq}`;
      const l = leads.find(x => x.id === v.leadId); l.verify_status = 'verified';
      return { nonce: v.nonce, lead: { id: l.id, business_name: l.business_name, email: l.email, trade: l.trade, list_size: l.list_size, deal_value: l.deal_value, estimate_narrative: l.estimate_narrative || null } };
    },
    async saveNarrative(tokenHash, nonce, leadId, narrative) {
      const v = verifications.find(x => x.tokenHash === tokenHash);
      if (!v || v.nonce !== nonce || v.completedAt) return false;
      leads.find(x => x.id === leadId).estimate_narrative = narrative; return true;
    },
    async completeVerification(tokenHash, nonce) {
      const v = verifications.find(x => x.tokenHash === tokenHash);
      if (!v || v.nonce !== nonce || v.completedAt) return false;
      v.completedAt = Date.now(); return true;
    },
    async releaseVerification(tokenHash, nonce) {
      const v = verifications.find(x => x.tokenHash === tokenHash);
      if (v && v.nonce === nonce && !v.completedAt) { v.claimedAt = null; v.nonce = null; }
    },
    async abuseSnapshot() { return {}; },
    async pruneQuota() {},
    sha256,
  };
}
module.exports = { createMemoryStore };
