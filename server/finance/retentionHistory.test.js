// Tests for the W66 retention history snapshots.
//
// The history module captures the current dashboard state
// for every tenant at a point in time. It's append-only:
// each snapshot is a frozen denormalised row. Operators
// can later query the history to see how the state
// evolved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  snapshotRetentionDashboard,
  listRetentionHistory,
  startRetentionSnapshot,
  streamRetentionHistoryCsv,
} from './retentionHistory.js';

function makeHistoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER,
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE audit_retention (
      tenant_id INTEGER PRIMARY KEY,
      retention_days INTEGER NOT NULL DEFAULT 365,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by INTEGER,
      last_purge_at TEXT,
      last_purge_count INTEGER,
      last_purge_days INTEGER
    );
    CREATE TABLE retention_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
      retention_days INTEGER NOT NULL,
      has_explicit_config INTEGER NOT NULL DEFAULT 0,
      audit_row_count INTEGER NOT NULL DEFAULT 0,
      last_purge_at TEXT,
      last_purge_count INTEGER
    );
  `);
  return db;
}

function seedAudit(db, { tenantId, ageDays }) {
  const ts = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO audit (tenant_id, user_id, action, resource, created_at)
     VALUES (?, 1, 'invoice.create', 'invoice:1', ?)`,
  ).run(tenantId, ts);
}

function seedConfig(db, { tenantId, days }) {
  db.prepare(
    `INSERT INTO audit_retention
     (tenant_id, retention_days, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), 1)`,
  ).run(tenantId, days);
}

test('snapshotRetentionDashboard: writes one row per tenant with audit rows', () => {
  const db = makeHistoryDb();
  seedConfig(db, { tenantId: 0, days: 90 });
  seedConfig(db, { tenantId: 7, days: 180 });
  seedAudit(db, { tenantId: 0, ageDays: 5 });
  seedAudit(db, { tenantId: 0, ageDays: 50 });
  seedAudit(db, { tenantId: 7, ageDays: 10 });
  seedAudit(db, { tenantId: 5, ageDays: 100 });   // default-tenant
  const count = snapshotRetentionDashboard(db);
  assert.equal(count, 3, 'three tenants with audit rows');
  // Verify the rows.
  const rows = db.prepare(`SELECT * FROM retention_history ORDER BY tenant_id`).all();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].tenant_id, 0);
  assert.equal(rows[0].retention_days, 90);
  assert.equal(rows[0].has_explicit_config, 1);
  assert.equal(rows[0].audit_row_count, 2);
  assert.equal(rows[1].tenant_id, 5);
  assert.equal(rows[1].retention_days, 365);   // default
  assert.equal(rows[1].has_explicit_config, 0);
  assert.equal(rows[2].tenant_id, 7);
  assert.equal(rows[2].retention_days, 180);
});

test('snapshotRetentionDashboard: stamps snapshot_at to now() by default', () => {
  const db = makeHistoryDb();
  seedAudit(db, { tenantId: 0, ageDays: 1 });
  const before = Math.floor(Date.now() / 1000);
  snapshotRetentionDashboard(db);
  const after = Math.floor(Date.now() / 1000);
  const row = db.prepare(`SELECT snapshot_at FROM retention_history WHERE tenant_id = 0`).get();
  // snapshot_at is the unix timestamp as a string.
  const t = new Date(row.snapshot_at + 'Z').getTime() / 1000;
  assert.ok(t >= before && t <= after, 'snapshot_at must be ~now');
});

test('snapshotRetentionDashboard: writes 0 rows when no tenants have audit rows', () => {
  const db = makeHistoryDb();
  const count = snapshotRetentionDashboard(db);
  assert.equal(count, 0);
});

test('listRetentionHistory: returns snapshots for a tenant in reverse-chronological order', () => {
  const db = makeHistoryDb();
  seedAudit(db, { tenantId: 0, ageDays: 1 });
  // Take three snapshots at different times.
  snapshotRetentionDashboard(db);
  // Force a gap by stamping an old timestamp.
  db.prepare(
    `INSERT INTO retention_history
     (tenant_id, snapshot_at, retention_days, has_explicit_config, audit_row_count)
     VALUES (0, datetime('now', '-2 days'), 90, 1, 5)`,
  ).run();
  db.prepare(
    `INSERT INTO retention_history
     (tenant_id, snapshot_at, retention_days, has_explicit_config, audit_row_count)
     VALUES (0, datetime('now', '-1 days'), 90, 1, 8)`,
  ).run();
  const history = listRetentionHistory(db, { tenantId: 0 });
  assert.equal(history.items.length, 3);
  // Newest first.
  const dates = history.items.map((h) => h.snapshot_at);
  assert.ok(dates[0] > dates[1]);
  assert.ok(dates[1] > dates[2]);
});

