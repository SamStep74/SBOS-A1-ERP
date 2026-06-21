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
} from './auth-sessions.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT,
      tenant_id INTEGER NOT NULL DEFAULT 0
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