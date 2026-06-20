// Tests for server/finance/adjustments.js — manual write-offs, refunds,
// and corrections. Real node:sqlite DB.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function makeRealDb() {
  const dir = mkdtempSync(join(tmpdir(), 'sbos-adj-'));
  const sqliteDb = new DatabaseSync(join(dir, 'finance.db'));
  sqliteDb.exec('ATTACH DATABASE ":memory:" AS finance');
  sqliteDb.exec('PRAGMA foreign_keys = OFF');
  sqliteDb.exec(`
    CREATE TABLE finance.customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, hvhh TEXT, address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      invoice_number TEXT NOT NULL UNIQUE,
      issue_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      subtotal_amd INTEGER NOT NULL,
      vat_amd INTEGER NOT NULL DEFAULT 0,
      total_amd INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','sent','paid','overdue','void')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT, voided_at TEXT, void_reason TEXT
    );
    CREATE TABLE finance.payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      paid_at TEXT NOT NULL DEFAULT (datetime('now')),
      amount_amd INTEGER NOT NULL, method TEXT NOT NULL DEFAULT 'bank_transfer',
      reference TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.invoice_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('writeoff','refund','correction')),
      amount_amd INTEGER NOT NULL CHECK (amount_amd > 0),
      reason TEXT NOT NULL,
      approved_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
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

async function seedCustomer(db, { name }) {
  await db.query('INSERT INTO finance.customers (name) VALUES ($1)', [name]);
  const r = await db.query('SELECT MAX(id) AS id FROM finance.customers');
  return Number(r.rows[0].id);
}
async function seedInvoice(db, { customer_id, invoice_number, total_amd }) {
  await db.query(
    `INSERT INTO finance.invoices
       (customer_id, invoice_number, issue_date, due_date,
        subtotal_amd, vat_amd, total_amd, status, notes, sent_at, voided_at, void_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [customer_id, invoice_number, '2026-06-01', '2026-07-01',
     total_amd, 0, total_amd, 'sent', null, '2026-06-01', null, null],
  );
  const r = await db.query('SELECT MAX(id) AS id FROM finance.invoices');
  return Number(r.rows[0].id);
}
async function seedPayment(db, { invoice_id, amount_amd }) {
  await db.query(
    `INSERT INTO finance.payments (invoice_id, paid_at, amount_amd, method, reference)
     VALUES ($1, datetime('now'), $2, 'bank_transfer', null)`,
    [invoice_id, amount_amd],
  );
}