test('listRetentionHistory: respects the limit option', () => {
  const db = makeHistoryDb();
  seedAudit(db, { tenantId: 0, ageDays: 1 });
  for (let i = 0; i < 5; i += 1) {
    db.prepare(
      `INSERT INTO retention_history
       (tenant_id, snapshot_at, retention_days, has_explicit_config, audit_row_count)
       VALUES (0, datetime('now', '-' || ? || ' days'), 90, 1, ?)`,
    ).run(i + 1, i + 1);
  }
  const history = listRetentionHistory(db, { tenantId: 0, limit: 3 });
  assert.equal(history.items.length, 3);
});

test('listRetentionHistory: returns empty list when no snapshots exist', () => {
  const db = makeHistoryDb();
  const history = listRetentionHistory(db, { tenantId: 0 });
  assert.deepEqual(history.items, []);
});

test('startRetentionSnapshot: tickNow captures immediately and returns a stop handle', () => {
  const db = makeHistoryDb();
  seedAudit(db, { tenantId: 0, ageDays: 1 });
  // tickMs: 60_000 minimum (the floor). We use the
  // floor so the test runs fast; the worker is opt-out
  // via handle.stop().
  const handle = startRetentionSnapshot({ db, tickMs: 60_000 });
  // tickNow is a sync wrapper around the same logic.
  const count = handle.tickNow();
  assert.equal(count, 1);
  handle.stop();
});

// ─── W67: retention history CSV export ───

async function collect(generator) {
  const out = [];
  for await (const chunk of generator) out.push(chunk);
  return out.join('');
}

test('streamRetentionHistoryCsv: emits the header line first', async () => {
  const db = makeHistoryDb();
  const text = await collect(streamRetentionHistoryCsv(db, { tenantId: 0 }));
  const lines = text.trim().split('\n');
  // Header is the first line.
  assert.match(lines[0], /^tenant_id,snapshot_at,retention_days,/);
  // No snapshots → no data rows beyond the header.
  assert.equal(lines.length, 1);
});

test('streamRetentionHistoryCsv: emits a row per snapshot with the documented shape', async () => {
  const db = makeHistoryDb();
  seedAudit(db, { tenantId: 0, ageDays: 1 });
  // Take three snapshots at different times.
  snapshotRetentionDashboard(db, '2026-06-01 10:00:00');
  snapshotRetentionDashboard(db, '2026-06-02 10:00:00');
  snapshotRetentionDashboard(db, '2026-06-03 10:00:00');
  const text = await collect(
    streamRetentionHistoryCsv(db, { tenantId: 0 }),
  );
  const lines = text.trim().split('\n');
  // 1 header + 3 data rows.
  assert.equal(lines.length, 4);
  // Header has the documented 8 columns.
  for (const col of [
    'tenant_id',
    'snapshot_at',
    'retention_days',
    'has_explicit_config',
    'audit_row_count',
    'last_purge_at',
    'last_purge_count',
    'last_purge_days',
  ]) {
    assert.ok(lines[0].includes(col), `header missing ${col}`);
  }
  // All data rows are for tenant 0.
  for (let i = 1; i < lines.length; i += 1) {
    assert.match(lines[i], /^0,/);
  }
});

test('streamRetentionHistoryCsv: respects the limit option', async () => {
  const db = makeHistoryDb();
  seedAudit(db, { tenantId: 0, ageDays: 1 });
  for (let i = 0; i < 5; i += 1) {
    db.prepare(
      `INSERT INTO retention_history
       (tenant_id, snapshot_at, retention_days, has_explicit_config, audit_row_count)
       VALUES (0, '2026-06-0' || ? || ' 10:00:00', 90, 1, ?)`,
    ).run(i + 1, i + 1);
  }
  const text = await collect(
    streamRetentionHistoryCsv(db, { tenantId: 0, limit: 3 }),
  );
  const lines = text.trim().split('\n');
  // 1 header + 3 data rows.
  assert.equal(lines.length, 4);
});
