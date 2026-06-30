#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const TOTAL = 500_000;
const BATCH  = 1_000;

async function seed() {
  const client = await pool.connect();
  try {
    console.log('Seeding prerequisite data...');

    // 1. Ensure a seed sequence exists
    const seqRes = await client.query(`
      INSERT INTO sequences (name, description, audience_type, active)
      VALUES ('Seed Sequence', 'Load test sequence', 'all', true)
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    let seqId;
    if (seqRes.rows.length) {
      seqId = seqRes.rows[0].id;
    } else {
      const r = await client.query("SELECT id FROM sequences WHERE name='Seed Sequence' LIMIT 1");
      seqId = r.rows[0].id;
    }

    // 2. Ensure step 1 exists for that sequence
    await client.query(`
      INSERT INTO sequence_steps (sequence_id, step_number, delay_days, subject, body)
      VALUES ($1, 1, 0, 'Test Subject', '<p>Test body</p>')
      ON CONFLICT DO NOTHING
    `, [seqId]);

    // 3. Ensure a seed salesperson exists
    const spRes = await client.query(`
      INSERT INTO salespeople (name, email, commission_rate, active)
      VALUES ('Seed SP', 'seed@loadtest.local', 0.10, true)
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `);
    let spId;
    if (spRes.rows.length) {
      spId = spRes.rows[0].id;
    } else {
      const r = await client.query("SELECT id FROM salespeople WHERE email='seed@loadtest.local' LIMIT 1");
      spId = r.rows[0].id;
    }

    // 4. Seed leads and enrollments in batches
    console.log(`Seeding ${TOTAL.toLocaleString()} contacts in batches of ${BATCH}...`);
    const start = Date.now();
    let inserted = 0;

    for (let b = 0; b < TOTAL / BATCH; b++) {
      await client.query('BEGIN');

      // Insert BATCH leads
      const leadValues = [];
      const leadParams = [];
      for (let i = 0; i < BATCH; i++) {
        const idx = b * BATCH + i;
        const offset = leadParams.length;
        leadValues.push(`($${offset+1}, $${offset+2}, $${offset+3})`);
        leadParams.push(`seed${idx}@loadtest.local`, `Seed${idx}`, 'User');
      }
      const leadRes = await client.query(
        `INSERT INTO leads (email, first_name, last_name) VALUES ${leadValues.join(',')} RETURNING id`,
        leadParams
      );
      const leadIds = leadRes.rows.map(r => r.id);

      // Insert BATCH enrollments — spread next_send_at across past 30 days so many are "due"
      const enrollValues = [];
      const enrollParams = [];
      for (let i = 0; i < BATCH; i++) {
        const leadId = leadIds[i];
        const daysAgo = Math.floor(Math.random() * 30);
        const nextSendAt = new Date(Date.now() - daysAgo * 86400000);
        const offset = enrollParams.length;
        enrollValues.push(`($${offset+1}, $${offset+2}, $${offset+3}, 'active', 1, $${offset+4})`);
        enrollParams.push(leadId, seqId, spId, nextSendAt);
      }
      await client.query(
        `INSERT INTO contact_enrollments (lead_id, sequence_id, salesperson_id, status, current_step, next_send_at)
         VALUES ${enrollValues.join(',')}`,
        enrollParams
      );

      await client.query('COMMIT');
      inserted += BATCH;

      if (inserted % 50_000 === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`  ${inserted.toLocaleString()} rows inserted (${elapsed}s elapsed)`);
      }
    }

    const total = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`Done. ${TOTAL.toLocaleString()} contacts seeded in ${total}s.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
