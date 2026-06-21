// server/finance/vendor360.test.js
//
// Tests for the CFO 360 view of a vendor. Mirrors the
// customer360.test.js pattern: real in-memory sqlite with a
// minimal vendor/purchase schema, seed via direct SQL, exercise
// the pure function. Production CRUD (createVendor, createPurchaseOrder,
// etc.) is tested separately in purchase.test.js — these tests
// focus on the 360 view's data composition.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { getVendor360, ValueError } from './vendor360.js';

// ────────────────────────────────────────────────────────────────────────
// Minimal real in-memory sqlite + pg-style adapter. Mirrors the
// customer360.test.js / realdb-smoke.test.js pattern: production-
// shape schema, real sqlite, pg-style $N → ? translation, ::bigint
// cast stripping.
// ────────────────────────────────────────────────────────────────────────

function makeDb() {
  const sqliteDb = new DatabaseSync(':memory:');
  sqliteDb.exec('ATTACH DATABASE ":memory:" AS finance');
  sqliteDb.exec('PRAGMA foreign_keys = OFF');
  sqliteDb.exec(`
    CREATE TABLE finance.vendors (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       INTEGER NOT NULL DEFAULT 0,
      code            TEXT NOT NULL,
      name            TEXT NOT NULL,
      hvhh            TEXT,
      address         TEXT,
      email           TEXT,
      phone           TEXT,
      contact_name    TEXT,
      archived        INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.purchase_orders (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id           INTEGER NOT NULL DEFAULT 0,
      order_number        TEXT NOT NULL,
      vendor_id           INTEGER NOT NULL,
      vendor_name         TEXT NOT NULL,
      vendor_hvhh         TEXT,
      status              TEXT NOT NULL DEFAULT 'rfq',
      order_date          TEXT NOT NULL,
      expected_date       TEXT,
      received_quantity   INTEGER NOT NULL DEFAULT 0,
      notes               TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      cancelled_at        TEXT,
      cancelled_reason    TEXT
    );
    CREATE TABLE finance.purchase_order_lines (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       INTEGER NOT NULL DEFAULT 0,
      order_id        INTEGER NOT NULL,
      catalog_item_id INTEGER NOT NULL,
      quantity        INTEGER NOT NULL,
      unit_cost       INTEGER NOT NULL DEFAULT 0,
      description     TEXT,
      line_order      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE finance.purchase_receipts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       INTEGER NOT NULL DEFAULT 0,
      order_id        INTEGER NOT NULL,
      receipt_number  TEXT NOT NULL,
      received_at     TEXT NOT NULL,
      notes           TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return {
    async query(sql, params = []) {
      const translated = sql
        .replace(/\$\d+/g, '?')
        .replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*/g, '');
      const stmt = sqliteDb.prepare(translated);
      const rows = stmt.all(...(params || []));
      return { rows };
    },
  };
}

// Helper: seed a vendor + an optional set of POs (each with one
// line item + total_amd derived from quantity*unit_cost) +
// optional receipts. Returns { db, vendor, pos, receipts }.
async function seedVendor(db, {
  code = 'V-YER',
  name = 'Yerevan Supply Co',
  hvhh = '01234568',
  pos = [],
  receipts = [],
} = {}) {
  const v = await db.query(
    'INSERT INTO finance.vendors (tenant_id, code, name, hvhh) VALUES (?, ?, ?, ?) RETURNING id',
    [0, code, name, hvhh],
  );
  const vendorId = Number(v.rows[0].id);
  const createdPOs = [];
  for (const po of pos) {
    const ins = await db.query(
      `INSERT INTO finance.purchase_orders
         (tenant_id, order_number, vendor_id, vendor_name, status, order_date, expected_date)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [0, po.order_number, vendorId, name, po.status || 'rfq', po.order_date, po.expected_date],
    );
    const poId = Number(ins.rows[0].id);
    await db.query(
      `INSERT INTO finance.purchase_order_lines
         (tenant_id, order_id, catalog_item_id, quantity, unit_cost)
       VALUES (?, ?, ?, ?, ?)`,
      [0, poId, 1, po.quantity || 1, po.unit_cost || 0],
    );
    createdPOs.push({ id: poId, ...po });
  }
  for (const r of receipts) {
    await db.query(
      `INSERT INTO finance.purchase_receipts
         (tenant_id, order_id, receipt_number, received_at, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [0, r.order_id, r.receipt_number, r.received_at, r.notes || null],
    );
  }
  // Re-fetch the vendor using the production getVendor (it uses
  // runQuery with the pg adapter).
  const { getVendor } = await import('./purchase.js');
  return { vendor: await getVendor(db, vendorId, 0), pos: createdPOs };
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('finance/vendor360 — CFO 360 view', () => {
  test('1. getVendor360: missing vendor throws ValueError (route layer maps to 404)', async () => {
    const db = makeDb();
    await assert.rejects(
      () => getVendor360(db, 999, 0, { today: '2026-06-21' }),
      (err) => err instanceof ValueError && /vendor 999 not found/.test(err.message),
    );
  });

  test('2. getVendor360: cross-tenant vendor is invisible (not found in tenant 7)', async () => {
    const db = makeDb();
    const { vendor } = await seedVendor(db, { pos: [] });
    await assert.rejects(
      () => getVendor360(db, vendor.id, 7, { today: '2026-06-21' }),
      (err) => err instanceof ValueError && /not found in tenant 7/.test(err.message),
    );
  });

  test('3. getVendor360: empty vendor (no POs) returns open_purchase_orders=[] and zero totals', async () => {
    const db = makeDb();
    const { vendor } = await seedVendor(db, { pos: [] });
    const out = await getVendor360(db, vendor.id, 0, { today: '2026-06-21' });
    assert.equal(out.vendor.id, vendor.id);
    assert.equal(out.vendor.name, 'Yerevan Supply Co');
    assert.equal(out.open_purchase_orders.length, 0);
    assert.equal(out.recent_receipts.length, 0);
    assert.equal(out.totals.open_count, 0);
    assert.equal(out.totals.open_total_amd, 0);
    assert.equal(out.totals.outstanding_amd, 0);
    assert.equal(out.aging.current, 0);
    assert.equal(out.aging.days_1_30, 0);
    assert.equal(out.aging.days_31_60, 0);
    assert.equal(out.aging.days_61_90, 0);
    assert.equal(out.aging.days_90_plus, 0);
  });

  test('4. getVendor360: one confirmed PO (expected in 10 days) goes into "current" aging bucket', async () => {
    const db = makeDb();
    const { vendor } = await seedVendor(db, {
      pos: [
        { order_number: 'PO-1', status: 'confirmed', order_date: '2026-06-01', expected_date: '2026-07-01', quantity: 10, unit_cost: 10000 },
      ],
    });
    const out = await getVendor360(db, vendor.id, 0, { today: '2026-06-21' });
    assert.equal(out.open_purchase_orders.length, 1);
    assert.equal(out.open_purchase_orders[0].order_number, 'PO-1');
    assert.equal(out.open_purchase_orders[0].total_amd, 100000);
    assert.equal(out.open_purchase_orders[0].outstanding_amd, 100000);
    assert.equal(out.open_purchase_orders[0].days_overdue, 0);
    assert.equal(out.totals.open_count, 1);
    assert.equal(out.totals.open_total_amd, 100000);
    assert.equal(out.totals.outstanding_amd, 100000);
    assert.equal(out.aging.current, 100000);
  });

  test('5. getVendor360: 45-day-overdue PO goes into days_31_60 bucket', async () => {
    const db = makeDb();
    const { vendor } = await seedVendor(db, {
      pos: [
        { order_number: 'PO-OVERDUE', status: 'confirmed', order_date: '2026-04-01', expected_date: '2026-05-07', quantity: 5, unit_cost: 10000 },
      ],
    });
    const out = await getVendor360(db, vendor.id, 0, { today: '2026-06-21' });
    assert.equal(out.open_purchase_orders[0].days_overdue, 45);
    assert.equal(out.aging.days_31_60, 50000);
  });

  test('6. getVendor360: 100-day-overdue PO goes into days_90_plus bucket', async () => {
    const db = makeDb();
    const { vendor } = await seedVendor(db, {
      pos: [
        { order_number: 'PO-VERY-OLD', status: 'partial', order_date: '2025-12-01', expected_date: '2026-03-13', quantity: 7, unit_cost: 10000 },
      ],
    });
    const out = await getVendor360(db, vendor.id, 0, { today: '2026-06-21' });
    assert.equal(out.open_purchase_orders[0].days_overdue, 100);
    assert.equal(out.aging.days_90_plus, 70000);
  });

  test('7. getVendor360: billed PO is excluded from open_purchase_orders + aging', async () => {
    const db = makeDb();
    const { vendor } = await seedVendor(db, {
      pos: [
        { order_number: 'PO-BILLED', status: 'billed', order_date: '2026-05-01', expected_date: '2026-06-01', quantity: 20, unit_cost: 10000 },
      ],
    });
    const out = await getVendor360(db, vendor.id, 0, { today: '2026-06-21' });
    assert.equal(out.open_purchase_orders.length, 0, 'billed PO should be excluded');
    assert.equal(out.totals.open_count, 0);
    assert.equal(out.totals.outstanding_amd, 0);
  });

  test('8. getVendor360: cancelled PO is excluded', async () => {
    const db = makeDb();
    const { vendor } = await seedVendor(db, {
      pos: [
        { order_number: 'PO-CANCELLED', status: 'cancelled', order_date: '2026-05-01', expected_date: '2026-06-01', quantity: 1, unit_cost: 100000 },
      ],
    });
    const out = await getVendor360(db, vendor.id, 0, { today: '2026-06-21' });
    assert.equal(out.open_purchase_orders.length, 0, 'cancelled PO should be excluded');
  });

  test('9. getVendor360: open_purchase_orders sorted by expected_date ASC (most urgent first)', async () => {
    const db = makeDb();
    const { vendor } = await seedVendor(db, {
      pos: [
        { order_number: 'PO-LATER',  status: 'confirmed', order_date: '2026-06-01', expected_date: '2026-08-01', quantity: 1, unit_cost: 100000 },
        { order_number: 'PO-URGENT', status: 'confirmed', order_date: '2026-04-01', expected_date: '2026-05-01', quantity: 1, unit_cost:  50000 },
        { order_number: 'PO-MIDDLE', status: 'confirmed', order_date: '2026-05-01', expected_date: '2026-07-01', quantity: 1, unit_cost:  75000 },
      ],
    });
    const out = await getVendor360(db, vendor.id, 0, { today: '2026-06-21' });
    const numbers = out.open_purchase_orders.map((p) => p.order_number);
    assert.deepEqual(numbers, ['PO-URGENT', 'PO-MIDDLE', 'PO-LATER']);
  });

  test('10. getVendor360: received PO is excluded from overdue aging (operator has the goods)', async () => {
    // status='received' means the operator has the goods. Aging is
    // about "what we expected but haven't received yet" — a received
    // PO has nothing to age. We still surface it in open_purchase_orders
    // (it's not billed yet → AP exposure is in the bill, not the PO)
    // but it doesn't contribute to the aging buckets.
    const db = makeDb();
    const { vendor } = await seedVendor(db, {
      pos: [
        { order_number: 'PO-RECEIVED', status: 'received', order_date: '2025-12-01', expected_date: '2026-01-15', quantity: 10, unit_cost: 10000 },
      ],
    });
    const out = await getVendor360(db, vendor.id, 0, { today: '2026-06-21' });
    // The PO appears in the open list (not yet billed).
    assert.equal(out.open_purchase_orders.length, 1);
    // But it does NOT contribute to overdue aging (the goods are
    // here; what's outstanding is the bill, not the receipt).
    assert.equal(out.aging.days_90_plus, 0);
    assert.equal(out.aging.current, 0);
  });

  test('11. getVendor360: recent_receipts surface in received_at DESC order', async () => {
    const db = makeDb();
    // Seed 2 POs first (no receipts yet), then insert receipts
    // that reference them. Doing it in two passes avoids the
    // "cannot access 'pos' before initialization" trap.
    const seed = await seedVendor(db, {
      pos: [
        { order_number: 'PO-A', status: 'received', order_date: '2026-04-01', expected_date: '2026-04-15', quantity: 1, unit_cost: 1000 },
        { order_number: 'PO-B', status: 'received', order_date: '2026-05-01', expected_date: '2026-05-15', quantity: 1, unit_cost: 1000 },
      ],
    });
    const { vendor, pos } = seed;
    await db.query(
      `INSERT INTO finance.purchase_receipts
         (tenant_id, order_id, receipt_number, received_at)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
      [0, pos[0].id, 'R-A-1', '2026-04-20', 0, pos[1].id, 'R-B-1', '2026-05-20'],
    );
    const out = await getVendor360(db, vendor.id, 0, { today: '2026-06-21' });
    assert.equal(out.recent_receipts.length, 2);
    // Sorted DESC by received_at.
    assert.equal(out.recent_receipts[0].receipt_number, 'R-B-1');
    assert.equal(out.recent_receipts[1].receipt_number, 'R-A-1');
    assert.equal(out.recent_receipts[0].order_number, 'PO-B');
  });

  test('12. getVendor360: invalid vendorId throws ValueError', async () => {
    const db = makeDb();
    await assert.rejects(
      () => getVendor360(db, 0, 0),
      /vendorId must be a positive integer/,
    );
    await assert.rejects(
      () => getVendor360(db, -1, 0),
      /vendorId must be a positive integer/,
    );
  });

  test('13. getVendor360: invalid tenantId throws ValueError', async () => {
    const db = makeDb();
    await assert.rejects(
      () => getVendor360(db, 1, -1),
      /tenantId must be a non-negative integer/,
    );
  });
});
