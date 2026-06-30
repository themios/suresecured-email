// Run once after deploying to create the admin account
// Usage: node src/setup.js

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, initDb } = require('./db');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@suresecured.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

async function setup() {
  await initDb();

  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await pool.query(
    `INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = $2`,
    [ADMIN_EMAIL, hash]
  );

  console.log(`Admin user ready: ${ADMIN_EMAIL}`);
  console.log('Change your password immediately after first login.');
  process.exit(0);
}

setup().catch(err => {
  console.error(err);
  process.exit(1);
});
