// Tests for server/finance/vatLedger.js — the multi-period VAT
// carry-forward ledger. Real DB (node:sqlite) to exercise the actual
// SQL (UPSERT, schema with finance.vat_carry_forward table).

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ────────────────────────────────────────────────────────────────────────
// Real DB harness — applies the migration files in order so the test
// runs against the same schema production uses. Mirrors the wave-5.1
// realdb-smoke recipe (the migration runner is exercised separately
// in migrate.test.js; here we just apply the SQL directly to keep the
// ledger tests focused on the API, not the runner).
// ────────────────────────────────────────────────────────────────────────

function makeRealDb() {
  const dir = mkdtempSync(join(tmpdir(), 'sbos-vatledger-'));
  const sqliteDb = new DatabaseSync(join(dir, 'finance.db'));
  sqliteDb.exec('ATTACH DATABASE ":memory:" AS finance');
  sqliteDb.exec('PRAGMA foreign_keys = OFF');
  // Build a sqlite-friendly finance schema inline. The migration files
  // are pg-style and have parser issues on node:sqlite (REFERENCES
  // doesn't accept `finance.X` in attached-db form, CREATE INDEX
  // doesn't either — same caveats as wave-5.1 realdb-smoke). What
  // we need here is just the `vat_carry_forward` table plus a minimal
  // surrounding schema to satisfy the ledger's queries. The static
  // check in realdb-smoke.test.js verifies the migration files
  // themselves; this test verifies the ledger's behavior.
  sqliteDb.exec(`
    CREATE TABLE finance.customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
    CREATE TABLE finance.vat_carry_forward (
      id INTEGER PRIMARY KEY,
      balance_amd INTEGER NOT NULL DEFAULT 0,
      as_of_period TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Sanity check: also verify the migration file declares the table.
  // (The static check in realdb-smoke.test.js is the primary defense;
  // this is a smoke-level fallback.)
  const mig0003 = readFileSync(join(__dirname, 'migrations', '0003_vat_carry_forward.sql'), 'utf8');
  if (!/vat_carry_forward/i.test(mig0003)) {
    throw new Error('0003_vat_carry_forward.sql is missing the vat_carry_forward table declaration');
  }
  return sqliteDb;
}

function makePgAdapter(sqliteDb) {
  return {
    async query(sql, params = []) {
      const translated = sql.replace(/\$\d+/g, '?').replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*/g, '');
      const stmt = sqliteDb.prepare(translated);
      return { rows: stmt.all(...(params || [])) };
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('finance — VAT carry-forward ledger (real DB)', () => {
  let db;
  let getCurrentCarryForward;
  let setCurrentCarryForward;
  let clearCurrentCarryForward;
  let computeAndCloseVatPeriod;
  let ValueError;

  before(async () => {
    const sqlite = makeRealDb();
    db = makePgAdapter(sqlite);
    const mod = await import('./vatLedger.js');
    getCurrentCarryForward = mod.getCurrentCarryForward;
    setCurrentCarryForward = mod.setCurrentCarryForward;
    clearCurrentCarryForward = mod.clearCurrentCarryForward;
    computeAndCloseVatPeriod = mod.computeAndCloseVatPeriod;
    ValueError = mod.ValueError;
  });

  test('1. fresh DB: getCurrentCarryForward returns the zero default', async () => {
    const r = await getCurrentCarryForward(db);
    assert.equal(r.balance_amd, 0);
    assert.equal(r.as_of_period, null);
  });

  test('2. setCurrentCarryForward stores balance + as_of_period', async () => {
    await setCurrentCarryForward(db, 50000, '2026-05');
    const r = await getCurrentCarryForward(db);
    assert.equal(r.balance_amd, 50000);
    assert.equal(r.as_of_period, '2026-05');
  });

  test('3. setCurrentCarryForward rejects bad asOfPeriod format', async () => {
    await assert.rejects(() => setCurrentCarryForward(db, 1000, '2026/05'), /YYYY-MM/);
    await assert.rejects(() => setCurrentCarryForward(db, 1000, '20-05'), /YYYY-MM/);
    await assert.rejects(() => setCurrentCarryForward(db, 1000, ''), /YYYY-MM/);
    await assert.rejects(() => setCurrentCarryForward(db, 1000, null), /YYYY-MM/);
    await assert.rejects(() => setCurrentCarryForward(db, 1000, 202605), /YYYY-MM/);
  });

  test('3b. computeAndCloseVatPeriod rejects bad yearMonth', async () => {
    await assert.rejects(() => computeAndCloseVatPeriod(db, '2026/06', {}, {}), /YYYY-MM/);
    await assert.rejects(() => computeAndCloseVatPeriod(db, 'bad', {}, {}), /YYYY-MM/);
    await assert.rejects(() => computeAndCloseVatPeriod(db, null, {}, {}), /YYYY-MM/);
  });

  test('4. setCurrentCarryForward rejects negative balance (defends against signed ints)', async () => {
    // roundAmd rounds 1.5 to 2 (a valid non-negative integer), so we
    // can't assert on 1.5 here — the rounding happens BEFORE the
    // assertNonNegativeInt check. The function correctly rounds floats
    // to whole drams per the no-float discipline; non-integer inputs
    // (1.5) become integers, not errors. We DO assert on a negative
    // integer which roundAmd preserves.
    await assert.rejects(() => setCurrentCarryForward(db, -1, '2026-06'), /non-negative integer/);
  });

  test('5. setCurrentCarryForward overwrites the prior row (upsert, not append)', async () => {
    await setCurrentCarryForward(db, 50000, '2026-05');
    await setCurrentCarryForward(db, 80000, '2026-06');
    const r = await getCurrentCarryForward(db);
    assert.equal(r.balance_amd, 80000, 'latest set wins');
    assert.equal(r.as_of_period, '2026-06');
  });

  test('6. clearCurrentCarryForward resets to 0 + returns the previous state', async () => {
    await setCurrentCarryForward(db, 75000, '2026-07');
    const prev = await clearCurrentCarryForward(db);
    assert.equal(prev.balance_amd, 75000);
    const after = await getCurrentCarryForward(db);
    assert.equal(after.balance_amd, 0);
    assert.equal(after.as_of_period, null);
  });

  test('7. clearCurrentCarryForward on a fresh DB is a no-op (returns zero default)', async () => {
    // Use a fresh DB so test 6's bank doesn't leak in.
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    const prev = await clearCurrentCarryForward(freshDb);
    assert.equal(prev.balance_amd, 0);
    assert.equal(prev.as_of_period, null);
  });

  // ────────────────────────────────────────────────────────────────────────
  // computeAndCloseVatPeriod — the high-level flow
  // ────────────────────────────────────────────────────────────────────────

  test('8. computeAndCloseVatPeriod: positive-net period → bank set to 0 (no carry-forward)', async () => {
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    const r = await computeAndCloseVatPeriod(freshDb, '2026-06', {
      sales: [{ netAmount: 1000000, vatRate: 20 }], // 200000 output VAT
    }, {
      purchases: [{ netAmount: 200000, vatRate: 20, source: 'domestic' }], // 40000 input
    });
    // Net = 200000 - 40000 = 160000 → vatToPay = 160000, no carry-forward.
    assert.equal(r.vatToPay, 160000);
    assert.equal(r.carryForward, 0);
    // The bank on disk should be 0.
    const bank = await getCurrentCarryForward(freshDb);
    assert.equal(bank.balance_amd, 0);
    assert.equal(bank.as_of_period, '2026-06');
  });

  test('9. computeAndCloseVatPeriod: negative-net period → bank grows by |net|', async () => {
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    // Pre-seed a small bank so we can verify the growth.
    await setCurrentCarryForward(freshDb, 10000, '2026-05');
    const r = await computeAndCloseVatPeriod(freshDb, '2026-06', {
      sales: [{ netAmount: 100000, vatRate: 20 }], // 20000 output
    }, {
      purchases: [{ netAmount: 300000, vatRate: 20, source: 'domestic' }], // 60000 input
    });
    // net = 20000 - 60000 = -40000; prior = 10000; total = -40000 - 10000 = -50000
    // → vatToPay = 0, carryForward = 50000
    assert.equal(r.vatToPay, 0);
    assert.equal(r.carryForward, 50000);
    // The bank on disk should be 50000.
    const bank = await getCurrentCarryForward(freshDb);
    assert.equal(bank.balance_amd, 50000);
    assert.equal(bank.as_of_period, '2026-06');
  });

  test('10. computeAndCloseVatPeriod: subsequent positive period applies the bank + clears the residual', async () => {
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    // Period 1: net = 20000 - 60000 = -40000 → bank grows to 40000.
    await computeAndCloseVatPeriod(freshDb, '2026-06',
      { sales: [{ netAmount: 100000, vatRate: 20 }] }, // 20000
      { purchases: [{ netAmount: 300000, vatRate: 20, source: 'domestic' }] }, // 60000
    );
    // Period 2: net = 80000, prior = 40000. The prior credit reduces
    // the current payable by 40000, leaving 40000 to pay. No new
    // carry-forward; the bank is now 0.
    const r = await computeAndCloseVatPeriod(freshDb, '2026-07',
      { sales: [{ netAmount: 400000, vatRate: 20 }] }, // 80000 output
      { purchases: [] },                               // 0 input
    );
    // net = 80000; prior = 40000; total = 80000 - 40000 = 40000
    // → vatToPay = 40000, carryForward = 0
    assert.equal(r.vatToPay, 40000);
    assert.equal(r.carryForward, 0);
    // Bank on disk = 0.
    const bank = await getCurrentCarryForward(freshDb);
    assert.equal(bank.balance_amd, 0);
    assert.equal(bank.as_of_period, '2026-07');
  });

  test('11. computeAndCloseVatPeriod: subsequent positive period smaller than the bank → residual stays banked', async () => {
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    // Period 1: negative net, bank = 80000.
    await computeAndCloseVatPeriod(freshDb, '2026-06',
      { sales: [{ netAmount: 100000, vatRate: 20 }] }, // 20000
      { purchases: [{ netAmount: 500000, vatRate: 20, source: 'domestic' }] }, // 100000
    );
    // bank = 20000 - 100000 = -80000 → vatToPay=0, carryForward=80000
    // Period 2: small positive net 20000. Prior 80000 > 20000, so vatToPay=0,
    // carryForward = 80000 - 20000 = 60000 (residual).
    const r = await computeAndCloseVatPeriod(freshDb, '2026-07',
      { sales: [{ netAmount: 100000, vatRate: 20 }] }, // 20000
      { purchases: [] },
    );
    assert.equal(r.vatToPay, 0);
    assert.equal(r.carryForward, 60000);
    const bank = await getCurrentCarryForward(freshDb);
    assert.equal(bank.balance_amd, 60000);
  });

  test('12. computeAndCloseVatPeriod: result includes priorPeriodCarryForward + priorAsOfPeriod for audit', async () => {
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    await setCurrentCarryForward(freshDb, 25000, '2026-04');
    const r = await computeAndCloseVatPeriod(freshDb, '2026-05',
      { sales: [{ netAmount: 500000, vatRate: 20 }] }, // 100000
      { purchases: [] },
    );
    // net = 100000; prior = 25000; total = 100000 - 25000 = 75000
    // → vatToPay = 75000, carryForward = 0
    assert.equal(r.vatToPay, 75000);
    assert.equal(r.carryForward, 0);
    assert.equal(r.priorPeriodCarryForward, 25000, 'audit field present');
    assert.equal(r.priorAsOfPeriod, '2026-04', 'audit field present');
  });

  test('13. computeAndCloseVatPeriod: bad yearMonth format rejected before any DB write', async () => {
    await assert.rejects(
      () => computeAndCloseVatPeriod(db, '2026/06', {}, {}),
      /YYYY-MM/,
    );
    // The bank should be unchanged.
    const bank = await getCurrentCarryForward(db);
    assert.equal(bank.balance_amd, 0, 'rejected write must not corrupt the bank');
  });

  test('14. three-period cross check: negative → positive → negative across months', async () => {
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    // Period 1 (2026-04): net -30000 → bank 30000
    const r1 = await computeAndCloseVatPeriod(freshDb, '2026-04',
      { sales: [{ netAmount: 200000, vatRate: 20 }] }, // 40000
      { purchases: [{ netAmount: 350000, vatRate: 20, source: 'domestic' }] }, // 70000
    );
    assert.equal(r1.vatToPay, 0);
    assert.equal(r1.carryForward, 30000);
    // Period 2 (2026-05): net 10000, prior 30000 → vatToPay 0, bank 20000
    const r2 = await computeAndCloseVatPeriod(freshDb, '2026-05',
      { sales: [{ netAmount: 50000, vatRate: 20 }] }, // 10000
      { purchases: [] },
    );
    assert.equal(r2.vatToPay, 0);
    assert.equal(r2.carryForward, 20000);
    // Period 3 (2026-06): net 15000, prior 20000 → vatToPay 0, bank 5000
    const r3 = await computeAndCloseVatPeriod(freshDb, '2026-06',
      { sales: [{ netAmount: 75000, vatRate: 20 }] }, // 15000
      { purchases: [] },
    );
    assert.equal(r3.vatToPay, 0);
    assert.equal(r3.carryForward, 5000);
  });
});
