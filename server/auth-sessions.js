// server/auth-sessions.js
//
// User-facing session management helpers (Wave 42).
//
// The /api/rbac/sessions endpoints in server/rbac/routes.js are the
// admin / auditor view: list ALL sessions in a tenant, revoke ANY
// session. They're behind `security.session.list` /
// `security.session.revoke` perm gates.
//
// This module is the user-facing view: a logged-in user can list
// THEIR OWN active sessions, revoke one of THEIR OWN sessions
// (e.g. "log me out of my old phone"), and revoke all of THEIR
// OWN sessions ("logout-everywhere", for when you suspect your
// account was compromised).
//
// The scope check is the critical security property: every helper
// here takes user_id and verifies the session row's user_id matches.
// Cross-user operations are rejected at the SQL boundary, not just
// at the route layer.

/**
 * List the active sessions for a specific user. "Active" = revoked_at
 * is NULL AND expires_at > now. Ordered most-recently-seen first so
 * the user's current device is at the top of the list.
 *
 * Sensitive fields (id, ip, user_agent) are returned so the UI can
 * render "Chrome on macOS, last seen 2h ago" — useful for spotting
 * unfamiliar devices. The full token is NOT returned (we already have
 * it; storing it would be a session-leak vector).
 *
 * @param {object} db  raw node:sqlite handle
 * @param {number} userId
 * @returns {Array<{
 *   id: string, user_id: number, tenant_id: number, role_id: string,
 *   created_at: string, last_seen_at: string, expires_at: string,
 *   ip: string|null, user_agent: string|null, mfa_verified_at: string|null,
 *   is_current: boolean
 * }>}
 */
export function listMySessions(db, userId) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('userId must be a positive integer');
  }
  // IMPORTANT: use strftime('%s', ...) on BOTH sides of the
  // comparison. ISO 8601 timestamps (e.g. '2026-06-21T19:28:06Z')
  // compare lexically against datetime('now') (= '2026-06-21 20:28:06')
  // in a buggy way — 'T' (ASCII 84) is > ' ' (ASCII 32), so an
  // expired same-day session can incorrectly appear "in the future"
  // of datetime('now'). Unix-timestamp comparison via strftime is
  // the safe path. CAST AS INTEGER forces numeric comparison
  // (SQLite's type affinity gives surprising results with mixed
  // TEXT/int otherwise — see pruneExpiredSessions for the same fix).
  const rows = db
    .prepare(
      `SELECT id, user_id, tenant_id, role_id, created_at, last_seen_at,
              expires_at, ip, user_agent, mfa_verified_at
         FROM sbos_rbac_sessions
        WHERE user_id = ?
          AND revoked_at IS NULL
          AND CAST(strftime('%s', expires_at) AS INTEGER) > CAST(strftime('%s', 'now') AS INTEGER)
        ORDER BY last_seen_at DESC`,
    )
    .all(userId);
  return (rows || []).map((r) => ({
    id: r.id,
    user_id: Number(r.user_id),
    tenant_id: Number(r.tenant_id),
    role_id: r.role_id,
    created_at: r.created_at,
    last_seen_at: r.last_seen_at,
    expires_at: r.expires_at,
    ip: r.ip || null,
    user_agent: r.user_agent || null,
    mfa_verified_at: r.mfa_verified_at || null,
  }));
}

/**
 * Revoke a specific session. Scope-checked: the caller must own the
 * session (session.user_id === userId). Returns true if the session
 * was found and revoked; false if the session doesn't exist or
 * doesn't belong to this user (no information leak).
 *
 * Already-revoked sessions are NOT re-revoked (we don't bump the
 * revoked_at timestamp — that's the audit signal for when the
 * session first became invalid).
 *
 * @param {object} db
 * @param {number} userId   the user attempting the revoke
 * @param {string} sessionId  the session to revoke
 * @returns {boolean}  true if revoked, false if not found / not yours
 */
export function revokeMySession(db, userId, sessionId) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('userId must be a positive integer');
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('sessionId must be a non-empty string');
  }
  const result = db
    .prepare(
      `UPDATE sbos_rbac_sessions
          SET revoked_at = datetime('now')
        WHERE id = ? AND user_id = ?
          AND revoked_at IS NULL`,
    )
    .run(sessionId, userId);
  return result.changes > 0;
}

