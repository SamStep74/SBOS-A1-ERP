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
import { recordSessionEvent } from './auth-sessions.js';

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

// Minimum acceptable password length. Enforced at changePassword()
// time so callers can't set a 1-char password.
const MIN_PASSWORD_LENGTH = 8;

/**
 * Change a user's password (self-service rotation). Verifies the
 * old password (constant-time via verifyPassword), enforces the
 * minimum length on the new password, then writes the new scrypt
 * hash + salt. Resets failed_logins + locked_until as a side-effect
 * (password rotation should also clear any active lockout — the
 * user clearly knows the old password).
 *
 * Side-effects on success:
 *   - users.password_hash + password_salt are updated
 *   - users.failed_logins reset to 0
 *   - users.locked_until cleared (NULL)
 *
 * Does NOT invalidate active sessions — the user kept their old
 * password knowledge, so any device they were logged in on is
 * still legitimately them. If the rotation was forced by a
 * compromise, the caller should pair this with a revoke-all
 * (POST /api/auth/sessions/revoke-all).
 *
 * @param {DatabaseSync} db  raw node:sqlite handle
 * @param {number} userId
 * @param {string} oldPassword
 * @param {string} newPassword
 * @returns {{ok: true} | {error: string}}
 */
export function changePassword(db, userId, oldPassword, newPassword) {
  // Wave 57: accept either a captured handle (legacy) or a
  // { current: handle } ref (live-swap-safe). Same duck-type
  // pattern as login() — see there.
  const isRef = db && typeof db.prepare !== 'function';
  const getDb = isRef
    ? () => {
        const cur = db.current;
        if (!cur) {
          throw new Error('changePassword: db is not open (mid-swap)');
        }
        return cur;
      }
    : () => db;
  if (!Number.isInteger(userId) || userId <= 0) {
    return { error: 'userId must be a positive integer' };
  }
  if (typeof oldPassword !== 'string' || oldPassword.length === 0) {
    return { error: 'oldPassword is required' };
  }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} chars` };
  }
  if (oldPassword === newPassword) {
    return { error: 'newPassword must be different from oldPassword' };
  }
  const row = getDb()
    .prepare(
      `SELECT id, password_hash, password_salt, locked_until
         FROM users WHERE id = ?`,
    )
    .get(userId);
  if (!row) {
    return { error: 'user not found' };
  }
  // Reject if the account is currently locked — the rotation would
  // be a side-channel for an attacker to test passwords against a
  // locked account (lockout evasion).
  if (row.locked_until && Date.parse(row.locked_until) > Date.now()) {
    return { error: 'account is temporarily locked; try again later' };
  }
  const ok = verifyPassword(oldPassword, row.password_hash, row.password_salt);
  if (!ok) {
    return { error: 'old password is incorrect' };
  }
  const { hash, salt } = hashPassword(newPassword);
  getDb().prepare(
    `UPDATE users
        SET password_hash = ?,
            password_salt = ?,
            failed_logins = 0,
            locked_until = NULL
      WHERE id = ?`,
  ).run(hash, salt, userId);
  return { ok: true };
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
  // Wave 57: accept either a captured `DatabaseSync` handle
  // (legacy) or a `{ current: handle }` ref (live-swap-safe).
  // Duck-type: if the arg has a `prepare` method, treat it
  // as a handle; otherwise dereference `.current`.
  const isRef = db && typeof db.prepare !== 'function';
  const getDb = isRef
    ? () => {
        const cur = db.current;
        if (!cur) {
          throw new Error('login: db is not open (mid-swap or not initialized)');
        }
        return cur;
      }
    : () => db;
  const maxFailed = opts.maxFailed || DEFAULT_MAX_FAILED;
  const lockoutSeconds = opts.lockoutSeconds || DEFAULT_LOCKOUT_SECONDS;
  const ttlSeconds = opts.ttlSeconds || 30 * 24 * 60 * 60;

  if (typeof username !== 'string' || typeof password !== 'string') {
    return { error: 'username and password are required', status: 400 };
  }
  if (username.length === 0 || password.length === 0) {
    return { error: 'username and password are required', status: 400 };
  }

  const row = getDb()
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
    // W73: also stamp last_failed_at so the periodic purge
    // can decide whether the counter is "stale" (>24h old).
    // UTC 'YYYY-MM-DD HH:MM:SS' format, matching the
    // threshold format in clearStaleFailedLogins.
    const lastFailedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    getDb().prepare(
      `UPDATE users
          SET failed_logins = ?, locked_until = ?, last_failed_at = ?
        WHERE id = ?`,
    ).run(newCount, lockedUntil, lastFailedAt, row.id);
    return { error: 'invalid username or password', status: 401 };
  }

  // Reset the failure counter on a successful login.
  if (row.failed_logins > 0 || row.locked_until) {
    getDb().prepare(
      `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?`,
    ).run(row.id);
  }

  // Mint a session. Reuse seedSessionForAdmin's shape so the
  // existing middleware picks it up unchanged.
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  getDb().prepare(
    `INSERT INTO sbos_rbac_sessions
       (id, user_id, tenant_id, role_id, permission_set_ids_json,
        effective_permissions_json, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?)`,
  ).run(
    token,
    row.id,
    row.tenant_id,
    row.role,
    '[]',
    '[]',
    expiresAt,
    opts.ip || null,
    opts.userAgent || null,
  );

  // Wave 55: record the login event in the activity log. The
  // event row is informational; a failure here must NOT fail
  // the login (the user has authenticated successfully and
  // shouldn't be punished for a log-write error).
  try {
    recordSessionEvent(db, {
      sessionId: token,
      userId: row.id,
      tenantId: row.tenant_id,
      eventType: 'login',
      ip: opts.ip || null,
      userAgent: opts.userAgent || null,
      payload: { method: 'password' },
    });
  } catch (_e) {
    // best-effort; don't fail login
  }

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
