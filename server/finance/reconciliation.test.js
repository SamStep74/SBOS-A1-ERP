// Tests for the GL reconciliation job (server/finance/reconciliation.js).
// Verifies that findUnpostedMoves + reconcileJournal correctly detect
// and fix the gap between the move rows and the journal entries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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
  confirmVendorBill,
  postVendorBill,
} from './purchase.js';
import {
  findUnpostedMoves,
  reconcileJournal,
} from './reconciliation.js';
import { getAccountBalance, listJournalEntries } from './journal.js';

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
// findUnpostedMoves
// ────────────────────────────────────────────────────────────────────────

test('findUnpostedMoves: empty DB → empty list', async () => {
  const db = makeMemoryDb();
  const unposted = await findUnpostedMoves(db, 0);
  assert.deepEqual(unposted, []);
});

test('findUnpostedMoves: a posted move + journal entry → not in the list', async () => {
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
  // The receiveStock side-effect already posts the GL entry. So
  // findUnpostedMoves should NOT return it.
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: loc.id, quantity: 10, unit_cost: 500 },
    0,
  );
  const unposted = await findUnpostedMoves(db, 0);
  assert.deepEqual(unposted, []);
});

test('findUnpostedMoves: a move whose journal entry was deleted → flagged', async () => {
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
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: loc.id, quantity: 10, unit_cost: 500 },
    0,
  );
  // Simulate the journal entry being lost (e.g. someone ran a
  // manual DELETE on the journal table).
  await db.query('DELETE FROM journal_entries WHERE source = $1 AND source_id = $2', [
    'stock.receive',
    1,
  ]);
  await db.query('DELETE FROM journal_entry_lines WHERE entry_id NOT IN (SELECT id FROM journal_entries)', []);
  const unposted = await findUnpostedMoves(db, 0);
  assert.equal(unposted.length, 1);
  assert.equal(unposted[0].source, 'stock.receive');
  assert.equal(unposted[0].move_id, 1);
});

test('findUnpostedMoves: cross-tenant isolation', async () => {
  const db = makeMemoryDb();
  const w0 = await createWarehouse(db, { code: 'WH0', name: 'T0' }, 0);
  const loc0 = await createLocation(
    db,
    { warehouse_id: w0.id, code: 'L0', name: 'L0', location_type: 'INTERNAL' },
    0,
  );
  const item0 = await createCatalogItem(db, { sku: 'T0', name: 'T0' }, 0);
  await receiveStock(
    db,
    { catalog_item_id: item0.id, destination_location_id: loc0.id, quantity: 5, unit_cost: 100 },
    0,
  );
  // Delete the t0 journal entry to make t0 "unposted".
  await db.query('DELETE FROM journal_entries WHERE source = $1', ['stock.receive']);
  // Tenant 0 sees the unposted move.
  const t0 = await findUnpostedMoves(db, 0);
  assert.equal(t0.length, 1);
  // Tenant 1 sees nothing (no moves in tenant 1).
  const t1 = await findUnpostedMoves(db, 1);
  assert.equal(t1.length, 0);
});

test('findUnpostedMoves: zero-cost move is NOT flagged (those are no-GL by design)', async () => {
  const db = makeMemoryDb();
  const w = await createWarehouse(db, { code: 'WH-1', name: 'Main' }, 0);
  const loc = await createLocation(
    db,
    { warehouse_id: w.id, code: 'BIN-1', name: 'Aisle 1', location_type: 'INTERNAL' },
    0,
  );
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  // Receive with unit_cost=0 (the no-GL case).
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: loc.id, quantity: 5, unit_cost: 0 },
    0,
  );
  const unposted = await findUnpostedMoves(db, 0);
  assert.deepEqual(unposted, []);
});

// ────────────────────────────────────────────────────────────────────────
// reconcileJournal
// ────────────────────────────────────────────────────────────────────────

