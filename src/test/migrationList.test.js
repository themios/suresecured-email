// Guard: a migration file that is not in MIGRATION_FILES never runs in production.
// (Found when 026 was written and the app booted without its tables.)
// Run: node --test src/test/migrationList.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@127.0.0.1:1/unused';
const { MIGRATION_FILES } = require('../db');

test('every migration file on disk is registered, and every registered file exists', () => {
  const dir = path.join(__dirname, '../../migrations');
  const onDisk = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  assert.deepStrictEqual(onDisk.filter(f => !MIGRATION_FILES.includes(f)), [], 'unregistered migration files');
  assert.deepStrictEqual(MIGRATION_FILES.filter(f => !onDisk.includes(f)), [], 'registered files missing on disk');
});
