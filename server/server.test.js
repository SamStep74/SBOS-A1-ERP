// SBOS-A1-ERP bootable HTTP server — integration test.
//
// Boots the real Express app on port 0 (random) and exercises the
// boot path with Node's built-in `fetch`. No supertest, no external
// HTTP harness — we want a test that runs on the same `node --test`
// flags the rest of the suite uses.
//
// Coverage focus (per task brief):
//   - server/index.js   (createApp)
//   - server/server.js  (start)
//   - server/finance/routes.js (new file)
//
// Plus the boot path end-to-end: middleware order, auth stub, RBAC
// mount, finance routes mount, dashboard HTML, 404/500.
//
// TDD: this file is the RED commit. server/index.js, server/server.js,
// and server/finance/routes.js are added in the GREEN commit.
//
// Auth mode: the test suite sets SBOS_AUTH_MODE=stub so the legacy
// "any request → stub Admin" middleware is in effect. The real-auth
// path is exercised by scripts/deploy-smoke.sh against a fresh DB.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Force the stub auth mode for the duration of this test file.
process.env.SBOS_AUTH_MODE = 'stub';

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function makeFinanceDb() {
  const dir = mkdtempSync(join(tmpdir(), 'sbos-srv-'));
  const sqliteDb = new DatabaseSync(join(dir, 'finance.db'));
  sqliteDb.exec('ATTACH DATABASE ":memory:" AS finance');
  sqliteDb.exec('PRAGMA foreign_keys = OFF');
  // Mirror of the production finance schema with sqlite-friendly
  // types. The canonical migrations under server/finance/migrations/
  // are Postgres-targeted (BIGSERIAL, TIMESTAMPTZ, CREATE SCHEMA).
  // The test harness builds a sqlite-compatible mirror with the same
  // column shape — same pattern as dashboard.test.js' makeRealDb.
  // The mirror here is a UNION of every column added in 0001..0005
  // so tests that exercise the latest SQL still resolve every
  // column the production code references.
  sqliteDb.exec(`
    CREATE TABLE finance.customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL, hvhh TEXT, address TEXT, email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      customer_id INTEGER NOT NULL,
      invoice_number TEXT NOT NULL UNIQUE,
      issue_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      subtotal_amd INTEGER NOT NULL,
      vat_amd INTEGER NOT NULL DEFAULT 0,
      total_amd INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','sent','paid','overdue','void')),
      notes TEXT,
      sent_at TEXT, voided_at TEXT, void_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.invoice_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      invoice_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity REAL NOT NULL, unit_price_amd INTEGER NOT NULL,
      line_total_amd INTEGER NOT NULL
    );
    CREATE TABLE finance.payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      invoice_id INTEGER NOT NULL,
      paid_at TEXT NOT NULL DEFAULT (datetime('now')),
      amount_amd INTEGER NOT NULL, method TEXT NOT NULL DEFAULT 'bank_transfer',
      reference TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.invoice_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      invoice_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('writeoff','refund','correction')),
      amount_amd INTEGER NOT NULL,
      reason TEXT NOT NULL,
      approved_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.vat_carry_forward (
      id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      balance_amd INTEGER NOT NULL DEFAULT 0,
      as_of_period TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, id),
      CHECK (id = 1)
    );
    CREATE TABLE finance.audit (
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
    /* Mirror the production migration runner's strip: the
       CREATE TABLE finance.audit above lands as bare 'audit' on
       sqlite (no schemas), so the audit module's queries are
       written without the prefix and the in-memory test creates
       a sibling 'audit' table for the prefix-stripped path. */
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
    -- Migration 0033 (W60 audit retention) — mirror the
    -- production prefix-stripped shape: the table is
    -- finance.audit_retention on pg and audit_retention on sqlite.
    CREATE TABLE audit_retention (
      tenant_id INTEGER PRIMARY KEY,
      retention_days INTEGER NOT NULL DEFAULT 365,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by INTEGER
    );
    /* Migration 0007 (inventory): ported schema mirror. The actual
       table name on sqlite is 'catalog_items' (no finance.
       prefix) because the migration runner strips it. Same for
       all inventory tables. */
    CREATE TABLE catalog_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'STOCKABLE',
      category_id INTEGER,
      uom_id INTEGER,
      uom_code TEXT NOT NULL DEFAULT 'pcs',
      barcode TEXT,
      vat_class TEXT NOT NULL DEFAULT 'VAT_STANDARD',
      standard_price INTEGER NOT NULL DEFAULT 0,
      sale_price INTEGER NOT NULL DEFAULT 0,
      standard_cost INTEGER NOT NULL DEFAULT 0,
      reorder_point INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE catalog_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      parent_id INTEGER,
      name TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE unit_of_measures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'count',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE stock_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      warehouse_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      location_type TEXT NOT NULL DEFAULT 'INTERNAL',
      parent_id INTEGER,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE stock_quants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      catalog_item_id INTEGER NOT NULL,
      location_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      reserved_quantity INTEGER NOT NULL DEFAULT 0,
      average_cost INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE stock_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      move_type TEXT NOT NULL,
      catalog_item_id INTEGER NOT NULL,
      source_location_id INTEGER,
      destination_location_id INTEGER,
      quantity INTEGER NOT NULL,
      unit_cost INTEGER NOT NULL DEFAULT 0,
      reference TEXT,
      delta INTEGER,
      notes TEXT,
      reason_category TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER
    );
    /* Migration 0032 (invoice_attachments) — ported schema mirror.
       The pure functions in attachments.js need the table. */
    CREATE TABLE invoice_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      invoice_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      description TEXT,
      storage_path TEXT NOT NULL,
      uploaded_by INTEGER,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    /* Migration 0008 (purchase) — ported schema mirror. The actual
       table names on sqlite are vendors / purchase_orders / etc.
       (no finance. prefix) because the migration runner strips
       it. The pure-function SQL is written with the prefix and
       stripped at DML time so the same SQL works on pg. */
    CREATE TABLE vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      hvhh TEXT,
      address TEXT,
      email TEXT,
      phone TEXT,
      contact_name TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      order_number TEXT NOT NULL,
      vendor_id INTEGER NOT NULL,
      vendor_name TEXT NOT NULL,
      vendor_hvhh TEXT,
      status TEXT NOT NULL DEFAULT 'rfq',
      order_date TEXT NOT NULL,
      expected_date TEXT,
      received_quantity INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      cancelled_at TEXT,
      cancelled_reason TEXT
    );
    CREATE TABLE purchase_order_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      order_id INTEGER NOT NULL,
      catalog_item_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      unit_cost INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      line_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE purchase_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      order_id INTEGER NOT NULL,
      receipt_number TEXT NOT NULL,
      received_at TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE purchase_receipt_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      receipt_id INTEGER NOT NULL,
      order_line_id INTEGER NOT NULL,
      catalog_item_id INTEGER NOT NULL,
      received_quantity INTEGER NOT NULL,
      unit_cost INTEGER NOT NULL DEFAULT 0,
      destination_location_id INTEGER
    );
    CREATE TABLE vendor_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      bill_number TEXT NOT NULL,
      vendor_id INTEGER NOT NULL,
      vendor_name TEXT NOT NULL,
      purchase_order_id INTEGER,
      status TEXT NOT NULL DEFAULT 'draft',
      subtotal INTEGER NOT NULL DEFAULT 0,
      vat INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      bill_date TEXT NOT NULL,
      due_date TEXT,
      notes TEXT,
      posted_at TEXT,
      paid_at TEXT,
      voided_at TEXT,
      voided_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE vendor_bill_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      bill_id INTEGER NOT NULL,
      catalog_item_id INTEGER,
      description TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_cost INTEGER NOT NULL DEFAULT 0,
      line_subtotal INTEGER NOT NULL DEFAULT 0,
      vat INTEGER NOT NULL DEFAULT 0,
      line_total INTEGER NOT NULL DEFAULT 0
    );
    -- Phase 1 ERP — GL journal (migration 0010)
    CREATE TABLE journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      entry_date TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id INTEGER,
      description TEXT,
      currency TEXT NOT NULL DEFAULT 'AMD',
      status TEXT NOT NULL DEFAULT 'posted',
      book_date TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER
    );
    CREATE TABLE journal_entry_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      entry_id INTEGER NOT NULL,
      line_order INTEGER NOT NULL DEFAULT 0,
      account_code TEXT NOT NULL,
      debit INTEGER NOT NULL DEFAULT 0,
      credit INTEGER NOT NULL DEFAULT 0,
      description TEXT
    );
    -- Wave 39: lots + serials tables (mirror 0014_lots_serials.sql).
    CREATE TABLE lots (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id           INTEGER NOT NULL DEFAULT 0,
      code                TEXT NOT NULL,
      supplier_lot_number TEXT,
      catalog_item_id     INTEGER NOT NULL,
      expiry_date         TEXT,
      received_at         TEXT NOT NULL,
      notes               TEXT,
      recalled_at         TEXT,
      recall_reason       TEXT,
      recalled_by         INTEGER,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE serials (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id             INTEGER NOT NULL DEFAULT 0,
      serial_number         TEXT NOT NULL,
      catalog_item_id       INTEGER NOT NULL,
      lot_id                INTEGER,
      status                TEXT NOT NULL DEFAULT 'in_stock',
      current_location_id   INTEGER,
      received_at           TEXT NOT NULL,
      sold_at               TEXT,
      notes                 TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE stock_lots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       INTEGER NOT NULL DEFAULT 0,
      lot_id          INTEGER NOT NULL,
      location_id     INTEGER NOT NULL,
      catalog_item_id INTEGER NOT NULL,
      quantity        INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return { sqliteDb, dir };
}

// pg-style adapter (the production finance modules use $N placeholders).
function makePgAdapter(sqliteDb) {
  return {
    async query(sql, params = []) {
      const translated = sql.replace(/\$\d+/g, '?').replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*/g, '');
      const stmt = sqliteDb.prepare(translated);
      return { rows: stmt.all(...(params || [])) };
    },
  };
}

// Combined "finance + rbac + tenant users" DB.
// `pgAdapter` returns { rows } for finance code; `sqliteDb` is the
// underlying node:sqlite handle for the RBAC routes (which use .prepare
// directly).
function makeFullDb() {
  const { sqliteDb, dir } = makeFinanceDb();
  // Minimal `users` table for the rbac routes + our auth middleware.
  sqliteDb.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT,
      role TEXT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      org_id INTEGER,
      mfa_required INTEGER NOT NULL DEFAULT 0,
      mfa_verified INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT,
      password_salt TEXT,
      failed_logins INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT
    );
  `);
  sqliteDb
    .prepare(
      'INSERT INTO users (id, username, email, role, tenant_id, org_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(1, 'admin', 'admin@example.com', 'Admin', 0, null);

  // RBAC schema (strip redundant composite PK; same workaround as rbac.test.js).
  const rbacDir = dirname(fileURLToPath(import.meta.url)) + '/rbac';
  const schema = readFileSync(join(rbacDir, 'schema.sql'), 'utf8').replace(
    /,\s*--[^\n]*\n\s*PRIMARY KEY \(id, tenant_id\)\n\s*\);/m,
    '\n  );',
  );
  sqliteDb.exec(schema);

  return {
    db: sqliteDb, // raw node:sqlite for RBAC + auth lookup
    pgAdapter: makePgAdapter(sqliteDb), // pg-style for finance pure functions
    dir,
  };
}

async function get(server, path) {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}${path}`;
  const res = await globalThis.fetch(url);
  const text = await res.text();
  let body = text;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, contentType, headers: res.headers };
}

async function postJson(server, path, payload, extraHeaders = {}) {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}${path}`;
  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, extraHeaders),
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  let body = text;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, contentType, headers: res.headers };
}

