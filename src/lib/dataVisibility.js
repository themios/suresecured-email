// Data visibility: counts for every registered table, a masked view of website form
// submissions, and an hourly anomaly check. Spec: specs/2026-10-14-data-visibility.md
//
// Boundary: this module reads only tables named in dataRegistry.js and the one detail
// table platform_leads. No table name, column name or SQL fragment ever comes from a
// request. Every read runs in a READ ONLY transaction with a statement timeout.
const { REGISTRY, TABLE_NAME_RE } = require('./dataRegistry');

const HOUR = 3_600_000, DAY = 24 * HOUR;

// Every limit is a named constant. Changing one is a reviewed code change.
const LIMITS = Object.freeze({
  PAGE_SIZE: 50,                 // form submissions per page
  MAX_PAGE: 200,                 // 10,000 records reachable by paging; beyond that, filter
  REVEALS_PER_HOUR: 30,          // full email/phone shown, per operator
  STATEMENT_TIMEOUT_MS: 5_000,   // a slow count shows "Unavailable", never blocks the page
  ANOMALY_MIN_PER_HOUR: 50,      // below this an hour is never a spike (quiet tables are noisy in ratio)
  ANOMALY_MULTIPLIER: 5,         // a spike is this many times the previous 7 days' average hour
  ANOMALY_REPEAT_MS: 6 * HOUR,   // at most one spike alert per table in this window
});

// Same signals as the 2026-10-10 cleanup: Cyrillic text, or a link in the business name.
// A heuristic for sorting only. It never hides or deletes a record.
const CYRILLIC_RE = /[Ѐ-ӿ]/;
function looksLikeSpam(row) {
  if (row.verify_status === 'verified') return false;
  const name = String(row.business_name || ''), msg = String(row.message || '');
  return CYRILLIC_RE.test(name) || CYRILLIC_RE.test(msg) || /https?:\/\//i.test(name);
}
const SPAM_SQL = `(verify_status <> 'verified' AND (business_name ~ '[Ѐ-ӿ]' OR coalesce(message, '') ~ '[Ѐ-ӿ]' OR business_name ~* 'https?://'))`;

function maskEmail(email) {
  const s = String(email || '');
  const at = s.lastIndexOf('@');
  if (at < 1) return s ? '•••' : '';
  return `${s[0]}•••${s.slice(at)}`;
}
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `•••• ${digits.slice(-4)}` : '';
}

const ident = (name) => {
  if (!TABLE_NAME_RE.test(name) || !Object.prototype.hasOwnProperty.call(REGISTRY, name)) {
    throw new Error(`refusing unregistered table: ${String(name).slice(0, 64)}`);
  }
  return `"${name}"`;
};

// ─── Filters from the request, bounded to known values ─────────────────────
function readFilters(query) {
  const q = query || {};
  const one = (v) => (typeof v === 'string' ? v : undefined); // repeated keys arrive as arrays
  const pageRaw = one(q.page);
  const page = pageRaw === undefined ? 1 : (/^\d{1,4}$/.test(pageRaw) ? Number(pageRaw) : NaN);
  const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
  const tri = (v) => (v === 'yes' || v === 'no' ? v : 'any');
  return {
    page,
    from: date(one(q.from)),
    to: date(one(q.to)),
    confirmed: tri(one(q.confirmed)),
    spam: tri(one(q.spam)),
  };
}
function pageAllowed(page) {
  return Number.isInteger(page) && page >= 1 && page <= LIMITS.MAX_PAGE;
}

// ─── Anomaly rule ───────────────────────────────────────────────────────────
function isSpike({ lastHour, prior7d }) {
  if (lastHour == null || prior7d == null) return false;
  const avgHour = prior7d / (7 * 24);
  return lastHour > LIMITS.ANOMALY_MIN_PER_HOUR && lastHour > LIMITS.ANOMALY_MULTIPLIER * avgHour;
}

