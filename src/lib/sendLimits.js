const { pool } = require('../db');

/**
 * Per-sending-identity daily caps with a warmup ramp.
 *
 * The "identity" is the actual From address a message goes out as (the shared
 * Ionos mailbox, a per-rep Gmail, etc.). Capping per identity protects the
 * sending domain's reputation no matter how many enrollments the cron pulls.
 *
 * Warmup schedule (week since the identity's warmup_start):
 *   week 1: 5   week 2: 10   week 3: 20   week 4: 40   week 5+: MAX
 * MAX is DAILY_SEND_LIMIT (default 80). Set an identity's warmup_start to a past
 * date, or a daily_cap_override, to skip/adjust the ramp.
 */
const WARMUP_STEPS = [5, 10, 20, 40];

function maxDailyLimit() {
  const n = parseInt(process.env.DAILY_SEND_LIMIT, 10);
  return Number.isNaN(n) ? 80 : n;
}

function warmupLimitForWeek(week) {
  if (week <= WARMUP_STEPS.length) return WARMUP_STEPS[week - 1];
  return maxDailyLimit();
}

/**
 * Compute today's effective cap for an identity, ensuring a send_identities row
 * exists (anchors the warmup start on first ever send).
 */
async function effectiveLimit(identity, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO send_identities (identity) VALUES ($1)
     ON CONFLICT (identity) DO UPDATE SET identity = EXCLUDED.identity
     RETURNING warmup_start, daily_cap_override`,
    [identity]
  );
  const row = rows[0];
  if (row?.daily_cap_override != null) return row.daily_cap_override;

  // Established mailbox with existing reputation? SEND_WARMUP=off skips the ramp
  // and applies DAILY_SEND_LIMIT immediately (still a cap, just no slow start).
  if ((process.env.SEND_WARMUP || 'on').toLowerCase() === 'off') return maxDailyLimit();

  const start = row?.warmup_start ? new Date(row.warmup_start) : new Date();
  const days = Math.floor((Date.now() - start.getTime()) / (24 * 60 * 60 * 1000));
  const week = Math.floor(days / 7) + 1;
  return warmupLimitForWeek(week);
}

/**
 * Atomically reserve one send for `identity` today.
 * Returns { ok: true, count } if under cap (counter incremented), or
 * { ok: false, limit, count } if the cap is already reached (no increment).
 */
async function reserveSend(identity, db = pool) {
  if (!identity) return { ok: true, count: 0 }; // nothing to key on — don't block
  const limit = await effectiveLimit(identity, db);

  const { rows } = await db.query(
    `INSERT INTO send_counters (identity, day, sent_count, first_send_day)
       VALUES ($1, CURRENT_DATE, 1, CURRENT_DATE)
     ON CONFLICT (identity, day) DO UPDATE
       SET sent_count = send_counters.sent_count + 1
       WHERE send_counters.sent_count < $2
     RETURNING sent_count`,
    [identity, limit]
  );

  if (!rows.length) {
    // Conditional update did not fire → at or over cap for today
    const { rows: cur } = await db.query(
      `SELECT sent_count FROM send_counters WHERE identity = $1 AND day = CURRENT_DATE`,
      [identity]
    );
    return { ok: false, limit, count: cur[0]?.sent_count ?? limit };
  }
  return { ok: true, limit, count: rows[0].sent_count };
}

module.exports = { reserveSend, effectiveLimit, maxDailyLimit, warmupLimitForWeek };
