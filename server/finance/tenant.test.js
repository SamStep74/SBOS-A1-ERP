// Tests for server/finance/tenant.js — multi-tenant middleware + helpers.
//
// Two test surfaces live here:
//   (A) Real-DB isolation: a node:sqlite DB with the migration applied,
//       two tenants, two invoices (one per tenant), and getArAging called
//       once per tenant — verifies each call sees only its tenant's data.
//   (B) Express middleware: mock req/res objects to exercise the
//       requireTenant middleware (header read, fallback to user, 400 on
//       missing, integer-only guard).
//   (C) Helper composition: scopedQuery / withTenant smoke tests using
//       the same mock-DB patterns the rest of finance uses.
//
// The 80-line cap on other test files does NOT apply here — the task
// brief explicitly carves out schema + middleware from that rule.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Node 20 CI does not ship node:sqlite. The real-DB tests skip in that
  // environment; the middleware + helper tests still run.
}

// ────────────────────────────────────────────────────────────────────────
// Real-DB harness — build a fresh sqlite DB with the finance schema
// (waves 1-4 columns) plus the new tenant_id column from 0005. Mirrors
// the wave-5.1 realdb-smoke.test.js pattern: ATTACH ... AS finance so
// the pg-style schema-qualified names in the production code resolve.
// ────────────────────────────────────────────────────────────────────────

function makeRealDbWithTenants() {
  const dir = mkdtempSync(join(tmpdir(), 'sbos-finance-tenant-'));
  const sqliteDb = new DatabaseSync(join(dir, 'finance.db'));
  sqliteDb.exec('ATTACH DATABASE ":memory:" AS finance');
  sqliteDb.exec('PRAGMA foreign_keys = OFF');
  sqliteDb.exec(`
    CREATE TABLE finance.tenants (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.customers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      hvhh        TEXT,
      address     TEXT,
      tenant_id   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.invoices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id     INTEGER NOT NULL,
      invoice_number  TEXT NOT NULL UNIQUE,
      issue_date      TEXT NOT NULL,
      due_date        TEXT NOT NULL,
      subtotal_amd    INTEGER NOT NULL,
      vat_amd         INTEGER NOT NULL DEFAULT 0,
      total_amd       INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('draft','sent','paid','overdue','void')),
      notes           TEXT,
      tenant_id       INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at         TEXT, voided_at TEXT, void_reason TEXT
    );
    CREATE TABLE finance.invoice_lines (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id      INTEGER NOT NULL,
      description     TEXT NOT NULL,
      quantity        REAL NOT NULL,
      unit_price_amd  INTEGER NOT NULL,
      line_total_amd  INTEGER NOT NULL,
      tenant_id       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE finance.payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id      INTEGER NOT NULL,
      paid_at         TEXT NOT NULL DEFAULT (datetime('now')),
      amount_amd      INTEGER NOT NULL,
      method          TEXT NOT NULL DEFAULT 'bank_transfer',
      reference       TEXT,
      tenant_id       INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO finance.tenants (id, name) VALUES (0, 'bootstrap');
  `);
  return { sqliteDb, dir };
}

// node:sqlite uses `?` positional placeholders. The production code uses
// pg-style `$N`. This adapter rewrites the SQL the way the wave-5.1
// realdb-smoke test does, and returns `{ rows }` so the production
// pg-dispatch path in invoice.js / reports.js runs unmodified.
function makePgAdapter(sqliteDb) {
  return {
    async query(sql, params = []) {
      const translated = sql.replace(/\$\d+/g, '?').replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*/g, '');
      const stmt = sqliteDb.prepare(translated);
      const rows = stmt.all(...(params || []));
      return { rows };
    },
  };
}

// Minimal in-memory mock DB for the helper tests. Mirrors the shape the
// reports.test.js mock uses, so we know scopedQuery is consistent with
// the rest of the finance surface. The mock records every statement
// and always returns an empty row set — the helper tests only assert
// on the SQL/params that the production code hands to `db.query`, not
// on what comes back.
function makeMockDb() {
  const statements = [];
  return {
    statements,
    async query(sql, params) {
      statements.push({ sql, params: params ?? [] });
      return { rows: [] };
    },
  };
}