// ─── Postgres store ─────────────────────────────────────────────────────────
function createPgDataStore(pool) {
  async function readOnly(fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN READ ONLY');
      await c.query(`SET LOCAL statement_timeout = ${Number(LIMITS.STATEMENT_TIMEOUT_MS)}`);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  return {
    // Tables that exist, and which of them have a created_at column.
    async schema() {
      return readOnly(async (c) => {
        const { rows } = await c.query(
          `SELECT t.table_name AS name,
                  EXISTS (SELECT 1 FROM information_schema.columns k
                           WHERE k.table_schema = t.table_schema AND k.table_name = t.table_name
                             AND k.column_name = 'created_at') AS has_created_at
             FROM information_schema.tables t
            WHERE t.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
            ORDER BY t.table_name`);
        return rows;
      });
    },

    // Counts for one registered table. Each table in its own transaction so one slow or
    // broken table shows "Unavailable" without taking the others with it.
    async tableStats(name, hasCreatedAt) {
      const t = ident(name);
      return readOnly(async (c) => {
        const sql = hasCreatedAt
          ? `SELECT count(*)::bigint AS total,
                    count(*) FILTER (WHERE created_at > now() - interval '24 hours')::bigint AS last24h,
                    count(*) FILTER (WHERE created_at > now() - interval '7 days')::bigint AS last7d,
                    count(*) FILTER (WHERE created_at > now() - interval '1 hour')::bigint AS last_hour,
                    count(*) FILTER (WHERE created_at <= now() - interval '1 hour'
                                       AND created_at > now() - interval '7 days 1 hour')::bigint AS prior7d,
                    max(created_at) AS newest
               FROM ${t}`
          : `SELECT count(*)::bigint AS total FROM ${t}`;
        const r = (await c.query(sql)).rows[0];
        const n = (v) => (v == null ? null : Number(v));
        return {
          total: n(r.total), last24h: n(r.last24h), last7d: n(r.last7d),
          lastHour: n(r.last_hour), prior7d: n(r.prior7d), newest: r.newest || null,
        };
      });
    },

    async listSubmissions(f) {
      const where = [], vals = [];
      if (f.from) { vals.push(f.from); where.push(`created_at >= $${vals.length}::date`); }
      if (f.to) { vals.push(f.to); where.push(`created_at < ($${vals.length}::date + 1)`); }
      if (f.confirmed === 'yes') where.push(`verify_status = 'verified'`);
      if (f.confirmed === 'no') where.push(`verify_status <> 'verified'`);
      if (f.spam === 'yes') where.push(SPAM_SQL);
      if (f.spam === 'no') where.push(`NOT ${SPAM_SQL}`);
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return readOnly(async (c) => {
        const total = Number((await c.query(`SELECT count(*)::bigint AS n FROM platform_leads ${w}`, vals)).rows[0].n);
        const { rows } = await c.query(
          `SELECT id, created_at, business_name, contact_name, trade, message, email, phone,
                  verify_status, confirm_email_status
             FROM platform_leads ${w}
            ORDER BY created_at DESC, id DESC
            LIMIT ${LIMITS.PAGE_SIZE} OFFSET ${(f.page - 1) * LIMITS.PAGE_SIZE}`, vals);
        return { total, rows };
      });
    },

    async getSubmission(id) {
      return readOnly(async (c) => {
        const { rows } = await c.query('SELECT id, email, phone FROM platform_leads WHERE id = $1', [id]);
        return rows[0] || null;
      });
    },
  };
}

// ─── Data health snapshot ───────────────────────────────────────────────────
// Returns one row per registered table plus the list of unregistered tables.
// A count that could not be read is null with status 'unavailable', never 0.
async function dataHealthSnapshot(store, log = console) {
  const schema = await store.schema();
  const present = new Map(schema.map(r => [r.name, r.has_created_at]));
  const unregistered = schema.map(r => r.name).filter(n => !Object.prototype.hasOwnProperty.call(REGISTRY, n));
  const rows = [];
  for (const [name, meta] of Object.entries(REGISTRY)) {
    if (!present.has(name)) {
      rows.push({ name, ...meta, status: 'missing' });
      continue;
    }
    try {
      const s = await store.tableStats(name, present.get(name));
      rows.push({ name, ...meta, ...s, hasCreatedAt: present.get(name), status: isSpike(s) ? 'spike' : 'normal' });
    } catch (err) {
      log.error('[data-health] count failed:', name, err.message);
      rows.push({ name, ...meta, status: 'unavailable' });
    }
  }
  return { rows, unregistered };
}

// ─── Hourly anomaly check ───────────────────────────────────────────────────
// Alerts carry table labels and counts only: no record contents, no organization.
async function runAnomalyCheck({ store, quota, alert, log = console }) {
  const result = { spikes: [], unregistered: [], unavailable: [], alerted: [], alertErrors: [] };
  const send = async (key, windowMs, text) => {
    const q = await quota(`alert:${key}`, windowMs, 1);
    if (!q.allowed) return;
    try { await alert(text); result.alerted.push(key); }
    catch (e) { result.alertErrors.push(`${key}: ${e.message}`); log.error('[data-health] ALERT NOT DELIVERED:', key, e.message); }
  };

  const snap = await dataHealthSnapshot(store, log);
  for (const r of snap.rows) {
    if (r.status === 'unavailable') result.unavailable.push(r.name);
    if (r.status !== 'spike') continue;
    result.spikes.push(r.name);
    const avg = (r.prior7d / (7 * 24)).toFixed(1);
    await send(`data-spike:${r.name}`, LIMITS.ANOMALY_REPEAT_MS,
      `<b>Data health: sudden growth in ${escHtml(r.label)}</b>\n` +
      `${r.lastHour.toLocaleString('en-US')} new records in the last hour. The normal rate is about ${avg} an hour.\n` +
      `This can be a bot, an import, or a fault that repeats an action.\n` +
      `Action: open Admin, Data health, and check what arrived.`);
  }
  if (snap.unregistered.length) {
    result.unregistered = snap.unregistered;
    await send('data-unregistered', DAY,
      `<b>Data health: tables nobody can see</b>\n` +
      `${snap.unregistered.length} table(s) exist that are not in the data registry, so no screen or check covers them.\n` +
      `Action: add each one to the registry (src/lib/dataRegistry.js) with a screen or a reason.`);
  }
  if (result.unavailable.length) {
    await send('data-unavailable', HOUR,
      `<b>Data health: some counts could not be read</b>\n` +
      `${result.unavailable.length} table(s) did not answer within ${LIMITS.STATEMENT_TIMEOUT_MS / 1000} seconds or returned an error. Their growth is not being watched right now.\n` +
      `Action: check the server log for "[data-health] count failed".`);
  }
  return result;
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

module.exports = {
  LIMITS, createPgDataStore, dataHealthSnapshot, runAnomalyCheck, isSpike,
  readFilters, pageAllowed, maskEmail, maskPhone, looksLikeSpam,
};
