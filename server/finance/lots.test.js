// server/finance/lots.test.js
//
// Tests for the lot + serial tracking. Mirrors the customer360.test.js
// pattern: real in-memory sqlite with the production schema, exercise
// the pure functions.
//
// Wave 37. Scope: createLot, getLot, listLotsForItem + createSerial,
// getSerial, listSerialsForItem. Stock-move integration is Wave 38.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  createLot,
  getLot,
  listLotsForItem,
  createSerial,
  getSerial,
  listSerialsForItem,
  ValueError,
} from './lots.js';
import { createCatalogItem } from './inventory.js';

function makeDb() {
  const sqliteDb = new DatabaseSync(':memory:');
  sqliteDb.exec('ATTACH DATABASE ":memory:" AS finance');
  sqliteDb.exec('PRAGMA foreign_keys = OFF');
  sqliteDb.exec(`
    CREATE TABLE finance.catalog_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       INTEGER NOT NULL DEFAULT 0,
      sku             TEXT NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT,
      type            TEXT NOT NULL DEFAULT 'STOCKABLE',
      category_id     INTEGER,
      uom_id          INTEGER,
      uom_code        TEXT NOT NULL DEFAULT 'pcs',
      barcode         TEXT,
      vat_class       TEXT NOT NULL DEFAULT 'VAT_STANDARD',
      standard_price  INTEGER NOT NULL DEFAULT 0,
      sale_price      INTEGER NOT NULL DEFAULT 0,
      standard_cost   INTEGER NOT NULL DEFAULT 0,
      reorder_point   INTEGER NOT NULL DEFAULT 0,
      archived        INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.lots (
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
    CREATE TABLE finance.serials (
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

async function seedItem(db, { sku = 'SKU-LOT-1', name = 'Lot-test item' } = {}) {
  return createCatalogItem(db, { sku, name }, 0);
}

describe('finance/lots — Wave 37 lot + serial tracking', () => {
  // ─── Lots ───

  test('1. createLot: minimal input (code, catalog_item_id, received_at) → returns row', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    const out = await createLot(db, {
      code: 'LOT-2026-A',
      catalog_item_id: item.id,
      received_at: '2026-06-21',
    }, 0);
    assert.equal(out.code, 'LOT-2026-A');
    assert.equal(out.catalog_item_id, item.id);
    assert.equal(out.tenant_id, 0);
    assert.equal(out.supplier_lot_number, null);
    assert.equal(out.expiry_date, null);
    assert.equal(out.notes, null);
    assert.ok(Number.isInteger(out.id) && out.id > 0);
  });

  test('2. createLot: full input (supplier_lot_number + expiry_date + notes) persists all fields', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    const out = await createLot(db, {
      code: 'LOT-2026-B',
      supplier_lot_number: 'SUPPLR-B123',
      catalog_item_id: item.id,
      expiry_date: '2027-06-21',
      received_at: '2026-06-21',
      notes: 'Cold-chain delivery',
    }, 0);
    assert.equal(out.supplier_lot_number, 'SUPPLR-B123');
    assert.equal(out.expiry_date, '2027-06-21');
    assert.equal(out.notes, 'Cold-chain delivery');
  });

  test('3. createLot: rejects empty / oversized code', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    await assert.rejects(
      () => createLot(db, { code: '', catalog_item_id: item.id, received_at: '2026-06-21' }, 0),
      /code must be a string of 1-64 characters/,
    );
    await assert.rejects(
      () => createLot(db, { code: 'x'.repeat(65), catalog_item_id: item.id, received_at: '2026-06-21' }, 0),
      /code must be a string of 1-64 characters/,
    );
  });

  test('4. createLot: rejects malformed expiry_date', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    await assert.rejects(
      () => createLot(db, {
        code: 'LOT-X',
        catalog_item_id: item.id,
        received_at: '2026-06-21',
        expiry_date: '2027/06/21',
      }, 0),
      /expiry_date must be in YYYY-MM-DD format/,
    );
  });

  test('5. createLot: rejects unknown catalog_item_id (orphan prevention)', async () => {
    const db = makeDb();
    await assert.rejects(
      () => createLot(db, { code: 'LOT-ORPHAN', catalog_item_id: 99999, received_at: '2026-06-21' }, 0),
      /catalog item 99999 not found/,
    );
  });

  test('6. getLot: returns null for non-existent or cross-tenant id', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    const lot = await createLot(db, { code: 'LOT-X', catalog_item_id: item.id, received_at: '2026-06-21' }, 0);
    // Non-existent
    assert.equal(await getLot(db, 999999, 0), null);
    // Cross-tenant (lot exists in tenant 0, query as tenant 7)
    assert.equal(await getLot(db, lot.id, 7), null);
    // Correct tenant → found
    const found = await getLot(db, lot.id, 0);
    assert.ok(found);
    assert.equal(found.code, 'LOT-X');
  });

  test('7. listLotsForItem: sorted by expiry_date ASC NULLS LAST (FEFO order)', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    // Create 3 lots with different expiries:
    //  - LOT-NULL: no expiry (NULL → goes last per FEFO)
    //  - LOT-NEAR: expires 2026-08-01 (closest → first)
    //  - LOT-FAR:  expires 2027-06-21 (later → second)
    await createLot(db, { code: 'LOT-NULL', catalog_item_id: item.id, received_at: '2026-06-21' }, 0);
    await createLot(db, { code: 'LOT-FAR', catalog_item_id: item.id, received_at: '2026-06-21', expiry_date: '2027-06-21' }, 0);
    await createLot(db, { code: 'LOT-NEAR', catalog_item_id: item.id, received_at: '2026-06-21', expiry_date: '2026-08-01' }, 0);
    const lots = await listLotsForItem(db, item.id, 0);
    assert.equal(lots.length, 3);
    assert.equal(lots[0].code, 'LOT-NEAR');
    assert.equal(lots[1].code, 'LOT-FAR');
    assert.equal(lots[2].code, 'LOT-NULL');
  });

  test('8. listLotsForItem: tenant-scoped (tenant 0 cannot see tenant 7 lots)', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    await createLot(db, { code: 'LOT-0', catalog_item_id: item.id, received_at: '2026-06-21' }, 0);
    // Tenant 7 sees nothing (item is tenant 0, lots are tenant 0)
    const lots7 = await listLotsForItem(db, item.id, 7);
    assert.equal(lots7.length, 0);
  });

  // ─── Serials ───

  test('9. createSerial: minimal input → returns row with default status=in_stock', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    const out = await createSerial(db, {
      serial_number: 'SN-ABC-001',
      catalog_item_id: item.id,
      received_at: '2026-06-21',
    }, 0);
    assert.equal(out.serial_number, 'SN-ABC-001');
    assert.equal(out.catalog_item_id, item.id);
    assert.equal(out.status, 'in_stock');
    assert.equal(out.lot_id, null);
    assert.equal(out.current_location_id, null);
    assert.equal(out.sold_at, null);
    assert.ok(Number.isInteger(out.id) && out.id > 0);
  });

  test('10. createSerial: with lot_id (lot must exist AND be for the same catalog_item)', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    const lot = await createLot(db, { code: 'LOT-1', catalog_item_id: item.id, received_at: '2026-06-21' }, 0);
    // Happy path: lot_id matches the catalog_item
    const s1 = await createSerial(db, {
      serial_number: 'SN-001',
      catalog_item_id: item.id,
      lot_id: lot.id,
      received_at: '2026-06-21',
    }, 0);
    assert.equal(s1.lot_id, lot.id);

    // Mismatch: lot is for item A, serial is for item B (different item)
    const item2 = await seedItem(db, { sku: 'SKU-LOT-2', name: 'Other item' });
    await assert.rejects(
      () => createSerial(db, {
        serial_number: 'SN-002',
        catalog_item_id: item2.id,
        lot_id: lot.id, // lot is for item 1, not item2
        received_at: '2026-06-21',
      }, 0),
      /is for catalog item 1, not 2/,
    );
  });

  test('11. createSerial: rejects invalid status', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    await assert.rejects(
      () => createSerial(db, {
        serial_number: 'SN-X',
        catalog_item_id: item.id,
        received_at: '2026-06-21',
        status: 'invalid_status',
      }, 0),
      /status must be one of/,
    );
  });

  test('12. createSerial: rejects oversized serial_number', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    await assert.rejects(
      () => createSerial(db, {
        serial_number: 'x'.repeat(65),
        catalog_item_id: item.id,
        received_at: '2026-06-21',
      }, 0),
      /serial_number must be a string of 1-64 characters/,
    );
  });

  test('13. getSerial: returns null for non-existent or cross-tenant id', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    const s = await createSerial(db, {
      serial_number: 'SN-CROSS',
      catalog_item_id: item.id,
      received_at: '2026-06-21',
    }, 0);
    assert.equal(await getSerial(db, 999999, 0), null);
    assert.equal(await getSerial(db, s.id, 7), null);
    const found = await getSerial(db, s.id, 0);
    assert.ok(found);
    assert.equal(found.serial_number, 'SN-CROSS');
  });

  test('14. listSerialsForItem: filters by lot_id and status', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    const lot = await createLot(db, { code: 'LOT-FILTER', catalog_item_id: item.id, received_at: '2026-06-21' }, 0);
    // 3 serials: 1 in lot (in_stock), 1 in lot (sold), 1 not in lot (in_stock)
    await createSerial(db, { serial_number: 'SN-A', catalog_item_id: item.id, lot_id: lot.id, received_at: '2026-06-21' }, 0);
    await createSerial(db, { serial_number: 'SN-B', catalog_item_id: item.id, lot_id: lot.id, received_at: '2026-06-21', status: 'sold' }, 0);
    await createSerial(db, { serial_number: 'SN-C', catalog_item_id: item.id, received_at: '2026-06-21' }, 0);

    const all = await listSerialsForItem(db, item.id, 0);
    assert.equal(all.length, 3);

    // Filter by lot_id
    const inLot = await listSerialsForItem(db, item.id, 0, { lot_id: lot.id });
    assert.equal(inLot.length, 2);
    assert.deepEqual(inLot.map((s) => s.serial_number).sort(), ['SN-A', 'SN-B']);

    // Filter by status
    const sold = await listSerialsForItem(db, item.id, 0, { status: 'sold' });
    assert.equal(sold.length, 1);
    assert.equal(sold[0].serial_number, 'SN-B');

    // Combined filters: lot + status
    const inLotSold = await listSerialsForItem(db, item.id, 0, { lot_id: lot.id, status: 'sold' });
    assert.equal(inLotSold.length, 1);
    assert.equal(inLotSold[0].serial_number, 'SN-B');

    const inLotInStock = await listSerialsForItem(db, item.id, 0, { lot_id: lot.id, status: 'in_stock' });
    assert.equal(inLotInStock.length, 1);
    assert.equal(inLotInStock[0].serial_number, 'SN-A');
  });

  test('15. listSerialsForItem: tenant-scoped (tenant 0 cannot see tenant 7 serials)', async () => {
    const db = makeDb();
    const item = await seedItem(db);
    await createSerial(db, { serial_number: 'SN-T0', catalog_item_id: item.id, received_at: '2026-06-21' }, 0);
    const ss = await listSerialsForItem(db, item.id, 7);
    assert.equal(ss.length, 0);
  });
});