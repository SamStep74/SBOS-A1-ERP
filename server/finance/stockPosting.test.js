// Tests for the stock-valuation handoff (server/finance/stockPosting.js).
// Two layers:
//   1. Direct stockPosting unit tests — assert each post* function
//      writes the right balanced journal entry.
//   2. End-to-end through receiveStock / deliverStock / adjustStock /
//      postVendorBill — assert the side-effect posts the right entry
//      and the journal balances.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  postStockReceiveGL,
  postStockDeliverGL,
  postStockAdjustGL,
  postVendorBillPostGL,
  ACCOUNTS,
} from './stockPosting.js';
import {
  createCatalogItem,
  createWarehouse,
  createLocation,
  receiveStock,
  deliverStock,
  adjustStock,
} from './inventory.js';
import {
  createVendor,
  createPurchaseOrder,
  confirmPurchaseOrder,
  receivePurchaseOrder,
  createVendorBillFromReceipt,
  postVendorBill,
} from './purchase.js';
import { getAccountBalance } from './journal.js';

// ────────────────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────────────────

function makeMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE catalog_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      sku TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
      type TEXT NOT NULL DEFAULT 'STOCKABLE',
      category_id INTEGER, uom_id INTEGER, uom_code TEXT NOT NULL DEFAULT 'pcs',
      barcode TEXT, vat_class TEXT NOT NULL DEFAULT 'VAT_STANDARD',
      standard_price INTEGER NOT NULL DEFAULT 0,
      sale_price INTEGER NOT NULL DEFAULT 0,
      standard_cost INTEGER NOT NULL DEFAULT 0,
      reorder_point INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      code TEXT NOT NULL, name TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE stock_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      warehouse_id INTEGER NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
      location_type TEXT NOT NULL DEFAULT 'INTERNAL', parent_id INTEGER,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE stock_quants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      catalog_item_id INTEGER NOT NULL, location_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      reserved_quantity INTEGER NOT NULL DEFAULT 0,
      average_cost INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE stock_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      move_type TEXT NOT NULL, catalog_item_id INTEGER NOT NULL,
      source_location_id INTEGER, destination_location_id INTEGER,
      quantity INTEGER NOT NULL, unit_cost INTEGER NOT NULL DEFAULT 0,
      reference TEXT, delta INTEGER, notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER
    );
    CREATE TABLE vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0, code TEXT NOT NULL, name TEXT NOT NULL,
      hvhh TEXT, address TEXT, email TEXT, phone TEXT, contact_name TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0, order_number TEXT NOT NULL,
      vendor_id INTEGER NOT NULL, vendor_name TEXT NOT NULL, vendor_hvhh TEXT,
      status TEXT NOT NULL DEFAULT 'rfq', order_date TEXT NOT NULL,
      expected_date TEXT, received_quantity INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      cancelled_at TEXT, cancelled_reason TEXT
    );
    CREATE TABLE purchase_order_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0, order_id INTEGER NOT NULL,
      catalog_item_id INTEGER NOT NULL, quantity INTEGER NOT NULL,
      unit_cost INTEGER NOT NULL DEFAULT 0, description TEXT,
      line_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE purchase_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0, order_id INTEGER NOT NULL,
      receipt_number TEXT NOT NULL, received_at TEXT NOT NULL, notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE purchase_receipt_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0, receipt_id INTEGER NOT NULL,
      order_line_id INTEGER NOT NULL, catalog_item_id INTEGER NOT NULL,
      received_quantity INTEGER NOT NULL, unit_cost INTEGER NOT NULL DEFAULT 0,
      destination_location_id INTEGER
    );
    CREATE TABLE vendor_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0, bill_number TEXT NOT NULL,
      vendor_id INTEGER NOT NULL, vendor_name TEXT NOT NULL,
      purchase_order_id INTEGER,
      status TEXT NOT NULL DEFAULT 'draft',
      subtotal INTEGER NOT NULL DEFAULT 0,
      vat INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      bill_date TEXT NOT NULL, due_date TEXT, notes TEXT,
      posted_at TEXT, paid_at TEXT, voided_at TEXT, voided_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE vendor_bill_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0, bill_id INTEGER NOT NULL,
      catalog_item_id INTEGER, description TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_cost INTEGER NOT NULL DEFAULT 0,
      line_subtotal INTEGER NOT NULL DEFAULT 0,
      vat INTEGER NOT NULL DEFAULT 0,
      line_total INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0, entry_date TEXT NOT NULL,
      source TEXT NOT NULL, source_id INTEGER, description TEXT,
      currency TEXT NOT NULL DEFAULT 'AMD',
      status TEXT NOT NULL DEFAULT 'posted',
      book_date TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER
    );
    CREATE TABLE journal_entry_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0, entry_id INTEGER NOT NULL,
      line_order INTEGER NOT NULL DEFAULT 0, account_code TEXT NOT NULL,
      debit INTEGER NOT NULL DEFAULT 0, credit INTEGER NOT NULL DEFAULT 0,
      description TEXT
    );
  `);
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
  };
}

// ────────────────────────────────────────────────────────────────────────
// Direct stockPosting unit tests
// ────────────────────────────────────────────────────────────────────────

test('ACCOUNTS constant exposes the right codes', () => {
  assert.equal(ACCOUNTS.INVENTORY, '216');
  assert.equal(ACCOUNTS.COGS, '711');
  assert.equal(ACCOUNTS.AP_PURCHASES, '521');
  assert.equal(ACCOUNTS.VAT_INPUT, '226');
});

test('postStockReceiveGL: writes Dr 216 / Cr 521 at the right amount', async () => {
  const db = makeMemoryDb();
  const out = await postStockReceiveGL(
    db,
    { id: 42, quantity: 10, unit_cost: 500, created_at: '2026-06-21T10:00:00Z' },
    0,
  );
  assert.ok(out.entry_id > 0);
  const inv = await getAccountBalance(db, '216', 0);
  assert.equal(inv.total_debit, 5000);
  const ap = await getAccountBalance(db, '521', 0);
  assert.equal(ap.total_credit, 5000);
});

test('postStockReceiveGL: zero quantity / zero cost → no entry', async () => {
  const db = makeMemoryDb();
  const out1 = await postStockReceiveGL(db, { id: 1, quantity: 0, unit_cost: 500 }, 0);
  const out2 = await postStockReceiveGL(db, { id: 2, quantity: 10, unit_cost: 0 }, 0);
  assert.equal(out1, null);
  assert.equal(out2, null);
});

test('postStockReceiveGL: no move id → no entry', async () => {
  const db = makeMemoryDb();
  const out = await postStockReceiveGL(db, { quantity: 10, unit_cost: 500 }, 0);
  assert.equal(out, null);
});

test('postStockDeliverGL: writes Dr 711 / Cr 216 at the source avg', async () => {
  const db = makeMemoryDb();
  const out = await postStockDeliverGL(
    db,
    { id: 7, quantity: 3, unit_cost: 500, created_at: '2026-06-22T10:00:00Z' },
    0,
  );
  assert.ok(out.entry_id > 0);
  const cogs = await getAccountBalance(db, '711', 0);
  assert.equal(cogs.total_debit, 1500);
  const inv = await getAccountBalance(db, '216', 0);
  assert.equal(inv.total_credit, 1500);
});

test('postStockAdjustGL: positive delta → Dr 216 / Cr 711 (gain)', async () => {
  const db = makeMemoryDb();
  const out = await postStockAdjustGL(
    db,
    { id: 1, quantity: 2, unit_cost: 500, delta: 2, created_at: '2026-06-23T10:00:00Z' },
    0,
  );
  assert.ok(out.entry_id > 0);
  const inv = await getAccountBalance(db, '216', 0);
  assert.equal(inv.total_debit, 1000);
  const cogs = await getAccountBalance(db, '711', 0);
  assert.equal(cogs.total_credit, 1000);
});

test('postStockAdjustGL: negative delta → Dr 711 / Cr 216 (loss)', async () => {
  const db = makeMemoryDb();
  const out = await postStockAdjustGL(
    db,
    { id: 1, quantity: 2, unit_cost: 500, delta: -2, created_at: '2026-06-23T10:00:00Z' },
    0,
  );
  assert.ok(out.entry_id > 0);
  const cogs = await getAccountBalance(db, '711', 0);
  assert.equal(cogs.total_debit, 1000);
  const inv = await getAccountBalance(db, '216', 0);
  assert.equal(inv.total_credit, 1000);
});

test('postStockAdjustGL: zero delta → no entry', async () => {
  const db = makeMemoryDb();
  const out = await postStockAdjustGL(
    db,
    { id: 1, quantity: 0, unit_cost: 500, delta: 0, created_at: '2026-06-23' },
    0,
  );
  assert.equal(out, null);
});

test('postVendorBillPostGL: with VAT → Dr 226 (VAT-input) / Cr 521 (AP)', async () => {
  const db = makeMemoryDb();
  const out = await postVendorBillPostGL(
    db,
    { id: 1, subtotal: 5000, vat: 1000, total: 6000, bill_date: '2026-06-25' },
    0,
  );
  assert.ok(out.entry_id > 0);
  const vat = await getAccountBalance(db, '226', 0);
  assert.equal(vat.total_debit, 1000);
  const ap = await getAccountBalance(db, '521', 0);
  assert.equal(ap.total_credit, 1000);
});

test('postVendorBillPostGL: zero VAT → AP reversal (Dr 521 / Cr 521)', async () => {
  const db = makeMemoryDb();
  const out = await postVendorBillPostGL(
    db,
    { id: 1, subtotal: 5000, vat: 0, total: 5000, bill_date: '2026-06-25' },
    0,
  );
  assert.ok(out.entry_id > 0);
  const ap = await getAccountBalance(db, '521', 0);
  assert.equal(ap.total_debit, 5000);
  assert.equal(ap.total_credit, 5000);
  assert.equal(ap.net_debit, 0);
});

test('postVendorBillPostGL: zero total → no entry', async () => {
  const db = makeMemoryDb();
  const out = await postVendorBillPostGL(
    db,
    { id: 1, subtotal: 0, vat: 0, total: 0, bill_date: '2026-06-25' },
    0,
  );
  assert.equal(out, null);
});

// ────────────────────────────────────────────────────────────────────────
// End-to-end: receive + deliver + bill → journal has the right entries
// ────────────────────────────────────────────────────────────────────────

test('end-to-end: receive 10 @ 500 → Dr 216 (5000) / Cr 521 (5000)', async () => {
  const db = makeMemoryDb();
  const w = await createWarehouse(db, { code: 'WH-1', name: 'Main' }, 0);
  const loc = await createLocation(
    db,
    { warehouse_id: w.id, code: 'BIN-1', name: 'Aisle 1', location_type: 'INTERNAL' },
    0,
  );
  const item = await createCatalogItem(
    db,
    { sku: 'X', name: 'X', unit_of_measure: 'pcs' },
    0,
  );
  const move = await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: loc.id, quantity: 10, unit_cost: 500 },
    0,
  );
  assert.equal(move.move_id, 1);
  // The GL post is a side-effect of receiveStock. Verify the journal.
  const inv = await getAccountBalance(db, '216', 0);
  assert.equal(inv.total_debit, 5000);
  const ap = await getAccountBalance(db, '521', 0);
  assert.equal(ap.total_credit, 5000);
});

test('end-to-end: receive + deliver → COGS at the weighted-avg cost', async () => {
  const db = makeMemoryDb();
  const w = await createWarehouse(db, { code: 'WH-1', name: 'Main' }, 0);
  const stockLoc = await createLocation(
    db,
    { warehouse_id: w.id, code: 'STOCK', name: 'Stock', location_type: 'INTERNAL' },
    0,
  );
  const outLoc = await createLocation(
    db,
    { warehouse_id: w.id, code: 'CUST', name: 'Customer dock', location_type: 'CUSTOMER' },
    0,
  );
  const item = await createCatalogItem(
    db,
    { sku: 'X', name: 'X', unit_of_measure: 'pcs' },
    0,
  );
  // Receive 10 @ 500
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 10, unit_cost: 500 },
    0,
  );
  // Deliver 3 to customer (no cost on the receive side because
  // it's a customer delivery; the source's avg is what drives the
  // COGS). Wait — the deliver requires no source, so this is just
  // a customer delivery.
  await deliverStock(
    db,
    { catalog_item_id: item.id, source_location_id: stockLoc.id, destination_location_id: outLoc.id, quantity: 3 },
    0,
  );
  const cogs = await getAccountBalance(db, '711', 0);
  // 3 units * 500 (avg) = 1500
  assert.equal(cogs.total_debit, 1500);
  // Inventory: 5000 from receive - 1500 from deliver = 3500
  const inv = await getAccountBalance(db, '216', 0);
  assert.equal(inv.total_debit, 5000);
  assert.equal(inv.total_credit, 1500);
  assert.equal(inv.net_debit, 3500);
});

test('end-to-end: full PO flow → receive-side GL + bill-side VAT GL', async () => {
  const db = makeMemoryDb();
  const v = await createVendor(
    db,
    { code: 'V1', name: 'V1', hvhh: '12345678' },
    0,
  );
  const item = await createCatalogItem(
    db,
    { sku: 'X', name: 'X', unit_of_measure: 'pcs' },
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
      order_number: 'PO-1',
      order_date: '2026-06-21',
      lines: [{ catalog_item_id: item.id, quantity: 5, unit_cost: 500 }],
    },
    0,
  );
  await confirmPurchaseOrder(db, po.id, 0);
  const rec = await receivePurchaseOrder(
    db,
    po.id,
    { destination_location_id: loc.id, lines: [{ order_line_id: 1, received_quantity: 5 }] },
    0,
  );
  // After receive: 5 units * 500 = 2500 in inventory, 2500 in AP.
  // (The PO receive delegates to receiveStock which posts the GL.)
  let inv = await getAccountBalance(db, '216', 0);
  assert.equal(inv.net_debit, 2500);
  let ap = await getAccountBalance(db, '521', 0);
  assert.equal(ap.net_credit, 2500);
  // Create the bill from the receipt.
  const billRes = await createVendorBillFromReceipt(
    db,
    po.id,
    { purchase_order_id: po.id, bill_number: 'BILL-1', bill_date: '2026-06-25' },
    0,
  );
  // billRes is {bill_id, ...} or {id, ...}; the create function returns the bill.
  // The bill_id is what we need to post.
  // Look at the bill subtotal/vat/total: 5*500 = 2500 subtotal, 20% VAT = 500, total = 3000.
  const billId = billRes.bill_id || billRes.id;
  // confirm → post the bill so the GL side-effect fires.
  const { confirmVendorBill } = await import('./purchase.js');
  await confirmVendorBill(db, billId, 0);
  await postVendorBill(db, billId, 0);
  // After the bill post: VAT 500 should be in account 226, AP 500
  // should be in account 521 (the VAT-side AP).
  const vat = await getAccountBalance(db, '226', 0);
  assert.equal(vat.total_debit, 500);
  // 521 should have a debit of 500 (the AP reversal) on top of the
  // original 2500 credit from the receive. Net: 2500 - 500 = 2000
  // (no — wait, the postVendorBillPostGL posts Dr 226 (500) / Cr
  // 521 (500), not a reversal). Let me re-check.
  ap = await getAccountBalance(db, '521', 0);
  // Pre-bill-post: 521 had 2500 credit (from receive).
  // Bill post: 521 gets +500 credit (VAT side).
  // Net: 3000 credit (= the full bill total).
  assert.equal(ap.total_credit, 3000);
  // Trial balance: total debits == total credits.
  const cogs = await getAccountBalance(db, '711', 0);
  const totalDr =
    (inv.net_debit || 0) + (vat.total_debit || 0) + (cogs.total_debit || 0);
  const totalCr = ap.total_credit || 0;
  // The flow doesn't have a deliver step, so totalCr should equal
  // the AP credit (3000) and totalDr should equal the inventory
  // (2500) + VAT input (500) = 3000.
  assert.equal(totalDr, totalCr);
  assert.equal(totalDr, 3000);
});
