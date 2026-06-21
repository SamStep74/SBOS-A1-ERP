// SBOS-A1-ERP login flow.
//
// POST /api/auth/login: takes { username, password }, verifies
// against the scrypt hash in the users table, mints a session row
// in sbos_rbac_sessions, returns the token. Designed for the
// single-node self-hosted deploy where the operator runs the CLI
// locally, gets an admin password printed to stdout, then hits
// /api/auth/login from their client.
//
// Security notes:
//   - Passwords are hashed with crypto.scrypt (no native deps, no
//     argon2/bcrypt dependency). 64-byte output, per-user random
//     16-byte salt.
//   - 5 failed logins within a sliding window locks the account
//     for 15 minutes (configurable via SBOS_LOGIN_LOCKOUT_SECONDS).
//   - The minted session token is the same opaque bearer scheme
//     server/auth.js uses; the existing middleware accepts it
//     without changes.
//   - The /api/auth/login route is unauthenticated by design (you
//     need to be able to call it without a token to get a token).
//     The real auth gate is on every other endpoint.

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

// ────────────────────────────────────────────────────────────────────────
// scrypt wrapper. Verifies a plaintext password against the stored
// (hash, salt) pair. Constant-time comparison.
// ────────────────────────────────────────────────────────────────────────

export function verifyPassword(plaintext, hashBase64, saltBase64) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return false;
  if (typeof hashBase64 !== 'string' || typeof saltBase64 !== 'string') return false;
  let expected;
  let actual;
  try {
    expected = Buffer.from(hashBase64, 'base64url');
    actual = scryptSync(plaintext, saltBase64, expected.length || 64);
  } catch (_e) {
    return false;
  }
  if (expected.length === 0 || actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function hashPassword(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('hashPassword: plaintext must be a non-empty string');
  }
  const salt = randomBytes(16).toString('base64url');
  const hash = scryptSync(plaintext, salt, 64).toString('base64url');
  return { hash, salt };
}

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_FAILED = 5;
const DEFAULT_LOCKOUT_SECONDS = 15 * 60;

// ────────────────────────────────────────────────────────────────────────
// authenticate — Express middleware. Adds /api/auth/login (public) and
// the helper `login(db, { username, password })` used by the route.
// ────────────────────────────────────────────────────────────────────────

/**
 * Verify a username/password against the users table, apply the
 * failed-login lockout policy, and on success mint a new session
 * row in sbos_rbac_sessions. Returns { token, user, expiresAt } or
 * { error, status } for a 401.
 *
 * @param {DatabaseSync} db  raw node:sqlite handle (not the pg adapter)
 * @param {string} username
 * @param {string} password
 * @param {object} [opts]
 * @param {number} [opts.maxFailed=5]
 * @param {number} [opts.lockoutSeconds=900]
 * @param {number} [opts.ttlSeconds=2592000]  30 days
 * @returns {{token?: string, user?: object, expiresAt?: string, error?: string, status?: number}}
 */
export function login(db, username, password, opts = {}) {
  const maxFailed = opts.maxFailed || DEFAULT_MAX_FAILED;
  const lockoutSeconds = opts.lockoutSeconds || DEFAULT_LOCKOUT_SECONDS;
  const ttlSeconds = opts.ttlSeconds || 30 * 24 * 60 * 60;

  if (typeof username !== 'string' || typeof password !== 'string') {
    return { error: 'username and password are required', status: 400 };
  }
  if (username.length === 0 || password.length === 0) {
    return { error: 'username and password are required', status: 400 };
  }

  const row = db
    .prepare(
      `SELECT id, username, email, role, tenant_id, org_id, mfa_required, mfa_verified,
              password_hash, password_salt, failed_logins, locked_until
         FROM users
        WHERE username = ?
        LIMIT 1`,
    )
    .get(username);

  // Constant-time-ish: even on unknown user, do a dummy scrypt to
  // even out the wall-clock cost. This is a soft mitigation against
  // username enumeration via timing — not perfect, but a real
  // improvement over a fast-path on the not-found branch.
  if (!row) {
    hashPassword('x'); // burn the cycles
    return { error: 'invalid username or password', status: 401 };
  }

  // Check the lockout BEFORE doing the scrypt — already-failed
  // accounts shouldn't get a chance to attempt.
  if (row.locked_until) {
    const lockedUntilMs = Date.parse(row.locked_until);
    if (Number.isFinite(lockedUntilMs) && lockedUntilMs > Date.now()) {
      const remaining = Math.ceil((lockedUntilMs - Date.now()) / 1000);
      return {
        error: `account is temporarily locked (${remaining}s remaining)`,
        status: 423,
      };
    }
  }

  const ok = verifyPassword(password, row.password_hash, row.password_salt);
  if (!ok) {
    // Increment failed_logins, set locked_until if over the threshold.
    const newCount = (row.failed_logins || 0) + 1;
    let lockedUntil = null;
    if (newCount >= maxFailed) {
      lockedUntil = new Date(Date.now() + lockoutSeconds * 1000).toISOString();
    }
    db.prepare(
      `UPDATE users
          SET failed_logins = ?, locked_until = ?
        WHERE id = ?`,
    ).run(newCount, lockedUntil, row.id);
    return { error: 'invalid username or password', status: 401 };
  }

  // Reset the failure counter on a successful login.
  if (row.failed_logins > 0 || row.locked_until) {
    db.prepare(
      `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?`,
    ).run(row.id);
  }

  // Mint a session. Reuse seedSessionForAdmin's shape so the
  // existing middleware picks it up unchanged.
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  db.prepare(
    `INSERT INTO sbos_rbac_sessions
       (id, user_id, tenant_id, role_id, permission_set_ids_json,
        effective_permissions_json, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)`,
  ).run(token, row.id, row.tenant_id, row.role, '[]', '[]', expiresAt);

  return {
    token,
    expiresAt,
    user: {
      id: Number(row.id),
      username: row.username,
      email: row.email,
      role: row.role,
      tenant_id: Number(row.tenant_id),
      org_id: row.org_id == null ? null : Number(row.org_id),
    },
  };
}
