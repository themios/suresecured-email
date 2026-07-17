/**
 * GET|POST /cron/send-sequences
 * Fires due email sequence steps.
 * Called every 15 minutes by cron-job.org.
 * Auth: Authorization: Bearer <CRON_SECRET>
 */
const express  = require('express');
const router   = express.Router();
const { google } = require('googleapis');
const { pool } = require('../db');
const { sendSequenceEmail, checkForReplies, checkForRepliesByAddress, sendReplyNotification, buildDigestHtml, getAuthedClient, buildRawMessage, getClientEmailConfig } = require('../lib/gmail');
const { imapEnabled, checkForRepliesViaImap } = require('../lib/imap');
const { callOpenRouter, buildDigestPrompt, classifyReply } = require('../lib/openrouter');
const { computeScore } = require('../lib/scoring');
const { sendSms } = require('../lib/telnyx');
const { setFirstTouchAttribution } = require('../lib/attribution');
const { sendTelegram, notifyNewLead, notifyHotReply, notifyDailySummary } = require('../lib/telegram');
const { runDueAgents } = require('../lib/agents/scheduler');

function cronAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

async function sendSequencesHandler(req, res) {
  const now = new Date().toISOString();
  let sent = 0, skipped = 0, errors = 0, replies = 0;

  // Cache client email configs and Gmail OAuth status per salesperson for this cron run
  const clientEmailConfigs = new Map();
  const salespersonGmailAuthed = new Map();

  // ── Pass 0: inbound email capture — new leads from Gmail inbox ──────────────
  try {
    const { rows: inboundAccounts } = await pool.query(`
      SELECT ea.salesperson_id, ea.email AS gmail_email, cec.client_id,
             cec.inbound_capture_enabled, cec.inbound_sequence_id, cec.inbound_last_check_at
      FROM email_accounts ea
      CROSS JOIN (
        SELECT cec2.* FROM client_email_config cec2
        WHERE cec2.inbound_capture_enabled = true
        ORDER BY cec2.client_id LIMIT 1
      ) cec
      WHERE ea.enabled = true
    `);

    for (const acct of inboundAccounts) {
      try {
        const auth = await getAuthedClient(acct.salesperson_id);
        if (!auth) continue;

        const gmail = google.gmail({ version: 'v1', auth: auth.client });
        // Search inbox for messages received since last check (or 2 hours ago)
        const since = acct.inbound_last_check_at
          ? Math.floor(new Date(acct.inbound_last_check_at).getTime() / 1000)
          : Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000);
        const q = `in:inbox after:${since} -from:me -from:${acct.gmail_email}`;
        const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 20 });
        const msgs = list.data.messages || [];

        for (const m of msgs) {
          try {
            const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['From', 'Subject'] });
            const headers = msg.data.payload?.headers || [];
            const fromHeader = headers.find(h => h.name === 'From')?.value || '';
            const subject    = headers.find(h => h.name === 'Subject')?.value || '';

            // Parse "Name <email>" or "email"
            const emailMatch = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/([^\s]+@[^\s]+)/);
            const senderEmail = emailMatch?.[1]?.toLowerCase().trim();
            if (!senderEmail) continue;

            const nameMatch = fromHeader.match(/^(.+?)\s*</);
            const senderName = nameMatch?.[1]?.replace(/"/g, '').trim() || '';
            const [firstName, ...rest] = senderName.split(' ');
            const lastName = rest.join(' ');

            // Skip if already a lead
            const { rows: existing } = await pool.query('SELECT id FROM leads WHERE email = $1', [senderEmail]);
            if (existing.length) continue;

            // Create new lead
            const { rows: newLead } = await pool.query(`
              INSERT INTO leads (email, first_name, last_name, stage, audience_type, client_id, created_at)
              VALUES ($1, $2, $3, 'new', 'inbound', $4, NOW())
              ON CONFLICT (email) DO NOTHING
              RETURNING id
            `, [senderEmail, firstName || senderEmail, lastName || '', acct.client_id]);

            if (!newLead[0]) continue;
            const leadId = newLead[0].id;

            // Log the inbound email as a note
            await pool.query(
              `INSERT INTO lead_notes (lead_id, author_name, content) VALUES ($1, $2, $3)`,
              [leadId, 'Inbound', `[Inbound email] ${subject}\n\nFrom: ${fromHeader}`]
            );

            // Notify via Telegram
            notifyNewLead({ firstName, lastName, email: senderEmail, source: 'email' }).catch(() => {});

            // Auto-enroll if sequence configured
            if (acct.inbound_sequence_id) {
              await pool.query(`
                INSERT INTO contact_enrollments (lead_id, sequence_id, salesperson_id, client_id, status, enrolled_at)
                VALUES ($1, $2, $3, $4, 'active', NOW())
                ON CONFLICT DO NOTHING
              `, [leadId, acct.inbound_sequence_id, acct.salesperson_id, acct.client_id]);
            }
          } catch (err) {
            console.error('[inbound] message processing error:', err.message);
          }
        }

        // Update last check timestamp
        await pool.query(
          `UPDATE client_email_config SET inbound_last_check_at = NOW() WHERE client_id = $1`,
          [acct.client_id]
        );
      } catch (err) {
        console.error('[inbound] account error:', err.message);
      }
    }
  } catch (err) {
    console.error('[inbound] pass failed:', err.message);
  }

  // ── Pass 1: reply check on ALL active enrollments with at least one send ────
  // Uses address-based Gmail search so it works for both Gmail and SES sends.
  // Capped at 200 per cron run to stay within Gmail API quota at scale.
  try {
    const { rows: replyRows } = await pool.query(`
      SELECT DISTINCT ON (ce.id)
        ce.id              AS enrollment_id,
        ce.lead_id,
        ce.salesperson_id,
        ce.enrolled_at,
        ce.client_id,
        l.email            AS lead_email,
        l.first_name,
        l.last_name,
        c.brand_config
      FROM contact_enrollments ce
      JOIN leads l        ON l.id = ce.lead_id
      LEFT JOIN clients c ON c.id = ce.client_id
      WHERE ce.status = 'active'
        AND EXISTS (SELECT 1 FROM email_sends es WHERE es.enrollment_id = ce.id AND es.status = 'sent')
      ORDER BY ce.id
      LIMIT 200
    `);

    for (const row of replyRows) {
      try {
        // Load + cache client email config
        if (row.client_id && !clientEmailConfigs.has(row.client_id)) {
          clientEmailConfigs.set(row.client_id, await getClientEmailConfig(row.client_id));
        }
        const clientCfg = row.client_id ? clientEmailConfigs.get(row.client_id) : null;

        // Check Gmail OAuth status for this salesperson (cached)
        if (!salespersonGmailAuthed.has(row.salesperson_id)) {
          const authed = await getAuthedClient(row.salesperson_id);
          salespersonGmailAuthed.set(row.salesperson_id, !!authed);
        }
        const hasGmail = salespersonGmailAuthed.get(row.salesperson_id);

        // Prefer Gmail API when OAuth is connected; fall back to IMAP or skip
        const replyCheck = hasGmail
          ? await checkForRepliesByAddress(row.salesperson_id, row.lead_email, row.enrolled_at)
          : imapEnabled(clientCfg)
            ? await checkForRepliesViaImap(row.lead_email, row.enrolled_at, clientCfg)
            : null;
        if (!replyCheck?.replied) continue;

        await pool.query(
          `UPDATE contact_enrollments SET status = 'paused', paused_reason = 'replied', replied_at = NOW() WHERE id = $1`,
          [row.enrollment_id]
        );
        await pool.query(
          `UPDATE leads SET reply_text = $1, reply_subject = $2 WHERE id = $3`,
          [replyCheck.replyText?.slice(0, 2000) || null, replyCheck.replySubject || null, row.lead_id]
        );
        replies++;

        const lead        = { id: row.lead_id, email: row.lead_email, first_name: row.first_name, last_name: row.last_name };
        const brandConfig = row.brand_config || {};
        if (replyCheck.replyText) {
          classifyReply(replyCheck.replyText, row.first_name).then(async (classification) => {
            try {
              await pool.query(
                `UPDATE leads SET reply_category=$1, reply_urgency=$2, reply_summary=$3, reply_classified_at=NOW() WHERE id=$4`,
                [classification.category, classification.urgency, classification.summary, row.lead_id]
              );
              replyCheck.classification = classification;
            } catch {}
            sendReplyNotification(row.salesperson_id, lead, replyCheck, brandConfig).catch(() => {});
            notifyHotReply({
              firstName: row.first_name, lastName: row.last_name, email: row.lead_email,
              category: classification.category, urgency: classification.urgency,
              summary: classification.summary, leadId: row.lead_id,
              appUrl: process.env.TRACKER_URL,
            }).catch(() => {});
          }).catch(() => {
            sendReplyNotification(row.salesperson_id, lead, replyCheck, brandConfig).catch(() => {});
          });
        } else {
          sendReplyNotification(row.salesperson_id, lead, replyCheck, brandConfig).catch(() => {});
          notifyHotReply({
            firstName: row.first_name, lastName: row.last_name, email: row.lead_email,
            category: 'reply', urgency: 'medium', leadId: row.lead_id,
            appUrl: process.env.TRACKER_URL,
          }).catch(() => {});
        }
      } catch (err) {
        console.error('[reply-check] enrollment', row.enrollment_id, err.message);
      }
    }
  } catch (err) {
    console.error('[reply-check] pass failed:', err.message);
  }

  // ── Pass 1b: reply check on direct emails sent via reply composer ─────────
  try {
    const { rows: directRows } = await pool.query(`
      SELECT l.id AS lead_id, l.email AS lead_email, l.first_name, l.last_name,
             l.direct_email_thread_id, l.direct_email_salesperson_id AS salesperson_id,
             c.brand_config
      FROM leads l
      LEFT JOIN clients c ON c.id = l.client_id
      WHERE l.direct_email_thread_id IS NOT NULL
        AND (l.replied_at IS NULL OR l.replied_at < NOW() - INTERVAL '7 days')
      LIMIT 100
    `);

    for (const row of directRows) {
      try {
        const auth = await getAuthedClient(row.salesperson_id);
        if (!auth) continue;

        const replyCheck = await checkForReplies(row.salesperson_id, row.direct_email_thread_id);
        if (!replyCheck.replied) continue;

        await pool.query(
          `UPDATE leads SET reply_text = $1, reply_subject = $2, replied_at = NOW() WHERE id = $3`,
          [replyCheck.replyText?.slice(0, 2000) || null, replyCheck.replySubject || null, row.lead_id]
        );
        replies++;

        const lead = { id: row.lead_id, email: row.lead_email, first_name: row.first_name, last_name: row.last_name };
        const brandConfig = row.brand_config || {};
        if (replyCheck.replyText) {
          classifyReply(replyCheck.replyText, row.first_name).then(async (classification) => {
            try {
              await pool.query(
                `UPDATE leads SET reply_category=$1, reply_urgency=$2, reply_summary=$3, reply_classified_at=NOW() WHERE id=$4`,
                [classification.category, classification.urgency, classification.summary, row.lead_id]
              );
              replyCheck.classification = classification;
            } catch {}
            sendReplyNotification(row.salesperson_id, lead, replyCheck, brandConfig).catch(() => {});
          }).catch(() => {
            sendReplyNotification(row.salesperson_id, lead, replyCheck, brandConfig).catch(() => {});
          });
        } else {
          sendReplyNotification(row.salesperson_id, lead, replyCheck, brandConfig).catch(() => {});
        }
      } catch (err) {
        console.error('[direct-reply-check] lead', row.lead_id, err.message);
      }
    }
  } catch (err) {
    console.error('[direct-reply-check] pass failed:', err.message);
  }

  const client = await pool.connect();
  let rows = [];
  try {
    await client.query('BEGIN');

    // Find active enrollments that are due — FOR UPDATE OF ce SKIP LOCKED prevents
    // concurrent cron runs from double-processing the same enrollment rows
    const result = await client.query(`
      SELECT
        ce.id              AS enrollment_id,
        ce.lead_id,
        ce.sequence_id,
        ce.salesperson_id,
        ce.current_step,
        ce.enrolled_at,
        ce.client_id,
        l.email            AS lead_email,
        l.phone            AS lead_phone,
        l.first_name,
        l.last_name,
        l.city,
        l.product_interest,
        l.audience_type,
        l.email_verified,
        s.name             AS salesperson_name,
        s.email            AS salesperson_email,
        s.phone            AS salesperson_phone,
        s.title            AS salesperson_title,
        c.brand_config,
        COALESCE((SELECT SUM(es.open_count)  FROM email_sends es WHERE es.lead_id = l.id), 0) AS open_count,
        COALESCE((SELECT SUM(es.click_count) FROM email_sends es WHERE es.lead_id = l.id), 0) AS click_count
      FROM contact_enrollments ce
      JOIN leads l       ON l.id  = ce.lead_id
      JOIN salespeople s ON s.id  = ce.salesperson_id
      LEFT JOIN clients c ON c.id = ce.client_id
      WHERE ce.status = 'active'
        AND ce.next_send_at <= $1
      ORDER BY ce.next_send_at
      LIMIT 100
      FOR UPDATE OF ce SKIP LOCKED
    `, [now]);

    rows = result.rows;

    for (const row of rows) {
      const nextStepNum = row.current_step + 1;

      // Get next step in the sequence
      const { rows: steps } = await client.query(
        `SELECT * FROM sequence_steps
         WHERE sequence_id = $1 AND step_number = $2`,
        [row.sequence_id, nextStepNum]
      );

      if (!steps[0]) {
        // No more steps — enrollment complete
        await client.query(
          `UPDATE contact_enrollments SET status = 'completed', completed_at = $1 WHERE id = $2`,
          [now, row.enrollment_id]
        );
        skipped++;
        continue;
      }

      const step = steps[0];

      // Check for replies on any prior sends in this enrollment
      const { rows: priorSends } = await client.query(
        `SELECT gmail_thread_id FROM email_sends
         WHERE enrollment_id = $1 AND gmail_thread_id IS NOT NULL
         LIMIT 1`,
        [row.enrollment_id]
      );

      if (priorSends[0]?.gmail_thread_id) {
        const replyCheck = await checkForReplies(row.salesperson_id, priorSends[0].gmail_thread_id);
        if (replyCheck.replied) {
          await client.query(
            `UPDATE contact_enrollments SET status = 'paused', paused_reason = 'replied', replied_at = NOW() WHERE id = $1`,
            [row.enrollment_id]
          );
          // Classify reply with AI and store on lead — fire-and-forget
          const lead = { id: row.lead_id, email: row.lead_email, first_name: row.first_name, last_name: row.last_name };
          if (replyCheck.replyText) {
            classifyReply(replyCheck.replyText, row.first_name).then(async (classification) => {
              try {
                await pool.query(
                  `UPDATE leads SET reply_category=$1, reply_urgency=$2, reply_summary=$3, reply_classified_at=NOW()
                   WHERE id=$4`,
                  [classification.category, classification.urgency, classification.summary, row.lead_id]
                );
                replyCheck.classification = classification;
              } catch {}
              sendReplyNotification(row.salesperson_id, lead, replyCheck, brandConfig).catch(() => {});
            }).catch(() => {
              sendReplyNotification(row.salesperson_id, lead, replyCheck, brandConfig).catch(() => {});
            });
          } else {
            sendReplyNotification(row.salesperson_id, lead, replyCheck, brandConfig).catch(() => {});
          }
          skipped++;
          continue;
        }
      }

      // Check suppression list and unsubscribed flag
      const { rows: suppressed } = await client.query(
        `SELECT 1 FROM suppression_list WHERE LOWER(email) = LOWER($1)
         UNION ALL
         SELECT 1 FROM leads WHERE id = $2 AND unsubscribed = true`,
        [row.lead_email, row.lead_id]
      );
      if (suppressed.length) {
        const reason = await client.query(
          `SELECT unsubscribed FROM leads WHERE id = $1`, [row.lead_id]
        );
        const pauseReason = reason.rows[0]?.unsubscribed ? 'unsubscribed' : 'suppressed';
        await client.query(
          `UPDATE contact_enrollments SET status = 'paused', paused_reason = $1 WHERE id = $2`,
          [pauseReason, row.enrollment_id]
        );
        skipped++;
        continue;
      }

      // Skip unverified addresses (ZeroBounce gate)
      if (row.email_verified !== true) {
        skipped++;
        continue;
      }

      // ── Tier gate: after step 3, pause leads with zero opens or clicks ──────
      // Keeps domain reputation clean — only continue engaged leads past step 3.
      if (nextStepNum > 3) {
        const { rows: engagement } = await client.query(
          `SELECT COALESCE(SUM(open_count),0) AS opens, COALESCE(SUM(click_count),0) AS clicks
           FROM email_sends WHERE enrollment_id = $1`,
          [row.enrollment_id]
        );
        const totalEngagement = parseInt(engagement[0]?.opens || 0) + parseInt(engagement[0]?.clicks || 0);
        if (totalEngagement === 0) {
          await client.query(
            `UPDATE contact_enrollments SET status = 'paused', paused_reason = 'no_engagement' WHERE id = $1`,
            [row.enrollment_id]
          );
          skipped++;
          continue;
        }
      }

      const brandConfig = row.brand_config || {};

      const vars = {
        first_name:        row.first_name || row.lead_email.split('@')[0],
        last_name:         row.last_name  || '',
        city:              row.city        || '',
        product_interest:  row.product_interest || 'security products',
        salesperson_name:  row.salesperson_name,
        salesperson_email: row.salesperson_email,
        salesperson_phone: row.salesperson_phone || brandConfig.phone || '',
        salesperson_title: row.salesperson_title || '',
        company_name:      brandConfig.name     || '',
        company_phone:     brandConfig.phone    || '',
        company_website:   brandConfig.website  || '',
        company_address:   brandConfig.address  || '',
      };

      // Resolve CTA URL from landing page matrix based on lead profile
      // Templates can use {cta_url} for their main call-to-action link
      const siteBase = brandConfig.website || 'https://suresecured.com';
      try {
        const intentLevel = (row.open_count >= 2 || row.click_count >= 1) ? 'high' : 'normal';
        const { rows: matrixRows } = await client.query(`
          SELECT destination_url FROM landing_page_matrix
          WHERE active = true
            AND (audience_type = $1 OR audience_type IS NULL)
            AND (product_interest = $2 OR product_interest IS NULL)
            AND (intent_level = $3 OR intent_level IS NULL)
          ORDER BY
            (audience_type = $1)::int DESC,
            (product_interest = $2)::int DESC,
            (intent_level = $3)::int DESC
          LIMIT 1
        `, [row.audience_type || 'B2C', row.product_interest || null, intentLevel]);

        const dest = matrixRows[0]?.destination_url || '/';
        vars.cta_url = dest.startsWith('http') ? dest : `${siteBase}${dest}`;
      } catch {
        vars.cta_url = siteBase;
      }

      // ─── Dispatch: SMS or Email ───────────────────────────────────────────
      // 10DLC NOTE: SMS outbound is blocked by US carriers until Brand+Campaign
      // are registered in Telnyx portal (Messaging > Brands & Campaigns).
      // 3-7 day approval. Remove this comment once 10DLC is approved.
      let sendResult;

      if (step.channel === 'sms') {
        // SMS path
        if (!row.lead_phone) {
          await client.query(
            `UPDATE contact_enrollments SET status = 'paused', paused_reason = 'no_phone' WHERE id = $1`,
            [row.enrollment_id]
          );
          console.warn(`[cron] SMS step ${step.id} skipped — no phone for lead ${row.lead_id}`);
          skipped++;
          continue;
        }

        // Interpolate vars into body (same {{var}} substitution as email)
        let smsBody = step.body || '';
        for (const [k, v] of Object.entries(vars)) {
          smsBody = smsBody.replaceAll(`{${k}}`, v || '');
        }

        const smsResult = await sendSms(row.lead_phone, smsBody);
        sendResult = smsResult;

        if (smsResult.ok) {
          // Log outbound SMS
          await client.query(
            `INSERT INTO sms_messages
               (enrollment_id, step_id, lead_id, client_id, direction, from_number, to_number,
                body, telnyx_message_id, status, sent_at)
             VALUES ($1,$2,$3,$4,'outbound',$5,$6,$7,$8,'sent',NOW())`,
            [row.enrollment_id, step.id, row.lead_id, row.client_id,
             process.env.TELNYX_PHONE_NUMBER, row.lead_phone,
             smsBody, smsResult.messageId]
          );
        }
      } else {
        // Email path (unchanged)
        // Load client cfg for send (may already be cached from reply-check pass)
        if (row.client_id && !clientEmailConfigs.has(row.client_id)) {
          clientEmailConfigs.set(row.client_id, await getClientEmailConfig(row.client_id));
        }
        sendResult = await sendSequenceEmail({
          salespersonId: row.salesperson_id,
          clientId:      row.client_id,
          to:            row.lead_email,
          subject:       step.subject,
          body:          step.body,
          vars,
          enrollmentId:  row.enrollment_id,
          stepId:        step.id,
          leadId:        row.lead_id,
        }, brandConfig);
      }

      if (sendResult.ok) {
        // Check if this was the last step
        const { rows: nextSteps } = await client.query(
          `SELECT id FROM sequence_steps WHERE sequence_id = $1 AND step_number > $2 LIMIT 1`,
          [row.sequence_id, nextStepNum]
        );

        if (nextSteps.length === 0) {
          // Last step sent — mark complete
          await client.query(
            `UPDATE contact_enrollments
             SET current_step = $1, status = 'completed', completed_at = $2
             WHERE id = $3`,
            [nextStepNum, now, row.enrollment_id]
          );
        } else {
          // Get next step delay (delay_minutes overrides delay_days for test mode)
          const { rows: futureStep } = await client.query(
            `SELECT delay_days, delay_minutes FROM sequence_steps WHERE sequence_id = $1 AND step_number = $2`,
            [row.sequence_id, nextStepNum + 1]
          );
          const fs = futureStep[0];
          const delayMs = fs?.delay_minutes != null
            ? fs.delay_minutes * 60 * 1000
            : (fs?.delay_days ?? 1) * 24 * 60 * 60 * 1000;
          const nextSendAt = new Date(Date.now() + delayMs).toISOString();

          await client.query(
            `UPDATE contact_enrollments
             SET current_step = $1, next_send_at = $2
             WHERE id = $3`,
            [nextStepNum, nextSendAt, row.enrollment_id]
          );
        }

        // First-touch attribution on successful outreach
        await setFirstTouchAttribution({
          leadId: row.lead_id,
          salespersonId: row.salesperson_id,
          source: 'email_enrollment',
          clientId: row.client_id,
        });

        sent++;
      } else if (sendResult.limited) {
        // Daily cap / warmup ceiling hit for this sending identity.
        // Leave the enrollment due (do not advance) so it retries next window.
        skipped++;
        console.log(`[cron] daily send cap reached for ${sendResult.identity} (limit ${sendResult.limit}) — enrollment ${row.enrollment_id} deferred`);
      } else {
        errors++;
        console.error(`[cron] send failed for enrollment ${row.enrollment_id}:`, sendResult.error);

        // Handle permanent bounce: suppress email address and pause enrollment
        if (sendResult.permanentBounce) {
          try {
            await client.query(
              `INSERT INTO suppression_list (email, reason, client_id)
               VALUES ($1, 'bounced', $2)
               ON CONFLICT (email) DO NOTHING`,
              [row.lead_email, row.client_id]
            );
            await client.query(
              `UPDATE contact_enrollments
               SET status = 'paused', paused_reason = 'bounced'
               WHERE id = $1`,
              [row.enrollment_id]
            );
            console.log(`[cron] permanent bounce — suppressed ${row.lead_email}, paused enrollment ${row.enrollment_id}`);
          } catch (bounceErr) {
            console.error('[cron] bounce suppression failed:', bounceErr.message);
          }
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[cron] unexpected error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }

  // Monitoring: alert on send failures so a broken sending identity / quota
  // issue surfaces immediately instead of silently degrading. Fire-and-forget.
  if (errors > 0) {
    sendTelegram(`⚠️ <b>Cron send-sequences</b>: ${errors} send error(s) this run (sent ${sent}, skipped ${skipped}).`).catch(() => {});
  }

  res.json({ ok: true, sent, skipped, errors, replies, timestamp: now });
}

router.all('/send-sequences', cronAuth, sendSequencesHandler);

/**
 * POST /cron/daily-digest
 * Generates AI-powered daily metrics summary email per client.
 * Called once daily by cron-job.org at 06:00 UTC.
 * Auth: Authorization: Bearer <CRON_SECRET>
 *
 * Recipient: the operator salesperson's own Gmail address (resolved from DB at runtime).
 * The digest is sent FROM and TO the operator's connected Gmail account — no separate
 * OPENROUTER_DIGEST_EMAIL env var is needed.
 */
router.post('/daily-digest', cronAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  let processed = 0, skipped = 0, errors = 0;
  const errorDetails = [];

  // Get all active clients
  const { rows: clients } = await pool.query(
    `SELECT id, brand_config FROM clients WHERE active = true`
  );

  for (const client of clients) {
    try {
      // Idempotency: skip if digest already sent today for this client
      const idempotency = await pool.query(
        `INSERT INTO digest_sends (client_id, period)
         VALUES ($1, $2)
         ON CONFLICT (client_id, period) DO NOTHING
         RETURNING id`,
        [client.id, today]
      );
      if (idempotency.rows.length === 0) {
        skipped++;
        continue;
      }

      // Query 24h metrics for this client.
      // Joins flow through leads (l) — email_sends and contact_enrollments have lead_id, not client_id.
      const { rows: [metrics] } = await pool.query(`
        SELECT
          COUNT(DISTINCT l.id) FILTER (WHERE l.created_at >= NOW() - INTERVAL '24 hours')      AS new_leads_24h,
          COUNT(es.id)         FILTER (WHERE es.sent_at   >= NOW() - INTERVAL '24 hours')      AS emails_sent_24h,
          COALESCE(AVG(es.open_count)  FILTER (WHERE es.sent_at >= NOW() - INTERVAL '24 hours'), 0) AS avg_opens,
          COALESCE(AVG(es.click_count) FILTER (WHERE es.sent_at >= NOW() - INTERVAL '24 hours'), 0) AS avg_clicks,
          COUNT(ce.id) FILTER (
            WHERE ce.status = 'paused'
              AND ce.paused_reason = 'replied'
              AND ce.replied_at >= NOW() - INTERVAL '24 hours'
          )                                                                                      AS replies_24h,
          COUNT(es.id) FILTER (WHERE es.bounced = true AND es.sent_at >= NOW() - INTERVAL '24 hours') AS bounces_24h,
          COUNT(DISTINCT l.id) FILTER (WHERE l.reply_urgency = 'high' AND l.reply_classified_at >= NOW() - INTERVAL '24 hours') AS hot_leads_24h,
          ROUND(
            COUNT(ce.id) FILTER (
              WHERE ce.status = 'paused'
                AND ce.paused_reason = 'replied'
                AND ce.replied_at >= NOW() - INTERVAL '24 hours'
            )::numeric
            / NULLIF(COUNT(es.id) FILTER (WHERE es.sent_at >= NOW() - INTERVAL '24 hours'), 0) * 100,
            1
          )                                                                                      AS reply_rate_pct
        FROM clients c
        LEFT JOIN leads l                ON l.client_id  = c.id
        LEFT JOIN contact_enrollments ce ON ce.lead_id   = l.id
        LEFT JOIN email_sends es         ON es.lead_id   = l.id
        WHERE c.id = $1
      `, [client.id]);

      // Ensure reply_rate_pct is never null in the prompt
      metrics.reply_rate_pct = metrics.reply_rate_pct != null ? metrics.reply_rate_pct : '0.0';

      // Bounce rate — deliverability health signal for the ops digest.
      const sent24 = Number(metrics.emails_sent_24h) || 0;
      metrics.bounce_rate_pct = sent24 > 0
        ? Math.round((Number(metrics.bounces_24h) / sent24) * 1000) / 10
        : '0.0';

      // Top subject lines by open rate (last 7 days)
      const { rows: topSubjects } = await pool.query(`
        SELECT ss.subject,
               SUM(es.open_count)                                                AS total_opens,
               COUNT(es.id)                                                      AS sends,
               ROUND(SUM(es.open_count)::numeric / NULLIF(COUNT(es.id), 0), 2) AS open_rate
        FROM email_sends es
        JOIN sequence_steps ss ON ss.id = es.step_id
        JOIN leads l           ON l.id  = es.lead_id
        WHERE l.client_id = $1
          AND es.sent_at >= NOW() - INTERVAL '7 days'
        GROUP BY ss.subject
        ORDER BY open_rate DESC
        LIMIT 3
      `, [client.id]);

      metrics.top_subjects = topSubjects.length
        ? topSubjects.map(r => `"${r.subject}" (${r.open_rate}x opens/send)`)
        : ['No email data yet'];

      // Build AI prompt and call OpenRouter
      const prompt = buildDigestPrompt(metrics);
      let aiSummary;
      try {
        aiSummary = await callOpenRouter(prompt);
      } catch (aiErr) {
        // Fall back to plain metrics summary if AI fails
        console.error(`[digest] OpenRouter failed for client ${client.id}:`, aiErr.message);
        aiSummary = `Yesterday: ${metrics.new_leads_24h} new leads, ${metrics.emails_sent_24h} emails sent, ${metrics.replies_24h} replies (${metrics.reply_rate_pct}% reply rate), ${metrics.bounces_24h} bounces.`;
      }

      // Find an operator-role salesperson with Gmail connected for this client
      const { rows: senders } = await pool.query(`
        SELECT s.id AS salesperson_id, s.email AS salesperson_email
        FROM salespeople s
        JOIN users u ON LOWER(u.email) = LOWER(s.email)
        WHERE u.client_id = $1
          AND u.role IN ('operator', 'owner')
          AND s.active = true
        LIMIT 1
      `, [client.id]);

      if (!senders[0]) {
        console.warn(`[digest] no operator salesperson found for client ${client.id} — skipping send`);
        errors++;
        continue;
      }

      const sender = senders[0];
      const auth = await getAuthedClient(sender.salesperson_id);
      if (!auth) {
        console.warn(`[digest] no Gmail account for salesperson ${sender.salesperson_id} — skipping`);
        errors++;
        continue;
      }

      const { client: gmailAuth, account } = auth;
      const brandConfig = client.brand_config || {};
      const clientName = brandConfig.name || 'SalesPilot';

      const html = buildDigestHtml(aiSummary, brandConfig);
      const raw = await buildRawMessage({
        fromName:    `${clientName} Digest`,
        fromAddress: account.email,
        to:          sender.salesperson_email,
        subject:     `${clientName} Daily Digest — ${today}`,
        textBody:    aiSummary,
        htmlBody:    html,
      });

      const gmail = google.gmail({ version: 'v1', auth: gmailAuth });
      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

      // Also send AI summary to Telegram
      notifyDailySummary({
        newLeads:   metrics.new_leads_24h  || 0,
        replies:    metrics.replies_24h    || 0,
        hotLeads:   metrics.hot_leads_24h  || 0,
        emailsSent: metrics.emails_sent_24h || 0,
        appUrl:     process.env.TRACKER_URL,
      }).catch(() => {});
      sendTelegram(`📝 <b>AI Summary</b>\n${aiSummary}`).catch(() => {});

      processed++;
    } catch (clientErr) {
      errors++;
      errorDetails.push({ client_id: client.id, error: clientErr.message });
      console.error(`[digest] error for client ${client.id}:`, clientErr.message);
    }
  }

  res.json({ ok: true, processed, skipped, errors, date: today, errorDetails });
});

/**
 * POST /cron/score-leads
 * Batch-updates leads.engagement_score for all active clients.
 * Run after send-sequences cron (e.g., every 6 hours or nightly).
 * Auth: Authorization: Bearer <CRON_SECRET>
 */
router.post('/score-leads', cronAuth, async (req, res) => {
  let updated = 0, errors = 0;

  // Get all active clients
  const { rows: clients } = await pool.query(
    `SELECT id FROM clients WHERE active = true`
  );

  for (const clientRow of clients) {
    try {
      // Aggregate per-lead engagement signals — scoped to this client
      const { rows: leads } = await pool.query(`
        SELECT
          l.id                                                    AS lead_id,
          COALESCE(SUM(es.open_count),  0)::integer              AS open_count,
          COALESCE(SUM(es.click_count), 0)::integer              AS click_count,
          COALESCE(bool_or(ce.paused_reason = 'replied'), false)  AS replied,
          COALESCE(MAX(ce.current_step), 0)::integer             AS step_reached
        FROM leads l
        LEFT JOIN contact_enrollments ce ON ce.lead_id = l.id
        LEFT JOIN email_sends es         ON es.lead_id = l.id
        WHERE l.client_id = $1
        GROUP BY l.id
      `, [clientRow.id]);

      for (const lead of leads) {
        const score = computeScore(
          lead.open_count,
          lead.click_count,
          lead.replied,
          lead.step_reached
        );

        await pool.query(
          `UPDATE leads
           SET engagement_score = $1, scored_at = NOW()
           WHERE id = $2 AND client_id = $3`,
          [score, lead.lead_id, clientRow.id]
        );

        updated++;
      }
    } catch (clientErr) {
      errors++;
      console.error(`[score-leads] error for client ${clientRow.id}:`, clientErr.message);
    }
  }

  res.json({ ok: true, updated, errors });
});

/**
 * POST /cron/run-agents
 * Fans out the AI marketing agents across every tenant that has them enabled.
 * Agents ship disabled by default, so this is a no-op until a tenant opts in.
 * Phase 07: Reporting agent (weekly cross-agent rollup). Idempotent per tenant/week.
 * Auth: Authorization: Bearer <CRON_SECRET>
 */
router.post('/run-agents', cronAuth, async (req, res) => {
  try {
    const results = await runDueAgents({ trigger: 'cron' });
    const totalErrors = results.reduce((a, r) => a + (r.errors || 0), 0);
    if (totalErrors > 0) {
      sendTelegram(`⚠️ <b>Cron run-agents</b>: ${totalErrors} agent error(s) this run.`).catch(() => {});
    }
    res.json({ ok: true, results, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[run-agents] failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /cron/poll-email-sources
 * Polls every enabled email intake source across all tenants and ingests leads
 * per each source's sender rules. No-op until a tenant connects a source.
 * Auth: Authorization: Bearer <CRON_SECRET>
 */
router.post('/poll-email-sources', cronAuth, async (req, res) => {
  try {
    const { pollAllSources } = require('../lib/emailSourcePoller');
    const results = await pollAllSources();
    const errs = results.filter(r => r.error).length;
    if (errs > 0) {
      sendTelegram(`⚠️ <b>Cron poll-email-sources</b>: ${errs} source error(s) this run.`).catch(() => {});
    }
    res.json({ ok: true, results, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[poll-email-sources] failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/test-telegram', cronAuth, async (req, res) => {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return res.json({ ok: false, error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in Railway env vars' });
  }
  const https = require('https');
  const body  = JSON.stringify({ chat_id: chatId, text: '✅ SureSecured Bot Connected! Notifications are working.', parse_mode: 'HTML' });
  const result = await new Promise((resolve) => {
    const r = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res2 => {
      let data = '';
      res2.on('data', c => data += c);
      res2.on('end', () => resolve(JSON.parse(data)));
    });
    r.on('error', err => resolve({ ok: false, description: err.message }));
    r.write(body); r.end();
  });
  res.json({ telegramResponse: result, token_prefix: token.slice(0, 10) + '...', chat_id: chatId });
});

module.exports = router;
