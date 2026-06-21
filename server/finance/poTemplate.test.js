// Tests for the PO + delivery-note template engine.
// Two layers:
//   1. Pure renderer tests (no DB) — assert the text/HTML output of
//      renderPurchaseOrder / renderDeliveryNote for a known PO
//      shape, in Armenian / English / Russian, with and without
//      lines, with and without notes.
//   2. DB-backed tests for getPurchaseOrder + getReceipt — assert
//      the hydration shape (item names joined in, totals computed).
//
// Mirrors the harness pattern in inventory.test.js / purchase.test.js:
// in-memory sqlite + $N → ? translation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createCatalogItem,
  createWarehouse,
  createLocation,
  receiveStock,
} from './inventory.js';
import {
  createVendor,
  createPurchaseOrder,
  confirmPurchaseOrder,
  receivePurchaseOrder,
  getPurchaseOrder,
  getReceipt,
} from './purchase.js';
import { renderPurchaseOrder, renderDeliveryNote } from './poTemplate.js';

// ────────────────────────────────────────────────────────────────────────
// Test harness — minimal in-memory sqlite with all the tables the
// template getters need.
// ────────────────────────────────────────────────────────────────────────

function makeMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
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
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      notes TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
  `);

  // Wrap the raw sqlite handle in a pg-style adapter that
  // translates $N → ? for node:sqlite (the production migration
  // runner does the same on the real DB; the in-memory test
  // harness needs to mirror the translation or every query fails
  // with "column index out of range").
  return {
    async query(sql, params = []) {
      const translated = sql.replace(/\$\d+/g, '?');
      const stmt = db.prepare(translated);
      const upper = translated.trim().toUpperCase();
      if (upper.startsWith('SELECT') || upper.includes(' RETURNING')) {
        return { rows: stmt.all(...(params || [])) };
      }
      const info = stmt.run(...(params || []));
      return { rows: [], lastInsertRowid: info.lastInsertRowid };
    },
    _raw: db,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Pure renderer tests
// ────────────────────────────────────────────────────────────────────────

function makeFakePo(overrides = {}) {
  return {
    id: 42,
    order_number: 'PO-ARM-0001',
    vendor_id: 7,
    vendor_name: 'ACME Corp',
    vendor_hvhh: '12345678',
    status: 'confirmed',
    order_date: '2026-06-21',
    expected_date: '2026-06-28',
    received_quantity: 0,
    notes: 'Rush order',
    lines: [
      {
        id: 1,
        catalog_item_id: 100,
        catalog_item_name: 'Widget',
        unit_of_measure: 'pcs',
        quantity: 10,
        unit_cost: 500,
        line_subtotal: 5000,
      },
      {
        id: 2,
        catalog_item_id: 101,
        catalog_item_name: 'Gadget',
        unit_of_measure: 'pcs',
        quantity: 5,
        unit_cost: 1000,
        line_subtotal: 5000,
      },
    ],
    subtotal: 10000,
    vat: 2000,
    total: 12000,
    ...overrides,
  };
}

function makeFakeReceipt(overrides = {}) {
  return {
    id: 99,
    order_id: 42,
    order_number: 'PO-ARM-0001',
    receipt_number: 'RCPT-1',
    received_at: '2026-06-25',
    notes: null,
    vendor_id: 7,
    vendor_name: 'ACME Corp',
    vendor_hvhh: '12345678',
    lines: [
      {
        id: 1,
        catalog_item_id: 100,
        catalog_item_name: 'Widget',
        unit_of_measure: 'pcs',
        received_quantity: 10,
        unit_cost: 500,
        line_subtotal: 5000,
        warehouse_name: 'Main Warehouse',
        destination_location_code: 'BIN-A1',
        destination_location_name: 'Aisle 1',
      },
    ],
    ...overrides,
  };
}

test('renderPurchaseOrder: Armenian (hy) — header + line items + totals', () => {
  const po = makeFakePo();
  const out = renderPurchaseOrder(po, 'hy');
  // Header in Armenian.
  assert.match(out, /Գնման պատվեր/);
  assert.match(out, /PO-ARM-0001/);
  // Vendor block.
  assert.match(out, /Մատակարար/);
  assert.match(out, /ACME Corp/);
  assert.match(out, /ՀՎՀՀ/);
  assert.match(out, /12345678/);
  // Items table — Armenian column headers.
  assert.match(out, /Ապրանքների ցանկ/);
  assert.match(out, /Անվանում/);
  assert.match(out, /Քանակ/);
  assert.match(out, /Գին/);
  assert.match(out, /Գումար/);
  // Line item rendered.
  assert.match(out, /Widget/);
  assert.match(out, /Gadget/);
  // Totals in Armenian.
  assert.match(out, /Ընդհանուր առանց ԱԱՀ/);
  assert.match(out, /ԱԱՀ 20%/);
  assert.match(out, /Ընդհանուր/);
  // Currency formatting uses ֏ or digits — at least the digits appear.
  assert.match(out, /10,000|10000/);
  assert.match(out, /12,000|12000/);
  // Notes + status.
  assert.match(out, /Հաստատված/);
  assert.match(out, /Rush order/);
});

test('renderPurchaseOrder: English (en) fallback works', () => {
  const po = makeFakePo();
  const out = renderPurchaseOrder(po, 'en');
  assert.match(out, /Purchase Order/);
  assert.match(out, /Vendor/);
  assert.match(out, /ACME Corp/);
  assert.match(out, /Confirmed/);
  assert.match(out, /Subtotal/);
  assert.match(out, /Total/);
  assert.match(out, /Rush order/);
  // Armenian-only strings should NOT appear.
  assert.doesNotMatch(out, /Գնման պատվեր/);
  assert.doesNotMatch(out, /Հաստատված/);
});

test('renderPurchaseOrder: unknown locale falls back to default (en)', () => {
  const po = makeFakePo();
  const out = renderPurchaseOrder(po, 'xyz-not-a-locale');
  assert.match(out, /Purchase Order/);
  assert.match(out, /Vendor/);
});

test('renderPurchaseOrder: zero-line PO renders gracefully', () => {
  const po = makeFakePo({ lines: [], subtotal: 0, vat: 0, total: 0 });
  const out = renderPurchaseOrder(po, 'hy');
  // The "— (items)" marker is in Armenian.
  assert.match(out, /Ապրանքների ցանկ/);
  // Totals still render (as 0).
  assert.match(out, /Ընդհանուր/);
  assert.match(out, /0/);
});

test('renderPurchaseOrder: notes render when present', () => {
  const po = makeFakePo();
  const out = renderPurchaseOrder(po, 'hy');
  assert.match(out, /Նշումներ/);
  assert.match(out, /Rush order/);
});

test('renderPurchaseOrder: html format escapes + line-breaks', () => {
  const po = makeFakePo({ notes: '<script>alert(1)</script>' });
  const out = renderPurchaseOrder(po, 'en', { format: 'html' });
  // HTML-escaped: the script tag is harmless.
  assert.doesNotMatch(out, /<script>alert/);
  assert.match(out, /&lt;script&gt;/);
  // Line breaks become <br>.
  assert.match(out, /<br>/);
  // No raw un-escaped angle brackets from user input.
  assert.doesNotMatch(out, /<script>/);
});

test('renderPurchaseOrder: cancelled PO shows the reason', () => {
  const po = makeFakePo({
    status: 'cancelled',
    cancelled_at: '2026-06-22',
    cancelled_reason: 'Vendor went out of business',
  });
  const out = renderPurchaseOrder(po, 'en');
  assert.match(out, /Cancelled/);
  assert.match(out, /Vendor went out of business/);
});

test('renderPurchaseOrder: rejects unknown format', () => {
  const po = makeFakePo();
  assert.throws(() => renderPurchaseOrder(po, 'en', { format: 'pdf' }), /unknown format/);
});

test('renderDeliveryNote: Armenian (hy) — receipt header + items + signature', () => {
  const r = makeFakeReceipt();
  const out = renderDeliveryNote(r, 'hy');
  assert.match(out, /Առաքման նշագիր/);
  assert.match(out, /RCPT-1/);
  assert.match(out, /Հիմնված պատվերի վրա/);
  assert.match(out, /PO-ARM-0001/);
  assert.match(out, /Մատակարար/);
  assert.match(out, /ACME Corp/);
  assert.match(out, /Ընդունված ապրանքներ/);
  assert.match(out, /Widget/);
  assert.match(out, /Main Warehouse/);
  // Signature lines.
  assert.match(out, /Ընդունել է/);
  assert.match(out, /Ամսաթիվ, ստորագրություն/);
});

test('renderDeliveryNote: English (en) fallback', () => {
  const r = makeFakeReceipt();
  const out = renderDeliveryNote(r, 'en');
  assert.match(out, /Delivery Note/);
  assert.match(out, /Received at/);
  assert.match(out, /Based on PO/);
  assert.match(out, /ACME Corp/);
  assert.match(out, /Received items/);
  assert.match(out, /Received by/);
});

test('renderDeliveryNote: zero-line receipt still renders totals', () => {
  const r = makeFakeReceipt({ lines: [] });
  const out = renderDeliveryNote(r, 'en');
  assert.match(out, /Delivery Note/);
  assert.match(out, /Total/);
  // 0 appears.
  assert.match(out, /0/);
});

// ────────────────────────────────────────────────────────────────────────
// DB-backed tests for getPurchaseOrder + getReceipt
// ────────────────────────────────────────────────────────────────────────

test('getPurchaseOrder: returns hydrated PO with item names + totals', async () => {
  const db = makeMemoryDb();
  // Seed: vendor + item + PO.
  const v = await createVendor(
    db,
    { code: 'ACME', name: 'ACME Corp', hvhh: '12345678', address: 'Yerevan' },
    0,
  );
  const i1 = await createCatalogItem(
    db,
    { sku: 'WID-1', name: 'Widget', unit_of_measure: 'pcs', unit_cost_amd: 500 },
    0,
  );
  const po = await createPurchaseOrder(
    db,
    {
      vendor_id: v.id,
      order_number: 'PO-TEST-1',
      order_date: '2026-06-21',
      lines: [{ catalog_item_id: i1.id, quantity: 10, unit_cost: 500 }],
    },
    0,
  );
  assert.equal(po.id, 1);
  const got = await getPurchaseOrder(db, po.id, 0);
  assert.ok(got, 'getPurchaseOrder should find the PO');
  assert.equal(got.order_number, 'PO-TEST-1');
  assert.equal(got.vendor_name, 'ACME Corp');
  assert.equal(got.lines.length, 1);
  assert.equal(got.lines[0].catalog_item_name, 'Widget');
  assert.equal(got.lines[0].unit_of_measure, 'pcs');
  assert.equal(got.lines[0].line_subtotal, 5000);
  assert.equal(got.subtotal, 5000);
  assert.equal(got.vat, 1000);
  assert.equal(got.total, 6000);
});

test('getPurchaseOrder: null when id not in tenant', async () => {
  const db = makeMemoryDb();
  const got = await getPurchaseOrder(db, 999, 0);
  assert.equal(got, null);
});

test('getPurchaseOrder: cross-tenant isolation (tenant 1 cannot see tenant 0)', async () => {
  const db = makeMemoryDb();
  const v = await createVendor(
    db,
    { code: 'V1', name: 'Vendor 1', hvhh: '11111111' },
    0,
  );
  const i = await createCatalogItem(
    db,
    { sku: 'X-1', name: 'X', unit_of_measure: 'pcs' },
    0,
  );
  const po = await createPurchaseOrder(
    db,
    {
      vendor_id: v.id,
      order_number: 'PO-T-1',
      order_date: '2026-06-21',
      lines: [{ catalog_item_id: i.id, quantity: 1, unit_cost: 100 }],
    },
    0,
  );
  // Same id, different tenant → null.
  const got = await getPurchaseOrder(db, po.id, 1);
  assert.equal(got, null);
});

test('getReceipt: returns hydrated receipt with line items + warehouse', async () => {
  const db = makeMemoryDb();
  const v = await createVendor(
    db,
    { code: 'V1', name: 'Vendor 1', hvhh: '11111111' },
    0,
  );
  const i = await createCatalogItem(
    db,
    { sku: 'X-1', name: 'X', unit_of_measure: 'pcs' },
    0,
  );
  const w = await createWarehouse(db, { code: 'WH-1', name: 'Main' }, 0);
  const loc = await createLocation(
    db,
    { warehouse_id: w.id, code: 'BIN-1', name: 'Aisle 1', location_type: 'INTERNAL' },
    0,
  );
  const po = await createPurchaseOrder(
    db,
    {
      vendor_id: v.id,
      order_number: 'PO-R-1',
      order_date: '2026-06-21',
      lines: [{ catalog_item_id: i.id, quantity: 5, unit_cost: 500 }],
    },
    0,
  );
  await confirmPurchaseOrder(db, po.id, 0);
  const receiveRes = await receivePurchaseOrder(
    db,
    po.id,
    {
      destination_location_id: loc.id,
      lines: [{ order_line_id: 1, received_quantity: 5 }],
    },
    0,
  );
  assert.equal(receiveRes.receipt_id, 1);
  const got = await getReceipt(db, receiveRes.receipt_id, 0);
  assert.ok(got, 'getReceipt should find the receipt');
  assert.equal(got.receipt_number, receiveRes.receipt_number);
  assert.equal(got.order_number, 'PO-R-1');
  assert.equal(got.vendor_name, 'Vendor 1');
  assert.equal(got.lines.length, 1);
  assert.equal(got.lines[0].catalog_item_name, 'X');
  assert.equal(got.lines[0].warehouse_name, 'Main');
  assert.equal(got.lines[0].destination_location_code, 'BIN-1');
  assert.equal(got.lines[0].received_quantity, 5);
});

test('getReceipt: null when id not in tenant', async () => {
  const db = makeMemoryDb();
  const got = await getReceipt(db, 999, 0);
  assert.equal(got, null);
});

// ────────────────────────────────────────────────────────────────────────
// End-to-end: real PO + real receive → render in Armenian
// ────────────────────────────────────────────────────────────────────────

test('end-to-end: build PO + receive → render PO + delivery note in Armenian', async () => {
  const db = makeMemoryDb();
  const v = await createVendor(
    db,
    { code: 'ACME', name: 'ACME Մdelays', hvhh: '12345678' },
    0,
  );
  const item = await createCatalogItem(
    db,
    { sku: 'WID-1', name: 'Widget', unit_of_measure: 'pcs' },
    0,
  );
  const w = await createWarehouse(db, { code: 'WH-1', name: 'Main' }, 0);
  const loc = await createLocation(
    db,
    { warehouse_id: w.id, code: 'BIN-1', name: 'Aisle 1', location_type: 'INTERNAL' },
    0,
  );
  const po = await createPurchaseOrder(
    db,
    {
      vendor_id: v.id,
      order_number: 'PO-E2E-1',
      order_date: '2026-06-21',
      lines: [{ catalog_item_id: item.id, quantity: 3, unit_cost: 500 }],
    },
    0,
  );
  await confirmPurchaseOrder(db, po.id, 0);
  const rec = await receivePurchaseOrder(
    db,
    po.id,
    {
      destination_location_id: loc.id,
      lines: [{ order_line_id: 1, received_quantity: 3 }],
    },
    0,
  );

  // Render PO in Armenian.
  const poHydrated = await getPurchaseOrder(db, po.id, 0);
  const poText = renderPurchaseOrder(poHydrated, 'hy');
  assert.match(poText, /Գնման պատվեր/);
  assert.match(poText, /PO-E2E-1/);
  assert.match(poText, /Widget/);
  // Status: the PO was confirmed, then received — so it's now "received".
  assert.match(poText, /Ստացված/);

  // Render delivery note in Armenian.
  const rHydrated = await getReceipt(db, rec.receipt_id, 0);
  const dnText = renderDeliveryNote(rHydrated, 'hy');
  assert.match(dnText, /Առաքման նշագիր/);
  assert.match(dnText, /Հիմնված պատվերի վրա/);
  assert.match(dnText, /PO-E2E-1/);
  assert.match(dnText, /Widget/);
  assert.match(dnText, /Main/);
});