describe('finance — invoice adjustments (writeoff / refund / correction)', () => {
  let db;
  let recordAdjustment;
  let listAdjustmentsForInvoice;
  let getEffectivePaidAmd;
  let ValueError;

  before(async () => {
    const sqlite = makeRealDb();
    db = makePgAdapter(sqlite);
    const mod = await import('./adjustments.js');
    recordAdjustment = mod.recordAdjustment;
    listAdjustmentsForInvoice = mod.listAdjustmentsForInvoice;
    getEffectivePaidAmd = mod.getEffectivePaidAmd;
    ValueError = mod.ValueError;
  });

  test('1. recordAdjustment: writeoff stores a positive amount with kind=writeoff', async () => {
    const custId = await seedCustomer(db, { name: 'C1' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'WO-1', total_amd: 100000 });
    const r = await recordAdjustment(db, {
      invoice_id: invId, kind: 'writeoff', amount_amd: 100000,
      reason: 'Customer bankrupt, uncollectable', approved_by: 'cfo@example.com',
    });
    assert.equal(r.invoice_id, invId);
    assert.equal(r.kind, 'writeoff');
    assert.equal(r.amount_amd, 100000);
    assert.equal(r.reason, 'Customer bankrupt, uncollectable');
    assert.equal(r.approved_by, 'cfo@example.com');
    assert.ok(r.id, 'id should be assigned');
  });

  test('2. recordAdjustment: refund also reduces the effective paid', async () => {
    const custId = await seedCustomer(db, { name: 'C2' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'RF-1', total_amd: 50000 });
    const r = await recordAdjustment(db, {
      invoice_id: invId, kind: 'refund', amount_amd: 50000,
      reason: 'Customer returned goods, full refund',
    });
    assert.equal(r.kind, 'refund');
    assert.equal(r.amount_amd, 50000);
  });

  test('3. recordAdjustment: correction ADDS to the effective paid', async () => {
    const custId = await seedCustomer(db, { name: 'C3' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'CO-1', total_amd: 100000 });
    const r = await recordAdjustment(db, {
      invoice_id: invId, kind: 'correction', amount_amd: 20000,
      reason: 'Discovered an under-recorded payment',
    });
    assert.equal(r.kind, 'correction');
    assert.equal(r.amount_amd, 20000);
  });

  test('4. recordAdjustment rejects bad kind', async () => {
    await assert.rejects(
      () => recordAdjustment(db, { invoice_id: 1, kind: 'bad', amount_amd: 100, reason: 'x' }),
      /kind must be one of/,
    );
    await assert.rejects(
      () => recordAdjustment(db, { invoice_id: 1, kind: '', amount_amd: 100, reason: 'x' }),
      /kind must be one of/,
    );
    await assert.rejects(
      () => recordAdjustment(db, { invoice_id: 1, kind: null, amount_amd: 100, reason: 'x' }),
      /kind must be one of/,
    );
  });

  test('5. recordAdjustment rejects zero or negative amount_amd', async () => {
    const custId = await seedCustomer(db, { name: 'C5' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'ZA-1', total_amd: 100000 });
    // For each bad amount, expect a ValueError matching /positive integer/.
    // Note: 1.5 is NOT bad — roundAmd rounds it to 2 (a valid whole dram),
    // so it inserts successfully. Only zero or negative integers are bad.
    for (const bad of [0, -1000, -1]) {
      let caught = null;
      try {
        await recordAdjustment(db, { invoice_id: invId, kind: 'writeoff', amount_amd: bad, reason: 'x' });
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, `amount_amd=${bad} should reject`);
      assert.ok(caught instanceof ValueError, `amount_amd=${bad} should be a ValueError`);
      assert.match(caught.message, /positive integer/);
    }
  });

  test('5b. recordAdjustment: float amount rounds to nearest whole dram (no rejection for 1.5)', async () => {
    // 1.5 rounds to 2 (roundAmd). The function inserts amount_amd=2
    // and returns the row. This is the no-float discipline at the
    // application boundary: callers may pass floats from JSON, but
    // they get whole drams on disk.
    const custId = await seedCustomer(db, { name: 'C5b' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'ZA-1B', total_amd: 100000 });
    const r = await recordAdjustment(db, { invoice_id: invId, kind: 'correction', amount_amd: 1.5, reason: 'fractional' });
    assert.equal(r.amount_amd, 2, '1.5 rounds to 2 (Math.round half-up)');
  });

  test('6. recordAdjustment rejects empty / missing reason', async () => {
    const custId = await seedCustomer(db, { name: 'C6' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'NR-1', total_amd: 100000 });
    await assert.rejects(
      () => recordAdjustment(db, { invoice_id: invId, kind: 'writeoff', amount_amd: 100, reason: '' }),
      /non-empty string/,
    );
    await assert.rejects(
      () => recordAdjustment(db, { invoice_id: invId, kind: 'writeoff', amount_amd: 100, reason: '   ' }),
      /non-empty string/,
    );
    await assert.rejects(
      () => recordAdjustment(db, { invoice_id: invId, kind: 'writeoff', amount_amd: 100, reason: null }),
      /non-empty string/,
    );
  });

  test('7. recordAdjustment rejects reason > 500 chars', async () => {
    const custId = await seedCustomer(db, { name: 'C7' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'LR-1', total_amd: 100000 });
    const long = 'x'.repeat(501);
    await assert.rejects(
      () => recordAdjustment(db, { invoice_id: invId, kind: 'writeoff', amount_amd: 100, reason: long }),
      /500 characters/,
    );
  });

  test('8. recordAdjustment rejects non-positive invoice_id', async () => {
    await assert.rejects(
      () => recordAdjustment(db, { invoice_id: 0, kind: 'writeoff', amount_amd: 100, reason: 'x' }),
      /positive integer/,
    );
    await assert.rejects(
      () => recordAdjustment(db, { invoice_id: -1, kind: 'writeoff', amount_amd: 100, reason: 'x' }),
      /positive integer/,
    );
  });

  test('9. recordAdjustment rejects missing invoice', async () => {
    await assert.rejects(
      () => recordAdjustment(db, { invoice_id: 99999, kind: 'writeoff', amount_amd: 100, reason: 'x' }),
      /invoice 99999 not found/,
    );
  });

  test('10. listAdjustmentsForInvoice returns ordered adjustments', async () => {
    const custId = await seedCustomer(db, { name: 'C10' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'L-1', total_amd: 100000 });
    await recordAdjustment(db, { invoice_id: invId, kind: 'writeoff', amount_amd: 10000, reason: 'partial bad debt' });
    await recordAdjustment(db, { invoice_id: invId, kind: 'correction', amount_amd: 5000, reason: 'late fee' });
    await recordAdjustment(db, { invoice_id: invId, kind: 'refund', amount_amd: 3000, reason: 'overcharge' });
    const list = await listAdjustmentsForInvoice(db, invId);
    assert.equal(list.length, 3);
    // First is the writeoff (earliest), then correction, then refund.
    assert.equal(list[0].kind, 'writeoff');
    assert.equal(list[1].kind, 'correction');
    assert.equal(list[2].kind, 'refund');
  });

  test('11. listAdjustmentsForInvoice returns empty for an invoice with no adjustments', async () => {
    const custId = await seedCustomer(db, { name: 'C11' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'E-1', total_amd: 100000 });
    const list = await listAdjustmentsForInvoice(db, invId);
    assert.deepEqual(list, []);
  });

  test('12. getEffectivePaidAmd: payments only → sums payments', async () => {
    const custId = await seedCustomer(db, { name: 'C12' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'P-1', total_amd: 100000 });
    await seedPayment(db, { invoice_id: invId, amount_amd: 40000 });
    await seedPayment(db, { invoice_id: invId, amount_amd: 60000 });
    const eff = await getEffectivePaidAmd(db, invId);
    assert.equal(eff, 100000);
  });

  test('13. getEffectivePaidAmd: writeoff reduces effective paid', async () => {
    const custId = await seedCustomer(db, { name: 'C13' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'W-1', total_amd: 100000 });
    await seedPayment(db, { invoice_id: invId, amount_amd: 100000 });
    // 100k paid → 100k effective. Then write off 30k → 70k effective.
    const before = await getEffectivePaidAmd(db, invId);
    assert.equal(before, 100000);
    await recordAdjustment(db, { invoice_id: invId, kind: 'writeoff', amount_amd: 30000, reason: 'partial bad debt' });
    const after = await getEffectivePaidAmd(db, invId);
    assert.equal(after, 70000);
  });

  test('14. getEffectivePaidAmd: refund reduces effective paid', async () => {
    const custId = await seedCustomer(db, { name: 'C14' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'R-1', total_amd: 50000 });
    await seedPayment(db, { invoice_id: invId, amount_amd: 50000 });
    await recordAdjustment(db, { invoice_id: invId, kind: 'refund', amount_amd: 10000, reason: 'returned goods' });
    assert.equal(await getEffectivePaidAmd(db, invId), 40000);
  });

  test('15. getEffectivePaidAmd: correction increases effective paid', async () => {
    const custId = await seedCustomer(db, { name: 'C15' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'COR-1', total_amd: 100000 });
    await seedPayment(db, { invoice_id: invId, amount_amd: 50000 });
    // 50k paid → 50k effective. Then add 30k correction → 80k.
    await recordAdjustment(db, { invoice_id: invId, kind: 'correction', amount_amd: 30000, reason: 'late fee' });
    assert.equal(await getEffectivePaidAmd(db, invId), 80000);
  });

  test('16. getEffectivePaidAmd: combined — writeoff + correction net out', async () => {
    const custId = await seedCustomer(db, { name: 'C16' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'MIX-1', total_amd: 200000 });
    await seedPayment(db, { invoice_id: invId, amount_amd: 100000 });
    // 100k paid. Add: -50k writeoff, +20k correction = 70k.
    await recordAdjustment(db, { invoice_id: invId, kind: 'writeoff', amount_amd: 50000, reason: 'partial bad debt' });
    await recordAdjustment(db, { invoice_id: invId, kind: 'correction', amount_amd: 20000, reason: 'late fee' });
    assert.equal(await getEffectivePaidAmd(db, invId), 70000);
  });

  test('17. append-only: recording a correction to fix a wrong writeoff requires a NEW row', async () => {
    // The audit-trail design: don't UPDATE, append a new correction
    // that nets out the original mistake.
    const custId = await seedCustomer(db, { name: 'C17' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'COR-2', total_amd: 100000 });
    await recordAdjustment(db, { invoice_id: invId, kind: 'writeoff', amount_amd: 30000, reason: 'wrong amount — should be 10k' });
    // Operator notices the mistake; records a positive correction for
    // the difference (20k back). Net writeoff: 10k. With no payments,
    // effective = 0 + 20k - 30k = -10k.
    await recordAdjustment(db, { invoice_id: invId, kind: 'correction', amount_amd: 20000, reason: 'reversing partial writeoff' });
    const list = await listAdjustmentsForInvoice(db, invId);
    assert.equal(list.length, 2, 'two rows, both preserved for audit');
    assert.equal(await getEffectivePaidAmd(db, invId), -10000, '0 payments + 20k correction - 30k writeoff = -10k');
  });

  test('18. recordAdjustment: rounding — amount_amd 1500.7 → 1501 (roundAmd semantics)', async () => {
    const custId = await seedCustomer(db, { name: 'C18' });
    const invId = await seedInvoice(db, { customer_id: custId, invoice_number: 'RND-1', total_amd: 100000 });
    const r = await recordAdjustment(db, {
      invoice_id: invId, kind: 'correction', amount_amd: 1500.7, reason: 'fractional amount',
    });
    assert.equal(r.amount_amd, 1501, 'roundAmd rounds to nearest whole dram');
  });
});