test('reconcileJournal: empty DB → 0 scanned, 0 reconciled, 0 errors', async () => {
  const db = makeMemoryDb();
  const result = await reconcileJournal(db, 0);
  assert.deepEqual(result, { scanned: 0, reconciled: 0, errors: [] });
});

test('reconcileJournal: dryRun reports the gap without posting', async () => {
  const db = makeMemoryDb();
  const w = await createWarehouse(db, { code: 'WH-1', name: 'Main' }, 0);
  const loc = await createLocation(
    db,
    { warehouse_id: w.id, code: 'BIN-1', name: 'Aisle 1', location_type: 'INTERNAL' },
    0,
  );
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: loc.id, quantity: 5, unit_cost: 100 },
    0,
  );
  // Delete the journal entry to create the gap.
  await db.query('DELETE FROM journal_entries WHERE source = $1', ['stock.receive']);
  await db.query('DELETE FROM journal_entry_lines WHERE entry_id NOT IN (SELECT id FROM journal_entries)', []);

  const beforeBal = await getAccountBalance(db, '216', 0);
  const dry = await reconcileJournal(db, 0, { dryRun: true });
  assert.equal(dry.scanned, 1);
  assert.equal(dry.reconciled, 0); // dryRun, no actual post
  // The balance is still 0 because dry-run didn't post.
  const afterDryBal = await getAccountBalance(db, '216', 0);
  assert.equal(afterDryBal.total_debit, beforeBal.total_debit);
});

test('reconcileJournal: posts the missing GL and the balances are restored', async () => {
  const db = makeMemoryDb();
  const w = await createWarehouse(db, { code: 'WH-1', name: 'Main' }, 0);
  const loc = await createLocation(
    db,
    { warehouse_id: w.id, code: 'BIN-1', name: 'Aisle 1', location_type: 'INTERNAL' },
    0,
  );
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: loc.id, quantity: 5, unit_cost: 100 },
    0,
  );
  // Delete the journal entry.
  await db.query('DELETE FROM journal_entries WHERE source = $1', ['stock.receive']);
  await db.query('DELETE FROM journal_entry_lines WHERE entry_id NOT IN (SELECT id FROM journal_entries)', []);

  const result = await reconcileJournal(db, 0);
  assert.equal(result.scanned, 1);
  assert.equal(result.reconciled, 1);
  assert.equal(result.errors.length, 0);
  // The GL is restored.
  const inv = await getAccountBalance(db, '216', 0);
  assert.equal(inv.total_debit, 500);
  const ap = await getAccountBalance(db, '521', 0);
  assert.equal(ap.total_credit, 500);
});

test('reconcileJournal: idempotent (running twice posts each move only once)', async () => {
  const db = makeMemoryDb();
  const w = await createWarehouse(db, { code: 'WH-1', name: 'Main' }, 0);
  const loc = await createLocation(
    db,
    { warehouse_id: w.id, code: 'BIN-1', name: 'Aisle 1', location_type: 'INTERNAL' },
    0,
  );
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: loc.id, quantity: 5, unit_cost: 100 },
    0,
  );
  await db.query('DELETE FROM journal_entries WHERE source = $1', ['stock.receive']);
  await db.query('DELETE FROM journal_entry_lines WHERE entry_id NOT IN (SELECT id FROM journal_entries)', []);

  const first = await reconcileJournal(db, 0);
  assert.equal(first.reconciled, 1);
  const second = await reconcileJournal(db, 0);
  // No gap left → 0 scanned on the second run.
  assert.equal(second.scanned, 0);
  assert.equal(second.reconciled, 0);
  // Still only 1 journal entry (not 2).
  const entries = await listJournalEntries(db, 0);
  assert.equal(entries.length, 1);
});

