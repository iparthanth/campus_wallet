/**
 * In-process fixed-window rate limiter.
 *
 * Honest about its ceiling: the counters live in this process's memory, so with two
 * API instances behind a load balancer each enforces its own limit and the effective
 * cap doubles. For a single-instance deployment that is correct; the moment a second
 * instance exists this must move to Redis. Documented rather than pretended away.
 */
const buckets = new Map();

const clientIp = (req) => req.ip ?? req.socket?.remoteAddress ?? 'unknown';

/**
 * Login/registration bucket: IP **and** the account being targeted.
 *
 * Keying on IP alone is wrong in Bangladesh specifically. A university network — or a
 * mobile carrier's CGNAT — puts thousands of students behind one public address, so an
 * IP-only limit means ten fat-fingered passwords anywhere on campus locks out everyone
 * else trying to sign in. Keying on (IP, email) still stops an attacker grinding one
 * account, without making one student's typo everybody's problem.
 */
export const authKey = (req) => `${clientIp(req)}|${String(req.body?.email ?? '').toLowerCase()}`;

export function rateLimit({ windowMs = 60_000, max = 60, key = 'default', keyFn = clientIp } = {}) {
  return function rateLimiter(req, res, next) {
    const id = `${key}:${keyFn(req)}`;
    const now = Date.now();
    let bucket = buckets.get(id);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(id, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);

    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(remaining));
    res.set('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests — slow down and try again shortly' },
      });
    }
    return next();
  };
}

/** Stops the Map growing without bound in a long-lived process. */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, b] of buckets) if (now >= b.resetAt) buckets.delete(id);
}, 60_000);
sweeper.unref?.(); // never hold the process open just to sweep counters

/** Test seam: each test needs a clean slate, not the previous test's counters. */
export const __resetRateLimits = () => buckets.clear();
