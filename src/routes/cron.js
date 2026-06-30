/**
 * GET /cron/send-sequences
 * Fires due email sequence steps.
 * Called every 15 minutes by cron-job.org.
 * Auth: Authorization: Bearer <CRON_SECRET>
 */
const express  = require('express');
const router   = express.Router();
const { pool } = require('../db');
const { sendSequenceEmail, checkForReplies } = require('../lib/gmail');

function cronAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

router.get('/send-sequences', cronAuth, async (req, res) => {
  const now = new Date().toISOString();
  let sent = 0, skipped = 0, errors = 0;

  try {
    // Find active enrollments that are due
    const { rows: due } = await pool.query(`
      SELECT
        ce.id              AS enrollment_id,
        ce.lead_id,
        ce.sequence_id,
        ce.salesperson_id,
        ce.current_step,
        ce.enrolled_at,
        ce.client_id,
        l.email            AS lead_email,
        l.first_name,
        l.last_name,
        l.city,
        l.product_interest,
        l.audience_type,
        s.name             AS salesperson_name,
        s.email            AS salesperson_email,
        c.brand_config
      FROM contact_enrollments ce
      JOIN leads l       ON l.id  = ce.lead_id
      JOIN salespeople s ON s.id  = ce.salesperson_id
      LEFT JOIN clients c ON c.id = ce.client_id
      WHERE ce.status = 'active'
        AND ce.next_send_at <= $1
      ORDER BY ce.next_send_at
      LIMIT 100
    `, [now]);

    for (const row of due) {
      const nextStepNum = row.current_step + 1;

      // Get next step in the sequence
      const { rows: steps } = await pool.query(
        `SELECT * FROM sequence_steps
         WHERE sequence_id = $1 AND step_number = $2`,
        [row.sequence_id, nextStepNum]
      );

      if (!steps[0]) {
        // No more steps — enrollment complete
        await pool.query(
          `UPDATE contact_enrollments SET status = 'completed', completed_at = $1 WHERE id = $2`,
          [now, row.enrollment_id]
        );
        skipped++;
        continue;
      }

      const step = steps[0];

      // Check for replies on any prior sends in this enrollment
      const { rows: priorSends } = await pool.query(
        `SELECT gmail_thread_id FROM email_sends
         WHERE enrollment_id = $1 AND gmail_thread_id IS NOT NULL
         LIMIT 1`,
        [row.enrollment_id]
      );

      if (priorSends[0]?.gmail_thread_id) {
        const replied = await checkForReplies(row.salesperson_id, priorSends[0].gmail_thread_id);
        if (replied) {
          await pool.query(
            `UPDATE contact_enrollments SET status = 'paused', paused_reason = 'replied' WHERE id = $1`,
            [row.enrollment_id]
          );
          skipped++;
          continue;
        }
      }

      // Check suppression list
      const { rows: suppressed } = await pool.query(
        'SELECT 1 FROM suppression_list WHERE LOWER(email) = LOWER($1)',
        [row.lead_email]
      );
      if (suppressed.length) {
        await pool.query(
          `UPDATE contact_enrollments SET status = 'paused', paused_reason = 'suppressed' WHERE id = $1`,
          [row.enrollment_id]
        );
        skipped++;
        continue;
      }

      const vars = {
        first_name:        row.first_name || row.lead_email.split('@')[0],
        last_name:         row.last_name  || '',
        city:              row.city        || '',
        product_interest:  row.product_interest || 'security products',
        salesperson_name:  row.salesperson_name,
        salesperson_email: row.salesperson_email,
      };

      const brandConfig = row.brand_config || {};
      const result = await sendSequenceEmail({
        salespersonId: row.salesperson_id,
        to:            row.lead_email,
        subject:       step.subject,
        body:          step.body,
        vars,
        enrollmentId:  row.enrollment_id,
        stepId:        step.id,
        leadId:        row.lead_id,
      }, brandConfig);

      if (result.ok) {
        // Check if this was the last step
        const { rows: nextSteps } = await pool.query(
          `SELECT id FROM sequence_steps WHERE sequence_id = $1 AND step_number > $2 LIMIT 1`,
          [row.sequence_id, nextStepNum]
        );

        if (nextSteps.length === 0) {
          // Last step sent — mark complete
          await pool.query(
            `UPDATE contact_enrollments
             SET current_step = $1, status = 'completed', completed_at = $2
             WHERE id = $3`,
            [nextStepNum, now, row.enrollment_id]
          );
        } else {
          // Get next step delay
          const { rows: futureStep } = await pool.query(
            `SELECT delay_days FROM sequence_steps WHERE sequence_id = $1 AND step_number = $2`,
            [row.sequence_id, nextStepNum + 1]
          );
          const delayDays = futureStep[0]?.delay_days ?? 1;
          const nextSendAt = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000).toISOString();

          await pool.query(
            `UPDATE contact_enrollments
             SET current_step = $1, next_send_at = $2
             WHERE id = $3`,
            [nextStepNum, nextSendAt, row.enrollment_id]
          );
        }

        // Log click/lead attribution
        await pool.query(
          `UPDATE leads SET salesperson_id = $1 WHERE id = $2 AND salesperson_id IS NULL`,
          [row.salesperson_id, row.lead_id]
        );

        sent++;
      } else {
        errors++;
        console.error(`[cron] send failed for enrollment ${row.enrollment_id}:`, result.error);
      }
    }
  } catch (err) {
    console.error('[cron] unexpected error:', err);
    return res.status(500).json({ error: err.message });
  }

  res.json({ ok: true, sent, skipped, errors, timestamp: now });
});

module.exports = router;
