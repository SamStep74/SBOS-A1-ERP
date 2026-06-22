// SBOS-A1-ERP real auth middleware.
//
// Replaces the "stub Admin for any token" behavior that the boot
// prototype used. The new contract:
//
//   - Bearer <token> must be the id of a row in sbos_rbac_sessions
//     (i.e. a live, non-revoked, non-expired session token).
//   - The middleware resolves the user_id from the session, then sets
//     `req.user = { id, username, role, tenant_id, ... }` and
//     `req.session = { id, role_id, permission_set_ids, ... }`.
//   - If the token is missing, malformed, or unknown → 401 (no
//     silent fall-through to a stub).
//   - `/api/health` is exempt (orchestrator probes it; no auth needed).
//
// Back-compat:
//   - If `SBOS_AUTH_MODE=stub` is set, the middleware falls back to
//     the legacy behavior (any request → stub Admin, id=1, tenant=0).
//     Used by the unit tests so the existing 893-test suite continues
//     to work without seeding a session per test.
//
// On the boot side, bin/sbos-server.mjs seeds a session token on a
// fresh boot (see seedSessionForAdmin()) and prints it to stdout so
// the operator can `curl -H "Authorization: Bearer <token>" ...`.

import { randomBytes } from 'node:crypto';
import { recordSessionEvent } from './auth-sessions.js';

// ────────────────────────────────────────────────────────────────────────
// Token format. A session token is a 32-char URL-safe base64 string
// (crypto.randomBytes(24).toString('base64url')). 192 bits of entropy
// is enough for an opaque bearer token; we don't sign or encrypt it.
// ────────────────────────────────────────────────────────────────────────

export function generateSessionToken() {
  return randomBytes(24).toString('base64url');
}

// ────────────────────────────────────────────────────────────────────────
// seedSessionForAdmin(db, opts) — boot helper.
// Creates a session row for user_id=1 (the admin stub) and returns
// the token. Idempotent on (user_id, role_id) — if a live session
// already exists, returns its token instead of creating a new one.
// ────────────────────────────────────────────────────────────────────────

