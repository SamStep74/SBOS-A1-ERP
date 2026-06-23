// SBOS-A1-ERP per-tenant rate limit cache (Wave 71).
//
// W70 added per-tenant login rate-limit config (CRUD + getEffectiveLoginLimits).
// W71 wires the config into the actual rate-limit check so a tenant
// who sets max_per_ip=5 actually gets 5, not the global default 20.
//
// Design:
// - One SlidingWindowLimiter pair (per-IP, per-username) per tenant.
//   Cached in a Map<tenantId, { ip, username, fetchedAt }>.
// - Cache is invalidated by the PUT route (immediate) AND by a TTL
//   (60s default) so a DB-side mutation (e.g. raw SQL during a
//   restore) takes effect without a server restart.
// - The cache stores the limiters, not the values, so we don't need
//   to recreate them on every read. The Map is bounded by
//   unique-tenant-with-traffic, which is small (tens, not millions).
// - Login attempts that pass an unknown username fall through to
//   the default tenant (0), because the per-tenant config is keyed
//   on the tenant of the user being attempted, not the tenant of
//   the requester. (An unauthenticated POST /api/auth/login has no
//   requester tenant.)
//
// Why per-IP uses the same per-tenant limits as per-username:
// The W70 schema configures both dimensions in one row. Splitting
// them would mean two lookups and a more complex permission model.
// The tenant-of-user lookup gives us a single tenant identity for
// the attempt, and that tenant's per-IP limit applies.

const DEFAULT_TTL_MS = 60_000; // 60 seconds

// Hard-coded fallback when no db is available. Mirrors the
// W57 global defaults so tests and scripts that don't wire
// in a db still get the original 20/10 behaviour. Uses the
// W70 snake_case shape so the translation below works
// uniformly.
const FALLBACK_LIMITS = Object.freeze({ max_per_ip: 20, max_per_username: 10 });

/**
 * In-memory cache of SlidingWindowLimiter pairs, keyed by tenantId.
 * The W57 default-tenant limiters (tenantId=0) are the "fallback"
 * when no row exists for a tenant, so we always have a valid pair
 * to return.
 */
export class TenantRateLimitCache {
  constructor({ getEffectiveLoginLimits, limiterFactory, ttlMs = DEFAULT_TTL_MS, defaultTenantId = 0, clock = () => Date.now() }) {
    if (typeof getEffectiveLoginLimits !== 'function') {
      throw new TypeError('TenantRateLimitCache requires getEffectiveLoginLimits');
    }
    if (typeof limiterFactory !== 'function') {
      throw new TypeError('TenantRateLimitCache requires limiterFactory');
    }
    this._getEffectiveLoginLimits = getEffectiveLoginLimits;
    this._limiterFactory = limiterFactory;
    this._ttlMs = ttlMs;
    this._defaultTenantId = defaultTenantId;
    this._clock = clock;
    // Map<tenantId, { ip, username, fetchedAt }>
    this._cache = new Map();
  }

  /**
   * Get the (per-IP, per-username) limiter pair for a tenant,
   * creating the pair on first use. Refreshes after the TTL.
   *
   * `db` is the live sqlite handle (post-W52: the request uses
   * `req.app.locals.db` so a restore picks up the new values on
   * the next read after TTL).
   *
   * @param {number} tenantId
   * @param {object} db
   * @returns {{ ip: object, username: object, limits: { maxPerIp: number, maxPerUsername: number } }}
   */
  getLimiters(tenantId, db) {
    const tid = Number.isInteger(tenantId) ? tenantId : this._defaultTenantId;
    const now = this._clock();
    const cached = this._cache.get(tid);
    if (cached && now - cached.fetchedAt < this._ttlMs) {
      return cached;
    }
    // Fall back to the hard-coded W57 defaults when the
    // db is missing or doesn't have a `prepare` method
    // (unit tests, scripts, transient handle issues).
    const raw = (db && typeof db.prepare === 'function')
      ? this._getEffectiveLoginLimits(db, tid)
      : FALLBACK_LIMITS;
    // Translate the W70 snake_case shape to the W71
    // camelCase shape that the limiterFactory expects.
    const limits = {
      maxPerIp: raw.max_per_ip,
      maxPerUsername: raw.max_per_username,
    };
    const pair = this._limiterFactory(limits);
    const entry = { ...pair, limits, fetchedAt: now };
    this._cache.set(tid, entry);
    return entry;
  }

  /**
   * Drop the cache entry for a tenant. Called by the PUT route
   * when the config changes, so the next login attempt uses the
   * new limits. Idempotent: a no-op if the tenant isn't cached.
   */
  invalidate(tenantId) {
    this._cache.delete(Number.isInteger(tenantId) ? tenantId : this._defaultTenantId);
  }

  /**
   * Drop every cache entry. Useful for tests + the W52 live-swap
   * (so a restore picks up new values on the next read regardless
   * of TTL).
   */
  invalidateAll() {
    this._cache.clear();
  }

  /**
   * Test helper: how many tenants are currently cached.
   */
  size() {
    return this._cache.size;
  }
}

/**
 * Build a fresh SlidingWindowLimiter pair for a given limits
 * config. Pulled out so tests can substitute a deterministic
 * clock + a stub limiter if they want.
 */
export function makeLoginLimiterPair({ maxPerIp, maxPerUsername, factory = defaultLimiterFactory }) {
  return {
    ip: factory({ max: maxPerIp }),
    username: factory({ max: maxPerUsername }),
  };
}

function defaultLimiterFactory({ max: _max }) {
  // Inline import-style: we don't want to import SlidingWindowLimiter
  // here to keep this module pure, but we DO need real limiters in
  // production. Callers pass the SlidingWindowLimiter class as
  // `factory` from the wiring layer.
  throw new Error('defaultLimiterFactory is a placeholder; pass a real factory');
}
