/**
 * Shared rebuild logic for the v2 sequence seeds.
 *
 * Upserts steps 1..N in place (a step that has already been sent is referenced
 * by email_sends.step_id, so it cannot be deleted without orphaning send
 * history), marks them active, and RETIRES any leftover steps beyond N by
 * setting active = false rather than deleting them. Cron skips inactive steps,
 * so the sequence is effectively N steps while old send history stays intact.
 * Guarded so it refuses to run against a sequence people are actively moving
 * through.
 */
const { pool } = require('../db');

async function rebuildSequence(sequenceName, steps) {
  const { rows } = await pool.query('SELECT id FROM sequences WHERE name = $1', [sequenceName]);
  if (!rows.length) { console.error(`Sequence not found: ${sequenceName}`); process.exit(1); }
  const seqId = rows[0].id;

  const active = await pool.query(
    `SELECT COUNT(*)::int AS n FROM contact_enrollments WHERE sequence_id = $1 AND status = 'active'`,
    [seqId]
  );
  if (active.rows[0].n > 0) {
    console.error(`Refusing: ${active.rows[0].n} active enrollment(s) on "${sequenceName}". Pause them first.`);
    process.exit(1);
  }

  for (const [n, delay, subject, body] of steps) {
    await pool.query(
      `INSERT INTO sequence_steps (sequence_id, step_number, delay_days, subject, body, active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (sequence_id, step_number)
       DO UPDATE SET delay_days = $3, subject = $4, body = $5, active = true`,
      [seqId, n, delay, subject, body]
    );
  }

  // Retire (do not delete) any steps beyond N so send history stays attached.
  await pool.query(
    'UPDATE sequence_steps SET active = false WHERE sequence_id = $1 AND step_number > $2',
    [seqId, steps.length]
  );

  const check = await pool.query(
    'SELECT COUNT(*)::int AS n FROM sequence_steps WHERE sequence_id = $1 AND active = true', [seqId]);
  console.log(`"${sequenceName}" (id ${seqId}) rebuilt: ${check.rows[0].n} active steps.`);
}

module.exports = { rebuildSequence };
