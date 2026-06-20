// Tests for the finance schema migration runner.
//
// The runner is a tiny duck-type dispatcher: if `db.query` exists it treats
// the input as a pg-style PoolClient; otherwise it falls through to
// better-sqlite3-style (db.exec / db.prepare). We exercise both branches
// with mock DBs to prove the dispatch is correct.
//
// All tests use an in-memory mock DB — no real Postgres or sqlite required.
//
// TDD: this file lands in commit A (RED). The migrate.js module is a stub
// that throws NotImplementedError on the RED branch. Tests are expected to
// fail until commit B introduces the real implementation.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ────────────────────────────────────────────────────────────────────────────
// In-memory mock DBs
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a pg-style mock DB. Records every SQL passed to `.query(sql)` and
 * tracks a tiny in-memory model of `finance.migration_history` so tests can
 * assert on it.
 *
 * If `failOn` matches a SQL substring, throws a fake syntax error to simulate
 * a failing migration.
 */
function makePgMock({ failOn = null } = {}) {
  const statements = [];
  const history = []; // { id, name, applied_at }
  let nextId = 1;

  const db = {
    kind: 'pg',
    statements,
    history,
    async query(sql /* , params */) {
      statements.push(sql);
      if (failOn && sql.includes(failOn)) {
        const err = new Error(`syntax error at or near "${failOn}"`);
        err.code = '42601';
        throw err;
      }
      // Minimal model: finance.migration_history
      const trimmed = sql.trim();
      // CREATE TABLE finance.migration_history ...
      if (/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?finance\.migration_history/i.test(trimmed)) {
        return { rows: [] };
      }
      // INSERT INTO finance.migration_history ...
      const insertMatch = trimmed.match(/INSERT\s+INTO\s+finance\.migration_history[\s\S]*?VALUES\s*\(\s*\$1\s*,\s*\$2\s*,\s*\$3\s*\)/i);
      if (insertMatch) {
        // We can't see params here in our simple model; the runner is expected
        // to pass them via .query(sql, params). Capture the *params* from the
        // test wrapper instead. For now, push a placeholder.
        history.push({ id: nextId++, name: '<pending>', applied_at: '<pending>' });
        return { rows: [] };
      }
      // SELECT name FROM finance.migration_history
      if (/SELECT\s+name\s+FROM\s+finance\.migration_history/i.test(trimmed)) {
        return { rows: history.map((h) => ({ name: h.name })) };
      }
      // Generic DDL/DML — accept silently
      return { rows: [] };
    },
  };

  // Wrap query so tests can pass params and we capture them for history.
  const originalQuery = db.query.bind(db);
  db.query = async (sql, params) => {
    db.statements.push(sql);
    if (failOn && sql.includes(failOn)) {
      const err = new Error(`syntax error at or near "${failOn}"`);
      err.code = '42601';
      throw err;
    }
    const trimmed = sql.trim();
    if (/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?finance\.migration_history/i.test(trimmed)) {
      return { rows: [] };
    }
    if (/INSERT\s+INTO\s+finance\.migration_history/i.test(trimmed)) {
      // params: [name, applied_at] — id is BIGSERIAL (auto)
      const [name, applied_at] = params ?? [];
      history.push({ id: nextId++, name, applied_at });
      return { rows: [] };
    }
    if (/SELECT\s+name\s+FROM\s+finance\.migration_history/i.test(trimmed)) {
      return { rows: history.map((h) => ({ name: h.name })) };
    }
    return { rows: [] };
  };
  return db;
}

/**
 * Build a sqlite-style mock DB. Records every SQL passed to `.exec(sql)`.
 */
