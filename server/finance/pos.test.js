// Phase 3 POS basics — wave 1 + wave 2 + wave 3 unit tests (schema + pure functions).
// The test harness uses a minimal in-memory sqlite-shaped adapter
// that mimics the production pgAdapter shape (db.query() returns
// { rows: [...] }).
//
// The schema is migrated via applyMigrations() in the bootable
// server (npm run smoke:deploy), not in the test harness. The test
// harness creates the tables it needs; the POS tables include the
// new columns + unique partial index for "one open shift per
// register".
//
// Run: node --test server/finance/pos.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  openShift,
  listShifts,
  getShift,
  closeShift,
  addSale,
  addSaleLine,
  addPayment,
  addRegister,
  listRegisters,
  getRegister,
  completeSale,
  voidSale,
  refundSale,
  listRefunds,
  ValueError,
} from './pos.js';

function makeMemoryDb() {
  // Minimal in-memory sqlite-shaped adapter.
  // pos_registers + pos_shifts + pos_sales + pos_sale_lines +
  // pos_payments + catalog_items + customers are created in
  // the main schema (no finance. prefix). The test query shim
  // strips the finance. schema prefix so the production SQL
  // works (see catalog.test.js for the rationale).
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE pos_registers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      location TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE pos_shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      register_id INTEGER NOT NULL,
      opened_by INTEGER NOT NULL,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_by INTEGER,
      closed_at TEXT,
      opening_cash_amd INTEGER NOT NULL DEFAULT 0,
      closing_cash_amd INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE pos_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      shift_id INTEGER NOT NULL,
      register_id INTEGER NOT NULL,
      cashier_id INTEGER NOT NULL,
      customer_id INTEGER,
      total_amd INTEGER NOT NULL DEFAULT 0,
      tax_amd INTEGER,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE pos_sale_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      sale_id INTEGER NOT NULL,
      catalog_item_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price_amd INTEGER NOT NULL,
      line_total_amd INTEGER NOT NULL,
      line_tax_amd INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE pos_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      sale_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      amount_amd INTEGER NOT NULL,
      tendered_amd INTEGER NOT NULL,
      change_amd INTEGER NOT NULL DEFAULT 0,
      reference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE pos_refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      sale_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      amount_amd INTEGER NOT NULL,
      reason TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE catalog_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      unit_of_measure TEXT NOT NULL DEFAULT 'pcs',
      unit_cost_amd INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      hvhh TEXT,
      address TEXT,
      email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- The production partial unique index is on (tenant_id, register_id)
    -- WHERE status='open'. We replicate it for the "at most one
    -- open shift per register" invariant.
    CREATE UNIQUE INDEX pos_shifts_one_open_per_register_idx
        ON pos_shifts (tenant_id, register_id)
        WHERE status = 'open';
  `);
  return {
    _db: db,
    async query(sql, params = []) {
      // Use ?N numbered placeholders (the W76-1 lesson).
      const pgStyle = sql.replace(/\$\d+/g, (m) => '?' + m.slice(1));
      // Strip the finance. schema prefix for the test harness.
      const mainSchema = pgStyle.replace(/finance\./g, '');
      const stmt = db.prepare(mainSchema);
      const upper = sql.trim().toUpperCase();
      const isRead =
        upper.startsWith('SELECT') ||
        upper.startsWith('WITH') ||
        upper.includes(' RETURNING');
      if (isRead) {
        const rows = stmt.all(...params);
        return { rows };
      }
      const info = stmt.run(...params);
      return {
        rows: [],
        lastInsertRowid: info.lastInsertRowid,
        changes: info.changes,
      };
    },
  };
}

// Helper: create a POS register (so tests have a parent for shifts).
async function makeRegister(db, code = 'REG-001', name = 'Front Counter', active = 1) {
  const stmt = db._db.prepare(
    `INSERT INTO pos_registers (tenant_id, code, name, active)
     VALUES (0, ?, ?, ?) RETURNING id`,
  );
  const r = stmt.get(code, name, active);
  return { id: Number(r.id) };
}

// Helper: create a catalog item (so tests can addSaleLine).
async function makeCatalogItem(db, sku = 'TEST-1', name = 'Test Item') {
  const stmt = db._db.prepare(
    `INSERT INTO catalog_items (tenant_id, sku, name) VALUES (0, ?, ?) RETURNING id`,
  );
  const r = stmt.get(sku, name);
  return { id: Number(r.id) };
}

// Helper: create a customer (so tests can addSale with customer_id).
async function makeCustomer(db, name = 'Test Customer') {
  const stmt = db._db.prepare(
    `INSERT INTO customers (tenant_id, name) VALUES (0, ?) RETURNING id`,
  );
  const r = stmt.get(name);
  return { id: Number(r.id) };
}

// ────────────────────────────────────────────────────────────────────────
// Shifts
// ────────────────────────────────────────────────────────────────────────

test('pos: openShift inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const out = await openShift(
    db,
    { register_id: reg.id, opened_by: 1, opening_cash_amd: 5000 },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('pos: openShift applies default opening_cash_amd=0', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const out = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const shift = await getShift(db, out.id, 0);
  assert.equal(shift.opening_cash_amd, 0);
  assert.equal(shift.status, 'open');
});

test('pos: openShift throws ValueError for missing register', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    openShift(db, { register_id: 999, opened_by: 1 }, 0),
    /register 999 not found in tenant 0/,
  );
});

test('pos: openShift throws ValueError for retired register', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db, 'REG-OLD', 'Old Register', 0);
  await assert.rejects(
    openShift(db, { register_id: reg.id, opened_by: 1 }, 0),
    /retired/,
  );
});

test('pos: openShift enforces at most one open shift per register', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  // A second openShift for the same register must fail.
  await assert.rejects(
    openShift(db, { register_id: reg.id, opened_by: 2 }, 0),
    /already has an open shift/,
  );
});

test('pos: listShifts returns all shifts for the tenant (most recent first)', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const items = await listShifts(db, 0);
  assert.equal(items.length, 1);
});

test('pos: listShifts is tenant-scoped', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const items0 = await listShifts(db, 0);
  const items1 = await listShifts(db, 1);
  assert.equal(items0.length, 1);
  assert.equal(items1.length, 0);
});

test('pos: listShifts filters by registerId + status', async () => {
  const db = makeMemoryDb();
  const reg1 = await makeRegister(db, 'REG-1', 'Register 1');
  const reg2 = await makeRegister(db, 'REG-2', 'Register 2');
  await openShift(db, { register_id: reg1.id, opened_by: 1 }, 0);
  await openShift(db, { register_id: reg2.id, opened_by: 2 }, 0);
  const reg1Shifts = await listShifts(db, 0, { registerId: reg1.id });
  const reg2Shifts = await listShifts(db, 0, { registerId: reg2.id });
  assert.equal(reg1Shifts.length, 1);
  assert.equal(reg2Shifts.length, 1);
  const openShifts = await listShifts(db, 0, { status: 'open' });
  assert.equal(openShifts.length, 2);
});

test('pos: getShift throws ValueError for missing shift', async () => {
  const db = makeMemoryDb();
  await assert.rejects(getShift(db, 999, 0), /shift 999 not found in tenant 0/);
});

test('pos: getShift is tenant-scoped', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const out = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  await assert.rejects(getShift(db, out.id, 1), /not found in tenant 1/);
});

test('pos: closeShift transitions open → closed', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const open = await openShift(
    db,
    { register_id: reg.id, opened_by: 1, opening_cash_amd: 5000 },
    0,
  );
  await closeShift(
    db,
    open.id,
    { closed_by: 1, closing_cash_amd: 12000 },
    0,
  );
  const shift = await getShift(db, open.id, 0);
  assert.equal(shift.status, 'closed');
  assert.equal(shift.closing_cash_amd, 12000);
});

test('pos: closeShift throws ValueError on already-closed shift', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const open = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  await closeShift(db, open.id, { closed_by: 1, closing_cash_amd: 10000 }, 0);
  await assert.rejects(
    closeShift(db, open.id, { closed_by: 1, closing_cash_amd: 10000 }, 0),
    /already closed/,
  );
});

test('pos: after closeShift, a new openShift on the same register succeeds', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const a = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  await closeShift(db, a.id, { closed_by: 1, closing_cash_amd: 5000 }, 0);
  const b = await openShift(db, { register_id: reg.id, opened_by: 2 }, 0);
  assert.ok(b.id > a.id);
});

// ────────────────────────────────────────────────────────────────────────
// Sales
// ────────────────────────────────────────────────────────────────────────

test('pos: addSale inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const out = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('pos: addSale applies default status=open', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const out = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  // The sale row should exist with status='open' and total=0.
  const r = db._db
    .prepare('SELECT status, total_amd FROM pos_sales WHERE id = ?')
    .get(out.id);
  assert.equal(r.status, 'open');
  assert.equal(r.total_amd, 0);
});

test('pos: addSale throws ValueError for closed shift', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  await closeShift(db, shift.id, { closed_by: 1, closing_cash_amd: 0 }, 0);
  await assert.rejects(
    addSale(
      db,
      { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
      0,
    ),
    /is closed/,
  );
});

test('pos: addSale throws ValueError for shift/register mismatch', async () => {
  const db = makeMemoryDb();
  const reg1 = await makeRegister(db, 'REG-1');
  const reg2 = await makeRegister(db, 'REG-2');
  const shift = await openShift(db, { register_id: reg1.id, opened_by: 1 }, 0);
  await assert.rejects(
    addSale(
      db,
      { shift_id: shift.id, register_id: reg2.id, cashier_id: 1 },
      0,
    ),
    /register 1, not 2/,
  );
});

test('pos: addSale with customer_id validates the customer exists', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  await assert.rejects(
    addSale(
      db,
      { shift_id: shift.id, register_id: reg.id, cashier_id: 1, customer_id: 999 },
      0,
    ),
    /customer 999 not found/,
  );
});

// ────────────────────────────────────────────────────────────────────────
// Sale lines
// ────────────────────────────────────────────────────────────────────────

test('pos: addSaleLine inserts a row + recomputes total_amd', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const item = await makeCatalogItem(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  // Add 2 lines: qty 3 @ 1000 + qty 2 @ 500 = 3000 + 1000 = 4000.
  await addSaleLine(
    db,
    { sale_id: sale.id, catalog_item_id: item.id, quantity: 3, unit_price_amd: 1000 },
    0,
  );
  await addSaleLine(
    db,
    { sale_id: sale.id, catalog_item_id: item.id, quantity: 2, unit_price_amd: 500 },
    0,
  );
  const r = db._db
    .prepare('SELECT total_amd FROM pos_sales WHERE id = ?')
    .get(sale.id);
  assert.equal(r.total_amd, 4000);
});

test('pos: addSaleLine throws ValueError for missing sale', async () => {
  const db = makeMemoryDb();
  const item = await makeCatalogItem(db);
  await assert.rejects(
    addSaleLine(
      db,
      { sale_id: 999, catalog_item_id: item.id, quantity: 1, unit_price_amd: 100 },
      0,
    ),
    /sale 999 not found/,
  );
});

test('pos: addSaleLine throws ValueError for missing catalog item', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await assert.rejects(
    addSaleLine(
      db,
      { sale_id: sale.id, catalog_item_id: 999, quantity: 1, unit_price_amd: 100 },
      0,
    ),
    /catalog item 999 not found/,
  );
});

test('pos: addSaleLine validates quantity > 0', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const item = await makeCatalogItem(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await assert.rejects(
    addSaleLine(
      db,
      { sale_id: sale.id, catalog_item_id: item.id, quantity: 0, unit_price_amd: 100 },
      0,
    ),
    /quantity/,
  );
});

// ────────────────────────────────────────────────────────────────────────
// Payments
// ────────────────────────────────────────────────────────────────────────

test('pos: addPayment inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  const out = await addPayment(
    db,
    {
      sale_id: sale.id,
      payment_method: 'cash',
      amount_amd: 5000,
      tendered_amd: 5000,
      change_amd: 0,
    },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('pos: addPayment validates payment_method', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await assert.rejects(
    addPayment(
      db,
      { sale_id: sale.id, payment_method: 'unknown', amount_amd: 5000, tendered_amd: 5000 },
      0,
    ),
    /payment method/,
  );
});

test('pos: addPayment validates tendered_amd >= amount_amd', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await assert.rejects(
    addPayment(
      db,
      { sale_id: sale.id, payment_method: 'cash', amount_amd: 5000, tendered_amd: 4000 },
      0,
    ),
    /tendered_amd.*>=.*amount_amd/,
  );
});

test('pos: addPayment enforces change_amd=0 for non-cash', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await assert.rejects(
    addPayment(
      db,
      {
        sale_id: sale.id,
        payment_method: 'card',
        amount_amd: 5000,
        tendered_amd: 5000,
        change_amd: 500, // non-cash can't have change
      },
      0,
    ),
    /change_amd must be 0 for non-cash/,
  );
});

test('pos: addPayment accepts cash with non-zero change', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  const out = await addPayment(
    db,
    {
      sale_id: sale.id,
      payment_method: 'cash',
      amount_amd: 4500,
      tendered_amd: 5000,
      change_amd: 500,
    },
    0,
  );
  const r = db._db
    .prepare('SELECT amount_amd, tendered_amd, change_amd FROM pos_payments WHERE id = ?')
    .get(out.id);
  assert.equal(r.amount_amd, 4500);
  assert.equal(r.tendered_amd, 5000);
  assert.equal(r.change_amd, 500);
});

// ────────────────────────────────────────────────────────────────────────
// Registers (W88-1) — completes the data model: register is
// the parent of a shift. Without these, a cashier cannot
// open a shift on a freshly-created register via the API.
// ────────────────────────────────────────────────────────────────────────

test('pos: addRegister inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const out = await addRegister(
    db,
    { code: 'REG-A', name: 'Front Counter', location: 'Store 1' },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('pos: addRegister throws ValueError on duplicate code', async () => {
  const db = makeMemoryDb();
  await addRegister(db, { code: 'REG-DUP', name: 'First' }, 0);
  await assert.rejects(
    addRegister(db, { code: 'REG-DUP', name: 'Second' }, 0),
    /already exists/,
  );
});

test('pos: addRegister throws ValueError when required fields missing', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    addRegister(db, { name: 'No Code' }, 0),
    /code must be a string/,
  );
  await assert.rejects(
    addRegister(db, { code: 'NO-NAME' }, 0),
    /name must be a string/,
  );
});

test('pos: listRegisters returns all registers for the tenant (ordered by id ASC)', async () => {
  const db = makeMemoryDb();
  await addRegister(db, { code: 'REG-1', name: 'First' }, 0);
  await addRegister(db, { code: 'REG-2', name: 'Second' }, 0);
  const rows = await listRegisters(db, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].code, 'REG-1');
  assert.equal(rows[1].code, 'REG-2');
});

test('pos: getRegister returns the register or throws ValueError', async () => {
  const db = makeMemoryDb();
  const out = await addRegister(db, { code: 'REG-G', name: 'Get' }, 0);
  const r = await getRegister(db, out.id, 0);
  assert.equal(r.code, 'REG-G');
  assert.equal(r.active, 1);
  await assert.rejects(getRegister(db, 999, 0), /register 999 not found in tenant 0/);
});
// ────────────────────────────────────────────────────────────────────────
// A1-Validator wiring — addSale re-validates the customer's HVVH at
// sale-create time. Same fail-soft pattern as customer + vendor +
// invoice + contact + lead. Drift detection: the customer's HVVH
// could have become invalid since the customer was created.
// ────────────────────────────────────────────────────────────────────────

async function makeCustomerWithHvhh(db, name, hvhh) {
  const stmt = db._db.prepare(
    `INSERT INTO customers (tenant_id, name, hvhh) VALUES (0, ?, ?) RETURNING id`,
  );
  const r = stmt.get(name, hvhh);
  return { id: Number(r.id) };
}

test('addSale: customer with valid 8-digit HVVH → sale created (happy path)', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const cust = await makeCustomerWithHvhh(db, 'GoodCo', '00123456');
  const out = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, customer_id: cust.id, cashier_id: 1 },
    0,
  );
  assert.ok(Number.isInteger(out.id) && out.id > 0);
});

test('addSale: customer with invalid 9-digit HVVH → ValueError (drift detection)', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  // Create customer with valid hvhh, then mutate to invalid to simulate drift
  const cust = await makeCustomerWithHvhh(db, 'GoodCo', '00123456');
  db._db.prepare('UPDATE customers SET hvhh = ? WHERE id = ?').run('NOT_AN_HVVH', cust.id);
  await assert.rejects(
    addSale(
      db,
      { shift_id: shift.id, register_id: reg.id, customer_id: cust.id, cashier_id: 1 },
      0,
    ),
    /hvhh must be exactly 8 digits/,
  );
});

test('addSale: customer with no HVVH (walk-in customer) → sale created', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const cust = await makeCustomer(db, 'NoHvhhCo'); // makeCustomer doesn't set hvhh
  const out = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, customer_id: cust.id, cashier_id: 1 },
    0,
  );
  assert.ok(Number.isInteger(out.id) && out.id > 0);
});

test('addSale: customer_id=null (anonymous walk-in) → sale created without A1-Validator check', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const out = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, customer_id: null, cashier_id: 1 },
    0,
  );
  assert.ok(Number.isInteger(out.id) && out.id > 0);
});
// ────────────────────────────────────────────────────────────────────────
// Sale lifecycle: complete / void / refund (W89-1)
// ────────────────────────────────────────────────────────────────────────

test('pos: completeSale flips open → completed + sets completed_at', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  const out = await completeSale(db, sale.id, 0);
  assert.equal(out.id, sale.id);
  const refreshed = db._db.prepare('SELECT status, completed_at FROM pos_sales WHERE id = ?').get(sale.id);
  assert.equal(refreshed.status, 'completed');
  assert.ok(refreshed.completed_at != null);
});

test('pos: completeSale throws ValueError on already-completed sale', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await completeSale(db, sale.id, 0);
  await assert.rejects(
    completeSale(db, sale.id, 0),
    /already completed/,
  );
});

test('pos: voidSale flips open → voided', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  const out = await voidSale(db, sale.id, { voided_by: 1 }, 0);
  assert.equal(out.id, sale.id);
  const refreshed = db._db.prepare('SELECT status FROM pos_sales WHERE id = ?').get(sale.id);
  assert.equal(refreshed.status, 'voided');
});

test('pos: voidSale throws ValueError on completed sale (must use refundSale)', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await completeSale(db, sale.id, 0);
  await assert.rejects(
    voidSale(db, sale.id, { voided_by: 1 }, 0),
    /use refundSale to refund a completed sale/,
  );
});

test('pos: voidSale throws ValueError on already-voided sale', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await voidSale(db, sale.id, { voided_by: 1 }, 0);
  await assert.rejects(
    voidSale(db, sale.id, { voided_by: 1 }, 0),
    /already voided/,
  );
});

test('pos: voidSale does NOT insert a pos_refunds row (refund-only)', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await voidSale(db, sale.id, { voided_by: 1 }, 0);
  const refunds = await listRefunds(db, 0);
  assert.equal(refunds.length, 0);
});

test('pos: refundSale inserts pos_refunds + flips completed → voided', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await completeSale(db, sale.id, 0);
  const out = await refundSale(
    db,
    sale.id,
    {
      refunded_by: 1,
      amount_amd: 3000,
      payment_method: 'cash',
      reason: 'customer changed mind',
    },
    0,
  );
  assert.ok(Number.isInteger(out.id) && out.id > 0);
  const refreshed = db._db.prepare('SELECT status FROM pos_sales WHERE id = ?').get(sale.id);
  assert.equal(refreshed.status, 'voided');
  const refunds = await listRefunds(db, 0, { saleId: sale.id });
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amount_amd, 3000);
  assert.equal(refunds[0].payment_method, 'cash');
  assert.equal(refunds[0].reason, 'customer changed mind');
});

test('pos: refundSale throws ValueError on open sale (must voidSale instead)', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await assert.rejects(
    refundSale(
      db,
      sale.id,
      { refunded_by: 1, amount_amd: 1000, payment_method: 'cash' },
      0,
    ),
    /only completed sales can be refunded/,
  );
});

test('pos: refundSale throws ValueError on voided sale', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await voidSale(db, sale.id, { voided_by: 1 }, 0);
  await assert.rejects(
    refundSale(
      db,
      sale.id,
      { refunded_by: 1, amount_amd: 1000, payment_method: 'cash' },
      0,
    ),
    /only completed sales can be refunded/,
  );
});

test('pos: listRefunds returns all refunds for the tenant (chronological)', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  // Create + complete + refund two sales
  for (let i = 0; i < 2; i++) {
    const sale = await addSale(
      db,
      { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
      0,
    );
    await completeSale(db, sale.id, 0);
    await refundSale(
      db,
      sale.id,
      { refunded_by: 1, amount_amd: 1000 + i * 500, payment_method: 'cash' },
      0,
    );
  }
  const all = await listRefunds(db, 0);
  assert.equal(all.length, 2);
  assert.equal(all[0].amount_amd, 1000);
  assert.equal(all[1].amount_amd, 1500);
});

test('pos: listRefunds filters by saleId', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const s1 = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  const s2 = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await completeSale(db, s1.id, 0);
  await completeSale(db, s2.id, 0);
  await refundSale(
    db,
    s1.id,
    { refunded_by: 1, amount_amd: 1000, payment_method: 'cash' },
    0,
  );
  await refundSale(
    db,
    s2.id,
    { refunded_by: 1, amount_amd: 2000, payment_method: 'cash' },
    0,
  );
  const s1Refunds = await listRefunds(db, 0, { saleId: s1.id });
  assert.equal(s1Refunds.length, 1);
  assert.equal(s1Refunds[0].amount_amd, 1000);
  const s2Refunds = await listRefunds(db, 0, { saleId: s2.id });
  assert.equal(s2Refunds.length, 1);
  assert.equal(s2Refunds[0].amount_amd, 2000);
});

test('pos: refundSale throws ValueError on bad payment_method', async () => {
  const db = makeMemoryDb();
  const reg = await makeRegister(db);
  const shift = await openShift(db, { register_id: reg.id, opened_by: 1 }, 0);
  const sale = await addSale(
    db,
    { shift_id: shift.id, register_id: reg.id, cashier_id: 1 },
    0,
  );
  await completeSale(db, sale.id, 0);
  await assert.rejects(
    refundSale(
      db,
      sale.id,
      { refunded_by: 1, amount_amd: 1000, payment_method: 'crypto' },
      0,
    ),
    /payment method must be one of/,
  );
});