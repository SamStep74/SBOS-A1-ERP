// server/auth-sessions.test.js
//
// Tests for the user-facing session management helpers (Wave 42).
// Uses an in-memory sqlite db + a minimal users / sbos_rbac_sessions
// schema mirror. Verifies the scope checks (cross-user operations
// are blocked at the SQL boundary).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  listMySessions,
  revokeMySession,
  revokeAllMySessions,
  pruneExpiredSessions,
  recordSessionEvent,
  listSessionEvents,
  listUserSessionEvents,
  listApproachingLockout,
  bulkUnlockAll,
} from './auth-sessions.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT,
      role TEXT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      org_id INTEGER,
      failed_logins INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      last_failed_at TEXT
    );
    CREATE TABLE sbos_rbac_sessions (
      id              TEXT PRIMARY KEY,
      user_id         INTEGER NOT NULL,
      tenant_id       INTEGER NOT NULL,
      role_id         TEXT NOT NULL,
      permission_set_ids_json TEXT NOT NULL DEFAULT '[]',
      effective_permissions_json TEXT NOT NULL DEFAULT '[]',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at      TEXT NOT NULL,
      ip              TEXT,
      user_agent      TEXT,
      mfa_verified_at TEXT,
      revoked_at      TEXT
    );
    CREATE TABLE sbos_session_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL,
      user_id         INTEGER NOT NULL,
      tenant_id       INTEGER NOT NULL DEFAULT 0,
      event_type      TEXT NOT NULL,
      ip              TEXT,
      user_agent      TEXT,
      payload_json    TEXT NOT NULL DEFAULT '{}',
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Seed two users (so we can verify cross-user isolation).
  db.prepare('INSERT INTO users (id, username, role, tenant_id) VALUES (?, ?, ?, ?)').run(1, 'alice', 'Admin', 0);
  db.prepare('INSERT INTO users (id, username, role, tenant_id) VALUES (?, ?, ?, ?)').run(2, 'bob', 'Operator', 0);
  return db;
}

// Helper: insert a session row.
function seedSession(db, { id, userId, expiresAt, revokedAt = null }) {
  db.prepare(
    `INSERT INTO sbos_rbac_sessions (id, user_id, tenant_id, role_id, expires_at, revoked_at)
     VALUES (?, ?, 0, 'Admin', ?, ?)`,
  ).run(id, userId, expiresAt, revokedAt);
}

test('listMySessions: returns the user\'s active sessions, ordered by last_seen_at DESC', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  seedSession(db, { id: 'sess-old', userId: 1, expiresAt: future });
  // Update last_seen_at on 'sess-old' to be older than 'sess-new'.
  db.prepare(`UPDATE sbos_rbac_sessions SET last_seen_at = '2026-06-01T10:00:00Z' WHERE id = ?`).run('sess-old');
  seedSession(db, { id: 'sess-new', userId: 1, expiresAt: future });
  db.prepare(`UPDATE sbos_rbac_sessions SET last_seen_at = '2026-06-21T10:00:00Z' WHERE id = ?`).run('sess-new');
  const sessions = listMySessions(db, 1);
  assert.equal(sessions.length, 2);
  // Newest first.
  assert.equal(sessions[0].id, 'sess-new');
  assert.equal(sessions[1].id, 'sess-old');
});

test('listMySessions: filters out revoked + expired sessions', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  seedSession(db, { id: 'sess-active', userId: 1, expiresAt: future });
  seedSession(db, { id: 'sess-revoked', userId: 1, expiresAt: future, revokedAt: '2026-06-21T00:00:00Z' });
  seedSession(db, { id: 'sess-expired', userId: 1, expiresAt: past });
  const sessions = listMySessions(db, 1);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'sess-active');
});

test('listMySessions: tenant-isolated via user_id (bob does not see alice\'s sessions)', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  seedSession(db, { id: 'sess-alice', userId: 1, expiresAt: future });
  seedSession(db, { id: 'sess-bob', userId: 2, expiresAt: future });
  const aliceSessions = listMySessions(db, 1);
  const bobSessions = listMySessions(db, 2);
  assert.equal(aliceSessions.length, 1);
  assert.equal(aliceSessions[0].id, 'sess-alice');
  assert.equal(bobSessions.length, 1);
  assert.equal(bobSessions[0].id, 'sess-bob');
});

