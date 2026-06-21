// Test the desk (Phase 2) pure functions end-to-end.
// Mirrors the pattern in server/finance/crm.test.js:
// each test gets a fresh in-memory DB so the test is hermetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createCase,
  listCases,
  getCase,
  createReply,
  listReplies,
  ValueError,
} from './desk.js';

// ────────────────────────────────────────────────────────────────────────
// Test harness — production-shaped db adapter
// ────────────────────────────────────────────────────────────────────────

function makeMemoryDb() {
  // Minimal in-memory sqlite-shaped adapter. finance.desk_*
  // tables are created here (matches the production
  // 0011_desk.sql schema).
  const db = new DatabaseSync(':memory:');
  db.exec('ATTACH DATABASE ":memory:" AS finance');
  db.exec(`
    CREATE TABLE finance.desk_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      customer_id INTEGER,
      contact_id INTEGER,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      assignee_id INTEGER,
      tracking_number TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- NOTE: indexes are NOT created in the test schema. The
    -- production migration (0011_desk.sql) creates them; the
    -- test harness omits them because node:sqlite has a quirk
    -- where CREATE INDEX with the finance. schema prefix
    -- raises "near '.': syntax error". The test queries work
    -- without indexes (just slower).
    CREATE TABLE finance.desk_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      case_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      author TEXT NOT NULL,
      author_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- NOTE: indexes are NOT created in the test schema. The
    -- production migration (0011_desk.sql) creates them; the
    -- test harness omits them because node:sqlite has a quirk
    -- where CREATE INDEX with the finance. schema prefix
    -- raises "near '.': syntax error". The test queries work
    -- without indexes (just slower).
  `);
  return {
    _db: db,
    // Production shape: db.query(sql, params) returns { rows: [...] }
    async query(sql, params = []) {
      // Translate pg-style $N → sqlite ? placeholder.
      const pgStyle = sql.replace(/\$\d+/g, '?');
      const stmt = db.prepare(pgStyle);
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith('SELECT') || upper.includes(' RETURNING')) {
        const rows = stmt.all(...params);
        return { rows };
      }
      // INSERT/UPDATE/DELETE
      const info = stmt.run(...params);
      return {
        rows: [],
        lastInsertRowid: info.lastInsertRowid,
        changes: info.changes,
      };
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Cases
// ────────────────────────────────────────────────────────────────────────

test('desk: createCase inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const out = await createCase(
    db,
    { subject: 'Login broken', body: 'Cannot log in' },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('desk: createCase applies default status=open + priority=normal', async () => {
  const db = makeMemoryDb();
  const out = await createCase(
    db,
    { subject: 'X', body: 'Y' },
    0,
  );
  const row = await getCase(db, out.id, 0);
  assert.equal(row.status, 'open');
  assert.equal(row.priority, 'normal');
});

test('desk: listCases returns the cases for the tenant (most recent first)', async () => {
  const db = makeMemoryDb();
  const a = await createCase(db, { subject: 'A', body: 'a' }, 0);
  const b = await createCase(db, { subject: 'B', body: 'b' }, 0);
  const c = await createCase(db, { subject: 'C', body: 'c' }, 0);
  const rows = await listCases(db, 0);
  assert.equal(rows.length, 3);
  // Most recent first (by id DESC).
  assert.equal(rows[0].id, c.id);
  assert.equal(rows[1].id, b.id);
  assert.equal(rows[2].id, a.id);
});

test('desk: listCases is tenant-scoped', async () => {
  const db = makeMemoryDb();
  await createCase(db, { subject: 'Tenant0', body: 'x' }, 0);
  await createCase(db, { subject: 'Tenant1', body: 'y' }, 1);
  const rows0 = await listCases(db, 0);
  const rows1 = await listCases(db, 1);
  assert.equal(rows0.length, 1);
  assert.equal(rows0[0].subject, 'Tenant0');
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0].subject, 'Tenant1');
});

test('desk: listCases filters by status', async () => {
  const db = makeMemoryDb();
  await createCase(db, { subject: 'Open 1', body: 'x', status: 'open' }, 0);
  await createCase(db, { subject: 'Open 2', body: 'y', status: 'open' }, 0);
  await createCase(db, { subject: 'Resolved 1', body: 'z', status: 'resolved' }, 0);
  const all = await listCases(db, 0);
  const openOnly = await listCases(db, 0, 'open');
  const resolvedOnly = await listCases(db, 0, 'resolved');
  assert.equal(all.length, 3);
  assert.equal(openOnly.length, 2);
  assert.equal(resolvedOnly.length, 1);
  assert.equal(resolvedOnly[0].subject, 'Resolved 1');
});

test('desk: getCase throws ValueError for missing case', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    getCase(db, 999, 0),
    /case 999 not found in tenant 0/,
  );
});

