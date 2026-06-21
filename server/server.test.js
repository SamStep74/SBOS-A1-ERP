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