test('revokeMySession: revokes the user\'s own session (returns true)', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  seedSession(db, { id: 'sess-1', userId: 1, expiresAt: future });
  const ok = revokeMySession(db, 1, 'sess-1');
  assert.equal(ok, true);
  // Verify the row is marked revoked.
  const row = db.prepare('SELECT revoked_at FROM sbos_rbac_sessions WHERE id = ?').get('sess-1');
  assert.ok(row.revoked_at, 'session should be marked revoked');
});

test('revokeMySession: cannot revoke another user\'s session (returns false, no row change)', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  seedSession(db, { id: 'sess-alice', userId: 1, expiresAt: future });
  // bob tries to revoke alice's session.
  const ok = revokeMySession(db, 2, 'sess-alice');
  assert.equal(ok, false);
  // The row must NOT be revoked.
  const row = db.prepare('SELECT revoked_at FROM sbos_rbac_sessions WHERE id = ?').get('sess-alice');
  assert.equal(row.revoked_at, null);
});

test('revokeMySession: already-revoked session returns false (no double-revoke)', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  seedSession(db, { id: 'sess-1', userId: 1, expiresAt: future, revokedAt: '2026-06-21T00:00:00Z' });
  // First revoke: already-revoked → returns false.
  const ok = revokeMySession(db, 1, 'sess-1');
  assert.equal(ok, false);
});

test('revokeAllMySessions: revokes every active session for the user', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  seedSession(db, { id: 'sess-1', userId: 1, expiresAt: future });
  seedSession(db, { id: 'sess-2', userId: 1, expiresAt: future });
  seedSession(db, { id: 'sess-3', userId: 1, expiresAt: future });
  // Add an unrelated session for bob (must NOT be touched).
  seedSession(db, { id: 'sess-bob', userId: 2, expiresAt: future });
  const n = revokeAllMySessions(db, 1);
  assert.equal(n, 3);
  // Alice's 3 sessions are now revoked.
  const aliceSessions = listMySessions(db, 1);
  assert.equal(aliceSessions.length, 0);
  // Bob's session is untouched.
  const bobSessions = listMySessions(db, 2);
  assert.equal(bobSessions.length, 1);
});

test('revokeAllMySessions: {excludeCurrentSessionId} keeps the current session alive', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  seedSession(db, { id: 'sess-current', userId: 1, expiresAt: future });
  seedSession(db, { id: 'sess-old-phone', userId: 1, expiresAt: future });
  const n = revokeAllMySessions(db, 1, { excludeCurrentSessionId: 'sess-current' });
  assert.equal(n, 1); // only sess-old-phone was revoked
  // Current session is still alive.
  const sessions = listMySessions(db, 1);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'sess-current');
});

test('pruneExpiredSessions: marks expired-but-active sessions as revoked', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  seedSession(db, { id: 'sess-active', userId: 1, expiresAt: future });
  seedSession(db, { id: 'sess-expired', userId: 1, expiresAt: past });
  // Disable the delete pass to test just the expire pass.
  const out = pruneExpiredSessions(db, { deleteRevokedAfterDays: 0 });
  assert.equal(out.expired_revoked, 1);
  // The expired session is now marked revoked (not deleted).
  const row = db.prepare('SELECT revoked_at FROM sbos_rbac_sessions WHERE id = ?').get('sess-expired');
  assert.ok(row.revoked_at, 'expired session should be marked revoked');
  // The active session is untouched.
  const activeRow = db.prepare('SELECT revoked_at FROM sbos_rbac_sessions WHERE id = ?').get('sess-active');
  assert.equal(activeRow.revoked_at, null);
});

test('pruneExpiredSessions: deletes revoked sessions older than the threshold', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  seedSession(db, { id: 'sess-active', userId: 1, expiresAt: future });
  // Insert a revoked session that was revoked 100 days ago.
  const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
  seedSession(db, { id: 'sess-old-revoked', userId: 1, expiresAt: future, revokedAt: longAgo });
  const out = pruneExpiredSessions(db, { deleteRevokedAfterDays: 90 });
  assert.equal(out.deleted, 1);
  // The old revoked session is gone.
  const deleted = db.prepare('SELECT id FROM sbos_rbac_sessions WHERE id = ?').get('sess-old-revoked');
  assert.equal(deleted, undefined);
  // The active session is untouched.
  const active = db.prepare('SELECT id FROM sbos_rbac_sessions WHERE id = ?').get('sess-active');
  assert.ok(active);
});