test('desk: getCase is tenant-scoped (cross-tenant access denied)', async () => {
  const db = makeMemoryDb();
  const out = await createCase(db, { subject: 'X', body: 'y' }, 0);
  await assert.rejects(
    getCase(db, out.id, 1),
    new RegExp(`case ${out.id} not found in tenant 1`),
  );
});

test('desk: createCase validates status + priority', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createCase(db, { subject: 'X', body: 'y', status: 'invalid' }, 0),
    /case status must be one of/,
  );
  await assert.rejects(
    createCase(db, { subject: 'X', body: 'y', priority: 'invalid' }, 0),
    /case priority must be one of/,
  );
});

test('desk: createCase requires subject + body', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createCase(db, { body: 'y' }, 0),
    /subject must be a string of 1-255 characters/,
  );
  await assert.rejects(
    createCase(db, { subject: 'X' }, 0),
    /body must be a string of 1-8192 characters/,
  );
});

// ────────────────────────────────────────────────────────────────────────
// Replies
// ────────────────────────────────────────────────────────────────────────

test('desk: createReply inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const c = await createCase(db, { subject: 'X', body: 'y' }, 0);
  const out = await createReply(
    db,
    c.id,
    { body: 'Reply 1', author: 'agent' },
    0,
  );
  assert.ok(out.id > 0);
});

test('desk: createReply throws ValueError for missing case', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createReply(db, 999, { body: 'X', author: 'agent' }, 0),
    /case 999 not found in tenant 0/,
  );
});

test('desk: createReply validates author', async () => {
  const db = makeMemoryDb();
  const c = await createCase(db, { subject: 'X', body: 'y' }, 0);
  await assert.rejects(
    createReply(db, c.id, { body: 'X', author: 'invalid' }, 0),
    /reply author must be one of/,
  );
});

test('desk: listReplies returns the replies for the case (chronological)', async () => {
  const db = makeMemoryDb();
  const c = await createCase(db, { subject: 'X', body: 'y' }, 0);
  await createReply(db, c.id, { body: 'First', author: 'customer' }, 0);
  await createReply(db, c.id, { body: 'Second', author: 'agent' }, 0);
  await createReply(db, c.id, { body: 'Third', author: 'customer' }, 0);
  const rows = await listReplies(db, c.id, 0);
  assert.equal(rows.length, 3);
  // Chronological (by id ASC).
  assert.equal(rows[0].body, 'First');
  assert.equal(rows[1].body, 'Second');
  assert.equal(rows[2].body, 'Third');
});

test('desk: listReplies is tenant-scoped', async () => {
  const db = makeMemoryDb();
  const c = await createCase(db, { subject: 'X', body: 'y' }, 0);
  await createReply(db, c.id, { body: 'r', author: 'agent' }, 0);
  const rows0 = await listReplies(db, c.id, 0);
  const rows1 = await listReplies(db, c.id, 1);
  assert.equal(rows0.length, 1);
  assert.equal(rows1.length, 0);
});
