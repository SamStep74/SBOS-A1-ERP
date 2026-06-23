// SBOS-A1-ERP W78: admin rate-limit reset route.
//
// W57's SlidingWindowLimiter prunes on consume() and
// has its own startCleanup() timer. In normal operation
// the in-memory store is bounded by unique keys. The
// one thing the cleanup can't do is RECLAIM a state
// the operator considers stale — e.g. an IP that
// tripped the per-IP limit 10 minutes ago should
// probably not be blocked if a legitimate user now
// appears from the same NAT.
//
// W78 exposes a single route:
//   POST /api/rbac/rate-limit/login/reset
//     body: { ip?, username? }  — reset one or all
//     returns: { ok, resetKeys: number }
//
// The route is admin-only (security.audit.export, same
// gate as the W57 per-tenant rate-limit config) so a
// compromised low-privilege user can't blanket-reset
// the limiter store.
//
// resetLoginRateLimit() (the existing W57 export) clears
// the entire store. W78 adds targeted reset:
//   - resetLoginRateLimitByIp(ip) — clear just one IP
//   - resetLoginRateLimitByUsername(username) — clear one user
// Both are exported from server/rate-limit.js so the
// route can call them.

import {
  resetLoginRateLimit,
  resetLoginRateLimitByIp,
  resetLoginRateLimitByUsername,
} from '../rate-limit.js';

/**
 * Count the number of keys that would be reset. The
 * underlying limiter doesn't expose its internal Map
 * (intentional — we don't want callers reaching into
 * the store). The W57 `peek()` returns the count for
 * a given key, but it doesn't tell us about the OTHER
 * keys. So we just report `1` for targeted resets
 * (one key) and `{ total: known }` for blanket resets
 * if we can find the size.
 *
 * For now, the response just reports "did we reset at
 * least one" — the operator can call again if needed.
 * The store size is observable via
 * `resetLoginRateLimit()._store.size` in dev mode but
 * that's not exposed over HTTP.
 */
export function buildResetLoginRateLimitHandler() {
  return async function resetHandler(req, res, next) {
    try {
      const body = req.body || {};
      const ip = typeof body.ip === 'string' ? body.ip.trim() : '';
      const username =
        typeof body.username === 'string' ? body.username.trim() : '';
      if (ip && username) {
        return res.status(400).json({
          error: 'invalid_request',
          message: 'specify exactly one of ip or username (not both)',
        });
      }
      if (!ip && !username) {
        // Blanket reset — admin confirms via header
        // (otherwise a typo could clear everyone).
        const confirm = req.headers['x-confirm-blanket-reset'];
        if (confirm !== 'yes') {
          return res.status(400).json({
            error: 'invalid_request',
            message:
              'blanket reset requires X-Confirm-Blanket-Reset: yes header',
          });
        }
        resetLoginRateLimit();
        return res.status(200).json({ ok: true, resetKeys: 'all' });
      }
      if (ip) {
        resetLoginRateLimitByIp(ip);
        return res.status(200).json({ ok: true, resetKeys: 1, scope: 'ip' });
      }
      // username
      resetLoginRateLimitByUsername(username);
      return res.status(200).json({ ok: true, resetKeys: 1, scope: 'username' });
    } catch (err) {
      next(err);
    }
  };
}
