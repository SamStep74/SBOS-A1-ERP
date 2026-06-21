// Auth login flow — scrypt hash + session mint + failed-login lockout.
//
// The test uses a fresh in-memory sqlite db to exercise the
// auth-login module directly (no HTTP layer). The HTTP path
// (`POST /api/auth/login`) is exercised by the integration
// tests in server.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { login, verifyPassword, hashPassword } from './auth-login.js';

// ────────────────────────────────────────────────────────────────────────
// Test harness: minimal in-memory sqlite with the bare-minimum
// tables that login() touches (users + sbos_rbac_sessions). Mirrors
// the production boot's CREATE TABLE shape (minus the columns the
// login path doesn't read).
// ────────────────────────────────────────────────────────────────────────

function makeAuthDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT,
      role TEXT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      org_id INTEGER,
      mfa_required INTEGER NOT NULL DEFAULT 0,
      mfa_verified INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT,
      password_salt TEXT,
      failed_logins INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT
    );
    CREATE TABLE sbos_rbac_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      role_id TEXT NOT NULL,
      permission_set_ids_json TEXT NOT NULL,
      effective_permissions_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    );
  `);
  return db;
}

function seedUser(db, { username, password, role = 'Admin', tenant_id = 0, id = 1 }) {
  const { hash, salt } = hashPassword(password);
  db.prepare(
    `INSERT INTO users (id, username, email, role, tenant_id, password_hash, password_salt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, username, `${username}@example.com`, role, tenant_id, hash, salt);
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

test('login: valid credentials mint a session row and return a token', () => {
  const db = makeAuthDb();
  seedUser(db, { username: 'admin', password: 's3cret!' });
  const result = login(db, 'admin', 's3cret!');
  assert.equal(result.error, undefined);
  assert.equal(typeof result.token, 'string');
  assert.ok(result.token.length >= 16, 'token should be at least 16 chars');
  assert.equal(result.user.username, 'admin');
  // Session row exists in the db.
  const row = db.prepare('SELECT id, user_id, role_id, expires_at FROM sbos_rbac_sessions WHERE id = ?').get(result.token);
  assert.ok(row, 'session row should exist');
  assert.equal(row.user_id, 1);
  assert.equal(row.role_id, 'Admin');
});

test('login: wrong password returns 401 and increments failed_logins', () => {
  const db = makeAuthDb();
  seedUser(db, { username: 'admin', password: 'right' });
  const result = login(db, 'admin', 'wrong');
  assert.equal(result.status, 401);
  assert.equal(result.error, 'invalid username or password');
  const user = db.prepare('SELECT failed_logins FROM users WHERE username = ?').get('admin');
  assert.equal(user.failed_logins, 1);
});

test('login: unknown username returns 401 with the same message (no enumeration)', () => {
  const db = makeAuthDb();
  seedUser(db, { username: 'admin', password: 's3cret!' });
  const result = login(db, 'nobody', 'whatever');
  assert.equal(result.status, 401);
  assert.equal(result.error, 'invalid username or password');
});

test('login: 5 failed attempts lock the account for 15 minutes', () => {
  const db = makeAuthDb();
  seedUser(db, { username: 'admin', password: 'right' });
  for (let i = 0; i < 5; i++) {
    login(db, 'admin', 'wrong-' + i);
  }
  // 6th attempt — even with the right password — sees the lock.
  const result = login(db, 'admin', 'right');
  assert.equal(result.status, 423);
  assert.ok(/locked/i.test(result.error), `expected lock message, got: ${result.error}`);
});

test('login: missing username or password returns 400', () => {
  const db = makeAuthDb();
  seedUser(db, { username: 'admin', password: 's3cret!' });
  assert.equal(login(db, '', 's3cret!').status, 400);
  assert.equal(login(db, 'admin', '').status, 400);
  assert.equal(login(db, undefined, 's3cret!').status, 400);
});

test('verifyPassword: hashPassword + verifyPassword round-trip', () => {
  const { hash, salt } = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', hash, salt), true);
  assert.equal(verifyPassword('wrong', hash, salt), false);
  // Garbage inputs don't throw.
  assert.equal(verifyPassword('', hash, salt), false);
  assert.equal(verifyPassword('x', null, salt), false);
  assert.equal(verifyPassword('x', hash, null), false);
});

test('login: per-user salt means same password has different hash per user', () => {
  const db = makeAuthDb();
  seedUser(db, { username: 'a', password: 'same', id: 1 });
  seedUser(db, { username: 'b', password: 'same', id: 2 });
  const a = db.prepare('SELECT password_hash, password_salt FROM users WHERE username = ?').get('a');
  const b = db.prepare('SELECT password_hash, password_salt FROM users WHERE username = ?').get('b');
  assert.notEqual(a.password_hash, b.password_hash, 'hashes should differ due to per-user salt');
  assert.notEqual(a.password_salt, b.password_salt, 'salts should differ');
  // Both verify successfully with their own salt.
  assert.equal(verifyPassword('same', a.password_hash, a.password_salt), true);
  assert.equal(verifyPassword('same', b.password_hash, b.password_salt), true);
});