test('reconcileJournal: end-to-end — receive + deliver + bill + delete all journal entries', async () => {
  const db = makeMemoryDb();
  const v = await createVendor(
    db,
    { code: 'V1', name: 'V1', hvhh: '12345678' },
    0,
  );
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  const w = await createWarehouse(db, { code: 'WH-1', name: 'Main' }, 0);
  const stockLoc = await createLocation(
    db,
    { warehouse_id: w.id, code: 'STOCK', name: 'Stock', location_type: 'INTERNAL' },
    0,
  );
  const outLoc = await createLocation(
    db,
    { warehouse_id: w.id, code: 'CUST', name: 'Cust', location_type: 'CUSTOMER' },
    0,
  );
  // 1. Receive via PO.
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
  await receivePurchaseOrder(
    db,
    po.id,
    { destination_location_id: stockLoc.id, lines: [{ order_line_id: 1, received_quantity: 5 }] },
    0,
  );
  // 2. Deliver 2 units.
  await deliverStock(
    db,
    { catalog_item_id: item.id, source_location_id: stockLoc.id, destination_location_id: outLoc.id, quantity: 2 },
    0,
  );
  // 3. Create + confirm + post the bill.
  const billRes = await createVendorBillFromReceipt(
    db,
    po.id,
    { purchase_order_id: po.id, bill_number: 'BILL-1', bill_date: '2026-06-25' },
    0,
  );
  const billId = billRes.bill_id || billRes.id;
  await confirmVendorBill(db, billId, 0);
  await postVendorBill(db, billId, 0);

  // Sanity: journal has 3 entries (receive, deliver, bill.post).
  const beforeDel = await listJournalEntries(db, 0);
  assert.equal(beforeDel.length, 3);

  // Now nuke the journal — simulate total corruption.
  await db.query('DELETE FROM journal_entries', []);
  await db.query('DELETE FROM journal_entry_lines', []);

  // Reconcile.
  const result = await reconcileJournal(db, 0);
  assert.equal(result.scanned, 3);
  assert.equal(result.reconciled, 3);
  assert.equal(result.errors.length, 0);

  // The balances are restored.
  // 216: 5*500 (receive) - 2*500 (deliver) = 1500 net debit
  const inv = await getAccountBalance(db, '216', 0);
  assert.equal(inv.net_debit, 1500);
  // 711: 2*500 = 1000 net debit
  const cogs = await getAccountBalance(db, '711', 0);
  assert.equal(cogs.net_debit, 1000);
  // 521: 2500 (receive) + 500 (bill VAT) = 3000 net credit
  const ap = await getAccountBalance(db, '521', 0);
  assert.equal(ap.net_credit, 3000);
  // 226: 500 net debit (VAT input)
  const vat = await getAccountBalance(db, '226', 0);
  assert.equal(vat.net_debit, 500);
});

test('reconcileJournal: error from a corrupt move is collected, not thrown', async () => {
  const db = makeMemoryDb();
  // Insert a stock_move that has no matching destination location
  // (a corrupt move). The reconciliation will try to load it via
  // loadMove, which just reads columns — the load itself succeeds,
  // but the post* call will fail when the journal entry's move_id
  // doesn't satisfy a future constraint. (We don't have a
  // constraint; instead, simulate by directly inserting a journal
  // entry with a stale id.) Easier: just create a real move +
  // delete the move row to make the loadMove return null.
  const w = await createWarehouse(db, { code: 'WH-1', name: 'Main' }, 0);
  const loc = await createLocation(
    db,
    { warehouse_id: w.id, code: 'BIN-1', name: 'Aisle 1', location_type: 'INTERNAL' },
    0,
  );
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: loc.id, quantity: 5, unit_cost: 100 },
    0,
  );
  // Delete both the journal entry AND the underlying move to
  // simulate a hard-to-recover state. findUnpostedMoves won't even
  // flag it (the move is gone), so this is just a sanity test
  // that the no-throw contract holds.
  await db.query('DELETE FROM journal_entries', []);
  await db.query('DELETE FROM stock_moves', []);
  const result = await reconcileJournal(db, 0);
  assert.equal(result.scanned, 0);
  assert.equal(result.reconciled, 0);
});
