// Tests for the finance audit retention policy (W60).
//
// The retention config is per-tenant; each tenant can set how many
// days of audit history to keep. 0 = keep forever. Default = 365
// (one year — matches the typical regulatory retention window for
// financial records in many jurisdictions).
//
// The purge function takes a tenant_id + days and DELETEs every
// audit row older than the cutoff. It's safe to call repeatedly
// (idempotent — second call is a no-op). The function uses the
// same sqlite-vs-pg prefix pattern as audit.js (queries without
// the `finance.` prefix work on both backends).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  getAuditRetention,
  setAuditRetention,
  purgeOldAuditEvents,
  recordPurgeRun,
  getRetentionDashboard,
  streamRetentionDashboardCsv,
  getRetentionDigestSummary,
  buildRetentionDigestBody,
  DEFAULT_RETENTION_DAYS,
} from './auditRetention.js';

function makeRetentionDb() {
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
  `);
  return db;
}

function seedAudit(db, { tenantId, ageDays, action = 'invoice.create' }) {
  // created_at is N days in the past.
  const ts = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO audit (tenant_id, user_id, action, resource, created_at)
     VALUES (?, 1, ?, 'invoice:1', ?)`,
  ).run(tenantId, action, ts);
}

test('getAuditRetention: returns the default when no config exists', () => {
  const db = makeRetentionDb();
  const cfg = getAuditRetention(db, 0);
  assert.equal(cfg.retention_days, DEFAULT_RETENTION_DAYS);
  assert.equal(cfg.tenant_id, 0);
});

test('getAuditRetention: returns the stored config when one exists', () => {
  const db = makeRetentionDb();
  setAuditRetention(db, 0, 90, 1);
  const cfg = getAuditRetention(db, 0);
  assert.equal(cfg.retention_days, 90);
  assert.equal(cfg.updated_by, 1);
});

test('setAuditRetention: upsert — second call replaces the first', () => {
  const db = makeRetentionDb();
  setAuditRetention(db, 0, 30, 1);
  setAuditRetention(db, 0, 60, 2);
  const cfg = getAuditRetention(db, 0);
  assert.equal(cfg.retention_days, 60);
  assert.equal(cfg.updated_by, 2);
});

test('setAuditRetention: rejects negative days', () => {
  const db = makeRetentionDb();
  assert.throws(() => setAuditRetention(db, 0, -1, 1), /non-negative/);
});

test('setAuditRetention: accepts 0 (keep forever)', () => {
  const db = makeRetentionDb();
  setAuditRetention(db, 0, 0, 1);
  const cfg = getAuditRetention(db, 0);
  assert.equal(cfg.retention_days, 0);
});

test('purgeOldAuditEvents: deletes rows older than the cutoff', () => {
  const db = makeRetentionDb();
  seedAudit(db, { tenantId: 0, ageDays: 100 });
  seedAudit(db, { tenantId: 0, ageDays: 10 });
  seedAudit(db, { tenantId: 0, ageDays: 1 });
  // 30-day retention: the 100-day-old row goes, the rest stay.
  const purged = purgeOldAuditEvents(db, 0, 30);
  assert.equal(purged, 1);
  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM audit WHERE tenant_id = 0`).get().n;
  assert.equal(remaining, 2);
});

test('purgeOldAuditEvents: tenant-scoped — does not touch other tenants', () => {
  const db = makeRetentionDb();
  seedAudit(db, { tenantId: 0, ageDays: 100 });
  seedAudit(db, { tenantId: 5, ageDays: 100 });
  const purged = purgeOldAuditEvents(db, 0, 30);
  assert.equal(purged, 1);
  // Tenant 5's old row must still be there.
  const t5 = db.prepare(`SELECT COUNT(*) AS n FROM audit WHERE tenant_id = 5`).get().n;
  assert.equal(t5, 1, 'tenant 5 row must be untouched');
});

test('purgeOldAuditEvents: 0 days = delete nothing (keep forever semantics)', () => {
  const db = makeRetentionDb();
  seedAudit(db, { tenantId: 0, ageDays: 1000 });
  const purged = purgeOldAuditEvents(db, 0, 0);
  assert.equal(purged, 0);
  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM audit WHERE tenant_id = 0`).get().n;
  assert.equal(remaining, 1);
});

test('purgeOldAuditEvents: returns 0 when no rows match', () => {
  const db = makeRetentionDb();
  seedAudit(db, { tenantId: 0, ageDays: 1 });
  const purged = purgeOldAuditEvents(db, 0, 30);
  assert.equal(purged, 0);
});