/**
 * Revoke all active sessions for a user. Used for the
 * "logout-everywhere" flow (account compromise, lost device, etc).
 *
 * Optionally excludes the current session from the cascade — useful
 * for the "revoke all OTHER sessions but keep me logged in here" UX.
 * For the all-including-current case (full logout-everywhere), pass
 * {excludeCurrentSessionId: null} or omit the field.
 *
 * Returns the number of sessions revoked.
 *
 * @param {object} db
 * @param {number} userId
 * @param {object} [opts]
 * @param {string|null} [opts.excludeCurrentSessionId]  if set, this
 *   session is NOT revoked (the caller's own session, kept alive
 *   so they don't get logged out mid-request)
 * @returns {number}  the number of sessions revoked
 */
export function revokeAllMySessions(db, userId, opts = {}) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('userId must be a positive integer');
  }
  const exclude = opts.excludeCurrentSessionId;
  if (exclude != null && typeof exclude !== 'string') {
    throw new Error('opts.excludeCurrentSessionId must be a string or null');
  }
  let sql, params;
  if (exclude != null) {
    sql = `UPDATE sbos_rbac_sessions
              SET revoked_at = datetime('now')
            WHERE user_id = ?
              AND id != ?
              AND revoked_at IS NULL`;
    params = [userId, exclude];
  } else {
    sql = `UPDATE sbos_rbac_sessions
              SET revoked_at = datetime('now')
            WHERE user_id = ?
              AND revoked_at IS NULL`;
    params = [userId];
  }
  const result = db.prepare(sql).run(...params);
  return result.changes;
}

/**
 * Boot-time janitor. Marks expired-but-not-yet-revoked sessions as
 * revoked (so they don't pollute the active-sessions list) and
 * optionally deletes very-old revoked sessions to keep the table
 * small.
 *
 * Idempotent + safe to run on every boot. The append-only audit
 * story means we DON'T delete active sessions — we just mark them
 * revoked, preserving the audit trail of when the session expired.
 *
 * For revoked sessions, we can be more aggressive: a session that
 * was revoked N days ago has served its audit purpose and can be
 * deleted to keep the table small. Defaults to N=90 days.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.deleteRevokedAfterDays=90]  prune revoked
 *   sessions older than this. Set to 0 to skip the delete pass
 *   (keep all revoked sessions for forensic purposes).
 * @returns {{ expired_revoked: number, deleted: number }}
 */
export function pruneExpiredSessions(db, opts = {}) {
  const deleteAfterDays = opts.deleteRevokedAfterDays != null
    ? Number(opts.deleteRevokedAfterDays)
    : 90;
  // Pass 1: mark expired-but-active sessions as revoked. Same
  // strftime('%s', ...) trick as listMySessions — see comment there.
  // CAST AS INTEGER forces both sides to numeric comparison (SQLite's
  // type affinity gives surprising results with mixed TEXT/int).
  const expireResult = db
    .prepare(
      `UPDATE sbos_rbac_sessions
          SET revoked_at = datetime('now')
        WHERE revoked_at IS NULL
          AND CAST(strftime('%s', expires_at) AS INTEGER) <= CAST(strftime('%s', 'now') AS INTEGER)`,
    )
    .run();
  let deleted = 0;
  // Pass 2: delete very-old revoked sessions (best-effort cleanup).
  // CAST the strftime result so the comparison is integer-integer
  // (no affinity-driven surprises).
  if (deleteAfterDays > 0) {
    const cutoffSeconds = Math.floor((Date.now() - deleteAfterDays * 24 * 60 * 60 * 1000) / 1000);
    const deleteResult = db
      .prepare(
        `DELETE FROM sbos_rbac_sessions
          WHERE revoked_at IS NOT NULL
            AND CAST(strftime('%s', revoked_at) AS INTEGER) < ?`,
      )
      .run(cutoffSeconds);
    deleted = deleteResult.changes;
  }
  return { expired_revoked: expireResult.changes, deleted };
}