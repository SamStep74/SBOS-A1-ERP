// SBOS-A1-ERP rate limiter (Wave 57 + Wave 71).
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

import {
  TenantRateLimitCache,
  makeLoginLimiterPair,
} from './rate-limit-tenant.js';
import { getEffectiveLoginLimits } from './finance/tenantRateLimit.js';

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
//
// Wave 71: per-tenant overrides. The login rate-limit config
// (W70) lets a tenant override the global 20/5min per-IP and
// 10/5min per-username defaults. The TenantRateLimitCache
// holds one SlidingWindowLimiter pair per tenant, with a
// short TTL so DB-side mutations (W52 restore, raw SQL)
// take effect within a minute. The PUT route invalidates
// the cache immediately so operator changes apply on the
// next login attempt.
const LOGIN_WINDOW_MS = 5 * 60_000; // 5 minutes

// Module-level cache. Shared between all login attempts.
// `db` is passed per-request so a post-W52 restore is
// visible (the limiter pair itself is process-local, but
// the limits it was constructed with are re-read from the
// live db).
let loginRateLimitCache = null;

function ensureCache() {
  if (!loginRateLimitCache) {
    loginRateLimitCache = new TenantRateLimitCache({
      getEffectiveLoginLimits,
      limiterFactory: (limits) => {
        const pair = makeLoginLimiterPair({
          maxPerIp: limits.maxPerIp,
          maxPerUsername: limits.maxPerUsername,
          factory: ({ max }) => new SlidingWindowLimiter({
            windowMs: LOGIN_WINDOW_MS,
            max,
            cleanupIntervalMs: 60_000,
          }),
        });
        pair.ip.startCleanup();
        pair.username.startCleanup();
        return pair;
      },
    });
  }
  return loginRateLimitCache;
}

/**
 * Resolve the tenantId for a username. Default to 0 (the
 * global tenant) when the user is unknown. This lookup is
 * one indexed query per login attempt; it's safe to do
 * before the credential check because we don't reveal
 * anything about the password.
 */
function resolveTenantForUsername(db, username) {
  if (!username || !db || typeof db.prepare !== 'function') return 0;
  try {
    const row = db
      .prepare('SELECT tenant_id FROM users WHERE username = ?')
      .get(username);
    if (row && Number.isInteger(row.tenant_id)) {
      return row.tenant_id;
    }
  } catch (_err) {
    // If the users table doesn't exist (tests with a
    // bare db) or some other transient issue, fall back
    // to the default tenant. We don't want a schema
    // drift to 500 the login route.
    return 0;
  }
  return 0;
}

export function checkLoginRateLimit({ ip, username, db }) {
  const tenantId = resolveTenantForUsername(db, username);
  const cache = ensureCache();
  const { ip: ipLimiter, username: usernameLimiter, limits } = cache.getLimiters(
    tenantId,
    db,
  );
  // Check per-IP first (typically stricter because one IP
  // is a single device/network).
  const ipKey = `ip:${ip || 'unknown'}`;
  const ipCheck = ipLimiter.consume(ipKey);
  if (!ipCheck.allowed) {
    return { ...ipCheck, scope: 'ip', max: limits.maxPerIp };
  }
  // Then per-username (protects specific accounts from
  // distributed brute force).
  if (username) {
    const userKey = `user:${username}`;
    const userCheck = usernameLimiter.consume(userKey);
    if (!userCheck.allowed) {
      return { ...userCheck, scope: 'user', max: limits.maxPerUsername };
    }
  }
  return {
    allowed: true,
    remaining: ipCheck.remaining,
    retryAfter: 0,
    total: ipCheck.total,
    scope: 'ip',
    max: limits.maxPerIp,
  };
}

export function resetLoginRateLimit() {
  if (loginRateLimitCache) {
    loginRateLimitCache.invalidateAll();
  }
}

/**
 * W78: targeted reset — clear the per-IP limiter for one
 * IP across all tenant limiters. The IP limiter is keyed
 * `ip:<ip>` so we walk the cache and reset just that
 * key on every tenant's limiter pair.
 *
 * This is the operator's panic button when a legitimate
 * user got blocked by their IP (e.g. shared NAT, VPN).
 * Returns the number of tenant limiters that were
 * touched.
 */
export function resetLoginRateLimitByIp(ip) {
  if (!ip || !loginRateLimitCache) return 0;
  let touched = 0;
  for (const [, entry] of loginRateLimitCache.entries()) {
    if (entry && entry.ip && typeof entry.ip.reset === 'function') {
      entry.ip.reset(`ip:${ip}`);
      touched += 1;
    }
  }
  return touched;
}

/**
 * W78: targeted reset — clear the per-username limiter
 * for one username across all tenants. Same pattern as
 * the per-IP reset.
 */
export function resetLoginRateLimitByUsername(username) {
  if (!username || !loginRateLimitCache) return 0;
  let touched = 0;
  for (const [, entry] of loginRateLimitCache.entries()) {
    if (
      entry &&
      entry.username &&
      typeof entry.username.reset === 'function'
    ) {
      entry.username.reset(`user:${username}`);
      touched += 1;
    }
  }
  return touched;
}

/**
 * Invalidate the cached limiters for one tenant. Called by
 * the PUT /api/rbac/tenants/:tenantId/rate-limit route so
 * operator changes take effect on the next login attempt.
 */
export function invalidateTenantLoginLimiters(tenantId) {
  if (loginRateLimitCache) {
    loginRateLimitCache.invalidate(tenantId);
  }
}

/**
 * Drop every cached tenant limiter pair. Called by swapDb
 * (Wave 52) on a backup-restore so the new values are
 * picked up on the next read regardless of TTL.
 */
export function invalidateAllLoginLimiters() {
  if (loginRateLimitCache) {
    loginRateLimitCache.invalidateAll();
  }
}
