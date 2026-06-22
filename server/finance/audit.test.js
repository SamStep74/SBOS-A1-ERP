// Tests for the finance audit module (recordAudit + listAudit).
//
// Uses a fresh in-memory sqlite db so each test is hermetic. Mirrors
// the production finance.audit schema (migration 0006).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { recordAudit, listAudit, streamAuditCsv } from './audit.js';

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

test('listAudit: resource_id filter (Wave 29 — matches numeric id anywhere in the resource string)', async () => {
  // Wave 29 makes wrapFinanceRoute record the actual entity id
  // (e.g. 'invoice:42:void' for a POST /invoices/42/void). The
  // resource_id filter matches the numeric id anywhere in the
  // resource string — useful for "what happened to invoice 42?"
  // queries that should include the void, the update, the lines
  // replacement, the payment, etc.
  const db = makeAuditDb();
  recordAudit(db, { tenant_id: 0, action: 'invoice.create', resource: 'invoice:new', method: 'POST', path: '/x', status_code: 201 });
  recordAudit(db, { tenant_id: 0, action: 'invoice.update', resource: 'invoice:42', method: 'PATCH', path: '/x', status_code: 200 });
  recordAudit(db, { tenant_id: 0, action: 'invoice.void', resource: 'invoice:42:void', method: 'POST', path: '/x', status_code: 200 });
  recordAudit(db, { tenant_id: 0, action: 'invoice.update', resource: 'invoice:43', method: 'PATCH', path: '/x', status_code: 200 });
  recordAudit(db, { tenant_id: 0, action: 'customer.update', resource: 'customer:42', method: 'PATCH', path: '/x', status_code: 200 });
  // Filter by id=42 matches invoice:42 (update) + invoice:42:void
  // (void) — NOT invoice:new (no id) and NOT invoice:43 (different
  // id) and NOT customer:42 (different table — the query is
  // substring-based so it matches "customer:42" too; callers
  // should combine with action or resource_prefix for precision).
  const rows = await listAudit(db, { tenant_id: 0, resource_id: 42 });
  assert.equal(rows.length, 3, `expected 3 rows, got ${rows.length}: ${JSON.stringify(rows.map(r => r.resource))}`);
  const resources = rows.map((r) => r.resource).sort();
  assert.deepEqual(resources, ['customer:42', 'invoice:42', 'invoice:42:void']);
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

// ────────────────────────────────────────────────────────────────────────
// Wave 40 — streamAuditCsv (CSV export)
// ────────────────────────────────────────────────────────────────────────

async function consumeStream(gen) {
  const chunks = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks.join('');
}

function seedAudit(db, rows) {
  for (const r of rows) {
    recordAudit(db, r);
  }
}

test('streamAuditCsv: header line + rows are emitted (header first)', async () => {
  const db = makeAuditDb();
  seedAudit(db, [
    { tenant_id: 0, user_id: 1, username: 'admin', action: 'create',
      resource: 'invoice:1', method: 'POST', path: '/api/finance/invoices',
      status_code: 201, payload_json: '{}', request_id: 'r1', created_at: '2026-06-21T10:00:00Z' },
    { tenant_id: 0, user_id: 1, username: 'admin', action: 'update',
      resource: 'invoice:1', method: 'PATCH', path: '/api/finance/invoices/1',
      status_code: 200, payload_json: '{"status":"posted"}', request_id: 'r2', created_at: '2026-06-21T10:01:00Z' },
  ]);
  const csv = await consumeStream(streamAuditCsv(db, { tenant_id: 0 }));
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3, 'expected header + 2 rows');
  // Header columns in the documented order.
  assert.match(lines[0], /^id,tenant_id,user_id,username,action,resource/);
  // Second line is row 1 (id=1).
  assert.match(lines[1], /^1,/);
  assert.match(lines[1], /,create,/);
  // Third line is row 2 (id=2).
  assert.match(lines[2], /^2,/);
  assert.match(lines[2], /,update,/);
});

test('streamAuditCsv: CSV-escapes commas + quotes + newlines in fields', async () => {
  const db = makeAuditDb();
  // payload_json contains a comma, quotes, and a newline.
  // recordAudit reads entry.payload (then JSON.stringifies it).
  const nasty = { note: 'hello, world\nwith "quotes" inside' };
  recordAudit(db, {
    tenant_id: 0, user_id: 7, username: 'eve, the auditor', action: 'create',
    resource: 'invoice:1', method: 'POST', path: '/api/finance/invoices',
    status_code: 201, payload: nasty, request_id: 'r1', created_at: '2026-06-21T10:00:00Z',
  });
  const csv = await consumeStream(streamAuditCsv(db, { tenant_id: 0 }));
  // The username "eve, the auditor" must be quoted in the CSV.
  assert.match(csv, /"eve, the auditor"/);
  // The payload_json (serialized form) contains a comma, embedded
  // " (which CSV escapes as ""), and a newline. The whole field
  // must be wrapped in " ... " with the inner " doubled up.
  // JSON.stringify turns \n into the literal \n inside the JSON
  // string body. So the CSV cell is:
  //   "{""note"":""hello, world\nwith \""quotes\"" inside""}"
  assert.match(csv, /"\{""note"":""hello, world\\nwith \\""quotes\\"" inside""\}"/);
});

test('streamAuditCsv: tenant-scoped (tenant 7 rows are filtered out when querying tenant 0)', async () => {
  const db = makeAuditDb();
  seedAudit(db, [
    { tenant_id: 0, user_id: 1, username: 'a', action: 'create',
      resource: 'invoice:1', method: 'POST', path: '/p',
      status_code: 201, payload_json: null, request_id: null, created_at: '2026-06-21T10:00:00Z' },
    { tenant_id: 7, user_id: 2, username: 'b', action: 'create',
      resource: 'invoice:99', method: 'POST', path: '/p',
      status_code: 201, payload_json: null, request_id: null, created_at: '2026-06-21T10:00:00Z' },
  ]);
  const csv = await consumeStream(streamAuditCsv(db, { tenant_id: 0 }));
  const lines = csv.trim().split('\n');
  // header + 1 row (tenant 7 excluded).
  assert.equal(lines.length, 2);
  // The row should be tenant 0's, not tenant 7's.
  assert.match(lines[1], /^1,0,/);
});

test('streamAuditCsv: honors the same filters as listAudit (action + resource_prefix)', async () => {
  const db = makeAuditDb();
  seedAudit(db, [
    { tenant_id: 0, user_id: 1, username: 'a', action: 'create',
      resource: 'invoice:1', method: 'POST', path: '/p',
      status_code: 201, payload_json: null, request_id: null, created_at: '2026-06-21T10:00:00Z' },
    { tenant_id: 0, user_id: 1, username: 'a', action: 'update',
      resource: 'invoice:1', method: 'PATCH', path: '/p',
      status_code: 200, payload_json: null, request_id: null, created_at: '2026-06-21T10:01:00Z' },
    { tenant_id: 0, user_id: 1, username: 'a', action: 'update',
      resource: 'vendor:5', method: 'PATCH', path: '/p',
      status_code: 200, payload_json: null, request_id: null, created_at: '2026-06-21T10:02:00Z' },
  ]);
  // Filter: action=update + resource_prefix=invoice
  const csv = await consumeStream(streamAuditCsv(db, {
    tenant_id: 0, action: 'update', resource_prefix: 'invoice',
  }));
  const lines = csv.trim().split('\n');
  // header + 1 row (only the invoice update; vendor update is filtered out).
  assert.equal(lines.length, 2);
  assert.match(lines[1], /,update,/);
  assert.match(lines[1], /,invoice:1,/);
});

test('streamAuditCsv: empty result emits only the header line (no spurious blank lines)', async () => {
  const db = makeAuditDb();
  const csv = await consumeStream(streamAuditCsv(db, { tenant_id: 0 }));
  // Just the header, terminated by a newline.
  assert.equal(csv, 'id,tenant_id,user_id,username,action,resource,method,path,status_code,payload_json,request_id,created_at\n');
});

test('streamAuditCsv: chunk size controls the number of yields (rows > chunkSize → multiple yields)', async () => {
  const db = makeAuditDb();
  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push({
      tenant_id: 0, user_id: 1, username: 'a', action: 'create',
      resource: 'invoice:' + i, method: 'POST', path: '/p',
      status_code: 201, payload_json: null, request_id: null,
      created_at: '2026-06-21T10:' + String(i).padStart(2, '0') + ':00Z',
    });
  }
  seedAudit(db, rows);
  // chunkSize=10 + 25 rows → 4 yields:
  //   1 header
  //   2 data chunks of 10 rows each (full chunks)
  //   1 final flush of the leftover 5 rows
  let yields = 0;
  for await (const _chunk of streamAuditCsv(db, { tenant_id: 0 }, 10)) {
    yields++;
  }
  assert.equal(yields, 4);
});

