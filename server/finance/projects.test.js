// Phase 2 projects — wave 1 unit tests (schema +
// pure functions). The test harness uses a minimal
// in-memory sqlite-shaped adapter that mimics the
// production pgAdapter shape (db.query() returns
// { rows: [...] }).
//
// The schema is migrated via applyMigrations() in
// the bootable server (npm run smoke:deploy), not
// in the test harness (the test harness creates
// only the tables it needs; indexes are omitted
// per the W72-1 lesson that CREATE INDEX with a
// finance. schema prefix raises "near '.' syntax
// error" in node:sqlite). The test queries work
// without indexes (just slower).
//
// Run: node --test server/finance/projects.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createProject,
  listProjects,
  getProject,
  createTask,
  listTasks,
  getTask,
  createTimeEntry,
  listTimeEntries,
  ValueError,
} from './projects.js';

function makeMemoryDb() {
  // Minimal in-memory sqlite-shaped adapter.
  // finance.projects* tables are created here
  // (matches the production 0012_projects.sql
  // schema, but omits the indexes per the
  // W72-1 lesson).
  const db = new DatabaseSync(':memory:');
  db.exec('ATTACH DATABASE ":memory:" AS finance');
  db.exec(`
    CREATE TABLE finance.projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      code TEXT,
      name TEXT NOT NULL,
      description TEXT,
      customer_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      start_date TEXT,
      end_date TEXT,
      owner_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.project_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'normal',
      assignee_id INTEGER,
      due_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.project_time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      work_date TEXT NOT NULL,
      hours REAL NOT NULL,
      billable INTEGER NOT NULL DEFAULT 1,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return {
    _db: db,
    // Production shape: db.query(sql, params) returns
    // { rows: [...] }. The pure functions speak the
    // production shape (W71-2 lesson).
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
// Projects
// ────────────────────────────────────────────────────────────────────────

test('projects: createProject inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const out = await createProject(db, { name: 'My Project' }, 0);
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0, `expected id > 0, got ${out.id}`);
});

test('projects: createProject applies default status=active', async () => {
  const db = makeMemoryDb();
  const out = await createProject(db, { name: 'My Project' }, 0);
  const project = await getProject(db, out.id, 0);
  assert.equal(project.status, 'active');
});

test('projects: createProject validates status', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createProject(db, { name: 'X', status: 'unknown' }, 0),
    /project status/,
  );
});

test('projects: createProject requires name', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createProject(db, {}, 0),
    /name/,
  );
});

test('projects: createProject validates start_date / end_date format', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createProject(db, { name: 'X', start_date: 'not-a-date' }, 0),
    /start_date/,
  );
  await assert.rejects(
    createProject(db, { name: 'X', end_date: '2026-06-21T10:00:00Z' }, 0),
    /end_date/,
  );
  // Note: a "valid-format-but-invalid-calendar" date like
  // '2026-13-99' matches the regex but isn't a real date.
  // The pure function only validates the format, not the
  // calendar validity (the DB CHECK constraint + the
  // application layer can catch it later). This is
  // intentional — strict format validation is the cheap,
  // fast check; calendar validity is the DB's job.
});

test('projects: listProjects returns the projects for the tenant (most recent first)', async () => {
  const db = makeMemoryDb();
  const a = await createProject(db, { name: 'A' }, 0);
  const b = await createProject(db, { name: 'B' }, 0);
  const items = await listProjects(db, 0);
  assert.equal(items.length, 2);
  // Most recent first: b then a
  assert.equal(items[0].id, b.id);
  assert.equal(items[1].id, a.id);
});

test('projects: listProjects is tenant-scoped', async () => {
  const db = makeMemoryDb();
  await createProject(db, { name: 'Tenant 0' }, 0);
  await createProject(db, { name: 'Tenant 1' }, 1);
  const items0 = await listProjects(db, 0);
  const items1 = await listProjects(db, 1);
  assert.equal(items0.length, 1);
  assert.equal(items0[0].name, 'Tenant 0');
  assert.equal(items1.length, 1);
  assert.equal(items1[0].name, 'Tenant 1');
});

test('projects: listProjects filters by status', async () => {
  const db = makeMemoryDb();
  const a = await createProject(db, { name: 'A' }, 0);
  const b = await createProject(db, { name: 'B', status: 'completed' }, 0);
  const active = await listProjects(db, 0, 'active');
  const completed = await listProjects(db, 0, 'completed');
  assert.equal(active.length, 1);
  assert.equal(active[0].id, a.id);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].id, b.id);
});

test('projects: getProject throws ValueError for missing project', async () => {
  const db = makeMemoryDb();
  assert.rejects(
    () => getProject(db, 999, 0),
    (err) => err instanceof ValueError && /not found in tenant/.test(err.message),
  );
});

test('projects: getProject is tenant-scoped (cross-tenant access denied)', async () => {
  const db = makeMemoryDb();
  const out = await createProject(db, { name: 'Tenant 0' }, 0);
  assert.rejects(
    () => getProject(db, out.id, 1),
    (err) => err instanceof ValueError && /not found in tenant/.test(err.message),
  );
});

// ────────────────────────────────────────────────────────────────────────
// Tasks
// ────────────────────────────────────────────────────────────────────────

test('projects: createTask inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const p = await createProject(db, { name: 'P' }, 0);
  const out = await createTask(db, { project_id: p.id, name: 'Task 1' }, 0);
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('projects: createTask throws ValueError for missing project', async () => {
  const db = makeMemoryDb();
  assert.rejects(
    () => createTask(db, { project_id: 999, name: 'Task 1' }, 0),
    (err) => err instanceof ValueError && /project.*not found in tenant/.test(err.message),
  );
});

test('projects: createTask applies default status=todo + priority=normal', async () => {
  const db = makeMemoryDb();
  const p = await createProject(db, { name: 'P' }, 0);
  const out = await createTask(db, { project_id: p.id, name: 'T' }, 0);
  const task = await getTask(db, out.id, 0);
  assert.equal(task.status, 'todo');
  assert.equal(task.priority, 'normal');
});

test('projects: createTask validates status + priority', async () => {
  const db = makeMemoryDb();
  const p = await createProject(db, { name: 'P' }, 0);
  assert.rejects(
    () => createTask(db, { project_id: p.id, name: 'T', status: 'unknown' }, 0),
    (err) => err instanceof ValueError && /task status/.test(err.message),
  );
  assert.rejects(
    () => createTask(db, { project_id: p.id, name: 'T', priority: 'unknown' }, 0),
    (err) => err instanceof ValueError && /task priority/.test(err.message),
  );
});

test('projects: createTask requires name', async () => {
  const db = makeMemoryDb();
  const p = await createProject(db, { name: 'P' }, 0);
  assert.rejects(
    () => createTask(db, { project_id: p.id }, 0),
    (err) => err instanceof ValueError && /name/.test(err.message),
  );
});

test('projects: listTasks returns the tasks for the project (chronological)', async () => {
  const db = makeMemoryDb();
  const p = await createProject(db, { name: 'P' }, 0);
  const t1 = await createTask(db, { project_id: p.id, name: 'T1' }, 0);
  const t2 = await createTask(db, { project_id: p.id, name: 'T2' }, 0);
  const items = await listTasks(db, p.id, 0);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, t1.id);
  assert.equal(items[1].id, t2.id);
});

test('projects: listTasks throws ValueError for missing project', async () => {
  const db = makeMemoryDb();
  assert.rejects(
    () => listTasks(db, 999, 0),
    (err) => err instanceof ValueError && /project.*not found in tenant/.test(err.message),
  );
});

test('projects: listTasks is tenant-scoped', async () => {
  const db = makeMemoryDb();
  const p0 = await createProject(db, { name: 'P0' }, 0);
  const p1 = await createProject(db, { name: 'P1' }, 1);
  await createTask(db, { project_id: p0.id, name: 'T0' }, 0);
  await createTask(db, { project_id: p1.id, name: 'T1' }, 1);
  const items0 = await listTasks(db, p0.id, 0);
  const items1 = await listTasks(db, p1.id, 1);
  assert.equal(items0.length, 1);
  assert.equal(items0[0].name, 'T0');
  assert.equal(items1.length, 1);
  assert.equal(items1[0].name, 'T1');
});

test('projects: listTasks filters by status', async () => {
  const db = makeMemoryDb();
  const p = await createProject(db, { name: 'P' }, 0);
  await createTask(db, { project_id: p.id, name: 'T1', status: 'todo' }, 0);
  const t2 = await createTask(db, { project_id: p.id, name: 'T2', status: 'done' }, 0);
  const done = await listTasks(db, p.id, 0, 'done');
  assert.equal(done.length, 1);
  assert.equal(done[0].id, t2.id);
});

test('projects: getTask throws ValueError for missing task', async () => {
  const db = makeMemoryDb();
  assert.rejects(
    () => getTask(db, 999, 0),
    (err) => err instanceof ValueError && /task.*not found in tenant/.test(err.message),
  );
});

test('projects: getTask is tenant-scoped', async () => {
  const db = makeMemoryDb();
  const p = await createProject(db, { name: 'P' }, 0);
  const out = await createTask(db, { project_id: p.id, name: 'T' }, 0);
  assert.rejects(
    () => getTask(db, out.id, 1),
    (err) => err instanceof ValueError && /task.*not found in tenant/.test(err.message),
  );
});

// ────────────────────────────────────────────────────────────────────────
// Time entries
// ────────────────────────────────────────────────────────────────────────

test('projects: createTimeEntry inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const p = await createProject(db, { name: 'P' }, 0);
  const t = await createTask(db, { project_id: p.id, name: 'T' }, 0);
  const out = await createTimeEntry(
    db,
    { task_id: t.id, user_id: 42, work_date: '2026-06-21', hours: 1.5 },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('projects: createTimeEntry throws ValueError for missing task', async () => {
  const db = makeMemoryDb();
  assert.rejects(
    () => createTimeEntry(
      db,
      { task_id: 999, user_id: 42, work_date: '2026-06-21', hours: 1.5 },
      0,
    ),
    (err) => err instanceof ValueError && /task.*not found in tenant/.test(err.message),
  );
});

test('projects: createTimeEntry validates hours (> 0, <= 24, 2 decimal places)', async () => {
  const db = makeMemoryDb();
  const p = await createProject(db, { name: 'P' }, 0);
  const t = await createTask(db, { project_id: p.id, name: 'T' }, 0);
  // Negative
  assert.rejects(
    () => createTimeEntry(
      db,
      { task_id: t.id, user_id: 42, work_date: '2026-06-21', hours: -1 },
      0,
    ),
    (err) => err instanceof ValueError && /hours/.test(err.message),
  );
  // Too many decimals
  assert.rejects(
    () => createTimeEntry(
      db,
      { task_id: t.id, user_id: 42, work_date: '2026-06-21', hours: 1.234 },
      0,
    ),
    (err) => err instanceof ValueError && /2 decimal places/.test(err.message),
  );
  // Over 24
  assert.rejects(
    () => createTimeEntry(
      db,
      { task_id: t.id, user_id: 42, work_date: '2026-06-21', hours: 25 },
      0,
    ),
    (err) => err instanceof ValueError && /hours/.test(err.message),
  );
});

test('projects: createTimeEntry normalizes billable=true to 1', async () => {
  const db = makeMemoryDb();
  const p = await createProject(db, { name: 'P' }, 0);
  const t = await createTask(db, { project_id: p.id, name: 'T' }, 0);
  const out = await createTimeEntry(
    db,
    { task_id: t.id, user_id: 42, work_date: '2026-06-21', hours: 1, billable: true },
    0,
  );
  const items = await listTimeEntries(db, t.id, 0);
  assert.equal(items[0].billable, 1);
  assert.equal(items[0].id, out.id);
});

test('projects: createTimeEntry normalizes billable=false to 0', async () => {
  const db = makeMemoryDb();
  const p = await createProject(db, { name: 'P' }, 0);
  const t = await createTask(db, { project_id: p.id, name: 'T' }, 0);
  await createTimeEntry(
    db,
    { task_id: t.id, user_id: 42, work_date: '2026-06-21', hours: 1, billable: false },
    0,
  );
  const items = await listTimeEntries(db, t.id, 0);
  assert.equal(items[0].billable, 0);
});

test('projects: listTimeEntries returns the entries for the task (chronological)', async () => {
  const db = makeMemoryDb();
  const p = await createProject(db, { name: 'P' }, 0);
  const t = await createTask(db, { project_id: p.id, name: 'T' }, 0);
  await createTimeEntry(
    db,
    { task_id: t.id, user_id: 42, work_date: '2026-06-22', hours: 2 },
    0,
  );
  await createTimeEntry(
    db,
    { task_id: t.id, user_id: 42, work_date: '2026-06-21', hours: 1 },
    0,
  );
  const items = await listTimeEntries(db, t.id, 0);
  assert.equal(items.length, 2);
  // Ordered by work_date ASC: 06-21 first, then 06-22
  assert.equal(items[0].work_date, '2026-06-21');
  assert.equal(items[1].work_date, '2026-06-22');
});

test('projects: listTimeEntries throws ValueError for missing task', async () => {
  const db = makeMemoryDb();
  assert.rejects(
    () => listTimeEntries(db, 999, 0),
    (err) => err instanceof ValueError && /task.*not found in tenant/.test(err.message),
  );
});

test('projects: listTimeEntries is tenant-scoped', async () => {
  const db = makeMemoryDb();
  const p0 = await createProject(db, { name: 'P0' }, 0);
  const p1 = await createProject(db, { name: 'P1' }, 1);
  const t0 = await createTask(db, { project_id: p0.id, name: 'T0' }, 0);
  const t1 = await createTask(db, { project_id: p1.id, name: 'T1' }, 1);
  await createTimeEntry(
    db,
    { task_id: t0.id, user_id: 42, work_date: '2026-06-21', hours: 1 },
    0,
  );
  await createTimeEntry(
    db,
    { task_id: t1.id, user_id: 42, work_date: '2026-06-21', hours: 2 },
    1,
  );
  const items0 = await listTimeEntries(db, t0.id, 0);
  assert.equal(items0.length, 1);
  assert.equal(items0[0].hours, 1);
  // Cross-tenant access: listTimeEntries for t0 in tenant 1
  // throws ValueError (existence check on the wrong tenant
  // doesn't find the task).
  assert.rejects(
    () => listTimeEntries(db, t0.id, 1),
    (err) => err instanceof ValueError && /task.*not found in tenant/.test(err.message),
  );
});