test('pruneExpiredSessions: is idempotent — second call is a no-op', () => {
  const db = makeDb();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  seedSession(db, { id: 'sess-expired', userId: 1, expiresAt: past });
  const first = pruneExpiredSessions(db, { deleteRevokedAfterDays: 0 });
  assert.equal(first.expired_revoked, 1);
  // Second pass: nothing left to expire.
  const second = pruneExpiredSessions(db, { deleteRevokedAfterDays: 0 });
  assert.equal(second.expired_revoked, 0);
});

// ─── Wave 55: session activity log ───

test('recordSessionEvent: writes a row to sbos_session_events', () => {
  const db = makeDb();
  const id = recordSessionEvent(db, {
    sessionId: 'sess-1',
    userId: 1,
    tenantId: 0,
    eventType: 'login',
    ip: '10.0.0.1',
    userAgent: 'jest',
    payload: { method: 'password' },
  });
  assert.ok(id && id > 0, 'recordSessionEvent must return the new row id');
  const row = db
    .prepare('SELECT * FROM sbos_session_events WHERE id = ?')
    .get(id);
  assert.equal(row.session_id, 'sess-1');
  assert.equal(row.event_type, 'login');
  assert.equal(row.ip, '10.0.0.1');
  assert.equal(row.user_agent, 'jest');
  // The payload round-trips as JSON.
  const payload = JSON.parse(row.payload_json);
  assert.deepEqual(payload, { method: 'password' });
});

test('recordSessionEvent: missing required fields throws', () => {
  const db = makeDb();
  assert.throws(
    () => recordSessionEvent(db, { sessionId: 's' }),
    /requires sessionId, userId, eventType/,
  );
  assert.throws(
    () => recordSessionEvent(db, { userId: 1, eventType: 'login' }),
    /requires sessionId, userId, eventType/,
  );
  assert.throws(
    () => recordSessionEvent(db, { sessionId: 's', userId: 1 }),
    /requires sessionId, userId, eventType/,
  );
});

test('listSessionEvents: returns events for a session, most-recent first', () => {
  const db = makeDb();
  recordSessionEvent(db, {
    sessionId: 'sess-A',
    userId: 1,
    eventType: 'login',
    ip: '10.0.0.1',
  });
  recordSessionEvent(db, {
    sessionId: 'sess-A',
    userId: 1,
    eventType: 'revoked',
    payload: { source: 'admin' },
  });
  recordSessionEvent(db, {
    sessionId: 'sess-B', // different session — should NOT appear
    userId: 1,
    eventType: 'login',
  });
  const events = listSessionEvents(db, 'sess-A');
  assert.equal(events.length, 2);
  // Most-recent first: the 'revoked' was inserted second.
  assert.equal(events[0].event_type, 'revoked');
  assert.equal(events[1].event_type, 'login');
  assert.equal(events[0].session_id, 'sess-A');
  // Payload parses back.
  assert.deepEqual(events[0].payload, { source: 'admin' });
  // No 'sess-B' events leaked in.
  for (const e of events) {
    assert.equal(e.session_id, 'sess-A');
  }
});

test('listSessionEvents: empty result for an unknown session', () => {
  const db = makeDb();
  recordSessionEvent(db, { sessionId: 'sess-A', userId: 1, eventType: 'login' });
  const events = listSessionEvents(db, 'sess-DOES-NOT-EXIST');
  assert.equal(events.length, 0);
});

test('listUserSessionEvents: aggregates events across all the user\'s sessions', () => {
  const db = makeDb();
  // 2 sessions for user 1
  recordSessionEvent(db, { sessionId: 'sess-A', userId: 1, eventType: 'login', ip: '1.1.1.1' });
  recordSessionEvent(db, { sessionId: 'sess-B', userId: 1, eventType: 'login', ip: '2.2.2.2' });
  // 1 session for user 2 — should NOT appear
  recordSessionEvent(db, { sessionId: 'sess-C', userId: 2, eventType: 'login' });
  const events = listUserSessionEvents(db, 1);
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.user_id, 1);
  }
  const ips = events.map((e) => e.ip).sort();
  assert.deepEqual(ips, ['1.1.1.1', '2.2.2.2']);
});

// ─── Wave 59: lockout observability + bulk unlock ───

