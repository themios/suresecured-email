/**
 * Unit tests for agent helpers that need no database.
 * Run: node --test src/lib/agents/agents.test.js
 */
const assert = require('node:assert');
const { test } = require('node:test');

const { isoWeekKey, buildPrompt, fallbackSummary } = require('./reporting');
const { estimateCost } = require('./costs');
const { segmentForScore, resolveThresholds } = require('./segmentation');

test('isoWeekKey formats ISO week correctly', () => {
  // 2026-01-01 is a Thursday -> ISO week 01 of 2026
  assert.strictEqual(isoWeekKey(new Date('2026-01-01T12:00:00Z')), '2026-W01');
  // Mid-July 2026
  assert.match(isoWeekKey(new Date('2026-07-16T12:00:00Z')), /^2026-W2\d$/);
  // Week is zero-padded
  assert.match(isoWeekKey(new Date('2026-03-02T00:00:00Z')), /^2026-W\d\d$/);
});

test('isoWeekKey is stable within the same ISO week', () => {
  const mon = isoWeekKey(new Date('2026-07-13T00:00:00Z')); // Monday
  const sun = isoWeekKey(new Date('2026-07-19T23:00:00Z')); // Sunday same ISO week
  assert.strictEqual(mon, sun);
});

test('buildPrompt includes metrics and handles empty agent activity', () => {
  const input = {
    metrics: { new_leads: 5, emails_sent: 20, replies: 2, reply_rate_pct: 10, bounces: 1 },
    activity: [],
    runStats: [],
    pending: 0,
  };
  const p = buildPrompt(input, { name: 'Acme' });
  assert.match(p, /Acme/);
  assert.match(p, /New leads: 5/);
  assert.match(p, /no agent activity yet/);
  assert.match(p, /no agent runs yet/);
});

test('buildPrompt renders activity and run lines when present', () => {
  const input = {
    metrics: { new_leads: 0, emails_sent: 0, replies: 0, reply_rate_pct: 0, bounces: 0 },
    activity: [{ agent: 'segmentation', type: 'segment.updated', n: 3 }],
    runStats: [{ agent: 'segmentation', runs: 1, errors: 0 }],
    pending: 4,
  };
  const p = buildPrompt(input, {});
  assert.match(p, /segmentation:segment\.updated×3/);
  assert.match(p, /segmentation 1 runs/);
  assert.match(p, /awaiting your approval: 4/);
});

test('fallbackSummary is plain and includes core numbers', () => {
  const s = fallbackSummary({
    metrics: { new_leads: 3, emails_sent: 10, replies: 1, reply_rate_pct: 10, bounces: 0 },
    pending: 2,
  });
  assert.match(s, /3 new leads/);
  assert.match(s, /2 proposal/);
});

test('estimateCost computes from usage and known pricing', () => {
  const c = estimateCost('google/gemini-2.5-flash', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
  // 0.30 in + 2.50 out
  assert.ok(Math.abs(c - 2.8) < 1e-9, `expected ~2.8, got ${c}`);
});

test('estimateCost is zero for unknown models (never blocks a run)', () => {
  assert.strictEqual(estimateCost('some/unknown-model', { prompt_tokens: 999, completion_tokens: 999 }), 0);
});

test('segmentForScore buckets across the four default tiers', () => {
  assert.strictEqual(segmentForScore(100), 'hot');
  assert.strictEqual(segmentForScore(50),  'hot');   // boundary inclusive
  assert.strictEqual(segmentForScore(49),  'warm');
  assert.strictEqual(segmentForScore(25),  'warm');  // boundary inclusive
  assert.strictEqual(segmentForScore(24),  'cool');
  assert.strictEqual(segmentForScore(1),   'cool');  // boundary inclusive
  assert.strictEqual(segmentForScore(0),   'cold');
});

test('segmentForScore treats null/undefined score as cold', () => {
  assert.strictEqual(segmentForScore(null), 'cold');
  assert.strictEqual(segmentForScore(undefined), 'cold');
});

test('resolveThresholds honours valid config and ignores garbage', () => {
  assert.deepStrictEqual(resolveThresholds({ thresholds: { hot: 70, warm: 40, cool: 5 } }), { hot: 70, warm: 40, cool: 5 });
  // garbage falls back to defaults
  assert.deepStrictEqual(resolveThresholds({ thresholds: { hot: 'x' } }), { hot: 50, warm: 25, cool: 1 });
  assert.deepStrictEqual(resolveThresholds({}), { hot: 50, warm: 25, cool: 1 });
});

test('custom thresholds re-bucket scores', () => {
  const cfg = { thresholds: { hot: 80, warm: 40, cool: 10 } };
  assert.strictEqual(segmentForScore(70, cfg), 'warm');
  assert.strictEqual(segmentForScore(5, cfg),  'cold');
});