export function seedSessionForAdmin(db, { ttlSeconds = 60 * 60 * 24 * 30 } = {}) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  // Look for any live session for user 1 with role 'Admin'.
  const existing = db
    .prepare(
      `SELECT id FROM sbos_rbac_sessions
        WHERE user_id = 1 AND role_id = 'Admin'
          AND revoked_at IS NULL
          AND strftime('%s', expires_at) > strftime('%s', 'now')
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get();
  if (existing && existing.id) {
    return existing.id;
  }
  const token = generateSessionToken();
  db.prepare(
    `INSERT INTO sbos_rbac_sessions
       (id, user_id, tenant_id, role_id, permission_set_ids_json,
        effective_permissions_json, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)`,
  ).run(
    token,
    1,
    0,
    'Admin',
    '[]', // resolved PS list — not used by the middleware; the rbac
          // routes compute the live set per-request
    '[]', // same for effective perms
    expiresAt,
  );
  // Wave 55: record the boot-time admin session in the
  // activity log so the operator can see "yes, an admin
  // session was minted at boot time, source=seed".
  try {
    recordSessionEvent(db, {
      sessionId: token,
      userId: 1,
      tenantId: 0,
      eventType: 'login',
      ip: null,
      userAgent: null,
      payload: { method: 'boot-seed' },
    });
  } catch (_e) {
    // best-effort; don't fail boot
  }
  return token;
}

// ────────────────────────────────────────────────────────────────────────
// makeAuthMiddleware — returns an Express middleware.
//   opts.db — node:sqlite handle
//   opts.authMode — 'real' (default) or 'stub' (legacy)
//
// On success: sets req.user, req.session, calls next().
// On failure (real mode only): responds 401 with { error: 'unauthorized' }.
// ────────────────────────────────────────────────────────────────────────

export function makeAuthMiddleware({ db, dbRef, authMode = process.env.SBOS_AUTH_MODE || 'real' }) {
  if (authMode !== 'real' && authMode !== 'stub') {
    throw new Error(`authMode must be 'real' or 'stub', got ${JSON.stringify(authMode)}`);
  }
  // Resolve the live db on every request. The legacy `db` arg is
  // captured at construction time and is fine for callers that
  // never swap the handle. Callers that need the live-swap
  // behavior (e.g. POST /api/rbac/backup/restore) pass `dbRef`
  // and we read `dbRef.current` per request.
  const getDb = dbRef
    ? () => dbRef.current
    : () => db;

  function stubAdmin() {
    return { id: 1, username: 'admin', role: 'Admin', tenant_id: 0, org_id: null, mfa_verified: true };
  }

  return function authMiddleware(req, res, next) {
    // /api/health is exempt — orchestrator probes need no token.
    // /api/auth/login is exempt — the login flow is what mints
    // the token, so it must be callable without one.
    if (
      req.path === '/api/health' ||
      req.path === '/api/health/' ||
      req.path === '/api/auth/login' ||
      req.path === '/api/auth/login/'
    ) {
      req.user = { id: 0, role: 'Admin', tenant_id: 0, mfa_verified: true };
      return next();
    }

    if (authMode === 'stub') {
      req.user = stubAdmin();
      return next();
    }

    // real mode: require a valid session token.
    const auth = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'missing Authorization: Bearer <token> header',
      });
    }
    const token = match[1].trim();
    if (token.length < 8 || token.length > 256) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'token length is invalid',
      });
    }

    // Read the LIVE db (not the captured `db`) so the auth
    // middleware survives a live-swap from the backup/restore
    // route. If the swapped-in db has the session row, the
    // request goes through; if not, the auth fails normally.
    const liveDb = getDb();
    if (!liveDb) {
      return res.status(503).json({
        error: 'service_unavailable',
        message: 'db is initializing or has been closed',
      });
    }
    let row;
    try {
      row = liveDb
        .prepare(
          `SELECT s.id AS session_id, s.user_id, s.tenant_id, s.role_id,
                  s.permission_set_ids_json, s.effective_permissions_json,
                  s.expires_at, s.revoked_at,
                  u.username, u.email, u.role AS user_role,
                  u.org_id, u.mfa_required, u.mfa_verified
             FROM sbos_rbac_sessions s
JOIN users u ON u.id = s.user_id
             WHERE s.id = ?
               AND s.revoked_at IS NULL
               AND strftime('%s', s.expires_at) > strftime('%s', 'now')
             LIMIT 1`,
        )
        .get(token);
    } catch (_err) {
      return res.status(500).json({ error: 'internal_error', message: 'auth lookup failed' });
    }

    if (!row) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'session token is unknown, revoked, or expired',
      });
    }

    req.user = {
      id: Number(row.user_id),
      username: row.username,
      email: row.email,
      role: row.user_role || row.role_id,
      tenant_id: Number(row.tenant_id),
      org_id: row.org_id == null ? null : Number(row.org_id),
      mfa_required: !!row.mfa_required,
      mfa_verified: !!row.mfa_verified,
    };
    req.session = {
      id: row.session_id,
      role_id: row.role_id,
      permission_set_ids: safeJsonArray(row.permission_set_ids_json),
      effective_permissions: safeJsonArray(row.effective_permissions_json),
    };
    // Bump last_seen_at in the background (fire and forget).
    try {
      liveDb.prepare(
        `UPDATE sbos_rbac_sessions SET last_seen_at = datetime('now') WHERE id = ?`,
      ).run(row.session_id);
    } catch (_e) {
      // best-effort; don't fail the request on a write miss
    }
    return next();
  };
}

function safeJsonArray(s) {
  if (typeof s !== 'string' || s.length === 0) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
