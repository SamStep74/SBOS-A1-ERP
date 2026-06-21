// Test the purchase + vendor-bill pure functions end-to-end.
// Mirrors the customer.test.js / inventory.test.js pattern.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createVendor,
  listVendors,
  createPurchaseOrder,
  confirmPurchaseOrder,
  cancelPurchaseOrder,
  receivePurchaseOrder,
  listPurchaseOrders,
  createVendorBillFromReceipt,
  confirmVendorBill,
  postVendorBill,
  payVendorBill,
  voidVendorBill,
  listVendorBills,
  ValueError,
} from './purchase.js';
import {
  createCatalogItem,
  createWarehouse,
  createLocation,
  listBalances,
  listMoves,
} from './inventory.js';

// ────────────────────────────────────────────────────────────────────────
// Test harness — minimal in-memory sqlite with the inventory +
// purchase tables pre-created.
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
      delta INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER
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
  `);
  return {
    async query(sql, params = []) {
      // Translate pg-style $N placeholders → ? for node:sqlite.
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

async function setupVendorItemAndLocation(db) {
  const vendor = await createVendor(
    db,
    { code: 'V-YEREVAN', name: 'Yerevan Hardware Supply', hvhh: '01234568' },
    0,
  );
  const item = await createCatalogItem(
    db,
    { sku: 'HW-SCANNER-001', name: 'POS Barcode Scanner', standard_cost: 50000 },
    0,
  );
  const wh = await createWarehouse(db, { code: 'WH', name: 'Main Warehouse' }, 0);
  const stockLoc = await createLocation(
    db,
    { warehouse_id: wh.id, code: 'STOCK', name: 'Stock Area' },
    0,
  );
  return { vendor, item, stockLoc };
}

// ────────────────────────────────────────────────────────────────────────
// Vendors
// ────────────────────────────────────────────────────────────────────────

test('createVendor: minimal valid input → returns id + row', async () => {
  const db = makeMemoryDb();
  const out = await createVendor(db, { code: 'V1', name: 'Acme LLC' }, 0);
  assert.equal(out.code, 'V1');
  assert.equal(out.name, 'Acme LLC');
  assert.equal(out.hvhh, null);
  assert.ok(Number.isInteger(out.id) && out.id > 0);
});

test('createVendor: with HVVH', async () => {
  const db = makeMemoryDb();
  const out = await createVendor(
    db,
    { code: 'V2', name: 'Beta', hvhh: '01234567' },
    0,
  );
  assert.equal(out.hvhh, '01234567');
});

test('createVendor: rejects malformed HVVH', async () => {
  const db = makeMemoryDb();
  await assert.rejects(createVendor(db, { code: 'V', name: 'X', hvhh: '12' }, 0), ValueError);
  await assert.rejects(createVendor(db, { code: 'V', name: 'X', hvhh: 'abcdefgh' }, 0), ValueError);
});

test('createVendor: duplicate code in tenant → ValueError', async () => {
  const db = makeMemoryDb();
  await createVendor(db, { code: 'DUP', name: 'A' }, 0);
  await assert.rejects(createVendor(db, { code: 'DUP', name: 'B' }, 0), ValueError);
});

test('createVendor: duplicate HVVH in tenant → ValueError', async () => {
  const db = makeMemoryDb();
  await createVendor(db, { code: 'A', name: 'A', hvhh: '11111111' }, 0);
  await assert.rejects(createVendor(db, { code: 'B', name: 'B', hvhh: '11111111' }, 0), ValueError);
});

test('listVendors: tenant-scoped', async () => {
  const db = makeMemoryDb();
  await createVendor(db, { code: 'A', name: 'A' }, 0);
  await createVendor(db, { code: 'B', name: 'B' }, 0);
  await createVendor(db, { code: 'C', name: 'C' }, 7);
  assert.equal((await listVendors(db, 0)).length, 2);
  assert.equal((await listVendors(db, 7)).length, 1);
});

// ────────────────────────────────────────────────────────────────────────
// Purchase orders
// ────────────────────────────────────────────────────────────────────────

test('createPurchaseOrder: minimal valid input → rfq status + line counts', async () => {
  const db = makeMemoryDb();
  const { vendor, item } = await setupVendorItemAndLocation(db);
  const out = await createPurchaseOrder(
    db,
    {
      order_number: 'PO-001',
      vendor_id: vendor.id,
      order_date: '2026-06-21',
      lines: [
        { catalog_item_id: item.id, quantity: 5, unit_cost: 50000 },
        { catalog_item_id: item.id, quantity: 3, unit_cost: 50000 },
      ],
    },
    0,
  );
  assert.equal(out.status, 'rfq');
  assert.equal(out.subtotal, 8 * 50000);
  assert.equal(out.vat, Math.floor(out.subtotal * 0.2));
  assert.equal(out.total, out.subtotal + out.vat);
});

test('createPurchaseOrder: requires non-empty lines', async () => {
  const db = makeMemoryDb();
  const { vendor } = await setupVendorItemAndLocation(db);
  await assert.rejects(
    createPurchaseOrder(db, { order_number: 'X', vendor_id: vendor.id, order_date: '2026-01-01', lines: [] }, 0),
    ValueError,
  );
});

test('createPurchaseOrder: rejects unknown vendor', async () => {
  const db = makeMemoryDb();
  const { item } = await setupVendorItemAndLocation(db);
  await assert.rejects(
    createPurchaseOrder(
      db,
      { order_number: 'X', vendor_id: 999, order_date: '2026-01-01', lines: [{ catalog_item_id: item.id, quantity: 1 }] },
      0,
    ),
    ValueError,
  );
});

test('createPurchaseOrder: duplicate order_number in tenant → ValueError', async () => {
  const db = makeMemoryDb();
  const { vendor, item } = await setupVendorItemAndLocation(db);
  await createPurchaseOrder(
    db,
    { order_number: 'PO-DUP', vendor_id: vendor.id, order_date: '2026-01-01', lines: [{ catalog_item_id: item.id, quantity: 1 }] },
    0,
  );
  await assert.rejects(
    createPurchaseOrder(
      db,
      { order_number: 'PO-DUP', vendor_id: vendor.id, order_date: '2026-01-01', lines: [{ catalog_item_id: item.id, quantity: 1 }] },
      0,
    ),
    ValueError,
  );
});

test('confirmPurchaseOrder: rfq → confirmed', async () => {
  const db = makeMemoryDb();
  const { vendor, item } = await setupVendorItemAndLocation(db);
  const order = await createPurchaseOrder(
    db,
    { order_number: 'PO-1', vendor_id: vendor.id, order_date: '2026-01-01', lines: [{ catalog_item_id: item.id, quantity: 1 }] },
    0,
  );
  const out = await confirmPurchaseOrder(db, order.id, 0);
  assert.equal(out.status, 'confirmed');
});

test('cancelPurchaseOrder: rfq → cancelled (with reason)', async () => {
  const db = makeMemoryDb();
  const { vendor, item } = await setupVendorItemAndLocation(db);
  const order = await createPurchaseOrder(
    db,
    { order_number: 'PO-1', vendor_id: vendor.id, order_date: '2026-01-01', lines: [{ catalog_item_id: item.id, quantity: 1 }] },
    0,
  );
  const out = await cancelPurchaseOrder(db, order.id, 'vendor went out of business', 0);
  assert.equal(out.status, 'cancelled');
  assert.equal(out.cancelled_reason, 'vendor went out of business');
});

// ────────────────────────────────────────────────────────────────────────
// Receive + 3-way match
// ────────────────────────────────────────────────────────────────────────

test('receivePurchaseOrder: full receipt updates stock + moves PO to received', async () => {
  const db = makeMemoryDb();
  const { vendor, item, stockLoc } = await setupVendorItemAndLocation(db);
  const order = await createPurchaseOrder(
    db,
    {
      order_number: 'PO-RCPT-1',
      vendor_id: vendor.id,
      order_date: '2026-01-01',
      lines: [{ catalog_item_id: item.id, quantity: 10, unit_cost: 50000, description: 'scanners' }],
    },
    0,
  );
  await confirmPurchaseOrder(db, order.id, 0);

  // Get the order_line_id.
  const orderLinesRes = await db.query('SELECT id, catalog_item_id, quantity FROM purchase_order_lines WHERE order_id = ?', [order.id]);
  const ol = orderLinesRes.rows[0];

  const out = await receivePurchaseOrder(
    db,
    order.id,
    { destination_location_id: stockLoc.id, lines: [{ order_line_id: ol.id, received_quantity: 10 }] },
    0,
  );
  assert.equal(out.new_status, 'received');
  assert.equal(out.total_received, 10);
  // Stock was updated.
  const bal = await listBalances(db, 0, { itemId: item.id });
  assert.equal(bal.length, 1);
  assert.equal(bal[0].quantity, 10);
  assert.equal(bal[0].average_cost, 50000);
  // A stock move was logged.
  const moves = await listMoves(db, 0, { itemId: item.id });
  assert.equal(moves.length, 1);
  assert.equal(moves[0].move_type, 'RECEIPT');
  assert.equal(moves[0].reference, 'PO-RCPT-1');
});

test('receivePurchaseOrder: partial receipt (3 of 5) keeps PO in partial', async () => {
  const db = makeMemoryDb();
  const { vendor, item, stockLoc } = await setupVendorItemAndLocation(db);
  const order = await createPurchaseOrder(
    db,
    {
      order_number: 'PO-PART-1',
      vendor_id: vendor.id,
      order_date: '2026-01-01',
      lines: [{ catalog_item_id: item.id, quantity: 5, unit_cost: 50000 }],
    },
    0,
  );
  await confirmPurchaseOrder(db, order.id, 0);
  const orderLinesRes = await db.query('SELECT id FROM purchase_order_lines WHERE order_id = ?', [order.id]);
  const ol = orderLinesRes.rows[0];

  const out = await receivePurchaseOrder(
    db,
    order.id,
    { destination_location_id: stockLoc.id, lines: [{ order_line_id: ol.id, received_quantity: 3 }] },
    0,
  );
  assert.equal(out.new_status, 'partial');
  assert.equal(out.total_received, 3);
  assert.equal(out.total_ordered, 5);
  // Stock moved only 3.
  const bal = await listBalances(db, 0, { itemId: item.id });
  assert.equal(bal[0].quantity, 3);
});

test('receivePurchaseOrder: cannot over-receive (sum exceeds ordered qty)', async () => {
  const db = makeMemoryDb();
  const { vendor, item, stockLoc } = await setupVendorItemAndLocation(db);
  const order = await createPurchaseOrder(
    db,
    {
      order_number: 'PO-OVER',
      vendor_id: vendor.id,
      order_date: '2026-01-01',
      lines: [{ catalog_item_id: item.id, quantity: 5, unit_cost: 50000 }],
    },
    0,
  );
  await confirmPurchaseOrder(db, order.id, 0);
  const orderLinesRes = await db.query('SELECT id FROM purchase_order_lines WHERE order_id = ?', [order.id]);
  const ol = orderLinesRes.rows[0];

  // Receive 3, then 3 more — the second call should reject.
  await receivePurchaseOrder(
    db,
    order.id,
    { destination_location_id: stockLoc.id, lines: [{ order_line_id: ol.id, received_quantity: 3 }] },
    0,
  );
  await assert.rejects(
    receivePurchaseOrder(
      db,
      order.id,
      { destination_location_id: stockLoc.id, lines: [{ order_line_id: ol.id, received_quantity: 3 }] },
      0,
    ),
    ValueError,
  );
});

test('receivePurchaseOrder: cannot receive an rfq order (must confirm first)', async () => {
  const db = makeMemoryDb();
  const { vendor, item, stockLoc } = await setupVendorItemAndLocation(db);
  const order = await createPurchaseOrder(
    db,
    {
      order_number: 'PO-NO-CONF',
      vendor_id: vendor.id,
      order_date: '2026-01-01',
      lines: [{ catalog_item_id: item.id, quantity: 1, unit_cost: 0 }],
    },
    0,
  );
  const orderLinesRes = await db.query('SELECT id FROM purchase_order_lines WHERE order_id = ?', [order.id]);
  const ol = orderLinesRes.rows[0];
  await assert.rejects(
    receivePurchaseOrder(
      db,
      order.id,
      { destination_location_id: stockLoc.id, lines: [{ order_line_id: ol.id, received_quantity: 1 }] },
      0,
    ),
    ValueError,
  );
});

// ────────────────────────────────────────────────────────────────────────
// Vendor bills
// ────────────────────────────────────────────────────────────────────────

test('createVendorBillFromReceipt: full bill from fully-received PO', async () => {
  const db = makeMemoryDb();
  const { vendor, item, stockLoc } = await setupVendorItemAndLocation(db);
  const order = await createPurchaseOrder(
    db,
    {
      order_number: 'PO-BILL-1',
      vendor_id: vendor.id,
      order_date: '2026-01-01',
      lines: [{ catalog_item_id: item.id, quantity: 5, unit_cost: 50000 }],
    },
    0,
  );
  await confirmPurchaseOrder(db, order.id, 0);
  const orderLinesRes = await db.query('SELECT id FROM purchase_order_lines WHERE order_id = ?', [order.id]);
  const ol = orderLinesRes.rows[0];
  await receivePurchaseOrder(
    db,
    order.id,
    { destination_location_id: stockLoc.id, lines: [{ order_line_id: ol.id, received_quantity: 5 }] },
    0,
  );

  const bill = await createVendorBillFromReceipt(
    db,
    order.id,
    { bill_number: 'BILL-1', bill_date: '2026-01-15' },
    0,
  );
  assert.equal(bill.status, 'draft');
  assert.equal(bill.subtotal, 5 * 50000);
  assert.equal(bill.vat, Math.floor(bill.subtotal * 0.2));
  assert.equal(bill.total, bill.subtotal + bill.vat);
  assert.equal(bill.line_count, 1);
});

test('createVendorBillFromReceipt: refuses a non-received order', async () => {
  const db = makeMemoryDb();
  const { vendor, item } = await setupVendorItemAndLocation(db);
  const order = await createPurchaseOrder(
    db,
    {
      order_number: 'PO-NOREC',
      vendor_id: vendor.id,
      order_date: '2026-01-01',
      lines: [{ catalog_item_id: item.id, quantity: 1, unit_cost: 0 }],
    },
    0,
  );
  await confirmPurchaseOrder(db, order.id, 0);
  await assert.rejects(
    createVendorBillFromReceipt(db, order.id, { bill_number: 'B1', bill_date: '2026-01-15' }, 0),
    ValueError,
  );
});

test('createVendorBillFromReceipt: refuses duplicate bill_number', async () => {
  const db = makeMemoryDb();
  const { vendor, item, stockLoc } = await setupVendorItemAndLocation(db);
  const order = await createPurchaseOrder(
    db,
    { order_number: 'PO-DUP-B', vendor_id: vendor.id, order_date: '2026-01-01', lines: [{ catalog_item_id: item.id, quantity: 1, unit_cost: 1000 }] },
    0,
  );
  await confirmPurchaseOrder(db, order.id, 0);
  const orderLinesRes = await db.query('SELECT id FROM purchase_order_lines WHERE order_id = ?', [order.id]);
  const ol = orderLinesRes.rows[0];
  await receivePurchaseOrder(db, order.id, { destination_location_id: stockLoc.id, lines: [{ order_line_id: ol.id, received_quantity: 1 }] }, 0);
  await createVendorBillFromReceipt(db, order.id, { bill_number: 'B-DUP', bill_date: '2026-01-15' }, 0);
  await assert.rejects(
    createVendorBillFromReceipt(db, order.id, { bill_number: 'B-DUP', bill_date: '2026-01-16' }, 0),
    ValueError,
  );
});

test('Vendor bill state machine: draft → confirmed → posted → paid', async () => {
  const db = makeMemoryDb();
  const { vendor, item, stockLoc } = await setupVendorItemAndLocation(db);
  const order = await createPurchaseOrder(
    db,
    { order_number: 'PO-SM', vendor_id: vendor.id, order_date: '2026-01-01', lines: [{ catalog_item_id: item.id, quantity: 1, unit_cost: 1000 }] },
    0,
  );
  await confirmPurchaseOrder(db, order.id, 0);
  const orderLinesRes = await db.query('SELECT id FROM purchase_order_lines WHERE order_id = ?', [order.id]);
  const ol = orderLinesRes.rows[0];
  await receivePurchaseOrder(db, order.id, { destination_location_id: stockLoc.id, lines: [{ order_line_id: ol.id, received_quantity: 1 }] }, 0);
  const bill = await createVendorBillFromReceipt(db, order.id, { bill_number: 'B-SM', bill_date: '2026-01-15' }, 0);

  // draft → confirmed
  const c1 = await confirmVendorBill(db, bill.id, 0);
  assert.equal(c1.status, 'confirmed');

  // confirmed → posted
  const c2 = await postVendorBill(db, bill.id, 0);
  assert.equal(c2.status, 'posted');

  // Verify the PO transitioned to 'billed'.
  const orders = await listPurchaseOrders(db, 0, { status: 'billed' });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].id, order.id);

  // posted → paid
  const c3 = await payVendorBill(db, bill.id, 0);
  assert.equal(c3.status, 'paid');
});

test('voidVendorBill: from draft with a reason', async () => {
  const db = makeMemoryDb();
  const { vendor, item, stockLoc } = await setupVendorItemAndLocation(db);
  const order = await createPurchaseOrder(
    db,
    { order_number: 'PO-VB', vendor_id: vendor.id, order_date: '2026-01-01', lines: [{ catalog_item_id: item.id, quantity: 1, unit_cost: 1000 }] },
    0,
  );
  await confirmPurchaseOrder(db, order.id, 0);
  const orderLinesRes = await db.query('SELECT id FROM purchase_order_lines WHERE order_id = ?', [order.id]);
  const ol = orderLinesRes.rows[0];
  await receivePurchaseOrder(db, order.id, { destination_location_id: stockLoc.id, lines: [{ order_line_id: ol.id, received_quantity: 1 }] }, 0);
  const bill = await createVendorBillFromReceipt(db, order.id, { bill_number: 'B-VB', bill_date: '2026-01-15' }, 0);
  const out = await voidVendorBill(db, bill.id, 'wrong amount', 0);
  assert.equal(out.status, 'void');
  assert.equal(out.voided_reason, 'wrong amount');
});

test('voidVendorBill: refuses a paid bill', async () => {
  const db = makeMemoryDb();
  const { vendor, item, stockLoc } = await setupVendorItemAndLocation(db);
  const order = await createPurchaseOrder(
    db,
    { order_number: 'PO-PB', vendor_id: vendor.id, order_date: '2026-01-01', lines: [{ catalog_item_id: item.id, quantity: 1, unit_cost: 1000 }] },
    0,
  );
  await confirmPurchaseOrder(db, order.id, 0);
  const orderLinesRes = await db.query('SELECT id FROM purchase_order_lines WHERE order_id = ?', [order.id]);
  const ol = orderLinesRes.rows[0];
  await receivePurchaseOrder(db, order.id, { destination_location_id: stockLoc.id, lines: [{ order_line_id: ol.id, received_quantity: 1 }] }, 0);
  const bill = await createVendorBillFromReceipt(db, order.id, { bill_number: 'B-PB', bill_date: '2026-01-15' }, 0);
  await confirmVendorBill(db, bill.id, 0);
  await postVendorBill(db, bill.id, 0);
  await payVendorBill(db, bill.id, 0);
  await assert.rejects(voidVendorBill(db, bill.id, 'too late', 0), ValueError);
});

// ────────────────────────────────────────────────────────────────────────
// End-to-end
// ────────────────────────────────────────────────────────────────────────

test('end-to-end: vendor → PO → receive → bill → pay', async () => {
  const db = makeMemoryDb();
  const { vendor, item, stockLoc } = await setupVendorItemAndLocation(db);
  const order = await createPurchaseOrder(
    db,
    { order_number: 'PO-E2E', vendor_id: vendor.id, order_date: '2026-01-01', lines: [{ catalog_item_id: item.id, quantity: 3, unit_cost: 50000, description: 'e2e' }] },
    0,
  );
  await confirmPurchaseOrder(db, order.id, 0);
  const ol = (await db.query('SELECT id FROM purchase_order_lines WHERE order_id = ?', [order.id])).rows[0];
  const rcpt = await receivePurchaseOrder(
    db,
    order.id,
    { destination_location_id: stockLoc.id, lines: [{ order_line_id: ol.id, received_quantity: 3 }] },
    0,
  );
  assert.equal(rcpt.new_status, 'received');
  // Stock was credited.
  const bal = await listBalances(db, 0, { itemId: item.id });
  assert.equal(bal[0].quantity, 3);

  const bill = await createVendorBillFromReceipt(db, order.id, { bill_number: 'B-E2E', bill_date: '2026-01-15' }, 0);
  await confirmVendorBill(db, bill.id, 0);
  await postVendorBill(db, bill.id, 0);
  await payVendorBill(db, bill.id, 0);

  // Final state: order=billed, bill=paid, stock=3 units.
  const orders = await listPurchaseOrders(db, 0);
  assert.equal(orders[0].status, 'billed');
  const bills = await listVendorBills(db, 0);
  assert.equal(bills[0].status, 'paid');
});
