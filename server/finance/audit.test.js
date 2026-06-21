// Tests for the finance audit module (recordAudit + listAudit).
//
// Uses a fresh in-memory sqlite db so each test is hermetic. Mirrors
// the production finance.audit schema (migration 0006).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { recordAudit, listAudit } from './audit.js';

function makeAuditDb() {
  const db = new DatabaseSync(':memory:');
  // Mirror the production migration runner's sqlite behavior: the
  // `finance.` schema prefix is stripped on sqlite, so the table
  // is just `audit` in the sqlite file. (For pg it's `finance.audit`,
  // but the audit module's queries are written without the prefix
  // so the same SQL works on both backends.)
  db.exec(`
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
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

test('recordAudit: inserts a row with all fields', async () => {
  const db = makeAuditDb();
  recordAudit(db, {
    tenant_id: 5,
    user_id: 42,
    username: 'tester',
    action: 'invoice.create',
    resource: 'invoice:99',
    method: 'POST',
    path: '/api/finance/invoices',
    status_code: 201,
    payload: { customer_id: 1, lines: [] },
  });
  const rows = await listAudit(db, { tenant_id: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'invoice.create');
  assert.equal(rows[0].username, 'tester');
  assert.equal(rows[0].status_code, 201);
  assert.match(rows[0].payload_json, /customer_id/);
});

test('recordAudit: truncates payloads larger than 4KB', async () => {
  const db = makeAuditDb();
  const bigPayload = { blob: 'x'.repeat(8000) };
  recordAudit(db, {
    tenant_id: 0,
    action: 'test.truncate',
    resource: 'test:1',
    method: 'POST',
    path: '/x',
    status_code: 200,
    payload: bigPayload,
  });
  const rows = await listAudit(db, { tenant_id: 0 });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].payload_json.length < 4200, 'payload should be truncated');
  assert.match(rows[0].payload_json, /\.\.\.$/, 'truncated payload ends with ellipsis');
});

test('listAudit: tenant scope filter (tenant 0 cannot see tenant 5 rows)', async () => {
  const db = makeAuditDb();
  recordAudit(db, { tenant_id: 0, action: 'a', resource: 'r', method: 'POST', path: '/x', status_code: 200 });
  recordAudit(db, { tenant_id: 5, action: 'b', resource: 'r', method: 'POST', path: '/x', status_code: 200 });
  const t0 = await listAudit(db, { tenant_id: 0 });
  const t5 = await listAudit(db, { tenant_id: 5 });
  assert.equal(t0.length, 1);
  assert.equal(t5.length, 1);
  assert.equal(t0[0].action, 'a');
  assert.equal(t5[0].action, 'b');
});

test('listAudit: action filter', async () => {
  const db = makeAuditDb();
  recordAudit(db, { tenant_id: 0, action: 'invoice.create', resource: 'r', method: 'POST', path: '/x', status_code: 201 });
  recordAudit(db, { tenant_id: 0, action: 'payment.create', resource: 'r', method: 'POST', path: '/x', status_code: 201 });
  const rows = await listAudit(db, { tenant_id: 0, action: 'payment.create' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'payment.create');
});

test('listAudit: resource prefix filter', async () => {
  const db = makeAuditDb();
  recordAudit(db, { tenant_id: 0, action: 'a', resource: 'invoice:1', method: 'POST', path: '/x', status_code: 200 });
  recordAudit(db, { tenant_id: 0, action: 'a', resource: 'customer:7', method: 'POST', path: '/x', status_code: 200 });
  const rows = await listAudit(db, { tenant_id: 0, resource_prefix: 'invoice:' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource, 'invoice:1');
});

test('listAudit: limit + offset (most-recent first)', async () => {
  const db = makeAuditDb();
  for (let i = 0; i < 5; i++) {
    recordAudit(db, { tenant_id: 0, action: 'a' + i, resource: 'r', method: 'POST', path: '/x', status_code: 200 });
  }
  const page1 = await listAudit(db, { tenant_id: 0, limit: 2, offset: 0 });
  const page2 = await listAudit(db, { tenant_id: 0, limit: 2, offset: 2 });
  assert.equal(page1.length, 2);
  assert.equal(page2.length, 2);
  // Most-recent first → page1[0] is the highest id.
  assert.ok(page1[0].id > page1[1].id);
  assert.ok(page2[0].id > page2[1].id);
  // Pages don't overlap.
  const ids = new Set([page1[0].id, page1[1].id, page2[0].id, page2[1].id]);
  assert.equal(ids.size, 4);
});