// ────────────────────────────────────────────────────────────────────────
// Wave 50 — full-text search (?q=...)
// ────────────────────────────────────────────────────────────────────────

test('listAudit: ?q matches against the action column', async () => {
  const db = makeAuditDb();
  seedAudit(db, [
    { tenant_id: 0, user_id: 1, username: 'a', action: 'invoice.create',
      resource: 'invoice:1', method: 'POST', path: '/p', status_code: 201,
      payload_json: '{}', request_id: 'r1', created_at: '2026-06-21T10:00:00Z' },
    { tenant_id: 0, user_id: 1, username: 'a', action: 'vendor.create',
      resource: 'vendor:1', method: 'POST', path: '/p', status_code: 201,
      payload_json: '{}', request_id: 'r2', created_at: '2026-06-21T10:01:00Z' },
  ]);
  const out = await listAudit(db, { tenant_id: 0, q: 'invoice' });
  assert.equal(out.length, 1);
  assert.equal(out[0].action, 'invoice.create');
});

test('listAudit: ?q matches against the resource column', async () => {
  const db = makeAuditDb();
  seedAudit(db, [
    { tenant_id: 0, user_id: 1, username: 'a', action: 'update',
      resource: 'customer:42', method: 'PATCH', path: '/p', status_code: 200,
      payload_json: '{}', request_id: 'r1', created_at: '2026-06-21T10:00:00Z' },
    { tenant_id: 0, user_id: 1, username: 'a', action: 'update',
      resource: 'invoice:99', method: 'PATCH', path: '/p', status_code: 200,
      payload_json: '{}', request_id: 'r2', created_at: '2026-06-21T10:01:00Z' },
  ]);
  const out = await listAudit(db, { tenant_id: 0, q: 'customer:42' });
  assert.equal(out.length, 1);
  assert.equal(out[0].resource, 'customer:42');
});

