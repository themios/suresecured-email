/**
 * Lightweight in-memory rate limiter (no extra dependencies).
 * Resets buckets on interval; suitable for single-instance Railway deploy.
 */
function createRateLimiter({ windowMs = 60_000, max = 60, keyFn = (req) => req.ip }) {
  const buckets = new Map();

  setInterval(() => buckets.clear(), windowMs).unref?.();

  return function rateLimit(req, res, next) {
    const key = keyFn(req) || req.ip || 'unknown';
    const entry = buckets.get(key) || { count: 0 };
    entry.count += 1;
    buckets.set(key, entry);

    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}

const loginLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 20 });
const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
const cronLimiter = createRateLimiter({ windowMs: 60_000, max: 30, keyFn: (req) => req.headers.authorization || req.ip });
const leadFormLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 10 });

module.exports = { createRateLimiter, loginLimiter, apiLimiter, cronLimiter, leadFormLimiter };
