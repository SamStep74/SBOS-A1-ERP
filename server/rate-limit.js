// SBOS-A1-ERP rate limiter (Wave 57).
//
// In-memory sliding-window rate limiter. Used to protect
// public-facing endpoints from credential stuffing + brute
// force. Pairs with Wave 38 lockout (per-user, longer window)
// and Wave 56 attachment upload (per-tenant, but the same
// module is reusable).
//
// The store is process-local. For a multi-process / multi-host
// deploy, swap the Map for a Redis-backed store. The shape
// of `consume` and `peek` is what the routes depend on, not
// the underlying storage.
//
// Usage:
//   const limiter = new SlidingWindowLimiter({
//     windowMs: 60_000,
//     max: 20,
//   });
//   const r = limiter.consume({ ip: req.ip, username });
//   if (!r.allowed) {
//     return res.status(429).set('Retry-After', r.retryAfter).json(...);
//   }

const DEFAULT_OPTS = {
  windowMs: 60_000, // 1 minute
  max: 20, // 20 attempts per window
  // Periodic cleanup of stale entries. The default of 1
  // minute prevents the Map from growing without bound
  // when many distinct keys are seen.
  cleanupIntervalMs: 60_000,
};

export class SlidingWindowLimiter {
  constructor(opts = {}) {
    this.windowMs = opts.windowMs || DEFAULT_OPTS.windowMs;
    this.max = opts.max || DEFAULT_OPTS.max;
    this.cleanupIntervalMs =
      opts.cleanupIntervalMs || DEFAULT_OPTS.cleanupIntervalMs;
    // Map<key, { attempts: number[] }>
    // Each key has an array of attempt timestamps (ms). New
    // attempts are added; old ones (older than windowMs) are
    // pruned on every consume() call.
    this._store = new Map();
    this._cleanupTimer = null;
  }

  /**
   * Record an attempt + return the rate-limit decision.
   *
   * @param {string} key — the rate-limit key (e.g. "ip:1.2.3.4"
   *                       or "user:alice"). The caller composes
   *                       the key shape.
   * @returns { allowed: boolean, remaining: number, retryAfter: number, total: number }
   *   - allowed:    true if the attempt fits under the limit
   *   - remaining:  how many more attempts fit in the current window
   *   - retryAfter: seconds until the OLDEST in-window attempt
   *                 expires (the wait time for the next slot to
   *                 open). Always >= 0. When allowed=true and
   *                 remaining>0, this is 0.
   *   - total:      total in-window attempts AFTER this one was
   *                 recorded
   *
   * The attempt is recorded even when over-limit, so the
   * caller can return the same 429 for repeated calls.
   */
  consume(key) {
    if (!key) {
      // Defensive: a missing key is a programming error.
      // Allow the request (don't 429 something we can't
      // account for) but log to stderr.
      return { allowed: true, remaining: this.max, retryAfter: 0, total: 0 };
    }
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let entry = this._store.get(key);
    if (!entry) {
      entry = { attempts: [] };
      this._store.set(key, entry);
    }
    // Prune old attempts.
    while (entry.attempts.length > 0 && entry.attempts[0] <= cutoff) {
      entry.attempts.shift();
    }
    // Record the new attempt.
    entry.attempts.push(now);
    const total = entry.attempts.length;
    if (total <= this.max) {
      return {
        allowed: true,
        remaining: this.max - total,
        retryAfter: 0,
        total,
      };
    }
    // Over limit. retryAfter = seconds until the oldest
    // in-window attempt expires (the first slot that
    // becomes available).
    const oldest = entry.attempts[0];
    const msUntilFree = Math.max(0, oldest + this.windowMs - now);
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil(msUntilFree / 1000),
      total,
    };
  }

  /**
   * Peek at the current state for a key without recording
   * an attempt. Useful for the X-RateLimit-* response headers
   * on every response (so the client can see its budget).
   */
  peek(key) {
    if (!key) {
      return { remaining: this.max, total: 0 };
    }
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const entry = this._store.get(key);
    if (!entry) {
      return { remaining: this.max, total: 0 };
    }
    while (entry.attempts.length > 0 && entry.attempts[0] <= cutoff) {
      entry.attempts.shift();
    }
    return {
      remaining: Math.max(0, this.max - entry.attempts.length),
      total: entry.attempts.length,
    };
  }

  /**
   * Reset a key. Used by tests + by the operator's
   * "unblock this IP" action.
   */
  reset(key) {
    if (key) this._store.delete(key);
  }

  /**
   * Reset all keys. Used by tests + on operator request.
   */
  resetAll() {
    this._store.clear();
  }

  /**
   * Start the periodic cleanup of stale entries. Optional —
   * consume() prunes on every call so the Map is bounded by
   * the number of distinct keys. This timer is for entries
   * that are seen once and then never re-touched (so their
   * attempts array is never re-pruned). Without it, the
   * store grows linearly with unique keys.
   */
  startCleanup() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      const cutoff = now - this.windowMs;
      for (const [key, entry] of this._store) {
        while (entry.attempts.length > 0 && entry.attempts[0] <= cutoff) {
          entry.attempts.shift();
        }
        if (entry.attempts.length === 0) {
          this._store.delete(key);
        }
      }
    }, this.cleanupIntervalMs);
    // Don't keep the process alive just for cleanup.
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  stopCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}

// Singleton for the login route. The route composes a
// key from the IP + the username so an attacker can't dodge
// the limit by varying usernames. The two windows are
// independent: a fixed IP can't make unlimited attempts
// across many usernames, AND a fixed username can't be
// hammered from many IPs.
const loginLimiter = new SlidingWindowLimiter({
  windowMs: 5 * 60_000, // 5 minutes
  max: 20, // 20 per 5 min per IP
});
const loginUsernameLimiter = new SlidingWindowLimiter({
  windowMs: 5 * 60_000,
  max: 10, // 10 per 5 min per username
});

loginLimiter.startCleanup();
loginUsernameLimiter.startCleanup();

export function checkLoginRateLimit({ ip, username }) {
  // Check per-IP first (typically stricter because one IP
  // is a single device/network).
  const ipCheck = loginLimiter.consume(`ip:${ip || 'unknown'}`);
  if (!ipCheck.allowed) {
    return { ...ipCheck, scope: 'ip' };
  }
  // Then per-username (protects specific accounts from
  // distributed brute force).
  if (username) {
    const userCheck = loginUsernameLimiter.consume(`user:${username}`);
    if (!userCheck.allowed) {
      return { ...userCheck, scope: 'user' };
    }
  }
  return { allowed: true, remaining: ipCheck.remaining, retryAfter: 0, total: ipCheck.total, scope: 'ip' };
}

export function resetLoginRateLimit() {
  loginLimiter.resetAll();
  loginUsernameLimiter.resetAll();
}
