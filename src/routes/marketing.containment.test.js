// Containment guard for the 2026-10-10 form relay incident.
// An unverified public submission to POST /get-started must not reach the model
// or the mailer. Run: node --test src/routes/marketing.containment.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const calls = { query: [], generateAudit: 0, sendDirectEmail: 0, callOpenRouter: 0 };

function stub(rel, exports) {
  const abs = require.resolve(path.join(__dirname, rel));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}
stub('../db', { pool: { query: async (sql, params) => { calls.query.push({ sql, params }); return { rows: [] }; } } });
stub('../lib/openrouter', { callOpenRouter: async () => { calls.callOpenRouter++; return 'x'; } });
stub('../lib/gmail', { sendDirectEmail: async () => { calls.sendDirectEmail++; } });
const audit = require('../lib/audit');
const realGenerate = audit.generateAudit;
audit.generateAudit = async (...a) => { calls.generateAudit++; return realGenerate(...a); };

const marketing = require('./marketing');

async function post(body) {
  const app = express();
  app.use('/', marketing);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/get-started`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    return res;
  } finally { server.close(); }
}

test('unverified submission is stored but triggers no AI call and no email', async () => {
  const res = await post({ business_name: 'Acme Roofing', email: 'someone@example.com', trade: 'roofing', list_size: '500_2000' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/?submitted=1#apply');
  assert.ok(calls.query.some(q => /INSERT INTO platform_leads/.test(q.sql)), 'lead still stored');
  assert.strictEqual(calls.generateAudit, 0, 'no estimate generation');
  assert.strictEqual(calls.callOpenRouter, 0, 'no model call');
  assert.strictEqual(calls.sendDirectEmail, 0, 'no outbound email');
});