function seedUser(db, { id, username, role = 'Admin', tenant_id = 0, failed_logins = 0, locked_until = null }) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  db.prepare(
    `INSERT INTO users (id, username, role, tenant_id, failed_logins, locked_until)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, username, role, tenant_id, failed_logins, locked_until);
}

test('listApproachingLockout: returns users with failed_logins >= threshold', () => {
  const db = makeDb();
  // 0 fails — not at risk
  seedUser(db, { id: 1, username: 'safe', failed_logins: 0 });
  // 1 fail — not at risk (default threshold 3)
  seedUser(db, { id: 2, username: 'low', failed_logins: 1 });
  // 3 fails — at risk
  seedUser(db, { id: 3, username: 'risky', failed_logins: 3 });
  // 5 fails — definitely at risk
  seedUser(db, { id: 4, username: 'very-risky', failed_logins: 5 });
  const items = listApproachingLockout(db);
  assert.equal(items.length, 2);
  // Sorted by failed_logins DESC.
  assert.equal(items[0].username, 'very-risky');
  assert.equal(items[1].username, 'risky');
});

test('listApproachingLockout: also includes currently-locked users', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  seedUser(db, { id: 1, username: 'safe', failed_logins: 0 });
  seedUser(db, { id: 2, username: 'locked', failed_logins: 0, locked_until: future });
  const items = listApproachingLockout(db);
  assert.equal(items.length, 1);
  assert.equal(items[0].username, 'locked');
  assert.equal(items[0].is_currently_locked, true);
});

test('listApproachingLockout: respects the threshold override', () => {
  const db = makeDb();
  seedUser(db, { id: 1, username: 'risky', failed_logins: 2 });
  // Default threshold is 3 — 2 fails is not at risk.
  assert.equal(listApproachingLockout(db).length, 0);
  // Lower threshold to 2 — now at risk.
  assert.equal(listApproachingLockout(db, { threshold: 2 }).length, 1);
});

test('listApproachingLockout: does not include expired-locked users', () => {
  const db = makeDb();
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  seedUser(db, { id: 1, username: 'expired', failed_logins: 0, locked_until: past });
  // The user is "locked" per the DB but the lock has expired.
  // Should NOT appear in the at-risk list (the lock is
  // effectively gone).
  assert.equal(listApproachingLockout(db).length, 0);
});

test('bulkUnlockAll: resets failed_logins + locked_until across all tenants', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  seedUser(db, { id: 1, username: 'a', failed_logins: 5, locked_until: future });
  seedUser(db, { id: 2, username: 'b', failed_logins: 0, locked_until: future });
  seedUser(db, { id: 3, username: 'c', failed_logins: 0, locked_until: null });
  // Users with no failed_logins and no locked_until should
  // not be touched. The UPDATE only fires when one of the
  // conditions is met.
  const count = bulkUnlockAll(db);
  assert.ok(count >= 2, `expected >= 2 unlocked, got ${count}`);
  // Verify the state.
  const a = db.prepare('SELECT failed_logins, locked_until FROM users WHERE id = 1').get();
  const b = db.prepare('SELECT failed_logins, locked_until FROM users WHERE id = 2').get();
  assert.equal(a.failed_logins, 0);
  assert.equal(a.locked_until, null);
  assert.equal(b.failed_logins, 0);
  assert.equal(b.locked_until, null);
});

test('bulkUnlockAll: tenant filter restricts the scope', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  seedUser(db, { id: 1, username: 'a', tenant_id: 0, failed_logins: 5, locked_until: future });
  seedUser(db, { id: 2, username: 'b', tenant_id: 7, failed_logins: 5, locked_until: future });
  const count = bulkUnlockAll(db, { tenantId: 0 });
  assert.equal(count, 1);
  const a = db.prepare('SELECT failed_logins FROM users WHERE id = 1').get();
  const b = db.prepare('SELECT failed_logins FROM users WHERE id = 2').get();
  assert.equal(a.failed_logins, 0, 'tenant 0 should be unlocked');
  assert.equal(b.failed_logins, 5, 'tenant 7 should be untouched');
});

test('bulkUnlockAll: returns 0 when no users are locked', () => {
  const db = makeDb();
  seedUser(db, { id: 1, username: 'safe', failed_logins: 0 });
  assert.equal(bulkUnlockAll(db), 0);
});