// SBOS-A1-ERP retention summary tests (Wave 75).
//
// The summary reads from getRetentionDashboard so we
// stub that out at the module level (via node's test
// mocking) to keep the test self-contained.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

// We import the module after setting up the audit_retention
// + audit tables, then build a real db handle. The function
// under test calls getRetentionDashboard which does the
// real SQL. We seed the tables and verify the summary.

import { buildRetentionSummary } from './retentionSummary.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  // Match the W6 finance.audit + W60 audit_retention
  // table shapes so the function under test (which does
  // SELECT FROM finance.audit / finance.audit_retention)
  // works without rewriting. SQLite's stripFinancePrefix
  // removes the `finance.` prefix on DDL too, so we
  // create the tables without the prefix here.
  db.exec(`
    CREATE TABLE audit_retention (
      tenant_id INTEGER PRIMARY KEY,
      retention_days INTEGER NOT NULL,
      updated_at TEXT,
      updated_by INTEGER,
      last_purge_at TEXT,
      last_purge_count INTEGER,
      last_purge_days INTEGER
    );
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      payload_json TEXT,
      request_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

test('75.1 returns the right totals for an empty DB', () => {
  const db = makeDb();
  const summary = buildRetentionSummary(db);
  assert.deepEqual(summary.totals, {
    tenants: 0,
    withOverride: 0,
    withDefault: 0,
    totalAuditRows: 0,
  });
  assert.deepEqual(summary.tenants, []);
  assert.ok(summary.generatedAt);
});

test('75.2 counts tenants with explicit config as "override"', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO audit_retention (tenant_id, retention_days) VALUES (1, 90)`,
  ).run();
  // Need at least one audit row to make the tenant
  // appear in the default-config UNION.
  db.prepare(
    `INSERT INTO audit (tenant_id, action, resource, method, path, status_code)
     VALUES (1, 'x', 'r', 'GET', '/p', 200)`,
  ).run();
  const summary = buildRetentionSummary(db);
  assert.equal(summary.totals.tenants, 1);
  assert.equal(summary.totals.withOverride, 1);
  assert.equal(summary.totals.withDefault, 0);
  assert.equal(summary.totals.totalAuditRows, 1);
});

test('75.3 counts tenants without explicit config as "default"', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO audit (tenant_id, action, resource, method, path, status_code)
     VALUES (2, 'x', 'r', 'GET', '/p', 200)`,
  ).run();
  const summary = buildRetentionSummary(db);
  assert.equal(summary.totals.tenants, 1);
  assert.equal(summary.totals.withOverride, 0);
  assert.equal(summary.totals.withDefault, 1);
});

test('75.4 mixed: 2 with override, 3 with default', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO audit_retention (tenant_id, retention_days) VALUES (1, 90)`,
  ).run();
  db.prepare(
    `INSERT INTO audit_retention (tenant_id, retention_days) VALUES (3, 60)`,
  ).run();
  // Audit rows for tenants 1, 2, 3, 4, 5
  for (const t of [1, 2, 3, 4, 5]) {
    db.prepare(
      `INSERT INTO audit (tenant_id, action, resource, method, path, status_code)
       VALUES (?, 'x', 'r', 'GET', '/p', 200)`,
    ).run(t);
  }
  const summary = buildRetentionSummary(db);
  assert.equal(summary.totals.tenants, 5);
  assert.equal(summary.totals.withOverride, 2);
  assert.equal(summary.totals.withDefault, 3);
  assert.equal(summary.totals.totalAuditRows, 5);
});

test('75.5 tenants are sorted by tenant_id ASC', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO audit_retention (tenant_id, retention_days) VALUES (3, 90)`,
  ).run();
  db.prepare(
    `INSERT INTO audit_retention (tenant_id, retention_days) VALUES (1, 60)`,
  ).run();
  for (const t of [1, 2, 3]) {
    db.prepare(
      `INSERT INTO audit (tenant_id, action, resource, method, path, status_code)
       VALUES (?, 'x', 'r', 'GET', '/p', 200)`,
    ).run(t);
  }
  const summary = buildRetentionSummary(db);
  const ids = summary.tenants.map((t) => t.tenantId);
  assert.deepEqual(ids, [1, 2, 3]);
});

test('75.6 each tenant has the expected shape', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO audit_retention (tenant_id, retention_days) VALUES (1, 90)`,
  ).run();
  db.prepare(
    `INSERT INTO audit (tenant_id, action, resource, method, path, status_code)
     VALUES (1, 'a', 'r', 'GET', '/p', 200)`,
  ).run();
  db.prepare(
    `INSERT INTO audit (tenant_id, action, resource, method, path, status_code)
     VALUES (1, 'b', 'r', 'GET', '/p', 200)`,
  ).run();
  const summary = buildRetentionSummary(db);
  assert.deepEqual(summary.tenants[0], {
    tenantId: 1,
    hasExplicitConfig: true,
    retentionDays: 90,
    auditRowCount: 2,
  });
});

test('75.7 invalid db throws TypeError', () => {
  assert.throws(() => buildRetentionSummary(null), TypeError);
  assert.throws(() => buildRetentionSummary({}), TypeError);
});
