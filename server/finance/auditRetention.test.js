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
      updated_by INTEGER
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