function makeSqliteMock({ failOn = null } = {}) {
  const statements = [];
  const history = []; // { name }
  const db = {
    kind: 'sqlite',
    statements,
    history,
    exec(sql) {
      statements.push(sql);
      if (failOn && sql.includes(failOn)) {
        throw new Error(`SQLITE_ERROR: near "${failOn}": syntax error`);
      }
      // Tiny model: parse name out of `INSERT INTO finance.migration_history ... VALUES ('name', ...)`
      const trimmed = sql.trim();
      const m = trimmed.match(/INSERT\s+INTO\s+finance\.migration_history[^']*'([^']+)'/i);
      if (m) history.push({ name: m[1] });
      // No return value for sqlite-style exec
    },
  };
  return db;
}

// Helper: create a fresh tmp dir with a finance/migrations/ subdir
function makeMigrationsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'finance-migrate-test-'));
  const migDir = join(dir, 'migrations');
  mkdirSync(migDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(migDir, name), content);
  }
  return { dir, migDir };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('applyMigrations — pg-style mock', () => {
  test('1. empty migrations dir returns { applied: [], skipped: [] }', async () => {
    const { dir } = makeMigrationsDir({}); // no files
    try {
      const { applyMigrations } = await import('./migrate.js');
      const db = makePgMock();
      const result = await applyMigrations(db, { migrationsDir: dir });
      assert.deepEqual(result, { applied: [], skipped: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('2. single new migration: applies it and records in history', async () => {
    const { dir } = makeMigrationsDir({
      '0001_init.sql': 'CREATE TABLE finance.customers (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL);',
    });
    try {
      const { applyMigrations } = await import('./migrate.js');
      const db = makePgMock();
      const result = await applyMigrations(db, { migrationsDir: dir });
      assert.deepEqual(result.applied, ['0001_init.sql']);
      assert.deepEqual(result.skipped, []);
      // The CREATE TABLE for the migration_history table itself should have run.
      const sawHistoryCreate = db.statements.some((s) =>
        /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?finance\.migration_history/i.test(s),
      );
      assert.equal(sawHistoryCreate, true, 'expected history table CREATE');
      // The migration SQL must have been executed.
      const sawMigrationSql = db.statements.some((s) =>
        /CREATE\s+TABLE\s+finance\.customers/i.test(s),
      );
      assert.equal(sawMigrationSql, true, 'expected migration SQL to run');
      // History should now have one entry for 0001_init.sql.
      assert.equal(db.history.length, 1);
      assert.equal(db.history[0].name, '0001_init.sql');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('3. running twice is a no-op the second time (idempotent)', async () => {
    const { dir } = makeMigrationsDir({
      '0001_init.sql': 'CREATE TABLE finance.customers (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL);',
    });
    try {
      const { applyMigrations } = await import('./migrate.js');
      const db = makePgMock();
      const first = await applyMigrations(db, { migrationsDir: dir });
      const second = await applyMigrations(db, { migrationsDir: dir });
      assert.deepEqual(first.applied, ['0001_init.sql']);
      assert.deepEqual(first.skipped, []);
      assert.deepEqual(second.applied, []);
      assert.deepEqual(second.skipped, ['0001_init.sql']);
      // History should still have exactly one entry — no duplicates.
      assert.equal(db.history.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('4. two new migrations: both applied in lex order', async () => {
    const { dir } = makeMigrationsDir({
      '0002_invoices.sql': 'CREATE TABLE finance.invoices (id BIGSERIAL PRIMARY KEY);',
      '0001_init.sql': 'CREATE TABLE finance.customers (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL);',
    });
    try {
      const { applyMigrations } = await import('./migrate.js');
      const db = makePgMock();
      const result = await applyMigrations(db, { migrationsDir: dir });
      assert.deepEqual(result.applied, ['0001_init.sql', '0002_invoices.sql']);
      assert.deepEqual(result.skipped, []);
      assert.equal(db.history.length, 2);
      assert.equal(db.history[0].name, '0001_init.sql');
      assert.equal(db.history[1].name, '0002_invoices.sql');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('5. finance.migration_history table is created if missing', async () => {
    // Start with an EMPTY statements array (no history table yet). The runner
    // must issue a CREATE TABLE for finance.migration_history before reading
    // from it.
    const { dir } = makeMigrationsDir({});
    try {
      const { applyMigrations } = await import('./migrate.js');
      const db = makePgMock();
      await applyMigrations(db, { migrationsDir: dir });
      const sawHistoryCreate = db.statements.some((s) =>
        /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?finance\.migration_history/i.test(s),
      );
      assert.equal(sawHistoryCreate, true, 'history table CREATE must be issued on first run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('6. failing migration: error rethrown, NOT recorded, subsequent NOT applied', async () => {
    const { dir } = makeMigrationsDir({
      '0001_init.sql': 'CREATE TABLE finance.customers (id BIGSERIAL PRIMARY KEY);',
      // 'this_is_broken' triggers the mock's failOn check.
      '0002_broken.sql': "SELECT this_is_broken FROM finance.migration_history;",
      '0003_after.sql': 'CREATE TABLE finance.invoices (id BIGSERIAL PRIMARY KEY);',
    });
    try {
      const { applyMigrations } = await import('./migrate.js');
      const db = makePgMock({ failOn: 'this_is_broken' });
      await assert.rejects(
        () => applyMigrations(db, { migrationsDir: dir }),
        /this_is_broken/,
        'expected the runner to rethrow the underlying SQL error',
      );
      // 0001_init should have been applied (it ran before 0002).
      assert.ok(
        db.history.some((h) => h.name === '0001_init.sql'),
        'expected 0001_init.sql to be recorded in history',
      );
      // 0002_broken must NOT be in history (it failed mid-flight).
      assert.ok(
        !db.history.some((h) => h.name === '0002_broken.sql'),
        'expected 0002_broken.sql to NOT be recorded in history',
      );
      // 0003_after must NOT have been applied.
      assert.ok(
        !db.history.some((h) => h.name === '0003_after.sql'),
        'expected 0003_after.sql to NOT be applied (subsequent skipped on failure)',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('applyMigrations — sqlite-style mock', () => {
  test('7. duck-type dispatch: sqlite DB (no .query) routes through db.exec', async () => {
    const { dir } = makeMigrationsDir({
      '0001_init.sql': 'CREATE TABLE finance.customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
    });
    try {
      const { applyMigrations } = await import('./migrate.js');
      const db = makeSqliteMock();
      const result = await applyMigrations(db, { migrationsDir: dir });
      assert.deepEqual(result.applied, ['0001_init.sql']);
      assert.deepEqual(result.skipped, []);
      // The sqlite branch must have used db.exec, not db.query.
      assert.equal(db.statements.length >= 1, true, 'expected db.exec to be called at least once');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('8. sqlite branch: idempotent on second run', async () => {
    const { dir } = makeMigrationsDir({
      '0001_init.sql': 'CREATE TABLE finance.customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
    });
    try {
      const { applyMigrations } = await import('./migrate.js');
      const db = makeSqliteMock();
      const first = await applyMigrations(db, { migrationsDir: dir });
      const second = await applyMigrations(db, { migrationsDir: dir });
      assert.deepEqual(first.applied, ['0001_init.sql']);
      assert.deepEqual(second.applied, []);
      assert.deepEqual(second.skipped, ['0001_init.sql']);
      assert.equal(db.history.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