// Mock req/res for middleware tests. Tiny surface — what the production
// requireTenant needs.
function mockReqRes(overrides = {}) {
  const req = {
    headers: {},
    user: null,
    ...overrides.req,
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  let nextCalled = false;
  let nextError = null;
  return {
    req,
    res,
    next: (err) => {
      nextCalled = true;
      nextError = err;
    },
    nextCalled: () => nextCalled,
    nextError: () => nextError,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('finance/tenant — multi-tenant middleware + helpers', () => {
  // The middleware / helper tests are pure JS; they don't need sqlite.
  let requireTenant, scopedQuery, withTenant, parseTenantId, ValueError;

  before(async () => {
    const mod = await import('./tenant.js');
    requireTenant = mod.requireTenant;
    scopedQuery = mod.scopedQuery;
    withTenant = mod.withTenant;
    ValueError = mod.ValueError;
    parseTenantId = mod.__internals.parseTenantId;
  });

  // ─── (B) Middleware tests ─────────────────────────────────────────────

  test('1. requireTenant returns 400 when no X-Tenant-Id header and no req.user', () => {
    const { req, res, next, nextCalled } = mockReqRes();
    requireTenant(req, res, next);
    assert.equal(nextCalled(), false, 'next() must NOT be called when tenant is missing');
    assert.equal(res.statusCode, 400, 'must respond 400');
    assert.equal(res.body.error, 'tenant_required');
    assert.ok(typeof res.body.message === 'string' && res.body.message.length > 0);
  });

  test('2. requireTenant stamps req.tenantId from X-Tenant-Id header', () => {
    const { req, res, next, nextCalled } = mockReqRes({
      req: { headers: { 'x-tenant-id': '7' } },
    });
    requireTenant(req, res, next);
    assert.equal(nextCalled(), true, 'next() must be called when header is present');
    assert.equal(req.tenantId, 7, 'req.tenantId must equal the parsed header value');
    assert.equal(res.statusCode, 200, 'no 400 sent');
  });

  test('3. requireTenant falls back to req.user.tenant_id when header is missing', () => {
    const { req, res, next, nextCalled } = mockReqRes({
      req: { user: { id: 42, role: 'Admin', tenant_id: 3 } },
    });
    requireTenant(req, res, next);
    assert.equal(nextCalled(), true, 'next() called');
    assert.equal(req.tenantId, 3, 'req.tenantId from user.tenant_id fallback');
  });

  test('4. requireTenant prefers X-Tenant-Id over req.user.tenant_id when both are present', () => {
    const { req, res, next, nextCalled } = mockReqRes({
      req: {
        headers: { 'x-tenant-id': '99' },
        user: { id: 1, role: 'Admin', tenant_id: 3 },
      },
    });
    requireTenant(req, res, next);
    assert.equal(nextCalled(), true);
    assert.equal(req.tenantId, 99, 'header wins over user.tenant_id');
  });

  test('5. requireTenant returns 400 on non-integer header (string, float, NaN)', () => {
    // Note: '0' is intentionally NOT in this list — tenant 0 is the
    // bootstrap tenant (the migration's DEFAULT 0) and must remain
    // valid. Bad values are: non-digits, fractions, scientific notation,
    // negatives, hex, leading `+`.
    for (const bad of ['abc', '1.5', '', 'NaN', 'null', '-1', '1e2', '+7', '0x7']) {
      const { req, res, next, nextCalled } = mockReqRes({
        req: { headers: { 'x-tenant-id': bad } },
      });
      requireTenant(req, res, next);
      assert.equal(
        nextCalled(),
        false,
        `next() must NOT be called for header=${JSON.stringify(bad)}`,
      );
      assert.equal(res.statusCode, 400, `400 for header=${JSON.stringify(bad)}`);
      assert.equal(res.body.error, 'tenant_required');
    }
  });

  test('6. requireTenant accepts positive integers including large ones', () => {
    for (const ok of ['1', '42', '999999']) {
      const { req, res, next, nextCalled } = mockReqRes({
        req: { headers: { 'x-tenant-id': ok } },
      });
      requireTenant(req, res, next);
      assert.equal(nextCalled(), true, `next() called for header=${ok}`);
      assert.equal(req.tenantId, Number(ok), `req.tenantId parsed from ${ok}`);
    }
  });

  // ─── (C) Helper tests ────────────────────────────────────────────────

  test('7. scopedQuery composes AND tenant_id = ? into a base SELECT', async () => {
    // makeMockDb is here so the test reads as a unit-of-`db.query`-caller;
    // the helper doesn't actually execute anything.
    const _db = makeMockDb();
    const { sql, params } = scopedQuery(
      'SELECT id, total_amd FROM finance.invoices WHERE status = $1',
      7,
      ['sent'],
    );
    // The composed SQL must contain a tenant_id predicate, and the params
    // array must end with the tenant id (the same $N position the
    // production code will resolve to ? in the driver).
    assert.ok(/tenant_id\s*=\s*\$\d+/i.test(sql), 'must inject tenant_id predicate');
    assert.equal(params[params.length - 1], 7, 'tenant id must be the last param');
  });

  test('8. scopedQuery returns a frozen {sql, params} pair', () => {
    const out = scopedQuery('SELECT 1', 1, []);
    assert.ok(Object.isFrozen(out), 'result must be frozen');
    assert.equal(typeof out.sql, 'string');
    assert.ok(Array.isArray(out.params));
  });

  test("9. withTenant returns a promise resolving to fn's value (sqlite path)", async () => {
    const db = makeMockDb();
    const out = await withTenant(db, 0, async () => 'ok');
    assert.equal(out, 'ok');
  });

  test('10. withTenant accepts fn returning a value (not a promise)', async () => {
    const db = makeMockDb();
    const out = await withTenant(db, 5, () => 42);
    assert.equal(out, 42);
  });

  test('10a. parseTenantId accepts a numeric input (the internal helper)', () => {
    assert.equal(parseTenantId(0), 0);
    assert.equal(parseTenantId(42), 42);
    assert.equal(parseTenantId(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  });

  test('10b. parseTenantId rejects negative / non-integer / non-finite numbers', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(parseTenantId(bad), null, `bad input ${String(bad)} should return null`);
    }
  });

  test('10c. withTenant throws ValueError on bad tenantId / fn', async () => {
    const db = makeMockDb();
    await assert.rejects(
      () => withTenant(db, -1, () => 1),
      (err) => err.name === 'ValueError',
    );
    await assert.rejects(
      () => withTenant(db, 'abc', () => 1),
      (err) => err.name === 'ValueError',
    );
    await assert.rejects(
      () => withTenant(db, 1, null),
      (err) => err.name === 'TypeError',
    );
  });

  test('10d. scopedQuery throws ValueError on bad baseSql / tenantId', () => {
    assert.throws(
      () => scopedQuery('', 0),
      (err) => err.name === 'ValueError',
    );
    assert.throws(
      () => scopedQuery(null, 0),
      (err) => err.name === 'ValueError',
    );
    assert.throws(
      () => scopedQuery('SELECT 1', -1),
      (err) => err.name === 'ValueError',
    );
    assert.throws(
      () => scopedQuery('SELECT 1', 'x'),
      (err) => err.name === 'ValueError',
    );
  });

  test('10e. ValueError is exported and is a real Error subclass', () => {
    // The tenant.js module re-exports ValueError for callers that want
    // to match by class, the same way invoice.js / payment.js do.
    assert.equal(typeof ValueError, 'function');
    const e = new ValueError('boom');
    assert.ok(e instanceof Error);
    assert.ok(e instanceof ValueError);
    assert.equal(e.name, 'ValueError');
    assert.equal(e.message, 'boom');
  });
});

// ─── (A) Real-DB isolation tests ────────────────────────────────────────
//
// These require node:sqlite. On Node 20 (no node:sqlite) the describe is
// skipped automatically.

const describeSqlite = DatabaseSync ? describe : describe.skip;

describeSqlite('finance/tenant — real-DB two-tenant isolation', () => {
  let db;
  let getArAging;
  let dir;
  const cleanupDirs = [];

  after(() => {
    for (const d of cleanupDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  before(async () => {
    const built = makeRealDbWithTenants();
    db = makePgAdapter(built.sqliteDb);
    dir = built.dir;
    cleanupDirs.push(dir);

    // Insert the second tenant. The first (id=0) is already inserted by
    // makeRealDbWithTenants() — it represents the bootstrap tenant.
    built.sqliteDb
      .prepare('INSERT INTO finance.tenants (id, name) VALUES (?, ?)')
      .run(1, 'Acme LLC');

    // Two customers, one per tenant.
    built.sqliteDb
      .prepare('INSERT INTO finance.customers (id, name, tenant_id) VALUES (?, ?, ?)')
      .run(1, 'T0 Customer', 0);
    built.sqliteDb
      .prepare('INSERT INTO finance.customers (id, name, tenant_id) VALUES (?, ?, ?)')
      .run(2, 'T1 Customer', 1);

    // Two invoices, one per tenant. Both sent+overdue so they show up in
    // the AR aging buckets. due_date is 50 days before asOfDate so both
    // fall into the 31-60 bucket.
    built.sqliteDb
      .prepare(
        `INSERT INTO finance.invoices
           (id, customer_id, invoice_number, issue_date, due_date,
            subtotal_amd, vat_amd, total_amd, status, tenant_id, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        1,
        'T0-INV-1',
        '2026-04-15',
        '2026-05-01',
        80000,
        0,
        80000,
        'sent',
        0,
        '2026-04-15T00:00:00Z',
      );
    built.sqliteDb
      .prepare(
        `INSERT INTO finance.invoices
           (id, customer_id, invoice_number, issue_date, due_date,
            subtotal_amd, vat_amd, total_amd, status, tenant_id, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        2,
        2,
        'T1-INV-1',
        '2026-04-15',
        '2026-05-01',
        200000,
        0,
        200000,
        'sent',
        1,
        '2026-04-15T00:00:00Z',
      );

    // Import the production reports module. We import lazily here so the
    // sqlite skip path doesn't try to load a module that may depend on it.
    const reportsMod = await import('./reports.js');
    getArAging = reportsMod.getArAging;
  });

  test('11. getArAging(db, asOfDate, tenantId=0) returns only tenant-0 invoices', async () => {
    const out = await getArAging(db, '2026-06-20', 0);
    // Tenant 0 has the 80k invoice → outstanding 80k. The tenant-1
    // 200k invoice must NOT appear.
    assert.equal(out.total_outstanding_amd, 80000, 'only tenant-0 80k counted');
    assert.equal(out.buckets['31_60'].invoice_count, 1, 'one 31-60 bucket row');
    assert.equal(out.buckets['31_60'].amount_amd, 80000, '31-60 amount = 80k');
    for (const k of Object.keys(out.buckets)) {
      if (k === '31_60') continue;
      assert.equal(out.buckets[k].invoice_count, 0, `${k} bucket must be empty`);
      assert.equal(out.buckets[k].amount_amd, 0, `${k} amount must be 0`);
    }
  });

  test('12. getArAging(db, asOfDate, tenantId=1) returns only tenant-1 invoices', async () => {
    const out = await getArAging(db, '2026-06-20', 1);
    // Tenant 1 has the 200k invoice only.
    assert.equal(out.total_outstanding_amd, 200000, 'only tenant-1 200k counted');
    assert.equal(out.buckets['31_60'].invoice_count, 1, 'one 31-60 bucket row');
    assert.equal(out.buckets['31_60'].amount_amd, 200000, '31-60 amount = 200k');
    for (const k of Object.keys(out.buckets)) {
      if (k === '31_60') continue;
      assert.equal(out.buckets[k].invoice_count, 0, `${k} bucket must be empty`);
      assert.equal(out.buckets[k].amount_amd, 0, `${k} amount must be 0`);
    }
  });

  test('13. getArAging with no tenantId arg defaults to tenant 0 (back-compat)', async () => {
    const out = await getArAging(db, '2026-06-20');
    // tenantId defaults to 0, so we see only the tenant-0 80k invoice.
    assert.equal(out.total_outstanding_amd, 80000, 'default tenantId=0 → 80k');
  });

  test('14. getArAging with non-existent tenant returns zero totals', async () => {
    const out = await getArAging(db, '2026-06-20', 9999);
    assert.equal(out.total_outstanding_amd, 0, 'unknown tenant → 0 outstanding');
    for (const k of Object.keys(out.buckets)) {
      assert.equal(out.buckets[k].invoice_count, 0);
      assert.equal(out.buckets[k].amount_amd, 0);
    }
  });
});
