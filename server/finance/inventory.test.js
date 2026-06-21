// Test the inventory pure functions end-to-end. Mirrors the
// pattern in server/finance/customer.test.js: each test gets a
// fresh in-memory DB (with the inventory tables pre-created) so
// the test is hermetic.
//
// Tests cover the full happy path (create warehouse → create
// location → create catalog item → receive → list balances →
// transfer → list moves) plus the failure paths (negative
// stock, unknown location, duplicate SKU, etc.).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createCatalogItem,
  listCatalogItems,
  createWarehouse,
  listWarehouses,
  createLocation,
  listLocations,
  receiveStock,
  deliverStock,
  transferStock,
  adjustStock,
  listBalances,
  listMoves,
  getReplenishmentReport,
  ValueError,
} from './inventory.js';

// ────────────────────────────────────────────────────────────────────────
// Test harness — mirrors the customer.test.js harness.
// ────────────────────────────────────────────────────────────────────────

function makeMemoryDb() {
  const db = new DatabaseSync(':memory:');
  // Mirror the production migration runner's strip: the migration
  // files say CREATE TABLE finance.catalog_items but on sqlite the
  // table lands as catalog_items. The pure functions are written
  // without the finance. prefix.
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
      reorder_point INTEGER NOT NULL DEFAULT 0,
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
  `);
  // pg-style adapter wrapper. We translate $N → ? on the way down.
  return {
    async query(sql, params = []) {
      const translated = sql.replace(/\$\d+/g, '?');
      const stmt = db.prepare(translated);
      const upper = translated.trim().toUpperCase();
      if (upper.startsWith('SELECT') || upper.includes(' RETURNING')) {
        const rows = stmt.all(...(params || []));
        return { rows };
      }
      const info = stmt.run(...(params || []));
      return { rows: [], lastInsertRowid: info.lastInsertRowid };
    },
    // Raw handle for tests that need to bypass the pg-style adapter
    // (e.g. verifying persistence of a column the adapter doesn't
    // expose via a pure function).
    _raw: db,
  };
}

async function setupWarehouseAndLocation(db) {
  const wh = await createWarehouse(db, { code: 'WH', name: 'Main Warehouse' }, 0);
  const stockLoc = await createLocation(db, { warehouse_id: wh.id, code: 'STOCK', name: 'Stock Area' }, 0);
  const dispatchLoc = await createLocation(
    db,
    { warehouse_id: wh.id, code: 'DISPATCH', name: 'Dispatch Staging' },
    0,
  );
  return { wh, stockLoc, dispatchLoc };
}

// ────────────────────────────────────────────────────────────────────────
// catalog items
// ────────────────────────────────────────────────────────────────────────

test('createCatalogItem: minimal valid input → returns id + row', async () => {
  const db = makeMemoryDb();
  const out = await createCatalogItem(db, { sku: 'HW-SCANNER-001', name: 'POS Barcode Scanner' }, 0);
  assert.equal(out.sku, 'HW-SCANNER-001');
  assert.equal(out.name, 'POS Barcode Scanner');
  assert.equal(out.type, 'STOCKABLE');
  assert.equal(out.vat_class, 'VAT_STANDARD');
  assert.ok(Number.isInteger(out.id) && out.id > 0);
});

test('createCatalogItem: rejects missing sku/name', async () => {
  const db = makeMemoryDb();
  await assert.rejects(createCatalogItem(db, { name: 'X' }, 0), ValueError);
  await assert.rejects(createCatalogItem(db, { sku: 'X-1' }, 0), ValueError);
});

test('createCatalogItem: rejects malformed sku (whitespace, slashes)', async () => {
  const db = makeMemoryDb();
  await assert.rejects(createCatalogItem(db, { sku: 'has space', name: 'X' }, 0), ValueError);
  await assert.rejects(createCatalogItem(db, { sku: 'has/slash', name: 'X' }, 0), ValueError);
});

test('createCatalogItem: duplicate SKU in same tenant → ValueError', async () => {
  const db = makeMemoryDb();
  await createCatalogItem(db, { sku: 'DUP-001', name: 'First' }, 0);
  await assert.rejects(createCatalogItem(db, { sku: 'DUP-001', name: 'Second' }, 0), ValueError);
});

test('createCatalogItem: same SKU in different tenants OK', async () => {
  const db = makeMemoryDb();
  await createCatalogItem(db, { sku: 'CROSS-001', name: 'T0' }, 0);
  const t7 = await createCatalogItem(db, { sku: 'CROSS-001', name: 'T7' }, 7);
  assert.equal(t7.tenant_id, 7);
});

test('listCatalogItems: scoped to tenant, excludes archived', async () => {
  const db = makeMemoryDb();
  await createCatalogItem(db, { sku: 'A-1', name: 'A' }, 0);
  await createCatalogItem(db, { sku: 'B-1', name: 'B' }, 0);
  await createCatalogItem(db, { sku: 'T7-1', name: 'T7' }, 7);
  const t0 = await listCatalogItems(db, 0);
  const t7 = await listCatalogItems(db, 7);
  assert.equal(t0.length, 2);
  assert.equal(t7.length, 1);
  assert.equal(t7[0].sku, 'T7-1');
});

// ────────────────────────────────────────────────────────────────────────
// warehouses + locations
// ────────────────────────────────────────────────────────────────────────

test('createWarehouse: minimal input → returns id + row', async () => {
  const db = makeMemoryDb();
  const out = await createWarehouse(db, { code: 'WH', name: 'Main' }, 0);
  assert.equal(out.code, 'WH');
  assert.equal(out.name, 'Main');
  assert.ok(Number.isInteger(out.id) && out.id > 0);
});

test('createWarehouse: duplicate code in same tenant → ValueError', async () => {
  const db = makeMemoryDb();
  await createWarehouse(db, { code: 'WH', name: 'A' }, 0);
  await assert.rejects(createWarehouse(db, { code: 'WH', name: 'B' }, 0), ValueError);
});

test('createLocation: requires existing warehouse + valid type', async () => {
  const db = makeMemoryDb();
  const wh = await createWarehouse(db, { code: 'WH', name: 'Main' }, 0);
  const loc = await createLocation(
    db,
    { warehouse_id: wh.id, code: 'STOCK', name: 'Stock Area', location_type: 'INTERNAL' },
    0,
  );
  assert.equal(loc.code, 'STOCK');
  assert.equal(loc.location_type, 'INTERNAL');
  await assert.rejects(
    createLocation(db, { warehouse_id: 999, code: 'X', name: 'X' }, 0),
    ValueError,
  );
  await assert.rejects(
    createLocation(db, { warehouse_id: wh.id, code: 'Y', name: 'Y', location_type: 'BOGUS' }, 0),
    ValueError,
  );
});

test('listLocations: filter by warehouse', async () => {
  const db = makeMemoryDb();
  const wh1 = await createWarehouse(db, { code: 'WH1', name: 'A' }, 0);
  const wh2 = await createWarehouse(db, { code: 'WH2', name: 'B' }, 0);
  await createLocation(db, { warehouse_id: wh1.id, code: 'A1', name: 'A1' }, 0);
  await createLocation(db, { warehouse_id: wh1.id, code: 'A2', name: 'A2' }, 0);
  await createLocation(db, { warehouse_id: wh2.id, code: 'B1', name: 'B1' }, 0);
  const wh1Locs = await listLocations(db, 0, wh1.id);
  const allLocs = await listLocations(db, 0);
  assert.equal(wh1Locs.length, 2);
  assert.equal(allLocs.length, 3);
});

// ────────────────────────────────────────────────────────────────────────
// stock moves: receive
// ────────────────────────────────────────────────────────────────────────

test('receiveStock: increases destination quantity + creates move row', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(db, { sku: 'WIDGET', name: 'Widget' }, 0);
  const out = await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 10, unit_cost: 1000 },
    0,
  );
  assert.equal(out.move_type, 'RECEIPT');
  assert.equal(out.new_quantity_at_destination, 10);
  assert.equal(out.new_average_cost, 1000);
  assert.ok(out.move_id > 0);

  const balances = await listBalances(db, 0, { itemId: item.id });
  assert.equal(balances.length, 1);
  assert.equal(balances[0].quantity, 10);
  assert.equal(balances[0].average_cost, 1000);

  const moves = await listMoves(db, 0, { itemId: item.id });
  assert.equal(moves.length, 1);
  assert.equal(moves[0].move_type, 'RECEIPT');
});

test('receiveStock: weighted-average cost across multiple receipts', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(db, { sku: 'W', name: 'W' }, 0);
  // First receipt: 10 @ 1000 → avg = 1000
  await receiveStock(db, { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 10, unit_cost: 1000 }, 0);
  // Second receipt: 10 @ 2000 → weighted avg = (10*1000 + 10*2000) / 20 = 1500
  const out = await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 10, unit_cost: 2000 },
    0,
  );
  assert.equal(out.new_average_cost, 1500);
  const bal = await listBalances(db, 0, { itemId: item.id });
  assert.equal(bal[0].quantity, 20);
  assert.equal(bal[0].average_cost, 1500);
});

test('receiveStock: rejects unknown item / unknown destination', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  await assert.rejects(
    receiveStock(db, { catalog_item_id: 999, destination_location_id: stockLoc.id, quantity: 1, unit_cost: 0 }, 0),
    ValueError,
  );
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  await assert.rejects(
    receiveStock(db, { catalog_item_id: item.id, destination_location_id: 999, quantity: 1, unit_cost: 0 }, 0),
    ValueError,
  );
});

test('receiveStock: tenant isolation (item in t0 not visible to t7)', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  await assert.rejects(
    receiveStock(db, { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 1, unit_cost: 0 }, 7),
    ValueError,
  );
});

// ────────────────────────────────────────────────────────────────────────
// stock moves: deliver
// ────────────────────────────────────────────────────────────────────────

test('deliverStock: decrements source, requires sufficient stock', async () => {
  const db = makeMemoryDb();
  const { stockLoc, dispatchLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  await receiveStock(db, { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 10, unit_cost: 1000 }, 0);
  const out = await deliverStock(
    db,
    { catalog_item_id: item.id, source_location_id: stockLoc.id, destination_location_id: dispatchLoc.id, quantity: 4 },
    0,
  );
  assert.equal(out.move_type, 'DELIVERY');
  assert.equal(out.new_quantity_at_source, 6);
  const bal = await listBalances(db, 0, { itemId: item.id });
  // Two balances: stockLoc (6) and dispatchLoc (4)
  const stock = bal.find((b) => b.location_id === stockLoc.id);
  const dispatch = bal.find((b) => b.location_id === dispatchLoc.id);
  assert.equal(stock.quantity, 6);
  assert.equal(stock.average_cost, 1000); // unchanged
  assert.equal(dispatch.quantity, 4);
  assert.equal(dispatch.average_cost, 1000);
});

test('deliverStock: refuses when insufficient stock', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  await receiveStock(db, { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 2, unit_cost: 0 }, 0);
  await assert.rejects(
    deliverStock(db, { catalog_item_id: item.id, source_location_id: stockLoc.id, quantity: 5 }, 0),
    ValueError,
  );
});

test('deliverStock: removes the quant row when quantity hits zero', async () => {
  const db = makeMemoryDb();
  const { stockLoc, dispatchLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  await receiveStock(db, { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 3, unit_cost: 0 }, 0);
  await deliverStock(db, { catalog_item_id: item.id, source_location_id: stockLoc.id, destination_location_id: dispatchLoc.id, quantity: 3 }, 0);
  const bal = await listBalances(db, 0, { itemId: item.id });
  // No balance for the source (quantity went to 0 → row deleted).
  assert.equal(bal.find((b) => b.location_id === stockLoc.id), undefined);
  assert.equal(bal.find((b) => b.location_id === dispatchLoc.id).quantity, 3);
});

// ────────────────────────────────────────────────────────────────────────
// stock moves: transfer
// ────────────────────────────────────────────────────────────────────────

test('transferStock: moves quantity between two INTERNAL locations', async () => {
  const db = makeMemoryDb();
  const { stockLoc, dispatchLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  await receiveStock(db, { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 10, unit_cost: 2000 }, 0);
  const out = await transferStock(
    db,
    { catalog_item_id: item.id, source_location_id: stockLoc.id, destination_location_id: dispatchLoc.id, quantity: 3 },
    0,
  );
  assert.equal(out.new_quantity_at_source, 7);
  assert.equal(out.new_quantity_at_destination, 3);
  const bal = await listBalances(db, 0, { itemId: item.id });
  const stock = bal.find((b) => b.location_id === stockLoc.id);
  const dispatch = bal.find((b) => b.location_id === dispatchLoc.id);
  assert.equal(stock.quantity, 7);
  assert.equal(dispatch.quantity, 3);
  assert.equal(dispatch.average_cost, 2000);
});

test('transferStock: rejects same source and destination', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  await receiveStock(db, { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 1, unit_cost: 0 }, 0);
  await assert.rejects(
    transferStock(db, { catalog_item_id: item.id, source_location_id: stockLoc.id, destination_location_id: stockLoc.id, quantity: 1 }, 0),
    ValueError,
  );
});

// ────────────────────────────────────────────────────────────────────────
// stock moves: adjust
// ────────────────────────────────────────────────────────────────────────

test('adjustStock: sets absolute quantity, records delta', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  await receiveStock(db, { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 10, unit_cost: 0 }, 0);
  const out = await adjustStock(
    db,
    { catalog_item_id: item.id, location_id: stockLoc.id, new_quantity: 8, reason: 'cycle count' },
    0,
  );
  assert.equal(out.old_quantity, 10);
  assert.equal(out.new_quantity, 8);
  assert.equal(out.delta, -2);
  const bal = await listBalances(db, 0, { itemId: item.id });
  assert.equal(bal[0].quantity, 8);
});

test('adjustStock: rejects negative new_quantity', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(db, { sku: 'X', name: 'X' }, 0);
  await assert.rejects(
    adjustStock(db, { catalog_item_id: item.id, location_id: stockLoc.id, new_quantity: -1 }, 0),
    ValueError,
  );
});

// ────────────────────────────────────────────────────────────────────────
// end-to-end: full receive → deliver → transfer → adjust cycle
// ────────────────────────────────────────────────────────────────────────

test('end-to-end: receive → transfer → deliver cycle', async () => {
  const db = makeMemoryDb();
  const { stockLoc, dispatchLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(
    db,
    { sku: 'POS', name: 'POS Terminal', standard_cost: 50000 },
    0,
  );

  // 1. Receive 20 units @ 50000 → 20 in stockLoc at 50000
  const r1 = await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 20, unit_cost: 50000, reference: 'PO-1' },
    0,
  );
  assert.equal(r1.new_quantity_at_destination, 20);

  // 2. Transfer 5 from stockLoc → dispatchLoc
  const t1 = await transferStock(
    db,
    { catalog_item_id: item.id, source_location_id: stockLoc.id, destination_location_id: dispatchLoc.id, quantity: 5 },
    0,
  );
  assert.equal(t1.new_quantity_at_source, 15);
  assert.equal(t1.new_quantity_at_destination, 5);

  // 3. Deliver 3 from dispatchLoc (no destination — outbound)
  const d1 = await deliverStock(
    db,
    { catalog_item_id: item.id, source_location_id: dispatchLoc.id, quantity: 3, reference: 'SO-1' },
    0,
  );
  assert.equal(d1.new_quantity_at_source, 2);

  // 4. Adjust stockLoc to 12 (cycle count says 12, not 15)
  const a1 = await adjustStock(
    db,
    { catalog_item_id: item.id, location_id: stockLoc.id, new_quantity: 12, reason: 'cycle count' },
    0,
  );
  assert.equal(a1.delta, -3);

  // 5. List balances: stockLoc=12, dispatchLoc=2
  const bal = await listBalances(db, 0, { itemId: item.id });
  assert.equal(bal.find((b) => b.location_id === stockLoc.id).quantity, 12);
  assert.equal(bal.find((b) => b.location_id === dispatchLoc.id).quantity, 2);

  // 6. List moves: 4 (receive, transfer, deliver, adjust)
  const moves = await listMoves(db, 0, { itemId: item.id });
  assert.equal(moves.length, 4);
  // Most-recent first: adjust, deliver, transfer, receive
  assert.deepEqual(moves.map((m) => m.move_type), ['ADJUSTMENT', 'DELIVERY', 'TRANSFER', 'RECEIPT']);
});

test('listBalances: tenant-scoped (tenant 0 cannot see tenant 7 stock)', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  // Create an item + warehouse + location for tenant 7
  const wh7 = await createWarehouse(db, { code: 'WH7', name: 'T7 Warehouse' }, 7);
  const loc7 = await createLocation(db, { warehouse_id: wh7.id, code: 'STOCK7', name: 'T7 Stock' }, 7);
  const item0 = await createCatalogItem(db, { sku: 'T0', name: 'T0' }, 0);
  const item7 = await createCatalogItem(db, { sku: 'T7', name: 'T7' }, 7);
  await receiveStock(db, { catalog_item_id: item0.id, destination_location_id: stockLoc.id, quantity: 5, unit_cost: 0 }, 0);
  await receiveStock(db, { catalog_item_id: item7.id, destination_location_id: loc7.id, quantity: 7, unit_cost: 0 }, 7);
  const t0 = await listBalances(db, 0);
  const t7 = await listBalances(db, 7);
  assert.equal(t0.length, 1);
  assert.equal(t0[0].quantity, 5);
  assert.equal(t7.length, 1);
  assert.equal(t7[0].quantity, 7);
});

// ────────────────────────────────────────────────────────────────────────
// Replenishment report (Wave 18)
// ────────────────────────────────────────────────────────────────────────

test('getReplenishmentReport: empty DB → empty report', async () => {
  const db = makeMemoryDb();
  const rep = await getReplenishmentReport(db, 0);
  assert.deepEqual(rep, []);
});

test('getReplenishmentReport: zero reorder_point → item never appears', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  // No reorder_point (defaults to 0) — even with zero stock it should NOT appear.
  await createCatalogItem(db, { sku: 'Z', name: 'Zero' }, 0);
  const rep = await getReplenishmentReport(db, 0);
  assert.deepEqual(rep, []);
});

test('getReplenishmentReport: item below threshold appears in report', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(
    db,
    { sku: 'A', name: 'Item A', reorder_point: 10 },
    0,
  );
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 3, unit_cost: 100 },
    0,
  );
  const rep = await getReplenishmentReport(db, 0);
  assert.equal(rep.length, 1);
  assert.equal(rep[0].sku, 'A');
  assert.equal(rep[0].total_stock, 3);
  assert.equal(rep[0].reorder_point, 10);
  assert.equal(rep[0].shortage, 7);
});

test('getReplenishmentReport: item at or above threshold does NOT appear', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(
    db,
    { sku: 'A', name: 'Item A', reorder_point: 10 },
    0,
  );
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: stockLoc.id, quantity: 10, unit_cost: 100 },
    0,
  );
  const rep = await getReplenishmentReport(db, 0);
  assert.deepEqual(rep, []);
});

test('getReplenishmentReport: sorted by shortage desc (largest gap first)', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  // Two items both below threshold, but with different shortage.
  const small = await createCatalogItem(
    db,
    { sku: 'S', name: 'Small', reorder_point: 5 },
    0,
  );
  const big = await createCatalogItem(
    db,
    { sku: 'B', name: 'Big', reorder_point: 20 },
    0,
  );
  await receiveStock(
    db,
    { catalog_item_id: small.id, destination_location_id: stockLoc.id, quantity: 4, unit_cost: 100 },
    0,
  );
  await receiveStock(
    db,
    { catalog_item_id: big.id, destination_location_id: stockLoc.id, quantity: 1, unit_cost: 100 },
    0,
  );
  const rep = await getReplenishmentReport(db, 0);
  assert.equal(rep.length, 2);
  assert.equal(rep[0].sku, 'B'); // shortage=19, should be first
  assert.equal(rep[1].sku, 'S'); // shortage=1, should be second
});

test('getReplenishmentReport: by_warehouse breakdown included per item', async () => {
  const db = makeMemoryDb();
  // Two warehouses, two locations.
  const w1 = await createWarehouse(db, { code: 'WH1', name: 'WH 1' }, 0);
  const w2 = await createWarehouse(db, { code: 'WH2', name: 'WH 2' }, 0);
  const l1 = await createLocation(
    db,
    { warehouse_id: w1.id, code: 'A', name: 'A', location_type: 'INTERNAL' },
    0,
  );
  const l2 = await createLocation(
    db,
    { warehouse_id: w2.id, code: 'B', name: 'B', location_type: 'INTERNAL' },
    0,
  );
  const item = await createCatalogItem(
    db,
    { sku: 'X', name: 'X', reorder_point: 10 },
    0,
  );
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: l1.id, quantity: 3, unit_cost: 100 },
    0,
  );
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: l2.id, quantity: 1, unit_cost: 100 },
    0,
  );
  const rep = await getReplenishmentReport(db, 0);
  assert.equal(rep.length, 1);
  assert.equal(rep[0].total_stock, 4);
  assert.equal(rep[0].by_warehouse.length, 2);
  // Sum of per-warehouse stock should equal total.
  const sumWh = rep[0].by_warehouse.reduce((s, w) => s + w.stock, 0);
  assert.equal(sumWh, 4);
});

test('getReplenishmentReport: warehouse_id filter scopes to one warehouse', async () => {
  const db = makeMemoryDb();
  const w1 = await createWarehouse(db, { code: 'WH1', name: 'WH 1' }, 0);
  const w2 = await createWarehouse(db, { code: 'WH2', name: 'WH 2' }, 0);
  const l1 = await createLocation(
    db,
    { warehouse_id: w1.id, code: 'A', name: 'A', location_type: 'INTERNAL' },
    0,
  );
  const l2 = await createLocation(
    db,
    { warehouse_id: w2.id, code: 'B', name: 'B', location_type: 'INTERNAL' },
    0,
  );
  const item = await createCatalogItem(
    db,
    { sku: 'X', name: 'X', reorder_point: 5 },
    0,
  );
  // Stock at WH1 = 4 (below threshold), stock at WH2 = 10 (above).
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: l1.id, quantity: 4, unit_cost: 100 },
    0,
  );
  await receiveStock(
    db,
    { catalog_item_id: item.id, destination_location_id: l2.id, quantity: 10, unit_cost: 100 },
    0,
  );
  const all = await getReplenishmentReport(db, 0);
  // Total = 14, well above reorder_point=5 → no report.
  assert.equal(all.length, 0);
  const wh1Only = await getReplenishmentReport(db, 0, { warehouseId: w1.id });
  // WH1 only = 4, below threshold → reported.
  assert.equal(wh1Only.length, 1);
  assert.equal(wh1Only[0].total_stock, 4);
  const wh2Only = await getReplenishmentReport(db, 0, { warehouseId: w2.id });
  // WH2 only = 10, above threshold → not reported.
  assert.equal(wh2Only.length, 0);
});

test('getReplenishmentReport: cross-tenant isolation', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  const item0 = await createCatalogItem(
    db,
    { sku: 'T0', name: 'Tenant 0 item', reorder_point: 10 },
    0,
  );
  const item7 = await createCatalogItem(
    db,
    { sku: 'T7', name: 'Tenant 7 item', reorder_point: 10 },
    7,
  );
  // Tenant 7 sees its own item (zero stock) but not tenant 0's.
  const t7 = await getReplenishmentReport(db, 7);
  assert.equal(t7.length, 1);
  assert.equal(t7[0].sku, 'T7');
  // Tenant 0 sees its own item (zero stock) but not tenant 7's.
  const t0 = await getReplenishmentReport(db, 0);
  assert.equal(t0.length, 1);
  assert.equal(t0[0].sku, 'T0');
});

test('getReplenishmentReport: archived items do not appear', async () => {
  const db = makeMemoryDb();
  const { stockLoc } = await setupWarehouseAndLocation(db);
  const item = await createCatalogItem(
    db,
    { sku: 'X', name: 'X', reorder_point: 10 },
    0,
  );
  // The createCatalogItem function doesn't expose archive; we'd need
  // an SQL update. This test guards the "AND ci.archived = 0" filter.
  // Run a raw SQL update via the test handle (the inventory harness
  // exposes the raw DatabaseSync as db._raw).
  db._raw.prepare('UPDATE catalog_items SET archived = 1 WHERE id = ?').run(item.id);
  const rep = await getReplenishmentReport(db, 0);
  assert.deepEqual(rep, []);
});

test('createCatalogItem: accepts reorder_point and persists it', async () => {
  const db = makeMemoryDb();
  const item = await createCatalogItem(
    db,
    { sku: 'A', name: 'A', reorder_point: 42 },
    0,
  );
  assert.equal(item.reorder_point, 42);
  // Re-read via SQL to confirm persistence.
  const row = db._raw.prepare('SELECT reorder_point FROM catalog_items WHERE id = ?').get(item.id);
  assert.equal(row.reorder_point, 42);
});

test('createCatalogItem: rejects negative reorder_point', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    () => createCatalogItem(db, { sku: 'A', name: 'A', reorder_point: -1 }, 0),
    (err) => err && err.name === 'ValueError' && /reorder_point/.test(err.message),
  );
});
