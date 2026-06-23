// SBOS-A1-ERP lockout purge tests (Wave 73).
//
// IMPORTANT: all datetimes in this test are UTC. The
// function stores its threshold as a UTC string
// ('YYYY-MM-DD HH:MM:SS') to match SQLite's
// datetime('now') format, so the stored last_failed_at
// MUST also be a UTC string for the comparison to
// produce the right result. Local-time strings would
// silently produce wrong results.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { clearStaleFailedLogins } from './lockout-purge.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      failed_logins INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      last_failed_at TEXT
    );
  `);
  return db;
}

function insertUser(db, id, username, failed_logins, locked_until, last_failed_at) {
  db.prepare(
    `INSERT INTO users (id, username, failed_logins, locked_until, last_failed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, username, failed_logins, locked_until, last_failed_at);
}

// Reference "now" for these tests: 2026-06-23 07:00:00 UTC
// (= 11:00:00 Yerevan). The function uses this exact ms.
const NOW_MS = Date.UTC(2026, 5, 23, 7, 0, 0); // month is 0-indexed
const NOW_ISO = '2026-06-23 07:00:00';

test('73.1 purges users with stale last_failed_at (older than threshold)', () => {
  const db = makeDb();
  // 25 hours ago (UTC) — stale
  insertUser(db, 1, 'alice', 4, null, '2026-06-22 06:00:00');
  // 1 hour ago (UTC) — fresh (within 24h)
  insertUser(db, 2, 'bob', 4, null, '2026-06-23 06:00:00');
  // never failed
  insertUser(db, 3, 'carol', 0, null, null);
  const result = clearStaleFailedLogins(db, {
    staleAfterMs: 24 * 60 * 60 * 1000,
    now: () => NOW_MS,
  });
  assert.equal(result.cleared, 1);
  assert.equal(result.scanned, 2);
  assert.equal(result.dryRun, false);
  // Alice was cleared
  const alice = db.prepare('SELECT * FROM users WHERE id = 1').get();
  assert.equal(alice.failed_logins, 0);
  assert.equal(alice.locked_until, null);
  // Bob was NOT cleared
  const bob = db.prepare('SELECT * FROM users WHERE id = 2').get();
  assert.equal(bob.failed_logins, 4);
  // Carol was untouched
  const carol = db.prepare('SELECT * FROM users WHERE id = 3').get();
  assert.equal(carol.failed_logins, 0);
});

test('73.2 also clears locked_until for stale users', () => {
  const db = makeDb();
  // last_failed_at is 25h ago (one hour past the 24h threshold)
  // so the row is strictly stale.
  insertUser(db, 1, 'alice', 5, '2026-06-22 08:00:00', '2026-06-22 06:00:00');
  const result = clearStaleFailedLogins(db, {
    staleAfterMs: 24 * 60 * 60 * 1000,
    now: () => NOW_MS,
  });
  assert.equal(result.cleared, 1);
  const alice = db.prepare('SELECT * FROM users WHERE id = 1').get();
  assert.equal(alice.failed_logins, 0);
  assert.equal(alice.locked_until, null);
});

test('73.3 dry-run counts but does not write', () => {
  const db = makeDb();
  insertUser(db, 1, 'alice', 4, null, '2026-06-22 06:00:00');
  const result = clearStaleFailedLogins(db, {
    staleAfterMs: 24 * 60 * 60 * 1000,
    now: () => NOW_MS,
    dryRun: true,
  });
  assert.equal(result.cleared, 0);
  assert.equal(result.scanned, 1);
  assert.equal(result.dryRun, true);
  // Alice was NOT touched
  const alice = db.prepare('SELECT * FROM users WHERE id = 1').get();
  assert.equal(alice.failed_logins, 4);
});

test('73.4 admin-sentinel value 99 is NOT purged', () => {
  // W59 sets failed_logins = 99 to mark "locked by admin".
  // The purge must NOT clear those.
  const db = makeDb();
  insertUser(db, 1, 'alice', 99, '2099-01-01 00:00:00', '2026-06-22 06:00:00');
  const result = clearStaleFailedLogins(db, {
    staleAfterMs: 24 * 60 * 60 * 1000,
    now: () => NOW_MS,
  });
  assert.equal(result.cleared, 0);
  assert.equal(result.scanned, 0);
  const alice = db.prepare('SELECT * FROM users WHERE id = 1').get();
  assert.equal(alice.failed_logins, 99);
});

test('73.5 users with no last_failed_at are NOT purged', () => {
  const db = makeDb();
  insertUser(db, 1, 'alice', 4, null, null);
  const result = clearStaleFailedLogins(db, {
    staleAfterMs: 24 * 60 * 60 * 1000,
    now: () => NOW_MS,
  });
  assert.equal(result.cleared, 0);
  const alice = db.prepare('SELECT * FROM users WHERE id = 1').get();
  assert.equal(alice.failed_logins, 4);
});

test('73.6 default threshold is 24h', () => {
  const db = makeDb();
  // 25 hours ago (UTC)
  insertUser(db, 1, 'alice', 4, null, '2026-06-22 06:00:00');
  const result = clearStaleFailedLogins(db, {
    now: () => NOW_MS,
  });
  assert.equal(result.cleared, 1);
});

test('73.7 custom threshold is respected', () => {
  const db = makeDb();
  // 30 minutes ago (UTC) — fresh for 24h, stale for 15min
  insertUser(db, 1, 'alice', 4, null, '2026-06-23 06:30:00');
  const result = clearStaleFailedLogins(db, {
    staleAfterMs: 15 * 60 * 1000,
    now: () => NOW_MS,
  });
  assert.equal(result.cleared, 1);
});

test('73.8 invalid db handle throws TypeError', () => {
  assert.throws(() => clearStaleFailedLogins(null), TypeError);
  assert.throws(() => clearStaleFailedLogins({}), TypeError);
});

test('73.9 returns the threshold in the result', () => {
  const db = makeDb();
  const result = clearStaleFailedLogins(db, {
    staleAfterMs: 24 * 60 * 60 * 1000,
    now: () => NOW_MS,
  });
  // 24h before NOW_ISO (UTC) = '2026-06-22 07:00:00'
  assert.equal(result.threshold, '2026-06-22 07:00:00');
});

test('73.10 multiple stale users are all purged', () => {
  const db = makeDb();
  insertUser(db, 1, 'alice', 4, null, '2026-06-22 06:00:00');
  insertUser(db, 2, 'bob', 5, null, '2026-06-22 05:00:00');
  insertUser(db, 3, 'carol', 3, null, '2026-06-22 04:00:00');
  const result = clearStaleFailedLogins(db, {
    staleAfterMs: 24 * 60 * 60 * 1000,
    now: () => NOW_MS,
  });
  assert.equal(result.cleared, 3);
});
