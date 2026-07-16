/**
 * Segmentation agent — sorts a tenant's contacts into engagement tiers so
 * messaging can differ by group (the video's "four groups").
 *
 * Deterministic and cheap: it buckets leads by `engagement_score` (0-100,
 * produced by the score-leads cron via lib/scoring) into hot / warm / cool /
 * cold. No LLM call, so cost is zero. It writes `leads.segment` and emits a
 * `segment.updated` event that the Reporting agent surfaces.
 *
 * Read/label only — it never sends outreach. Thresholds are configurable per
 * tenant via client_agent_settings.config.thresholds.
 */
const { pool } = require('../../db');
const { runAgent } = require('./runner');
const { emit } = require('./eventBus');

const DEFAULT_THRESHOLDS = { hot: 50, warm: 25, cool: 1 };

/** Resolve validated numeric thresholds from per-tenant config. */
function resolveThresholds(config = {}) {
  const t = config.thresholds || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    hot:  num(t.hot,  DEFAULT_THRESHOLDS.hot),
    warm: num(t.warm, DEFAULT_THRESHOLDS.warm),
    cool: num(t.cool, DEFAULT_THRESHOLDS.cool),
  };
}

/** Pure helper: which tier does a score fall into? (exported for tests) */
function segmentForScore(score, config = {}) {
  const th = resolveThresholds(config);
  const s = Number(score) || 0;
  if (s >= th.hot)  return 'hot';
  if (s >= th.warm) return 'warm';
  if (s >= th.cool) return 'cool';
  return 'cold';
}

/**
 * Run segmentation for one tenant.
 * @param {number} clientId
 * @param {{trigger?:string, config?:object}} opts
 */
async function runSegmentationForClient(clientId, opts = {}) {
  const { trigger = 'cron', config = {} } = opts;
  const th = resolveThresholds(config);

  return runAgent({ clientId, agent: 'segmentation', trigger }, async () => {
    // Single efficient pass: assign tiers and update only rows whose tier
    // changed. RETURNING gives us the "moved" count without a second scan.
    const { rows: movedRows } = await pool.query(
      `WITH scored AS (
         SELECT id, CASE
                  WHEN COALESCE(engagement_score, 0) >= $2 THEN 'hot'
                  WHEN COALESCE(engagement_score, 0) >= $3 THEN 'warm'
                  WHEN COALESCE(engagement_score, 0) >= $4 THEN 'cool'
                  ELSE 'cold'
                END AS seg
         FROM leads WHERE client_id = $1
       )
       UPDATE leads l
          SET segment = s.seg, segmented_at = NOW()
         FROM scored s
        WHERE l.id = s.id AND l.client_id = $1
          AND (l.segment IS DISTINCT FROM s.seg)
       RETURNING l.id`,
      [clientId, th.hot, th.warm, th.cool]
    );
    const moved = movedRows.length;

    const { rows: dist } = await pool.query(
      `SELECT COALESCE(segment, 'cold') AS seg, COUNT(*)::int AS n
         FROM leads WHERE client_id = $1 GROUP BY 1`,
      [clientId]
    );
    const counts = Object.fromEntries(dist.map(r => [r.seg, r.n]));
    const total = dist.reduce((a, r) => a + r.n, 0);

    // Only emit when something actually changed — keeps the bus quiet.
    if (moved > 0) {
      await emit(clientId, 'segmentation', 'segment.updated', { moved, counts });
    }
    return { total, moved, counts };
  });
}

module.exports = { runSegmentationForClient, segmentForScore, resolveThresholds };