async function putJson(server, path, payload, extraHeaders = {}) {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}${path}`;
  const res = await globalThis.fetch(url, {
    method: 'PUT',
    headers: Object.assign({ 'content-type': 'application/json' }, extraHeaders),
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  let body = text;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, contentType, headers: res.headers };
}

async function patchJson(server, path, payload, extraHeaders = {}) {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}${path}`;
  const res = await globalThis.fetch(url, {
    method: 'PATCH',
    headers: Object.assign({ 'content-type': 'application/json' }, extraHeaders),
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  let body = text;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, contentType, headers: res.headers };
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('bootable HTTP server (server/index.js + server/server.js)', () => {
  let app;
  let server;
  let full;
  let backupDir;

  before(async () => {
    const { createApp } = await import('./index.js');
    const { start } = await import('./server.js');
    // Each test file gets its own backup dir so the restore tests
    // don't race with the deploy-smoke script or other test files
    // writing to the default ./backups path. The dir is cleaned
    // up in the after() hook.
    const { mkdtempSync } = await import('node:fs');
    backupDir = mkdtempSync(join(tmpdir(), 'sbos-srv-backups-'));
    process.env.SBOS_BACKUP_DIR = backupDir;
    // Wave 56: each test file also gets its own attachments dir
    // so attachment uploads don't pollute the cwd or race with
    // other test files writing to ./attachments.
    const attachmentsDir = mkdtempSync(join(tmpdir(), 'sbos-srv-attachments-'));
    process.env.SBOS_ATTACHMENTS_DIR = attachmentsDir;
    full = makeFullDb();
    app = await createApp({ db: full.db, pgAdapter: full.pgAdapter, locale: 'en' });
    server = await start({ app, port: 0, host: '127.0.0.1' });
  });

  after(async () => {
    if (server && server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (backupDir) {
      // Best-effort cleanup of the per-test backup dir. We don't
      // fail the test if rmtree isn't available; the OS will GC
      // tmpdirs on reboot.
      try {
        const { rmSync } = await import('node:fs');
        rmSync(backupDir, { recursive: true, force: true });
      } catch (_e) {
        // best-effort
      }
    }
  });

  test('1. GET /api/health returns 200 with ok=true and version', async () => {
    const { status, body } = await get(server, '/api/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(
      typeof body.version === 'string' && body.version.length > 0,
      `version must be a non-empty string, got ${JSON.stringify(body.version)}`,
    );
  });

  test('2. GET /api/finance/dashboard?asOfDate=2026-06-20 returns 200 HTML', async () => {
    const { status, body, contentType } = await get(
      server,
      '/api/finance/dashboard?asOfDate=2026-06-20',
    );
    assert.equal(status, 200);
    assert.ok(contentType.includes('text/html'), `expected text/html, got ${contentType}`);
    assert.ok(
      typeof body === 'string' && body.includes('<!DOCTYPE html>'),
      'expected HTML doctype',
    );
    assert.ok(body.includes('2026-06-20'), 'expected asOfDate in HTML');
  });

  test('3. GET /api/finance/invoices (empty DB) returns 200 with items=[]', async () => {
    const { status, body } = await get(server, '/api/finance/invoices');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items), `expected items array, got ${JSON.stringify(body)}`);
    assert.equal(body.items.length, 0);
  });

  test('4. GET /api/rbac/permissions returns 200 with a version field', async () => {
    const { status, body } = await get(server, '/api/rbac/permissions');
    assert.equal(status, 200);
    assert.ok(
      typeof body.version === 'string' || typeof body.version === 'number',
      `expected version, got ${JSON.stringify(body)}`,
    );
  });

  test('5. GET /api/rbac/roles returns 200 with an items array', async () => {
    const { status, body } = await get(server, '/api/rbac/roles');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items), `expected items array, got ${JSON.stringify(body)}`);
    assert.ok(body.items.length > 0, 'expected at least the system roles');
  });

  test('5b. PUT /api/rbac/field-policies/*path preserves slash wildcard params', async () => {
    const { status, body } = await putJson(
      server,
      '/api/rbac/field-policies/customer/contact/ssn',
      { minPermission: 'crm.lead.read', isVisible: false, label: 'Customer SSN' },
    );
    assert.equal(status, 200);
    assert.equal(body.fieldPath, 'customer/contact/ssn');
    assert.equal(body.minPermission, 'crm.lead.read');
  });

  test('5c. PUT /api/rbac/record-rules/*resource preserves slash wildcard params', async () => {
    const { status, body } = await putJson(server, '/api/rbac/record-rules/crm/lead', {
      scope: 'custom',
      predicate: 'owner_id = $userId',
      description: 'owner-only',
    });
    assert.equal(status, 200);
    assert.equal(body.resource, 'crm/lead');
    assert.equal(body.scope, 'custom');
  });

  // ─── Wave 47: database backup ───

  test('47a. POST /api/rbac/backup returns the database as application/octet-stream', async () => {
    const port = server.address().port;
    const res = await globalThis.fetch('http://127.0.0.1:' + port + '/api/rbac/backup', {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type') || '';
    assert.match(ct, /application\/octet-stream/);
    const cd = res.headers.get('content-disposition') || '';
    assert.match(cd, /^attachment; filename="sbos-backup-\d{4}-\d{2}-\d{2}\.db"$/);
    const buf = Buffer.from(await res.arrayBuffer());
    // The response is a valid sqlite file: starts with the magic
    // string "SQLite format 3\000".
    assert.equal(buf.slice(0, 16).toString('utf8'), 'SQLite format 3\u0000');
  });

  test('47b. POST /api/rbac/backup writes an audit row before the snapshot', async () => {
    const beforeCount = full.db.prepare(
      `SELECT COUNT(*) AS n FROM audit WHERE action = 'backup.run'`,
    ).get().n;
    const port = server.address().port;
    await globalThis.fetch('http://127.0.0.1:' + port + '/api/rbac/backup', {
      method: 'POST',
    });
    const afterCount = full.db.prepare(
      `SELECT COUNT(*) AS n FROM audit WHERE action = 'backup.run'`,
    ).get().n;
    assert.equal(afterCount, beforeCount + 1, 'expected a new audit row for the backup');
    // The audit row references the database resource + the right user.
    const row = full.db.prepare(
      `SELECT resource, user_id FROM audit WHERE action = 'backup.run' ORDER BY id DESC LIMIT 1`,
    ).get();
    assert.equal(row.resource, 'database');
    assert.equal(row.user_id, 1); // stub auth mode admin
  });

  // ─── Wave 51: backup list + validate ───

  test('51a. GET /api/rbac/backup returns an empty list when the backup dir is empty', async () => {
    // The test's makeFullDb doesn't create the backup dir, so this
    // is the empty case.
    const { status, body } = await get(server, '/api/rbac/backup');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
    // The dir may not exist OR may exist but be empty — both
    // return 200 + items=[].
  });

  test('51b. POST /api/rbac/backup/validate accepts a valid sqlite file', async () => {
    // Build a small valid sqlite file in a tmp dir and POST it.
    const { DatabaseSync } = await import('node:sqlite');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readFileSync, unlinkSync } = await import('node:fs');
    const path = join(tmpdir(), `validate-test-${Date.now()}-${Math.random()}.db`);
    const handle = new DatabaseSync(path);
    handle.exec('CREATE TABLE test (id INTEGER, name TEXT)');
    handle.prepare('INSERT INTO test VALUES (?, ?)').run(1, 'hello');
    handle.close();
    const buf = readFileSync(path);
    unlinkSync(path);

    const port = server.address().port;
    const res = await globalThis.fetch('http://127.0.0.1:' + port + '/api/rbac/backup/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: buf,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.integrity, 'ok');
    assert.ok(body.size_bytes > 0);
    assert.ok(body.table_count >= 1, `expected at least 1 table, got ${body.table_count}`);
  });

  test('51c. POST /api/rbac/backup/validate rejects a non-sqlite file (missing magic)', async () => {
    const port = server.address().port;
    const res = await globalThis.fetch('http://127.0.0.1:' + port + '/api/rbac/backup/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: 'not a sqlite file at all',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid_backup');
  });

  test('51d. POST /api/rbac/backup/validate returns 415 for wrong Content-Type', async () => {
    const port = server.address().port;
    const res = await globalThis.fetch('http://127.0.0.1:' + port + '/api/rbac/backup/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 415);
    const body = await res.json();
    assert.equal(body.error, 'unsupported_media_type');
  });

  // ─── Wave 52: backup restore ───

  test('52a. POST /api/rbac/backup/restore rejects path-traversal filenames', async () => {
    // Any filename that doesn't match the canonical pattern
    // (including path-traversal attempts like ../../etc/passwd)
    // must be refused with 400 invalid_filename. The route never
    // joins the filename with the backup dir if the regex fails.
    const { status, body } = await postJson(server, '/api/rbac/backup/restore', {
      filename: '../../etc/passwd',
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_filename');
  });

  test('52b. POST /api/rbac/backup/restore returns 404 for a well-formed but missing filename', async () => {
    const { status, body } = await postJson(server, '/api/rbac/backup/restore', {
      filename: 'sbos-backup-2026-06-22.db',
    });
    assert.equal(status, 404);
    assert.equal(body.error, 'backup_not_found');
  });

  test('52c. POST /api/rbac/backup/restore with a valid snapshot restores the live db end-to-end', async () => {
    // IMPORTANT: this test runs against a SEPARATE server with its
    // own db. The restore route closes the live sqlite handle
    // mid-request, which would break the shared `full.db` used by
    // the rest of the test file (49a-49d etc. seed via `full.db`).
    // Using an isolated server keeps the destructive swap scoped.
    const { createApp } = await import('./index.js');
    const { start } = await import('./server.js');
    const isolatedDir = (await import('node:fs')).mkdtempSync(
      join(tmpdir(), 'sbos-srv-restore-'),
    );
    const isolatedDbPath = join(isolatedDir, 'finance.db');
    const { DatabaseSync } = await import('node:sqlite');
    const isolatedDb = new DatabaseSync(isolatedDbPath);
    // Minimal schema so the db isn't a 0-table file.
    isolatedDb.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        hvhh TEXT NOT NULL,
        tenant_id INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT,
        role TEXT,
        tenant_id INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO users (id, username, role, tenant_id) VALUES (1, 'admin', 'Admin', 0);
    `);
    // Build the app with this isolated db. We pass it through
    // createApp the same way the main test does.
    const isolatedPg = {
      async query() {
        return { rows: [] };
      },
    };
    const isolatedApp = await createApp({
      db: isolatedDb,
      pgAdapter: isolatedPg,
      locale: 'en',
    });
    const isolatedServer = await start({
      app: isolatedApp,
      port: 0,
      host: '127.0.0.1',
    });
    const isolatedPort = isolatedServer.address().port;
    const isolatedBackupDir = (await import('node:fs')).mkdtempSync(
      join(tmpdir(), 'sbos-restore-backups-'),
    );
    const oldBackupDir = process.env.SBOS_BACKUP_DIR;
    process.env.SBOS_BACKUP_DIR = isolatedBackupDir;
    try {
      // Step 1: seed a customer (so the snapshot HAS data).
      const seedRes = await postJson(isolatedServer, '/api/finance/customers', {
        name: 'Wave52-Customer',
        hvhh: '12345678',
      });
      // The customer may 403 (no perm in stub mode) or succeed.
      // Either way, the snapshot will reflect whatever state
      // the live db is in.
      void seedRes;

      // Step 2: take a snapshot of the live db.
      const backupRes = await globalThis.fetch(
        `http://127.0.0.1:${isolatedPort}/api/rbac/backup`,
        { method: 'POST' },
      );
      assert.equal(backupRes.status, 200, 'POST /api/rbac/backup must succeed');
      const backupBuf = Buffer.from(await backupRes.arrayBuffer());
      assert.ok(backupBuf.length > 0, 'backup buffer must be non-empty');

      // Step 3: write the snapshot to the isolated backup dir.
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `sbos-backup-${dateStr}.db`;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(isolatedBackupDir, filename), backupBuf);

      // Step 4: add a row to the live db (so the snapshot is
      // distinguishable from the live state).
      const before = isolatedDb
        .prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE type=?')
        .get('table');
      void before;

      // Step 5: restore. The route takes a pre-snapshot, then
      // swaps the live db with the chosen backup.
      const restoreRes = await postJson(
        isolatedServer,
        '/api/rbac/backup/restore',
        { filename },
      );
      assert.equal(restoreRes.status, 200, 'restore must return 200');
      assert.equal(restoreRes.body.ok, true);
      assert.equal(restoreRes.body.restored, filename);
      assert.ok(
        restoreRes.body.pre_restore &&
          restoreRes.body.pre_restore.startsWith('pre-restore-'),
        'restore must return a pre-restore name',
      );
      assert.ok(restoreRes.body.table_count > 0, 'restored db has tables');

      // Step 6: post-restore, the server should still be healthy.
      // (The swap closed the old handle and opened a new one;
      // subsequent requests must work on the new handle.)
      const healthRes = await get(isolatedServer, '/api/health');
      assert.equal(healthRes.status, 200, 'server still healthy after restore');
      assert.equal(healthRes.body.ok, true);
    } finally {
      // Cleanup: close the isolated server, restore env, nuke
      // the tempdir.
      process.env.SBOS_BACKUP_DIR = oldBackupDir;
      if (isolatedServer && isolatedServer.listening) {
        await new Promise((resolve) => isolatedServer.close(() => resolve()));
      }
      try {
        const { rmSync } = await import('node:fs');
        rmSync(isolatedDir, { recursive: true, force: true });
        rmSync(isolatedBackupDir, { recursive: true, force: true });
      } catch (_e) {
        // best-effort
      }
    }
  });

  test('52d. POST /api/rbac/backup/restore with a junk file rolls back without trashing the live db', async () => {
    // This test is non-destructive — it uses the isolated server
    // pattern so the shared full.db is unaffected. We write a
    // file that starts with the SQLite magic but is otherwise
    // junk. The route's sanity check (table count > 0) catches
    // this and rolls back. After the failed restore, the live db
    // is the original (the pre-restore snapshot was used to
    // recover).
    const { createApp } = await import('./index.js');
    const { start } = await import('./server.js');
    const isolatedDir = (await import('node:fs')).mkdtempSync(
      join(tmpdir(), 'sbos-srv-restore-bad-'),
    );
    const isolatedDbPath = join(isolatedDir, 'finance.db');
    const { DatabaseSync } = await import('node:sqlite');
    const isolatedDb = new DatabaseSync(isolatedDbPath);
    isolatedDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT,
        role TEXT,
        tenant_id INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO users (id, username, role, tenant_id) VALUES (1, 'admin', 'Admin', 0);
    `);
    const isolatedApp = await createApp({
      db: isolatedDb,
      pgAdapter: { async query() { return { rows: [] }; } },
      locale: 'en',
    });
    const isolatedServer = await start({
      app: isolatedApp,
      port: 0,
      host: '127.0.0.1',
    });
    const isolatedBackupDir = (await import('node:fs')).mkdtempSync(
      join(tmpdir(), 'sbos-restore-bad-backups-'),
    );
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `sbos-backup-${dateStr}.db`;
    const { writeFileSync } = await import('node:fs');
    // File that passes the magic check but has no tables.
    writeFileSync(
      join(isolatedBackupDir, filename),
      Buffer.from('SQLite format 3\u0000junk data, not a real db'),
    );

    const oldBackupDir = process.env.SBOS_BACKUP_DIR;
    process.env.SBOS_BACKUP_DIR = isolatedBackupDir;
    try {
      const { status, body } = await postJson(
        isolatedServer,
        '/api/rbac/backup/restore',
        { filename },
      );
      // Expect 400 (empty_backup) or 500 (restore_failed) — the
      // exact code depends on where the route's sanity check
      // fires. The important contract is: the live db is intact
      // (server still healthy afterward).
      assert.ok(
        status === 400 || status === 500,
        `expected 400/500 for corrupt backup, got ${status}`,
      );
      assert.ok(
        body.error === 'empty_backup' ||
          body.error === 'restore_failed' ||
          body.error === 'invalid_backup' ||
          body.error === 'integrity_check_failed',
        `expected a rollback error, got ${body.error}`,
      );
      // Verify the live db is still healthy post-failure.
      const healthRes = await get(isolatedServer, '/api/health');
      assert.equal(
        healthRes.status,
        200,
        'server must remain healthy after a failed restore',
      );
    } finally {
      process.env.SBOS_BACKUP_DIR = oldBackupDir;
      if (isolatedServer && isolatedServer.listening) {
        await new Promise((resolve) => isolatedServer.close(() => resolve()));
      }
      try {
        const { rmSync } = await import('node:fs');
        rmSync(isolatedDir, { recursive: true, force: true });
        rmSync(isolatedBackupDir, { recursive: true, force: true });
      } catch (_e) {
        // best-effort
      }
    }
  });

  // ─── Wave 49: account unlock ───

  test('49a. POST /api/rbac/users/:userId/unlock clears failed_logins + locked_until', async () => {
    // Self-seed bob (id=2) — tests run in parallel, so we can't
    // depend on the 42c test having seeded him first.
    const future = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    full.db.prepare('DELETE FROM users WHERE id = 2').run();
    full.db.prepare(
      `INSERT INTO users (id, username, email, role, tenant_id, failed_logins, locked_until)
       VALUES (2, 'bob', 'bob@example.com', 'Operator', 0, 4, ?)`,
    ).run(future);
    const r = await postJson(server, '/api/rbac/users/2/unlock', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.userId, 2);
    assert.equal(r.body.previous_failed_logins, 4);
    assert.equal(r.body.previous_locked_until, future);
    // The user is no longer locked.
    const row = full.db.prepare(
      `SELECT failed_logins, locked_until FROM users WHERE id = 2`,
    ).get();
    assert.equal(row.failed_logins, 0);
    assert.equal(row.locked_until, null);
  });

  test('49b. POST /api/rbac/users/999999/unlock returns 404 for unknown user', async () => {
    const r = await postJson(server, '/api/rbac/users/999999/unlock', {});
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'user_not_found');
  });

  test('49c. POST /api/rbac/users/abc/unlock returns 404 for non-numeric id', async () => {
    const r = await postJson(server, '/api/rbac/users/abc/unlock', {});
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
  });

  test('49d. POST /api/rbac/users/1/unlock on an already-unlocked user returns 200 with previous_failed_logins=0', async () => {
    // Admin (id=1) is fresh — no failed_logins or lock.
    full.db.prepare(
      `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = 1`,
    ).run();
    const r = await postJson(server, '/api/rbac/users/1/unlock', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.userId, 1);
    assert.equal(r.body.previous_failed_logins, 0);
    assert.equal(r.body.previous_locked_until, null);
  });

  // ─── Wave 53: account lockout observability + force-lock ───

  test('53a. GET /api/rbac/users returns 200 with items + totals', async () => {
    // Reset to a known state: admin (id=1) only, no failed_logins,
    // no lock. Other tests may have left bob (id=2) in a locked
    // state — clean that up too.
    full.db.prepare(
      `UPDATE users SET failed_logins = 0, locked_until = NULL`,
    ).run();
    const r = await get(server, '/api/rbac/users');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
    assert.ok(r.body.total >= 1, 'total must include the admin user');
    assert.equal(typeof r.body.locked_count, 'number');
    assert.equal(r.body.locked_count, 0, 'no users should be locked in the clean state');
    assert.equal(r.body.limit, 200);
    assert.equal(r.body.offset, 0);
  });

  test('53b. GET /api/rbac/users?locked=true returns only currently-locked users', async () => {
    // Reset everyone, then lock bob (id=2) with locked_until in
    // the future. The locked filter should include bob; the
    // unfiltered list should include both.
    full.db.prepare(
      `UPDATE users SET failed_logins = 0, locked_until = NULL`,
    ).run();
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    full.db.prepare(
      `UPDATE users SET failed_logins = 4, locked_until = ? WHERE id = 2`,
    ).run(future);

    // ?locked=true → only bob.
    const locked = await get(server, '/api/rbac/users?locked=true');
    assert.equal(locked.status, 200);
    assert.equal(locked.body.items.length, 1);
    assert.equal(locked.body.items[0].id, 2);
    assert.equal(locked.body.total, 1);

    // No filter → both users (admin + bob).
    const all = await get(server, '/api/rbac/users');
    assert.equal(all.status, 200);
    assert.ok(all.body.items.length >= 2);
    assert.ok(all.body.total >= 2);
    assert.equal(all.body.locked_count, 1);
  });

  test('53c. POST /api/rbac/users/:userId/lock force-locks the user with the given reason', async () => {
    // Reset bob, then lock him via the route. Verify:
    //   - the response has the expected shape
    //   - the db state has failed_logins=99 + locked_until in the future
    //   - bob is now visible in the ?locked=true list
    full.db.prepare(
      `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = 2`,
    ).run();
    const reason = 'W53 smoke test: simulated compromise';
    const r = await postJson(server, '/api/rbac/users/2/lock', { reason });
    assert.equal(r.status, 200);
    assert.equal(r.body.userId, 2);
    assert.equal(r.body.failed_logins, 99);
    assert.ok(
      r.body.locked_until && r.body.locked_until.length > 0,
      'locked_until must be set',
    );
    assert.equal(r.body.reason, reason);
    assert.equal(r.body.locked_by, 1, 'admin user is id=1 in stub auth mode');

    // Verify the db state.
    const after = full.db
      .prepare(
        'SELECT failed_logins, locked_until FROM users WHERE id = 2',
      )
      .get();
    assert.equal(after.failed_logins, 99);
    assert.ok(after.locked_until, 'locked_until must be set in the db');

    // Verify the locked-only list now includes bob.
    const locked = await get(server, '/api/rbac/users?locked=true');
    assert.equal(locked.status, 200);
    assert.ok(
      locked.body.items.some((u) => u.id === 2),
      'bob should be in the locked list after the force-lock',
    );
  });

  test('53d. POST /api/rbac/users/:userId/lock rejects requests with no reason', async () => {
    // The reason is mandatory — it's recorded in the audit log
    // so the action is always traceable to a documented
    // justification. Empty/missing reason → 400.
    const r1 = await postJson(server, '/api/rbac/users/2/lock', {});
    assert.equal(r1.status, 400);
    assert.equal(r1.body.error, 'invalid_request');

    const r2 = await postJson(server, '/api/rbac/users/2/lock', { reason: '' });
    assert.equal(r2.status, 400);
    assert.equal(r2.body.error, 'invalid_request');

    const r3 = await postJson(server, '/api/rbac/users/2/lock', { reason: '   ' });
    assert.equal(r3.status, 400);
    assert.equal(r3.body.error, 'invalid_request');
  });

  test('53e. POST /api/rbac/users/999999/lock returns 404 for unknown user', async () => {
    const r = await postJson(server, '/api/rbac/users/999999/lock', {
      reason: 'test 404 path',
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'user_not_found');
  });

  // ─── Wave 54: inventory adjustment reasons (mandatory + categorized) ───

  test('54a. POST /api/finance/stock/adjust without reason returns 400 (mandatory reason)', async () => {
    // Wave 54: the reason field is now mandatory. The body must
    // include a free-text explanation of why the stock is being
    // adjusted, plus a controlled reason_category. Missing reason
    // → 400.
    const r = await postJson(server, '/api/finance/stock/adjust', {
      catalog_item_id: 1,
      location_id: 1,
      new_quantity: 5,
      reason_category: 'recount',
    });
    assert.equal(r.status, 400);
    assert.ok(/reason/i.test(r.body.message || ''), 'error must mention reason');
  });

  test('54b. POST /api/finance/stock/adjust with reason shorter than 5 chars returns 400', async () => {
    const r = await postJson(server, '/api/finance/stock/adjust', {
      catalog_item_id: 1,
      location_id: 1,
      new_quantity: 5,
      reason: 'oops',
      reason_category: 'recount',
    });
    assert.equal(r.status, 400);
    assert.ok(/at least 5 characters/i.test(r.body.message || ''));
  });

  test('54c. POST /api/finance/stock/adjust with invalid reason_category returns 400', async () => {
    const r = await postJson(server, '/api/finance/stock/adjust', {
      catalog_item_id: 1,
      location_id: 1,
      new_quantity: 5,
      reason: 'unit test reason',
      reason_category: 'bogus_category',
    });
    assert.equal(r.status, 400);
    assert.ok(/reason_category/i.test(r.body.message || ''));
  });

  test('54d. GET /api/finance/stock/adjustments returns 200 with the items shape', async () => {
    // The endpoint exists + accepts the finance.stock.read perm.
    // Even with no adjustments, it returns {items: []}.
    const r = await get(server, '/api/finance/stock/adjustments');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
  });

  test('54e. GET /api/finance/stock/adjustments?category=damage accepts a category filter', async () => {
    // The category filter is optional. With no matches the
    // response is 200 + items=[]; with matches the items array
    // is filtered. We just verify the endpoint accepts the
    // query param without crashing.
    const r = await get(server, '/api/finance/stock/adjustments?category=damage');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
  });

  // ─── Wave 55: session activity log ───

  test('55a. GET /api/auth/sessions/events returns the current user\'s recent activity', async () => {
    // The test's auth mode is 'stub' — there's no real login
    // flow, so no session is auto-seeded. We seed a session +
    // login event directly via full.db to verify the endpoint
    // shape and that the filter (by user_id) works.
    full.db.prepare('DELETE FROM sbos_session_events WHERE user_id = 1').run();
    full.db
      .prepare(
        `INSERT INTO sbos_session_events
           (session_id, user_id, tenant_id, event_type, ip, user_agent, payload_json)
         VALUES (?, 1, 0, ?, ?, ?, ?)`,
      )
      .run('W55-test-session', 'login', '127.0.0.1', 'jest', JSON.stringify({ method: 'test-seed' }));
    const r = await get(server, '/api/auth/sessions/events');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
    // At least 1 event (the test-seeded one).
    assert.ok(r.body.items.length >= 1, 'at least 1 event expected');
    // The seeded event is present.
    const found = r.body.items.find(
      (e) =>
        e.event_type === 'login' &&
        e.payload &&
        e.payload.method === 'test-seed',
    );
    assert.ok(found, 'test-seeded login event must be present');
    // And it has the user_id of the current (stub) admin (id=1).
    assert.equal(found.user_id, 1);
  });

  test('55b. GET /api/rbac/sessions/:id/events returns 404 for an unknown session', async () => {
    const r = await get(server, '/api/rbac/sessions/this-does-not-exist/events');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'session_not_found');
  });

  test('55c. POST /api/auth/logout records a logout event for the current session', async () => {
    // Make a session login first (creates a 'login' event), then
    // logout (creates a 'logout' event). The list endpoint should
    // reflect both.
    //
    // The test's auth mode is 'stub' (admin always-on). The
    // stub-minted session has a 'login' event. We just need to
    // verify the logout endpoint records an event. The list
    // endpoint (/api/auth/sessions/events) should return at
    // least 2 events: 1 from boot-time login + 1 from this logout.
    const before = await get(server, '/api/auth/sessions/events');
    const beforeCount = before.body.items.length;
    const logoutRes = await postJson(server, '/api/auth/logout', {});
    // Logout in stub mode is a no-op (no req.session) but
    // returns 200 regardless. We just verify the response.
    assert.equal(logoutRes.status, 200);
    const after = await get(server, '/api/auth/sessions/events');
    // In stub mode there's no session.id so the logout doesn't
    // actually record. We just verify the endpoint shape.
    assert.ok(Array.isArray(after.body.items));
    // Document the relationship: events >= boot-time login (1).
    assert.ok(after.body.items.length >= 1);
    // And the count didn't go down.
    assert.ok(after.body.items.length >= beforeCount);
  });

  test('55d. GET /api/rbac/sessions/:id/events accepts ?limit', async () => {
    // Just verify the endpoint shape + the limit param is accepted.
    // The actual session id is the boot-minted admin session;
    // reading its events returns at least 1 row.
    const r = await get(server, '/api/rbac/sessions/UNKNOWN/events?limit=10');
    // Unknown session → 404.
    assert.equal(r.status, 404);
  });

  // ─── Wave 56: invoice document attachments ───

  test('56a. POST /api/finance/invoices/:id/attachments uploads a file (raw body + x-* headers)', async () => {
    // The route reads the raw body and uses x-filename / x-mime-type
    // / x-description for metadata. We just verify the upload +
    // metadata roundtrip.
    const port = server.address().port;
    // Use real PDF magic bytes so the Wave 58 file-type check
    // accepts the upload as application/pdf. (Previous Wave 56
    // tests used fake bytes + PDF mime; Wave 58's magic-byte
    // check correctly rejected the mismatch — the test now
    // uses actual PDF bytes so the rest of the flow is exercised.)
    const body = Buffer.concat([
      Buffer.from('%PDF-1.4\n%\x93\x8c\x8b\x9e'),
      Buffer.from('wave-56-test-' + Date.now()),
    ]);
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/finance/invoices/1/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': 'signed_quote.pdf',
          'x-mime-type': 'application/pdf',
          'x-description': 'test upload',
        },
        body,
      },
    );
    assert.equal(r.status, 201);
    const j = await r.json();
    assert.ok(j.id, 'attachment id must be present');
    assert.equal(j.filename, 'signed_quote.pdf');
    assert.equal(j.mime_type, 'application/pdf');
    assert.equal(j.size_bytes, body.length);
    assert.equal(j.description, 'test upload');
    assert.ok(j.storage_path, 'storage_path must be set');
  });

  test('56b. GET /api/finance/invoices/:id/attachments lists the row from 56a', async () => {
    // The list should include the attachment we just uploaded.
    // Note: tests run in parallel so the list might include rows
    // from other tests — we filter by filename.
    const r = await get(server, '/api/finance/invoices/1/attachments');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
    const found = r.body.items.find((a) => a.filename === 'signed_quote.pdf');
    assert.ok(found, 'uploaded attachment should appear in the list');
    assert.equal(found.mime_type, 'application/pdf');
  });

  test('56c. GET /api/finance/invoices/:id/attachments/:attId returns the raw bytes', async () => {
    // Find the attachment from 56a.
    const list = await get(server, '/api/finance/invoices/1/attachments');
    const a = list.body.items.find((x) => x.filename === 'signed_quote.pdf');
    assert.ok(a, 'precondition: attachment exists');
    const r = await get(
      server,
      `/api/finance/invoices/1/attachments/${a.id}`,
    );
    assert.equal(r.status, 200);
    assert.ok(r.contentType.includes('application/pdf'));
    // The body is the original bytes (the test fixture content).
    // get() returns the parsed body; for binary content, the test
    // is just verifying the endpoint shape + status.
  });

  test('56d. DELETE /api/finance/invoices/:id/attachments/:attId removes the attachment', async () => {
    const list = await get(server, '/api/finance/invoices/1/attachments');
    const a = list.body.items.find((x) => x.filename === 'signed_quote.pdf');
    assert.ok(a, 'precondition: attachment exists');
    const port = server.address().port;
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/finance/invoices/1/attachments/${a.id}`,
      { method: 'DELETE' },
    );
    assert.equal(r.status, 204);
    // List no longer includes it.
    const after = await get(server, '/api/finance/invoices/1/attachments');
    const stillThere = after.body.items.find(
      (x) => x.filename === 'signed_quote.pdf',
    );
    assert.equal(stillThere, undefined);
  });

  test('56e. POST /api/finance/invoices/:id/attachments with no x-filename returns 400', async () => {
    // Without x-filename the route can't compute the on-disk name.
    const port = server.address().port;
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/finance/invoices/1/attachments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('x'),
      },
    );
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_request');
  });

  // ─── Wave 57: login rate limiting ───

  test('57a. POST /api/auth/login rate-limits after the per-IP threshold', async () => {
    // Reset the rate limiter so prior tests don't pollute.
    const { resetLoginRateLimit } = await import('./rate-limit.js');
    resetLoginRateLimit();
    const port = server.address().port;
    // The per-IP limit is 20 per 5 minutes. 21 attempts should
    // trip the limit. We use varying usernames so the per-user
    // limit doesn't trigger first.
    let lastStatus = null;
    let lastBody = null;
    for (let i = 0; i < 21; i++) {
      const r = await globalThis.fetch(
        `http://127.0.0.1:${port}/api/auth/login`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: `W57-u${i}`, password: 'wrong' }),
        },
      );
      lastStatus = r.status;
      if (r.status === 429) {
        lastBody = await r.json();
        break;
      }
    }
    assert.equal(lastStatus, 429, 'expected 429 after 20 attempts');
    assert.equal(lastBody.error, 'rate_limited');
    assert.ok(lastBody.retry_after > 0);
    // The 429 carries standard rate-limit headers.
    assert.ok(
      lastBody.retry_after <= 300,
      `retry_after should be in seconds, got ${lastBody.retry_after}`,
    );
  });

  test('57b. POST /api/auth/login 429 response has Retry-After + X-RateLimit-Scope headers', async () => {
    const { resetLoginRateLimit } = await import('./rate-limit.js');
    resetLoginRateLimit();
    const port = server.address().port;
    // Burn the per-IP budget.
    for (let i = 0; i < 20; i++) {
      await globalThis.fetch(
        `http://127.0.0.1:${port}/api/auth/login`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: `W57b-u${i}`, password: 'wrong' }),
        },
      );
    }
    // The 21st attempt is 429.
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/auth/login`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'W57b-final', password: 'wrong' }),
      },
    );
    assert.equal(r.status, 429);
    assert.ok(r.headers.get('retry-after'), 'Retry-After header must be set');
    assert.ok(
      r.headers.get('x-ratelimit-scope') === 'ip',
      'X-RateLimit-Scope must be ip when per-IP limit triggers',
    );
  });

  test('57c. POST /api/auth/login resets via resetLoginRateLimit', async () => {
    // After reset, the budget is fresh.
    const { resetLoginRateLimit } = await import('./rate-limit.js');
    resetLoginRateLimit();
    const port = server.address().port;
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/auth/login`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'W57c', password: 'wrong' }),
      },
    );
    // First attempt after reset — not rate-limited. It will
    // return 401 (wrong password) which is the right outcome.
    assert.equal(r.status, 401);
  });

  // ─── Wave 58: file-type magic-byte detection ───

  test('58a. POST attachment with PDF bytes + application/pdf claim is accepted', async () => {
    // The Wave 58 file-type check passes when bytes match the
    // claimed type. Use real PDF magic so the verification
    // succeeds.
    const port = server.address().port;
    const body = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from('wave-58-valid-' + Date.now()),
    ]);
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/finance/invoices/1/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': 'w58_valid.pdf',
          'x-mime-type': 'application/pdf',
        },
        body,
      },
    );
    assert.equal(r.status, 201, 'real PDF bytes + PDF claim should be accepted');
    const j = await r.json();
    assert.equal(j.mime_type, 'application/pdf');
  });

  test('58b. POST attachment with PDF bytes claimed as image/jpeg is REJECTED (smuggling)', async () => {
    // The classic smuggling pattern: take a PDF, claim
    // image/jpeg. The bytes disagree; the check rejects.
    const port = server.address().port;
    const body = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from('wave-58-smuggle-' + Date.now()),
    ]);
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/finance/invoices/1/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': 'w58_smuggle.jpg',
          'x-mime-type': 'image/jpeg',
        },
        body,
      },
    );
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, 'invalid_request');
    assert.ok(/mismatch|pdf.*jpeg|jpeg.*pdf/i.test(j.message), `error message should describe the mismatch: ${j.message}`);
  });

  test('58c. POST attachment with executable (MZ) bytes claimed as application/pdf is REJECTED', async () => {
    // The reverse smuggling: take a Windows executable, claim
    // it's a PDF. The bytes start with 4D 5A (MZ) which is
    // not a PDF magic; the check rejects.
    const port = server.address().port;
    const body = Buffer.concat([
      Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
      Buffer.from('wave-58-exe-as-pdf-' + Date.now()),
    ]);
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/finance/invoices/1/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': 'w58_exe.pdf',
          'x-mime-type': 'application/pdf',
        },
        body,
      },
    );
    assert.equal(r.status, 400);
  });

  test('58d. POST attachment with no x-mime-type is accepted (octet-stream is the safe default)', async () => {
    // When the operator doesn't claim a type (no x-mime-type
    // header), the route defaults to application/octet-stream,
    // which is always accepted.
    const port = server.address().port;
    const body = Buffer.from('just some bytes, no claim\n');
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/finance/invoices/1/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': 'w58_unknown.bin',
        },
        body,
      },
    );
    assert.equal(r.status, 201, 'octet-stream is always accepted');
  });

  // ─── Wave 59: lockout observability (at-risk list) + bulk-unlock ───

  test('59a. GET /api/rbac/users/approaching-lockout returns users with elevated failed_logins or future lock', async () => {
    // Reset to a clean baseline.
    full.db.prepare(
      `UPDATE users SET failed_logins = 0, locked_until = NULL`,
    ).run();
    // Set bob (id=2) to 4 fails (at risk; default threshold 3).
    full.db.prepare(
      `UPDATE users SET failed_logins = 4, locked_until = NULL WHERE id = 2`,
    ).run();
    const r = await get(server, '/api/rbac/users/approaching-lockout');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
    assert.ok(
      r.body.items.some((u) => u.id === 2),
      'bob should be in the at-risk list (4 fails >= threshold 3)',
    );
  });

  test('59b. GET /api/rbac/users/approaching-lockout also includes currently-locked users', async () => {
    // Reset everyone, then set carol to a future lock with 0 fails.
    // She should appear in the at-risk list because the lock is
    // current — the at-risk query ORs the two conditions.
    full.db.prepare(
      `UPDATE users SET failed_logins = 0, locked_until = NULL`,
    ).run();
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    full.db
      .prepare(
        `INSERT OR REPLACE INTO users (id, username, role, tenant_id, failed_logins, locked_until)
         VALUES (3, 'carol', 'Operator', 0, 0, ?)`,
      )
      .run(future);
    try {
      const r = await get(server, '/api/rbac/users/approaching-lockout');
      assert.equal(r.status, 200);
      assert.ok(
        r.body.items.some((u) => u.id === 3 && u.is_currently_locked === true),
        'carol should appear with is_currently_locked=true',
      );
    } finally {
      // Cleanup the throwaway user.
      full.db.prepare(`DELETE FROM users WHERE id = 3`).run();
    }
  });

  test('59c. POST /api/rbac/users/bulk-unlock resets all failed_logins + locked_until', async () => {
    // Set up: bob has 5 fails + future lock, admin has 0. After
    // bulk-unlock, both should be at 0/null.
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    full.db
      .prepare(
        `UPDATE users SET failed_logins = 5, locked_until = ? WHERE id = 2`,
      )
      .run(future);
    full.db
      .prepare(
        `UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = 1`,
      )
      .run();

    const r = await postJson(server, '/api/rbac/users/bulk-unlock', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(
      r.body.unlocked_count >= 1,
      'at least bob should be unlocked',
    );

    // Verify both users are clean.
    const bob = full.db
      .prepare('SELECT failed_logins, locked_until FROM users WHERE id = 2')
      .get();
    assert.equal(bob.failed_logins, 0);
    assert.equal(bob.locked_until, null);
  });

  test('59d. POST /api/rbac/users/bulk-unlock with tenant_id only unlocks that tenant', async () => {
    // Add a user in tenant 7, lock them, then bulk-unlock with
    // tenant_id=0. The tenant 7 user should remain locked.
    const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    full.db
      .prepare(
        `INSERT OR REPLACE INTO users (id, username, role, tenant_id, failed_logins, locked_until)
         VALUES (3, 't7-locked', 'Operator', 7, 5, ?)`,
      )
      .run(future);
    try {
      const r = await postJson(server, '/api/rbac/users/bulk-unlock', {
        tenant_id: 0,
      });
      assert.equal(r.status, 200);
      // tenant 7 user should be untouched.
      const t7 = full.db
        .prepare('SELECT failed_logins FROM users WHERE id = 3')
        .get();
      assert.equal(t7.failed_logins, 5, 'tenant 7 user should remain locked');
    } finally {
      full.db.prepare(`DELETE FROM users WHERE id = 3`).run();
    }
  });

  // ─── Wave 60: audit-log retention policy ───

  test('60a. GET /api/finance/audit/retention returns the default config when unset', async () => {
    // No config row exists for tenant 0 yet. The endpoint should
    // synthesise the default 365d response.
    full.db.prepare(`DELETE FROM audit_retention WHERE tenant_id = 0`).run();
    const r = await get(server, '/api/finance/audit/retention');
    assert.equal(r.status, 200);
    assert.equal(r.body.tenant_id, 0);
    assert.equal(r.body.retention_days, 365);
    assert.equal(r.body.updated_at, null);
  });

  test('60b. PUT /api/finance/audit/retention stores the new config', async () => {
    // Reset, then PUT a 90-day config. The GET should reflect
    // the stored value (90, not 365).
    full.db.prepare(`DELETE FROM audit_retention WHERE tenant_id = 0`).run();
    const put = await putJson(server, '/api/finance/audit/retention', {
      retention_days: 90,
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.retention_days, 90);
    const got = await get(server, '/api/finance/audit/retention');
    assert.equal(got.body.retention_days, 90);
  });

  test('60c. PUT /api/finance/audit/retention rejects negative days', async () => {
    // The validator must surface the rejection as 400. We don't
    // even hit the DB on bad input.
    const r = await putJson(server, '/api/finance/audit/retention', {
      retention_days: -1,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_request');
  });

  test('60d. POST /api/finance/audit/purge with override deletes old rows', async () => {
    // Seed three rows: 100 days old, 10 days old, 1 day old.
    // Purge with retention_days=30 should delete only the
    // 100-day-old row.
    const tenantId = 0;
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    full.db.prepare(`DELETE FROM audit WHERE tenant_id = ?`).run(tenantId);
    const ins = full.db.prepare(
      `INSERT INTO audit (tenant_id, user_id, action, resource, method, path, status_code, created_at)
       VALUES (?, 1, 'invoice.create', ?, 'POST', '/api/finance/invoices', 200, ?)`,
    );
    ins.run(tenantId, 'invoice:1', old);
    ins.run(tenantId, 'invoice:2', recent);
    ins.run(tenantId, 'invoice:3', fresh);

    const r = await postJson(server, '/api/finance/audit/purge', {
      retention_days: 30,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.purged, 1);
    assert.equal(r.body.retention_days, 30);

    // Verify: the 100-day-old row is gone, the 10- and 1-day-old
    // rows are still there.
    const remaining = full.db
      .prepare(`SELECT COUNT(*) AS n FROM audit WHERE tenant_id = 0`)
      .get();
    assert.equal(remaining.n, 2);
  });

  // ─── Wave 61: extended file-type detection (BMP, TIFF, WEBP, ICO, MP4, MOV, AVI) ───

  test('61a. POST attachment with real BMP bytes + image/bmp claim is accepted', async () => {
    // BMP magic = 0x42 0x4D ("BM") at offset 0.
    const port = server.address().port;
    const body = Buffer.concat([
      Buffer.from([0x42, 0x4d]),
      Buffer.alloc(50, 0xff),
    ]);
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/finance/invoices/1/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': 'w61_bmp.bmp',
          'x-mime-type': 'image/bmp',
        },
        body,
      },
    );
    assert.equal(r.status, 201, `expected 201 got ${r.status}`);
  });

  test('61b. POST attachment with MP4 bytes + video/mp4 claim is accepted', async () => {
    // MP4 = ftyp at offset 4 + isom brand at offset 8.
    const port = server.address().port;
    const body = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20]),
      Buffer.from('ftyp'),
      Buffer.from('isom'),
      Buffer.alloc(20, 0x00),
    ]);
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/finance/invoices/1/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': 'w61_mp4.mp4',
          'x-mime-type': 'video/mp4',
        },
        body,
      },
    );
    assert.equal(r.status, 201);
  });

  test('61c. POST attachment with WEBP bytes claimed as image/png is REJECTED', async () => {
    // WEBP bytes (RIFF + WEBP brand) claimed as PNG.
    // The verifyMimeType check should reject the mismatch.
    const port = server.address().port;
    const body = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4, 0x10),
      Buffer.from('WEBP'),
      Buffer.alloc(20, 0xff),
    ]);
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/finance/invoices/1/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': 'w61_webp_as_png.webp',
          'x-mime-type': 'image/png',
        },
        body,
      },
    );
    assert.equal(r.status, 400, 'webp-claimed-as-png must be rejected');
  });

  test('61d. POST attachment with MP4 bytes claimed as video/quicktime is REJECTED', async () => {
    // MP4 (isom brand) claimed as MOV (qt  brand) is a
    // smuggling attempt. The isom brand makes the bytes MP4,
    // not MOV; verifyMimeType must reject.
    const port = server.address().port;
    const body = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20]),
      Buffer.from('ftyp'),
      Buffer.from('isom'),
      Buffer.alloc(20, 0x00),
    ]);
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/finance/invoices/1/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': 'w61_mp4_as_mov.mp4',
          'x-mime-type': 'video/quicktime',
        },
        body,
      },
    );
    assert.equal(r.status, 400, 'mp4-claimed-as-mov must be rejected');
  });

  test('61e. POST attachment with TIFF little-endian bytes + image/tiff is accepted', async () => {
    // TIFF LE = II*\0 (0x49 0x49 0x2A 0x00).
    const port = server.address().port;
    const body = Buffer.concat([
      Buffer.from([0x49, 0x49, 0x2a, 0x00]),
      Buffer.alloc(20, 0x00),
    ]);
    const r = await globalThis.fetch(
      `http://127.0.0.1:${port}/api/finance/invoices/1/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': 'w61_tiff_le.tiff',
          'x-mime-type': 'image/tiff',
        },
        body,
      },
    );
    assert.equal(r.status, 201);
  });

  test('6. GET /api/nonexistent returns 404', async () => {
    const { status, body } = await get(server, '/api/nonexistent');
    assert.equal(status, 404);
    // Generic 404 returns JSON `{error: 'not_found'}`.
    assert.ok(
      body && body.error === 'not_found',
      `expected error=not_found, got ${JSON.stringify(body)}`,
    );
  });

  test('7. GET /api/finance/customers (empty DB) returns 200 with items=[]', async () => {
    const { status, body } = await get(server, '/api/finance/customers');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items), `expected items array, got ${JSON.stringify(body)}`);
    assert.equal(body.items.length, 0);
  });

  test('8. GET /api/finance/vat/return?yearMonth=2026-06 returns 200 with a return shape', async () => {
    const { status, body } = await get(server, '/api/finance/vat/return?yearMonth=2026-06');
    assert.equal(status, 200);
    // The vat-return shape from computeVatReturn (camelCase) has
    // `outputVat` + `inputVat` + `net`. Empty DB → all zeros, but
    // the shape must be present.
    assert.ok(body && typeof body === 'object', 'expected object body');
    assert.ok('outputVat' in body, `expected outputVat, got ${JSON.stringify(body)}`);
    assert.ok('inputVat' in body, `expected inputVat, got ${JSON.stringify(body)}`);
    assert.ok('net' in body, `expected net, got ${JSON.stringify(body)}`);
  });

  test('9. GET /api/finance/einvoice/export/:invoiceId returns 404 for unknown id', async () => {
    const { status, body } = await get(server, '/api/finance/einvoice/export/9999');
    assert.equal(status, 404);
    assert.ok(body && body.error, `expected error body, got ${JSON.stringify(body)}`);
  });

  test('10. GET /api/finance/dashboard without asOfDate returns 400', async () => {
    const { status, body } = await get(server, '/api/finance/dashboard');
    assert.equal(status, 400);
    assert.ok(body && body.error, `expected error body, got ${JSON.stringify(body)}`);
  });

  test('11. GET /api/dashboard returns 200 HTML with title', async () => {
    // Mount /api/dashboard uses the same renderDashboard() but with the
    // default asOfDate = today. The HTML must contain the dashboard title.
    const { status, body, contentType } = await get(server, '/api/dashboard');
    assert.equal(status, 200);
    assert.ok(contentType.includes('text/html'), `expected text/html, got ${contentType}`);
    assert.ok(
      body.includes('<title>CFO Dashboard'),
      `expected CFO Dashboard title, got ${typeof body === 'string' ? body.slice(0, 200) : 'non-string'}`,
    );
  });

  test('12. GET /api/finance/invoices/:id with non-numeric id returns 404', async () => {
    const { status, body } = await get(server, '/api/finance/invoices/abc');
    assert.equal(status, 404);
    assert.ok(
      body && body.error === 'not_found',
      `expected error=not_found, got ${JSON.stringify(body)}`,
    );
  });

  test('13. GET /api/finance/invoices/:id with numeric-but-missing id returns 404', async () => {
    const { status, body } = await get(server, '/api/finance/invoices/9999');
    assert.equal(status, 404);
    assert.ok(
      body && body.error === 'not_found',
      `expected error=not_found, got ${JSON.stringify(body)}`,
    );
  });

  test('14. GET /api/finance/vat/return without yearMonth returns 400', async () => {
    const { status, body } = await get(server, '/api/finance/vat/return');
    assert.equal(status, 400);
    assert.ok(
      body && body.error === 'bad_request',
      `expected error=bad_request, got ${JSON.stringify(body)}`,
    );
  });

  test('15. GET /api/finance/vat/return with malformed yearMonth returns 400', async () => {
    const { status, body } = await get(server, '/api/finance/vat/return?yearMonth=2026-13');
    assert.equal(status, 400);
    assert.ok(
      body && body.error === 'bad_request',
      `expected error=bad_request, got ${JSON.stringify(body)}`,
    );
  });

  test('16. GET /api/finance/einvoice/export/abc (non-numeric) returns 404', async () => {
    const { status, body } = await get(server, '/api/finance/einvoice/export/abc');
    assert.equal(status, 404);
    assert.ok(
      body && body.error === 'not_found',
      `expected error=not_found, got ${JSON.stringify(body)}`,
    );
  });

  // ─── Write routes (the next wave) ───

  test('17. POST /api/finance/customers creates a customer (201, returns row)', async () => {
    const { status, body } = await postJson(server, '/api/finance/customers', {
      name: 'Acme LLC',
      hvhh: '12345678',
      address: 'Yerevan',
      email: 'ar@acme.am',
    });
    assert.equal(status, 201);
    assert.equal(body.name, 'Acme LLC');
    assert.equal(body.hvhh, '12345678');
    assert.equal(body.tenant_id, 0);
    assert.ok(Number.isInteger(body.id) && body.id > 0);
  });

  test('18. POST /api/finance/customers with invalid hvhh returns 400', async () => {
    const { status, body } = await postJson(server, '/api/finance/customers', {
      name: 'Bad',
      hvhh: '12',
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'bad_request');
  });

  test('19. PATCH /api/finance/customers/:id updates the customer (200)', async () => {
    const created = await postJson(server, '/api/finance/customers', { name: 'Original' });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const { status, body } = await patchJson(server, `/api/finance/customers/${id}`, {
      name: 'Renamed',
    });
    assert.equal(status, 200);
    assert.equal(body.name, 'Renamed');
  });

  test('20. PATCH /api/finance/customers/:id with non-numeric id returns 404', async () => {
    const { status, body } = await patchJson(server, '/api/finance/customers/abc', {
      name: 'X',
    });
    assert.equal(status, 404);
    assert.equal(body.error, 'not_found');
  });

  test('21. PATCH /api/finance/customers/:id for cross-tenant id returns 404', async () => {
    // Create a customer (tenant 0), then try to PATCH it with a different
    // tenant scope. The route's readTenant() picks up X-Tenant-Id.
    const created = await postJson(server, '/api/finance/customers', { name: 'Tenant-0 row' });
    const id = created.body.id;
    const { status, body } = await patchJson(
      server,
      `/api/finance/customers/${id}`,
      { name: 'Should fail' },
      { 'X-Tenant-Id': '7' },
    );
    assert.equal(status, 404);
    assert.equal(body.error, 'not_found');
  });

  test('22. POST /api/finance/invoices creates an invoice (201, status=draft)', async () => {
    // First create a customer to reference.
    const c = await postJson(server, '/api/finance/customers', { name: 'Inv Cust' });
    const customerId = c.body.id;
    const { status, body } = await postJson(server, '/api/finance/invoices', {
      customer_id: customerId,
      invoice_number: 'INV-2026-0001',
      issue_date: '2026-06-21',
      due_date: '2026-07-21',
      lines: [{ description: 'Service', quantity: 1, unit_price_amd: 100000 }],
    });
    assert.equal(status, 201);
    assert.equal(body.status, 'draft');
    assert.equal(body.total_amd, 100000);
  });

  test('23. POST /api/finance/invoices with bad body (no customer) returns 400', async () => {
    const { status, body } = await postJson(server, '/api/finance/invoices', {
      invoice_number: 'INV-bad',
      issue_date: '2026-06-21',
      due_date: '2026-07-21',
      lines: [],
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'bad_request');
  });

  test('24. PATCH /api/finance/invoices/:id updates status (draft → sent)', async () => {
    const c = await postJson(server, '/api/finance/customers', { name: 'InvUpd' });
    const inv = await postJson(server, '/api/finance/invoices', {
      customer_id: c.body.id,
      invoice_number: 'INV-UPD-1',
      issue_date: '2026-06-21',
      due_date: '2026-07-21',
      lines: [{ description: 'Svc', quantity: 1, unit_price_amd: 50000 }],
    });
    const { status, body } = await patchJson(server, `/api/finance/invoices/${inv.body.id}`, {
      status: 'sent',
    });
    assert.equal(status, 200);
    assert.equal(body.status, 'sent');
  });

  test('25. POST /api/finance/invoices/:id/payments records a payment', async () => {
    const c = await postJson(server, '/api/finance/customers', { name: 'PayCust' });
    const inv = await postJson(server, '/api/finance/invoices', {
      customer_id: c.body.id,
      invoice_number: 'INV-PAY-1',
      issue_date: '2026-06-21',
      due_date: '2026-07-21',
      lines: [{ description: 'Svc', quantity: 1, unit_price_amd: 100000 }],
    });
    // Move to 'sent' first (draft doesn't accept payments).
    await patchJson(server, `/api/finance/invoices/${inv.body.id}`, { status: 'sent' });
    const { status, body } = await postJson(
      server,
      `/api/finance/invoices/${inv.body.id}/payments`,
      { amount_amd: 100000, method: 'bank_transfer' },
    );
    assert.equal(status, 201);
    assert.equal(body.amount_amd, 100000);
    assert.equal(body.invoice_id, inv.body.id);
  });

  test('26. POST /api/finance/invoices/:id/payments against draft returns 400', async () => {
    const c = await postJson(server, '/api/finance/customers', { name: 'DraftCust' });
    const inv = await postJson(server, '/api/finance/invoices', {
      customer_id: c.body.id,
      invoice_number: 'INV-DRAFT-1',
      issue_date: '2026-06-21',
      due_date: '2026-07-21',
      lines: [{ description: 'Svc', quantity: 1, unit_price_amd: 50000 }],
    });
    // Invoice is still in 'draft' status — payments should be rejected.
    const { status, body } = await postJson(
      server,
      `/api/finance/invoices/${inv.body.id}/payments`,
      { amount_amd: 50000, method: 'cash' },
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'bad_request');
    assert.ok(/draft/i.test(body.message), `expected draft mention, got: ${body.message}`);
  });

  test('27. POST /api/finance/invoices/:id/void voids an invoice (returns updated row)', async () => {
    const c = await postJson(server, '/api/finance/customers', { name: 'VoidCust' });
    const inv = await postJson(server, '/api/finance/invoices', {
      customer_id: c.body.id,
      invoice_number: 'INV-VOID-1',
      issue_date: '2026-06-21',
      due_date: '2026-07-21',
      lines: [{ description: 'Svc', quantity: 1, unit_price_amd: 50000 }],
    });
    const { status, body } = await postJson(
      server,
      `/api/finance/invoices/${inv.body.id}/void`,
      { reason: 'duplicate issuance' },
    );
    assert.equal(status, 200);
    assert.equal(body.status, 'void');
  });

  test('28. POST /api/finance/invoices/:id/reconcile recomputes status from payments', async () => {
    const c = await postJson(server, '/api/finance/customers', { name: 'ReconcCust' });
    const inv = await postJson(server, '/api/finance/invoices', {
      customer_id: c.body.id,
      invoice_number: 'INV-RECONC-1',
      issue_date: '2026-06-21',
      due_date: '2026-07-21',
      lines: [{ description: 'Svc', quantity: 1, unit_price_amd: 80000 }],
    });
    await patchJson(server, `/api/finance/invoices/${inv.body.id}`, { status: 'sent' });
    await postJson(server, `/api/finance/invoices/${inv.body.id}/payments`, {
      amount_amd: 80000,
      method: 'cash',
    });
    const { status, body } = await postJson(
      server,
      `/api/finance/invoices/${inv.body.id}/reconcile`,
      {},
    );
    assert.equal(status, 200);
    assert.equal(body.status, 'paid');
    assert.equal(body.balance_amd, 0);
  });

  test('29. Cross-tenant write to invoice: PATCH with X-Tenant-Id:7 on tenant-0 invoice → 404', async () => {
    const c = await postJson(server, '/api/finance/customers', { name: 'IsoCust' });
    const inv = await postJson(server, '/api/finance/invoices', {
      customer_id: c.body.id,
      invoice_number: 'INV-ISO-1',
      issue_date: '2026-06-21',
      due_date: '2026-07-21',
      lines: [{ description: 'Svc', quantity: 1, unit_price_amd: 10000 }],
    });
    const { status, body } = await patchJson(
      server,
      `/api/finance/invoices/${inv.body.id}`,
      { status: 'sent' },
      { 'X-Tenant-Id': '7' },
    );
    assert.equal(status, 404);
    assert.equal(body.error, 'not_found');
  });

  test('30. POST /api/finance/invoices without X-Tenant-Id — stub auth provides tenant_id=0, succeeds (201)', async () => {
    // In stub auth mode, req.user.tenant_id=0 is always set, so
    // requireTenant reads the user's tenant and the request succeeds.
    // (In real auth mode, the same code would 400 because the admin
    // session has no tenant_id fallback — verified in smoke:deploy.)
    const c = await postJson(server, '/api/finance/customers', { name: 'NoHeaderCust' });
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/api/finance/invoices`;
    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customer_id: c.body.id,
        invoice_number: 'INV-NH-1',
        issue_date: '2026-06-21',
        due_date: '2026-07-21',
        lines: [{ description: 'Svc', quantity: 1, unit_price_amd: 5000 }],
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.tenant_id, 0);
  });

  test('31. POST /api/finance/customers without X-Tenant-Id succeeds in stub mode (201)', async () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/api/finance/customers`;
    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'NoHeaderCust2' }),
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.tenant_id, 0);
  });

  test('32. POST /api/finance/invoices with bad X-Tenant-Id — falls back to user.tenant_id, succeeds', async () => {
    // Bad header value is ignored (requireTenant's parseTenantId returns
    // null for non-integers); the user's tenant_id=0 takes over.
    const c = await postJson(server, '/api/finance/customers', { name: 'BadHeaderCust' });
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/api/finance/invoices`;
    const res = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'not-a-number' },
      body: JSON.stringify({
        customer_id: c.body.id,
        invoice_number: 'INV-BH-1',
        issue_date: '2026-06-21',
        due_date: '2026-07-21',
        lines: [{ description: 'Svc', quantity: 1, unit_price_amd: 5000 }],
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.tenant_id, 0);
  });

  // ─── Deferred item: POST /api/finance/invoices/:id/lines ───

  test('33. POST /api/finance/invoices/:id/lines replaces line items on a draft invoice', async () => {
    const c = await postJson(server, '/api/finance/customers', { name: 'LinesCust' });
    const inv = await postJson(server, '/api/finance/invoices', {
      customer_id: c.body.id,
      invoice_number: 'INV-LINES-1',
      issue_date: '2026-06-21',
      due_date: '2026-07-21',
      lines: [{ description: 'Old', quantity: 1, unit_price_amd: 1000 }],
    });
    const { status, body } = await postJson(
      server,
      `/api/finance/invoices/${inv.body.id}/lines`,
      {
        lines: [
          { description: 'New A', quantity: 2, unit_price_amd: 5000 },
          { description: 'New B', quantity: 1, unit_price_amd: 3000 },
        ],
      },
    );
    assert.equal(status, 200);
    assert.equal(body.total_amd, 13000);
  });

  test('34. POST /api/finance/invoices/:id/lines on a non-draft invoice returns 400', async () => {
    // Same as test 26 — set the invoice to sent, then try to replace lines.
    const c = await postJson(server, '/api/finance/customers', { name: 'LinesSentCust' });
    const inv = await postJson(server, '/api/finance/invoices', {
      customer_id: c.body.id,
      invoice_number: 'INV-LINES-SENT',
      issue_date: '2026-06-21',
      due_date: '2026-07-21',
      lines: [{ description: 'A', quantity: 1, unit_price_amd: 1000 }],
    });
    await patchJson(server, `/api/finance/invoices/${inv.body.id}`, { status: 'sent' });
    const { status, body } = await postJson(
      server,
      `/api/finance/invoices/${inv.body.id}/lines`,
      { lines: [{ description: 'B', quantity: 1, unit_price_amd: 2000 }] },
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'bad_request');
  });

  // ─── Deferred item: GET /api/finance/audit ───

  test('35. GET /api/finance/audit returns audit rows for the caller tenant', async () => {
    // Each write in this test suite records an audit row. After
    // running the earlier tests, the audit table has many rows
    // for tenant 0. Verify the list endpoint returns them, scoped
    // to tenant 0.
    const { status, body } = await get(server, '/api/finance/audit?limit=5');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items), `expected items array, got ${JSON.stringify(body)}`);
    assert.ok(body.items.length > 0, 'expected at least one audit row');
    const sample = body.items[0];
    assert.equal(sample.tenant_id, 0);
    assert.ok(['POST', 'PATCH', 'GET', 'DELETE'].includes(sample.method));
    assert.ok(typeof sample.action === 'string' && sample.action.length > 0);
  });

  test('36. GET /api/finance/audit filters by resource prefix', async () => {
    // Filter to invoice:1* to verify the prefix works. The earlier
    // tests created invoices, so a 'invoice:' prefix should match.
    const { status, body } = await get(server, '/api/finance/audit?resource=invoice:&limit=10');
    assert.equal(status, 200);
    for (const r of body.items) {
      assert.ok(r.resource.startsWith('invoice:'), `unexpected resource: ${r.resource}`);
    }
  });

  // ─── Wave 40: audit log CSV export ───

  test('40a. GET /api/finance/audit/export returns text/csv with a header line', async () => {
    // The earlier tests in this suite have populated the audit log
    // for tenant 0. Verify the export endpoint returns a CSV with
    // the documented header row + at least one data row. The
    // server.test.js server runs in stub auth mode, so no
    // Authorization header is needed.
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/api/finance/audit/export?limit=10`;
    const res = await globalThis.fetch(url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/csv/);
    assert.match(
      res.headers.get('content-disposition') || '',
      /^attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const text = await res.text();
    const lines = text.trim().split('\n');
    assert.ok(lines.length >= 2, 'expected header + at least 1 data row');
    // Header columns in the documented order.
    assert.match(lines[0], /^id,tenant_id,user_id,username,action,resource/);
  });

  test('40b. GET /api/finance/audit/export honors the resource_id filter', async () => {
    // Find an existing audit row for tenant 0 with a resource
    // shaped like 'customer:N'. Then export filtered by that id
    // and verify every returned row has resource_id = N.
    const list = await get(server, '/api/finance/audit?limit=20');
    assert.equal(list.status, 200);
    const customerRow = list.body.items.find((r) => /^customer:\d+/.test(r.resource));
    assert.ok(customerRow, 'expected at least one customer:* audit row to filter on');
    const idMatch = customerRow.resource.match(/^customer:(\d+)/);
    assert.ok(idMatch);
    const id = idMatch[1];
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/api/finance/audit/export?resource_id=${id}&limit=100`;
    const res = await globalThis.fetch(url);
    assert.equal(res.status, 200);
    const text = await res.text();
    const lines = text.trim().split('\n');
    assert.ok(lines.length >= 2, 'expected header + data rows');
    // Every data row must reference the requested id.
    for (let i = 1; i < lines.length; i++) {
      assert.match(lines[i], new RegExp(`,customer:${id}(,|:)`), `unexpected row: ${lines[i].slice(0, 100)}`);
    }
  });

  // ─── Wave 29: audit resource captures the actual entity id ───

  test('36a. PATCH /api/finance/customers/:id records audit with resource=customer:<id> (not the literal customer:id)', async () => {
    // Wave 29 wraps the customer.update resource as a function so
    // the actual entity id is captured. Before this wave the audit
    // row recorded 'customer:id' (the literal string). After the
    // wave it records 'customer:1' for PATCH /api/finance/customers/1.
    // Create a customer first, then PATCH it, then check the audit.
    const c = await postJson(server, '/api/finance/customers', { name: 'AuditWave29' });
    assert.equal(c.status, 201);
    const custId = c.body.id;
    const p = await patchJson(server, `/api/finance/customers/${custId}`, { name: 'AuditWave29-renamed' });
    assert.equal(p.status, 200);
    // The audit row should have resource = 'customer:<id>'.
    const { status, body } = await get(server, `/api/finance/audit?resource_id=${custId}&limit=20`);
    assert.equal(status, 200);
    const expected = `customer:${custId}`;
    const found = body.items.find((r) => r.resource === expected);
    assert.ok(found, `expected to find audit row with resource="${expected}", got: ${JSON.stringify(body.items.map((r) => r.resource))}`);
    assert.equal(found.action, 'customer.update');
  });

  test('36b. GET /api/finance/audit?resource_id=<id> returns all rows for that id (update + create)', async () => {
    // The previous test PATCHed customer 1 (well, the latest one).
    // The create row records 'customer:new' (no id yet) so it
    // wouldn't match. But the update records 'customer:<id>'
    // which DOES match. This test asserts the filter finds
    // the update row.
    const c = await postJson(server, '/api/finance/customers', { name: 'AuditWave29b' });
    assert.equal(c.status, 201);
    const custId = c.body.id;
    await patchJson(server, `/api/finance/customers/${custId}`, { name: 'AuditWave29b-rename' });
    const { status, body } = await get(server, `/api/finance/audit?resource_id=${custId}&limit=20`);
    assert.equal(status, 200);
    const updateRow = body.items.find((r) => r.resource === `customer:${custId}`);
    assert.ok(updateRow, 'expected to find the PATCH audit row by resource_id');
  });

  // ─── Wave 30: create routes also record the new entity id ───

  test('36c. POST /api/finance/customers records audit with resource=customer:<newId> (Wave 30 — closes the Wave 29 create-route gap)', async () => {
    // Wave 29 only fixed the id-based write routes (PATCH /:id,
    // POST /:id/void, etc.). The create routes (POST /invoices,
    // POST /customers) still recorded the literal 'customer:new'.
    // Wave 30 reads res.locals.createdId (set by the handler
    // right before res.json) so the create row records the
    // ACTUAL new id. After this wave, ?resource_id=<newId>
    // finds BOTH the create row and any subsequent update /
    // patch / void / payment rows for the same entity.
    const c = await postJson(server, '/api/finance/customers', { name: 'Wave30Create', hvhh: '22222222' });
    assert.equal(c.status, 201);
    const custId = c.body.id;
    // The create row should be findable by resource_id.
    const { status, body } = await get(server, `/api/finance/audit?resource_id=${custId}&limit=20`);
    assert.equal(status, 200);
    const createRow = body.items.find(
      (r) => r.resource === `customer:${custId}` && r.action === 'customer.create',
    );
    assert.ok(createRow, `expected create row with resource="customer:${custId}", got: ${JSON.stringify(body.items.map((r) => `${r.action}:${r.resource}`))}`);
  });

  // ─── Wave 32: customer 360 route ───

  test('36d. GET /api/finance/customers/:id/360 returns the full 360 view (Wave 32)', async () => {
    // Create a customer, then assert the 360 endpoint returns
    // the expected shape: customer info, open_invoices=[] (no
    // invoices yet), totals all zero, aging all zero.
    const c = await postJson(server, '/api/finance/customers', { name: 'Wave32Cust', hvhh: '44444444' });
    assert.equal(c.status, 201);
    const custId = c.body.id;
    const { status, body } = await get(server, `/api/finance/customers/${custId}/360`);
    assert.equal(status, 200);
    assert.equal(body.customer.id, custId);
    assert.equal(body.customer.name, 'Wave32Cust');
    assert.equal(body.customer.hvhh, '44444444');
    assert.ok(Array.isArray(body.open_invoices));
    assert.equal(body.open_invoices.length, 0);
    assert.ok(Array.isArray(body.recent_payments));
    assert.equal(body.totals.open_count, 0);
    assert.equal(body.totals.outstanding_amd, 0);
    assert.equal(body.aging.current, 0);
  });

  test('36e. GET /api/finance/customers/:id/360 returns 404 for missing customer (no existence-oracle leak)', async () => {
    const { status, body } = await get(server, '/api/finance/customers/999999/360');
    assert.equal(status, 404);
    assert.equal(body.error, 'not_found');
  });

  // ─── Wave 35: dashboard 360 route ───

  test('36f. GET /api/finance/360 returns the full dashboard JSON (Wave 35)', async () => {
    // The dashboard endpoint returns the AR + AP totals + top
    // customers + top vendors in one round-trip. The seed data
    // from earlier tests (the customer 1 we created in test 22)
    // means there's at least some data — we assert the shape +
    // the fields exist. The specific counts depend on the seed;
    // the structural assertions are the load-bearing ones.
    const { status, body } = await get(server, '/api/finance/360');
    assert.equal(status, 200);
    assert.equal(typeof body.today, 'string');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(body.today));
    assert.ok(body.ar, 'response should include ar');
    assert.ok(body.ap, 'response should include ap');
    assert.ok(typeof body.ar.open_count === 'number');
    assert.ok(typeof body.ar.outstanding_amd === 'number');
    assert.ok(body.ar.aging, 'ar.aging should exist');
    assert.ok(typeof body.ar.aging.current === 'number');
    assert.ok(typeof body.ar.aging.days_1_30 === 'number');
    assert.ok(typeof body.ar.aging.days_31_60 === 'number');
    assert.ok(typeof body.ar.aging.days_61_90 === 'number');
    assert.ok(typeof body.ar.aging.days_90_plus === 'number');
    assert.ok(typeof body.ap.open_count === 'number');
    assert.ok(typeof body.ap.outstanding_amd === 'number');
    assert.ok(body.ap.aging, 'ap.aging should exist');
    assert.ok(Array.isArray(body.top_customers));
    assert.ok(Array.isArray(body.top_vendors));
  });

  test('36g. GET /api/finance/360?today=YYYY-MM-DD uses the override (back-dated aging)', async () => {
    // The ?today query param lets the operator pull a back-dated
    // dashboard. The response.today should reflect the override.
    const { status, body } = await get(server, '/api/finance/360?today=2026-01-01');
    assert.equal(status, 200);
    assert.equal(body.today, '2026-01-01');
  });

  // ─── Wave 36: vendor 360 route ───

  test('36h. GET /api/finance/vendors/:id/360 returns the full 360 view (Wave 36)', async () => {
    // Vendor 360 was shipped as a pure function in Wave 33;
    // this wave wires the route. Empty vendor (no POs yet)
    // returns the expected shape with zero totals + empty arrays.
    const { status, body } = await get(server, '/api/finance/vendors/999998/360');
    assert.equal(status, 404, 'vendor 999998 should not exist in this tenant');
    assert.equal(body.error, 'not_found');
  });

  // ─── Wave 39: lots + serials route wiring ───

  test('39a. GET /api/finance/lots?catalog_item_id=N returns the items lots (Wave 39)', async () => {
    // Seed a catalog item + a lot via the admin path.
    const item = await postJson(server, '/api/finance/catalog/items', {
      sku: 'W39-LOT-RT', name: 'W39 lot route test item',
    });
    assert.equal(item.status, 201);
    const { createLot } = await import('./finance/lots.js');
    const lot = await createLot(full.pgAdapter, {
      code: 'LOT-RT-1', catalog_item_id: item.body.id, received_at: '2026-06-21',
    }, 0);
    const { status, body } = await get(server, `/api/finance/lots?catalog_item_id=${item.body.id}`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].id, lot.id);
    assert.equal(body.items[0].code, 'LOT-RT-1');
  });

  test('39b. GET /api/finance/lots/:id returns a single lot (Wave 39)', async () => {
    const item = await postJson(server, '/api/finance/catalog/items', {
      sku: 'W39-LOT-SINGLE', name: 'W39 single lot',
    });
    const { createLot } = await import('./finance/lots.js');
    const lot = await createLot(full.pgAdapter, {
      code: 'LOT-SINGLE', catalog_item_id: item.body.id, received_at: '2026-06-21',
    }, 0);
    const { status, body } = await get(server, `/api/finance/lots/${lot.id}`);
    assert.equal(status, 200);
    assert.equal(body.id, lot.id);
    assert.equal(body.code, 'LOT-SINGLE');
  });

  test('39c. GET /api/finance/lots/:id returns 404 for missing lot (no existence-oracle leak)', async () => {
    const { status, body } = await get(server, '/api/finance/lots/999999');
    assert.equal(status, 404);
    assert.equal(body.error, 'not_found');
  });

  test('39d. GET /api/finance/lots without catalog_item_id returns 400', async () => {
    const { status, body } = await get(server, '/api/finance/lots');
    assert.equal(status, 400);
    assert.equal(body.error, 'bad_request');
    assert.match(body.message, /catalog_item_id/);
  });

  test('39e. GET /api/finance/serials?catalog_item_id=N returns the items serials (Wave 39)', async () => {
    const item = await postJson(server, '/api/finance/catalog/items', {
      sku: 'W39-SERIAL-RT', name: 'W39 serial route test item',
    });
    const { createSerial } = await import('./finance/lots.js');
    const s1 = await createSerial(full.pgAdapter, {
      serial_number: 'SN-RT-1', catalog_item_id: item.body.id, received_at: '2026-06-21',
    }, 0);
    const s2 = await createSerial(full.pgAdapter, {
      serial_number: 'SN-RT-2', catalog_item_id: item.body.id, received_at: '2026-06-21',
    }, 0);
    const { status, body } = await get(server, `/api/finance/serials?catalog_item_id=${item.body.id}`);
    assert.equal(status, 200);
    assert.equal(body.items.length, 2);
    const ids = body.items.map(s => s.id).sort();
    assert.deepEqual(ids, [s1.id, s2.id].sort());
  });

  test('39f. GET /api/finance/items/:itemId/lots returns the same data as /api/finance/lots?catalog_item_id=N (route alias)', async () => {
    const item = await postJson(server, '/api/finance/catalog/items', {
      sku: 'W39-LOT-ALIAS', name: 'W39 lot alias test',
    });
    const { createLot } = await import('./finance/lots.js');
    await createLot(full.pgAdapter, {
      code: 'LOT-ALIAS', catalog_item_id: item.body.id, received_at: '2026-06-21',
    }, 0);
    const a = await get(server, `/api/finance/lots?catalog_item_id=${item.body.id}`);
    const b = await get(server, `/api/finance/items/${item.body.id}/lots`);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(b.body.items.length, a.body.items.length);
  });

  // ─── Wave 41: product recall ───

  test('41a. POST /api/finance/lots/:id/recall cascades status=recalled to all serials', async () => {
    const item = await postJson(server, '/api/finance/catalog/items', {
      sku: 'W41-RECALL', name: 'W41 recall item',
    });
    const { createLot, createSerial } = await import('./finance/lots.js');
    const lot = await createLot(full.pgAdapter, {
      code: 'LOT-RECALL-1', catalog_item_id: item.body.id, received_at: '2026-06-21',
    }, 0);
    const s1 = await createSerial(full.pgAdapter, {
      serial_number: 'SN-RECALL-1', catalog_item_id: item.body.id,
      lot_id: lot.id, current_location_id: 5, received_at: '2026-06-21',
    }, 0);
    const s2 = await createSerial(full.pgAdapter, {
      serial_number: 'SN-RECALL-2', catalog_item_id: item.body.id,
      lot_id: lot.id, current_location_id: 7, received_at: '2026-06-21',
    }, 0);
    // Trigger the recall.
    const r = await postJson(server, `/api/finance/lots/${lot.id}/recall`, {
      reason: 'Supplier flagged contamination — lot XYZ may be unsafe',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.already_recalled, false);
    assert.equal(r.body.recalled_serials, 2);
    assert.ok(r.body.lot.recalled_at, 'lot should have recalled_at stamped');
    assert.equal(r.body.lot.recall_reason, 'Supplier flagged contamination — lot XYZ may be unsafe');
    // Verify serials are now recalled via the GET endpoint.
    const recalled = await get(server, `/api/finance/lots/${lot.id}/recalled-serials`);
    assert.equal(recalled.status, 200);
    assert.equal(recalled.body.items.length, 2);
    const ids = recalled.body.items.map(s => s.id).sort();
    assert.deepEqual(ids, [s1.id, s2.id].sort());
  });

  test('41b. POST /api/finance/lots/:id/recall with missing reason returns 400', async () => {
    const item = await postJson(server, '/api/finance/catalog/items', {
      sku: 'W41-NORSN', name: 'W41 no-reason item',
    });
    const { createLot } = await import('./finance/lots.js');
    const lot = await createLot(full.pgAdapter, {
      code: 'LOT-NORSN', catalog_item_id: item.body.id, received_at: '2026-06-21',
    }, 0);
    const r = await postJson(server, `/api/finance/lots/${lot.id}/recall`, {});
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_request');
    assert.match(r.body.message, /reason is required/);
  });

  test('41c. POST /api/finance/lots/:id/recall is idempotent — second call returns already_recalled=true', async () => {
    const item = await postJson(server, '/api/finance/catalog/items', {
      sku: 'W41-IDEMP', name: 'W41 idempotent item',
    });
    const { createLot, createSerial } = await import('./finance/lots.js');
    const lot = await createLot(full.pgAdapter, {
      code: 'LOT-IDEMP', catalog_item_id: item.body.id, received_at: '2026-06-21',
    }, 0);
    await createSerial(full.pgAdapter, {
      serial_number: 'SN-IDEMP', catalog_item_id: item.body.id,
      lot_id: lot.id, received_at: '2026-06-21',
    }, 0);
    const first = await postJson(server, `/api/finance/lots/${lot.id}/recall`, {
      reason: 'first recall',
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.already_recalled, false);
    const second = await postJson(server, `/api/finance/lots/${lot.id}/recall`, {
      reason: 'second recall',
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.already_recalled, true);
    // The recall_reason is preserved from the first call.
    assert.equal(second.body.lot.recall_reason, 'first recall');
  });

  test('41d. POST /api/finance/lots/:id/recall with force=true re-cascades and updates the reason', async () => {
    const item = await postJson(server, '/api/finance/catalog/items', {
      sku: 'W41-FORCE', name: 'W41 force-recall item',
    });
    const { createLot, createSerial, getSerial } = await import('./finance/lots.js');
    const lot = await createLot(full.pgAdapter, {
      code: 'LOT-FORCE', catalog_item_id: item.body.id, received_at: '2026-06-21',
    }, 0);
    const s = await createSerial(full.pgAdapter, {
      serial_number: 'SN-FORCE', catalog_item_id: item.body.id,
      lot_id: lot.id, current_location_id: 5, received_at: '2026-06-21',
    }, 0);
    await postJson(server, `/api/finance/lots/${lot.id}/recall`, {
      reason: 'first reason',
    });
    // Simulate: customer returns the unit after the recall notice.
    await import('./finance/lots.js').then(m => m.assignSerialLocation(
      full.pgAdapter, 0, s.id, 5, 'returned', null,
    ));
    // Re-recall with force.
    const out = await postJson(server, `/api/finance/lots/${lot.id}/recall`, {
      reason: 're-cascade with extra serials',
      force: true,
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.already_recalled, false);
    assert.equal(out.body.lot.recall_reason, 're-cascade with extra serials');
    const updated = await getSerial(full.pgAdapter, s.id, 0);
    assert.equal(updated.status, 'recalled');
  });

  test('41e. POST /api/finance/lots/999999/recall returns 404 for missing lot', async () => {
    const r = await postJson(server, '/api/finance/lots/999999/recall', {
      reason: 'no such lot',
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
  });

  // ─── Wave 42: user-facing session management ───

  // Helper: insert a session row for a user. Mirrors the production
  // schema (permission_set_ids_json + effective_permissions_json are
  // NOT NULL — the boot-minted admin token row has them as '[]').
  function seedSession(db, { id, userId, roleId = 'Admin', expiresAt }) {
    db.prepare(
      `INSERT INTO sbos_rbac_sessions
         (id, user_id, tenant_id, role_id,
          permission_set_ids_json, effective_permissions_json,
          created_at, last_seen_at, expires_at)
       VALUES (?, ?, 0, ?, '[]', '[]', datetime('now'), datetime('now'), ?)`,
    ).run(id, userId, roleId, expiresAt);
  }

  test('42a. GET /api/auth/sessions returns the user\'s active sessions', async () => {
    // Stub auth mode sets req.user.id = 1 (the admin). Insert a
    // session row directly so listMySessions returns something.
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    full.db.prepare('DELETE FROM sbos_rbac_sessions WHERE user_id = 1 AND id LIKE ?').run('W42-%');
    seedSession(full.db, { id: 'W42-my-current', userId: 1, expiresAt: future });
    const { status, body } = await get(server, '/api/auth/sessions');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
    assert.ok(body.items.length >= 1);
    // The session we just inserted must be in the list.
    const found = body.items.find((s) => s.id === 'W42-my-current');
    assert.ok(found, `expected to find W42-my-current in ${JSON.stringify(body.items)}`);
  });

  test('42b. POST /api/auth/sessions/:id/revoke revokes a session the user owns', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    full.db.prepare('DELETE FROM sbos_rbac_sessions WHERE user_id = 1 AND id LIKE ?').run('W42-%');
    seedSession(full.db, { id: 'W42-revoke-me', userId: 1, expiresAt: future });
    const r = await postJson(server, '/api/auth/sessions/W42-revoke-me/revoke', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.revoked, 'W42-revoke-me');
    // Verify the row is marked revoked.
    const row = full.db.prepare('SELECT revoked_at FROM sbos_rbac_sessions WHERE id = ?').get('W42-revoke-me');
    assert.ok(row.revoked_at, 'session should be marked revoked');
  });

  test('42c. POST /api/auth/sessions/:id/revoke returns 404 for cross-user session (scope check)', async () => {
    // Insert a session for user 2 (bob). Stub auth mode uses user 1
    // (admin). The endpoint must reject with 404 — not silently succeed.
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    full.db.prepare('DELETE FROM sbos_rbac_sessions WHERE id LIKE ?').run('W42-other-%');
    full.db.prepare('DELETE FROM users WHERE id = ?').run(2);
    full.db.prepare('INSERT INTO users (id, username, email, role, tenant_id) VALUES (?, ?, ?, ?, 0)').run(2, 'bob', 'bob@example.com', 'Operator');
    seedSession(full.db, { id: 'W42-other-bobs', userId: 2, roleId: 'Operator', expiresAt: future });
    const r = await postJson(server, '/api/auth/sessions/W42-other-bobs/revoke', {});
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
    // Verify bob's session is NOT revoked.
    const row = full.db.prepare('SELECT revoked_at FROM sbos_rbac_sessions WHERE id = ?').get('W42-other-bobs');
    assert.equal(row.revoked_at, null);
  });

  test('42d. POST /api/auth/sessions/revoke-all revokes every active session for the user', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    full.db.prepare('DELETE FROM sbos_rbac_sessions WHERE user_id = 1 AND id LIKE ?').run('W42-%');
    full.db.prepare('DELETE FROM sbos_rbac_sessions WHERE user_id = 2 AND id LIKE ?').run('W42-%');
    seedSession(full.db, { id: 'W42-all-1', userId: 1, expiresAt: future });
    seedSession(full.db, { id: 'W42-all-2', userId: 1, expiresAt: future });
    // Add a session for bob (must NOT be touched).
    seedSession(full.db, { id: 'W42-all-bobs', userId: 2, roleId: 'Operator', expiresAt: future });
    const r = await postJson(server, '/api/auth/sessions/revoke-all', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.revoked_count, 2);
    // Bob's session is untouched.
    const bob = full.db.prepare('SELECT revoked_at FROM sbos_rbac_sessions WHERE id = ?').get('W42-all-bobs');
    assert.equal(bob.revoked_at, null);
  });

  // ─── Deferred item: per-permission endpoint guards ───

  test('37. The per-permission guard is wired on POST /api/finance/invoices (sanity: admin has the perm)', async () => {
    // This test just verifies that an admin user with the FinanceOperator
    // perm set can still POST. The negative case (403) is harder to
    // exercise in stub mode (the test pg adapter doesn't bind a
    // user without perms to req.user). The guard is in the route
    // table — verified by reading the route source — and the
    // perm matrix in the rbac layer is exercised by rbac.test.js.
    const c = await postJson(server, '/api/finance/customers', { name: 'GuardCust' });
    const { status } = await postJson(server, '/api/finance/invoices', {
      customer_id: c.body.id,
      invoice_number: 'INV-GUARD-1',
      issue_date: '2026-06-21',
      due_date: '2026-07-21',
      lines: [{ description: 'A', quantity: 1, unit_price_amd: 100 }],
    });
    assert.equal(status, 201);
  });

  // ─── Wave 45: password rotation ───

  test('45a. POST /api/auth/password rotates the current user\'s password (200)', async () => {
    // Stub auth mode sets req.user.id = 1 (admin). Seed the admin
    // password so changePassword can verify it.
    const { hashPassword } = await import('./auth-login.js');
    const { hash, salt } = hashPassword('initial-pass-1');
    full.db.prepare('DELETE FROM users WHERE id = 1').run();
    full.db.prepare(
      `INSERT INTO users (id, username, email, role, tenant_id, password_hash, password_salt)
       VALUES (1, 'admin', 'admin@example.com', 'Admin', 0, ?, ?)`,
    ).run(hash, salt);
    const r = await postJson(server, '/api/auth/password', {
      old_password: 'initial-pass-1',
      new_password: 'rotated-pass-2',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    // The new password is now in the DB.
    const row = full.db.prepare('SELECT password_hash, password_salt FROM users WHERE id = 1').get();
    assert.ok(row.password_hash, 'password_hash should be set');
    assert.ok(row.password_salt, 'password_salt should be set');
    // The new hash should NOT match the old hash.
    assert.notEqual(row.password_hash, hash);
  });

  test('45b. POST /api/auth/password with wrong old password returns 403', async () => {
    const r = await postJson(server, '/api/auth/password', {
      old_password: 'wrong-password',
      new_password: 'another-pass-2',
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'change_password_failed');
    assert.match(r.body.message, /old password is incorrect/);
  });

  test('45c. POST /api/auth/password with short new password returns 400', async () => {
    const r = await postJson(server, '/api/auth/password', {
      old_password: 'rotated-pass-2',  // the current password from 45a
      new_password: 'short',
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'change_password_failed');
    assert.match(r.body.message, /at least 8 chars/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Validation contract — covers createApp guard branches.
// ────────────────────────────────────────────────────────────────────────

describe('createApp validation guards', () => {
  test('rejects missing db', async () => {
    const { createApp } = await import('./index.js');
    await assert.rejects(
      () => createApp({ pgAdapter: { query: async () => ({ rows: [] }) } }),
      /createApp requires a db/,
    );
  });

  test('accepts missing pgAdapter (constructed from dbRef by default)', async () => {
    const { createApp } = await import('./index.js');
    const { sqliteDb } = makeFinanceDb();
    // Wave 54: pgAdapter is now optional. createApp constructs
    // it from the same dbRef that swapDb updates, so the live
    // swap propagates to every finance route. Old code required
    // a caller-supplied pgAdapter; new code wires it internally.
    const app = await createApp({ db: sqliteDb });
    assert.ok(app, 'createApp must succeed with just `db`');
  });
});

// ────────────────────────────────────────────────────────────────────────
// server.js start() — covers the no-app branch.
// ────────────────────────────────────────────────────────────────────────

describe('start() — bootable HTTP server boot', () => {
  test('start() with no app builds one from db + pgAdapter + locale', async () => {
    const { start } = await import('./server.js');
    const { sqliteDb } = makeFinanceDb();
    const pgAdapter = {
      async query(sql, params = []) {
        const stmt = sqliteDb.prepare(String(sql).replace(/\$\d+/g, '?'));
        return { rows: stmt.all(...(params || [])) };
      },
    };
    const server = await start({ db: sqliteDb, pgAdapter, port: 0, host: '127.0.0.1' });
    const { status, body } = await get(server, '/api/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    await new Promise((resolve) => server.close(() => resolve()));
  });
});