test('listAudit: ?q matches against the payload_json column (compliance drill-down)', async () => {
  const db = makeAuditDb();
  seedAudit(db, [
    { tenant_id: 0, user_id: 1, username: 'a', action: 'update',
      resource: 'customer:42', method: 'PATCH', path: '/p', status_code: 200,
      payload: { email: 'alice@example.com', hvhh: '12345678' },
      request_id: 'r1', created_at: '2026-06-21T10:00:00Z' },
    { tenant_id: 0, user_id: 1, username: 'a', action: 'update',
      resource: 'customer:99', method: 'PATCH', path: '/p', status_code: 200,
      payload: { email: 'bob@example.com' },
      request_id: 'r2', created_at: '2026-06-21T10:01:00Z' },
  ]);
  // Search by payload content (the HVVH field — useful for "show me everywhere
  // HVVH 12345678 appears in audit" investigations).
  const out = await listAudit(db, { tenant_id: 0, q: '12345678' });
  assert.equal(out.length, 1);
  assert.equal(out[0].resource, 'customer:42');
});

test('listAudit: ?q escapes LIKE special characters (% and _)', async () => {
  // If the escaping is wrong, a search for "100%" would match everything
  // (the % is a LIKE wildcard). The escape must neutralize it.
  const db = makeAuditDb();
  seedAudit(db, [
    { tenant_id: 0, user_id: 1, username: 'a', action: 'create',
      resource: 'invoice:1', method: 'POST', path: '/p', status_code: 201,
      payload: { amount: '100%' },
      request_id: 'r1', created_at: '2026-06-21T10:00:00Z' },
    { tenant_id: 0, user_id: 1, username: 'a', action: 'create',
      resource: 'invoice:2', method: 'POST', path: '/p', status_code: 201,
      payload: { amount: '50%' },
      request_id: 'r2', created_at: '2026-06-21T10:01:00Z' },
  ]);
  // Search for "100%" must match ONLY the 100% row, not the 50% row.
  const out = await listAudit(db, { tenant_id: 0, q: '100%' });
  assert.equal(out.length, 1);
  assert.equal(out[0].resource, 'invoice:1');
});

test('listAudit: empty ?q returns all rows (matches when q is missing)', async () => {
  const db = makeAuditDb();
  seedAudit(db, [
    { tenant_id: 0, user_id: 1, username: 'a', action: 'create',
      resource: 'invoice:1', method: 'POST', path: '/p', status_code: 201,
      payload_json: null, request_id: null, created_at: '2026-06-21T10:00:00Z' },
    { tenant_id: 0, user_id: 1, username: 'a', action: 'update',
      resource: 'invoice:1', method: 'PATCH', path: '/p', status_code: 200,
      payload_json: null, request_id: null, created_at: '2026-06-21T10:01:00Z' },
  ]);
  const out = await listAudit(db, { tenant_id: 0, q: '' });
  assert.equal(out.length, 2, 'empty q should behave like no q filter');
});

test('listAudit: ?q is tenant-scoped (does not leak across tenants)', async () => {
  const db = makeAuditDb();
  seedAudit(db, [
    { tenant_id: 0, user_id: 1, username: 'a', action: 'create',
      resource: 'invoice:1', method: 'POST', path: '/p', status_code: 201,
      payload: { note: 'shared-keyword' },
      request_id: 'r1', created_at: '2026-06-21T10:00:00Z' },
    { tenant_id: 7, user_id: 2, username: 'b', action: 'create',
      resource: 'invoice:99', method: 'POST', path: '/p', status_code: 201,
      payload: { note: 'shared-keyword' },
      request_id: 'r2', created_at: '2026-06-21T10:00:00Z' },
  ]);
  // Tenant 0 searching for "shared-keyword" should see only its own row.
  const out0 = await listAudit(db, { tenant_id: 0, q: 'shared-keyword' });
  assert.equal(out0.length, 1);
  assert.equal(Number(out0[0].tenant_id), 0);
  // Tenant 7 sees only its own.
  const out7 = await listAudit(db, { tenant_id: 7, q: 'shared-keyword' });
  assert.equal(out7.length, 1);
  assert.equal(Number(out7[0].tenant_id), 7);
});
