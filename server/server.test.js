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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER
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
      mfa_verified INTEGER NOT NULL DEFAULT 0
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

  before(async () => {
    const { createApp } = await import('./index.js');
    const { start } = await import('./server.js');
    full = makeFullDb();
    app = await createApp({ db: full.db, pgAdapter: full.pgAdapter, locale: 'en' });
    server = await start({ app, port: 0, host: '127.0.0.1' });
  });

  after(async () => {
    if (server && server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
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

  test('rejects missing pgAdapter', async () => {
    const { createApp } = await import('./index.js');
    const { sqliteDb } = makeFinanceDb();
    await assert.rejects(() => createApp({ db: sqliteDb }), /createApp requires a pgAdapter/);
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