// ─── W63: purge-run tracking + retention dashboard ───

test('recordPurgeRun: stamps last_purge_at + last_purge_count on the row', () => {
  const db = makeRetentionDb();
  setAuditRetention(db, 0, 90, 1);
  recordPurgeRun(db, 0, 42);
  const cfg = getAuditRetention(db, 0);
  assert.equal(cfg.last_purge_count, 42);
  assert.ok(cfg.last_purge_at, 'last_purge_at must be set');
});

test('recordPurgeRun: silently no-ops when no config row exists', () => {
  // A tenant on the default config has no row to update.
  // recordPurgeRun should NOT crash or create a row
  // (otherwise the operator's auto-cleaned default tenants
  // would leave stray rows in the audit_retention table).
  const db = makeRetentionDb();
  recordPurgeRun(db, 0, 42);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM audit_retention WHERE tenant_id = 0`).get();
  assert.equal(row.n, 0, 'recordPurgeRun must not create a row');
});

test('getRetentionDashboard: returns per-tenant stats for all tenants', () => {
  const db = makeRetentionDb();
  // Seed three tenants: one with config + purge history,
  // one with config but no purge, one with audit rows
  // only (default config).
  setAuditRetention(db, 0, 90, 1);
  setAuditRetention(db, 7, 180, 2);
  // No config for tenant 5 — uses the 365d default.
  seedAudit(db, { tenantId: 0, ageDays: 1 });
  seedAudit(db, { tenantId: 0, ageDays: 200 });   // would be purged at 90d
  seedAudit(db, { tenantId: 7, ageDays: 5 });
  seedAudit(db, { tenantId: 5, ageDays: 100 });
  const dashboard = getRetentionDashboard(db);
  assert.ok(Array.isArray(dashboard.items));
  assert.ok(dashboard.items.length >= 3);
  // Each item has the documented shape.
  for (const item of dashboard.items) {
    assert.ok(typeof item.tenant_id === 'number');
    assert.ok(typeof item.retention_days === 'number');
    assert.ok(typeof item.audit_row_count === 'number');
  }
  // The default-tenant (no config) shows retention_days=365
  // and has_explicit_config=false.
  const t5 = dashboard.items.find((i) => i.tenant_id === 5);
  assert.ok(t5);
  assert.equal(t5.retention_days, 365);
  assert.equal(t5.has_explicit_config, false);
  // Tenant 0 has explicit config + audit rows.
  const t0 = dashboard.items.find((i) => i.tenant_id === 0);
  assert.ok(t0);
  assert.equal(t0.retention_days, 90);
  assert.equal(t0.has_explicit_config, true);
  assert.equal(t0.audit_row_count, 2);
});

test('getRetentionDashboard: returns an empty list when no tenants have audit rows', () => {
  const db = makeRetentionDb();
  const dashboard = getRetentionDashboard(db);
  assert.deepEqual(dashboard.items, []);
});

// ─── W64: dashboard CSV export ───

async function collect(generator) {
  const out = [];
  for await (const chunk of generator) out.push(chunk);
  return out.join('');
}

test('streamRetentionDashboardCsv: emits the header line first', async () => {
  const db = makeRetentionDb();
  const text = await collect(streamRetentionDashboardCsv(db));
  const lines = text.trim().split('\n');
  // Header is the first line.
  assert.match(lines[0], /^tenant_id,retention_days,has_explicit_config,/);
  // No tenants → no data rows beyond the header.
  assert.equal(lines.length, 1);
});

test('streamRetentionDashboardCsv: emits a row per tenant with the documented shape', async () => {
  const db = makeRetentionDb();
  setAuditRetention(db, 0, 90, 1);
  setAuditRetention(db, 7, 180, 2);
  seedAudit(db, { tenantId: 5, ageDays: 1 });
  const text = await collect(streamRetentionDashboardCsv(db));
  const lines = text.trim().split('\n');
  // 1 header + 3 data rows.
  assert.equal(lines.length, 4);
  // Verify the documented columns are present.
  for (const col of [
    'tenant_id',
    'retention_days',
    'has_explicit_config',
    'updated_at',
    'updated_by',
    'last_purge_at',
    'last_purge_count',
    'last_purge_days',
    'audit_row_count',
  ]) {
    assert.ok(lines[0].includes(col), `header missing ${col}`);
  }
  // Sorted by tenant_id ASC.
  assert.match(lines[1], /^0,/);
  assert.match(lines[2], /^5,/);
  assert.match(lines[3], /^7,/);
});

test('streamRetentionDashboardCsv: includes the last-purge columns populated', async () => {
  const db = makeRetentionDb();
  setAuditRetention(db, 0, 90, 1);
  recordPurgeRun(db, 0, 17, 90);
  const text = await collect(streamRetentionDashboardCsv(db));
  const lines = text.trim().split('\n');
  // Header + 1 data row.
  assert.equal(lines.length, 2);
  // The data row has last_purge_count=17 and last_purge_days=90.
  const cols = lines[1].split(',');
  const purgeCount = Number(cols[6]);
  const purgeDays = Number(cols[7]);
  assert.equal(purgeCount, 17);
  assert.equal(purgeDays, 90);
});

test('streamRetentionDashboardCsv: produces a header-only output when no tenants', async () => {
  // Defensive: the CSV must remain valid (header + no rows)
  // when the dashboard is empty. Compliance tools expect a
  // header on every export.
  const db = makeRetentionDb();
  const text = await collect(streamRetentionDashboardCsv(db));
  assert.equal(text.trim().split('\n').length, 1);
});

// ─── W65: retention digest (weekly CFO email summary) ───

test('getRetentionDigestSummary: returns aggregate counts across all tenants', () => {
  const db = makeRetentionDb();
  setAuditRetention(db, 0, 90, 1);
  setAuditRetention(db, 7, 180, 2);
  // Seed audit rows in three tenants.
  seedAudit(db, { tenantId: 0, ageDays: 1 });
  seedAudit(db, { tenantId: 0, ageDays: 5 });
  seedAudit(db, { tenantId: 7, ageDays: 30 });
  seedAudit(db, { tenantId: 5, ageDays: 100 });
  const summary = getRetentionDigestSummary(db);
  assert.equal(summary.tenant_count, 3, 'three tenants with audit rows');
  assert.equal(summary.total_audit_rows, 4, 'four total audit rows');
  assert.equal(summary.tenants_on_default, 1, 'one tenant on default 365d');
  assert.equal(summary.tenants_with_explicit_config, 2, 'two tenants with explicit config');
  // No purge history yet, so totals are 0.
  assert.equal(summary.total_rows_purged, 0);
  assert.equal(summary.tenants_with_recent_purge, 0);
});

test('getRetentionDigestSummary: totals rows purged and counts tenants with a purge in the window', () => {
  const db = makeRetentionDb();
  setAuditRetention(db, 0, 90, 1);
  setAuditRetention(db, 7, 180, 2);
  // Stamp two recent purges.
  recordPurgeRun(db, 0, 17, 90);
  recordPurgeRun(db, 7, 8, 180);
  const summary = getRetentionDigestSummary(db);
  assert.equal(summary.total_rows_purged, 25, '17 + 8 = 25');
  assert.equal(summary.tenants_with_recent_purge, 2);
});

test('getRetentionDigestSummary: returns 0/0 when no retention activity has happened', () => {
  const db = makeRetentionDb();
  const summary = getRetentionDigestSummary(db);
  assert.equal(summary.tenant_count, 0);
  assert.equal(summary.total_audit_rows, 0);
  assert.equal(summary.total_rows_purged, 0);
});

test('buildRetentionDigestBody: includes the summary totals in the body', () => {
  const summary = {
    tenant_count: 5,
    tenants_on_default: 2,
    tenants_with_explicit_config: 3,
    total_audit_rows: 1234,
    total_rows_purged: 567,
    tenants_with_recent_purge: 3,
  };
  const body = buildRetentionDigestBody(summary);
  // The body is human-readable text; verify the key
  // numbers are present.
  assert.match(body, /5/);
  assert.match(body, /1234/);
  assert.match(body, /567/);
  assert.match(body, /2/);
  assert.match(body, /3/);
  // And it has a clear "what this is" header.
  assert.match(body, /audit retention|retention digest/i);
});

test('buildRetentionDigestBody: produces an empty-state message when there is no data', () => {
  const summary = {
    tenant_count: 0,
    tenants_on_default: 0,
    tenants_with_explicit_config: 0,
    total_audit_rows: 0,
    total_rows_purged: 0,
    tenants_with_recent_purge: 0,
  };
  const body = buildRetentionDigestBody(summary);
  assert.match(body, /no retention activity|nothing to report/i);
});
