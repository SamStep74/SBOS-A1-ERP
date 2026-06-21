// server/finance/customer360.test.js
//
// Tests for the CFO 360 view of a customer. Mirrors the
// realdb-smoke.test.js pattern: a real in-memory sqlite db with
// the production finance schema, exercised via the real CRUD
// functions (createCustomer, createInvoice, recordPayment, etc.)
// to seed the data, then getCustomer360 reads it.
//
// TDD: this file lands in commit A (RED). commit B adds
// server/finance/customer360.js and the suite goes green.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCustomer, getCustomer } from './customer.js';
import { createInvoice, updateInvoice } from './invoice.js';
import { recordPayment, reconcileInvoice } from './payment.js';
import { getCustomer360, ValueError } from './customer360.js';

// ────────────────────────────────────────────────────────────────────────
// Real in-memory sqlite db + pg-style adapter. Same shape as
// realdb-smoke.test.js uses; production CRUD functions work against
// the same `db.query(sql, params) → { rows }` surface they do in
// production.
// ────────────────────────────────────────────────────────────────────────

function makeDb() {
  const sqliteDb = new DatabaseSync(':memory:');
  sqliteDb.exec('ATTACH DATABASE ":memory:" AS finance');
  sqliteDb.exec('PRAGMA foreign_keys = OFF');
  sqliteDb.exec(`
    CREATE TABLE finance.customers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      hvhh        TEXT,
      address     TEXT,
      email       TEXT,
      tenant_id   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.invoices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id     INTEGER NOT NULL,
      invoice_number  TEXT NOT NULL UNIQUE,
      issue_date      TEXT NOT NULL,
      due_date        TEXT NOT NULL,
      subtotal_amd    INTEGER NOT NULL,
      vat_amd         INTEGER NOT NULL DEFAULT 0,
      total_amd       INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','sent','paid','overdue','void')),
      notes           TEXT,
      tenant_id       INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at         TEXT,
      voided_at       TEXT,
      void_reason     TEXT
    );
    CREATE TABLE finance.invoice_lines (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id      INTEGER NOT NULL,
      description     TEXT NOT NULL,
      quantity        REAL NOT NULL CHECK (quantity > 0),
      unit_price_amd  INTEGER NOT NULL CHECK (unit_price_amd >= 0),
      line_total_amd  INTEGER NOT NULL,
      tenant_id       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE finance.payments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id  INTEGER NOT NULL,
      paid_at     TEXT NOT NULL DEFAULT (datetime('now')),
      amount_amd  INTEGER NOT NULL CHECK (amount_amd > 0),
      method      TEXT NOT NULL DEFAULT 'bank_transfer'
                    CHECK (method IN ('bank_transfer','cash','card','other')),
      reference   TEXT,
      tenant_id   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return {
    async query(sql, params = []) {
      // Translate pg-style $N placeholders → sqlite positional ?.
      // Also strip pg-style type casts (::bigint, ::text) — sqlite
      // has no :: cast operator, integer-affinity columns handle
      // the conversion implicitly. The realdb-smoke.test.js uses
      // the same translation; copying the pattern.
      const translated = sql
        .replace(/\$\d+/g, '?')
        .replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*/g, '');
      const stmt = sqliteDb.prepare(translated);
      const rows = stmt.all(...(params || []));
      return { rows };
    },
  };
}

// Helper: create a customer + 1+ invoices in tenant 0, optionally
// apply payments. Returns { db, customer, invoices }.
async function seedCustomer(db, { name = 'Acme LLC', hvhh = '12345678', invoices = [] } = {}) {
  const customer = await createCustomer(db, { name, hvhh }, 0);
  const out = [];
  for (const inv of invoices) {
    const created = await createInvoice(
      db,
      {
        customer_id: customer.id,
        invoice_number: inv.invoice_number,
        issue_date: inv.issue_date,
        due_date: inv.due_date,
        lines: inv.lines || [{ description: 'X', quantity: 1, unit_price_amd: inv.total_amd }],
      },
      0,
    );
    if (inv.status === 'sent' || inv.status === 'overdue') {
      // mark as sent (the production flow does this; in the test
      // we skip the update and set the status via a direct write
      // OR via updateInvoice — but updateInvoice expects the
      // sent_at column populated, which is set on status='sent'
      // transitions. For test brevity, just call updateInvoice
      // with status='sent'.)
      await updateInvoice(db, created.id, { status: 'sent' }, 0);
    }
    if (inv.paid_amd && inv.paid_amd > 0) {
      await recordPayment(db, { invoice_id: created.id, amount_amd: inv.paid_amd }, 0);
    }
    out.push(created);
  }
  return { db, customer, invoices: out };
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('finance/customer360 — CFO 360 view', () => {
  test('1. getCustomer360: missing customer throws ValueError (route layer maps to 404)', async () => {
    const db = makeDb();
    await assert.rejects(
      () => getCustomer360(db, 999, 0, { today: '2026-06-21' }),
      (err) => err instanceof ValueError && /customer 999 not found/.test(err.message),
    );
  });

  test('2. getCustomer360: cross-tenant customer is invisible (not found in tenant 7)', async () => {
    // Same as missing — the function throws ValueError so the
    // route layer can't leak existence across tenants.
    const db = makeDb();
    const { customer } = await seedCustomer(db, { invoices: [] });
    await assert.rejects(
      () => getCustomer360(db, customer.id, 7, { today: '2026-06-21' }),
      (err) => err instanceof ValueError && /not found in tenant 7/.test(err.message),
    );
  });

  test('3. getCustomer360: empty customer (no invoices) returns open_invoices=[] and zero totals', async () => {
    const db = makeDb();
    const { customer } = await seedCustomer(db, { invoices: [] });
    const out = await getCustomer360(db, customer.id, 0, { today: '2026-06-21' });
    assert.equal(out.customer.id, customer.id);
    assert.equal(out.customer.name, 'Acme LLC');
    assert.equal(out.open_invoices.length, 0);
    assert.equal(out.recent_payments.length, 0);
    assert.equal(out.totals.open_count, 0);
    assert.equal(out.totals.open_total_amd, 0);
    assert.equal(out.totals.paid_total_amd, 0);
    assert.equal(out.totals.outstanding_amd, 0);
    assert.equal(out.aging.current, 0);
    assert.equal(out.aging.days_1_30, 0);
    assert.equal(out.aging.days_31_60, 0);
    assert.equal(out.aging.days_61_90, 0);
    assert.equal(out.aging.days_90_plus, 0);
  });

  test('4. getCustomer360: one sent invoice (due in 10 days) goes into "current" aging bucket', async () => {
    const db = makeDb();
    const { customer } = await seedCustomer(db, {
      invoices: [
        { invoice_number: 'INV-1', issue_date: '2026-06-01', due_date: '2026-07-01', total_amd: 100000, status: 'sent' },
      ],
    });
    const out = await getCustomer360(db, customer.id, 0, { today: '2026-06-21' });
    assert.equal(out.open_invoices.length, 1);
    assert.equal(out.open_invoices[0].invoice_number, 'INV-1');
    assert.equal(out.open_invoices[0].balance_amd, 100000);
    assert.equal(out.open_invoices[0].days_overdue, 0); // due in 10 days
    assert.equal(out.totals.open_count, 1);
    assert.equal(out.totals.outstanding_amd, 100000);
    assert.equal(out.aging.current, 100000);
    assert.equal(out.aging.days_1_30, 0);
  });

  test('5. getCustomer360: 45-day-overdue invoice goes into days_31_60 bucket', async () => {
    const db = makeDb();
    const { customer } = await seedCustomer(db, {
      invoices: [
        { invoice_number: 'INV-OVERDUE', issue_date: '2026-04-01', due_date: '2026-05-07', total_amd: 50000, status: 'overdue' },
      ],
    });
    // The seed marks the invoice as 'sent' (updateInvoice path),
    // but for this test we just need the due_date to be 45 days
    // before 'today'. The reconcileInvoice path uses the
    // invoice.status internally; the 360 view reads from the
    // invoice row's due_date, not the status.
    const out = await getCustomer360(db, customer.id, 0, { today: '2026-06-21' });
    assert.equal(out.open_invoices[0].days_overdue, 45);
    assert.equal(out.aging.days_31_60, 50000);
    assert.equal(out.aging.current, 0);
  });

  test('6. getCustomer360: 100-day-overdue invoice goes into days_90_plus bucket', async () => {
    const db = makeDb();
    const { customer } = await seedCustomer(db, {
      invoices: [
        { invoice_number: 'INV-VERY-OLD', issue_date: '2025-12-01', due_date: '2026-03-13', total_amd: 75000 },
      ],
    });
    const out = await getCustomer360(db, customer.id, 0, { today: '2026-06-21' });
    assert.equal(out.open_invoices[0].days_overdue, 100);
    assert.equal(out.aging.days_90_plus, 75000);
  });

  test('7. getCustomer360: paid invoice is excluded from open_invoices + aging', async () => {
    const db = makeDb();
    const { customer } = await seedCustomer(db, {
      invoices: [
        { invoice_number: 'INV-PAID', issue_date: '2026-05-01', due_date: '2026-06-01', total_amd: 200000, status: 'sent', paid_amd: 200000 },
      ],
    });
    const out = await getCustomer360(db, customer.id, 0, { today: '2026-06-21' });
    assert.equal(out.open_invoices.length, 0, 'paid invoice should be excluded');
    assert.equal(out.totals.open_count, 0);
    assert.equal(out.totals.outstanding_amd, 0);
    // The recent_payments list should include the payment.
    assert.equal(out.recent_payments.length, 1);
    assert.equal(out.recent_payments[0].amount_amd, 200000);
    assert.equal(out.recent_payments[0].invoice_number, 'INV-PAID');
  });

  test('8. getCustomer360: partially-paid invoice (paid_amd=30k of 100k) shows balance_amd=70k in aging', async () => {
    const db = makeDb();
    const { customer } = await seedCustomer(db, {
      invoices: [
        { invoice_number: 'INV-PARTIAL', issue_date: '2026-04-01', due_date: '2026-05-21', total_amd: 100000, status: 'overdue', paid_amd: 30000 },
      ],
    });
    // due_date 2026-05-21 → 31 days overdue vs today 2026-06-21
    const out = await getCustomer360(db, customer.id, 0, { today: '2026-06-21' });
    assert.equal(out.open_invoices.length, 1);
    assert.equal(out.open_invoices[0].balance_amd, 70000);
    assert.equal(out.totals.paid_total_amd, 30000);
    assert.equal(out.totals.outstanding_amd, 70000);
    assert.equal(out.aging.days_31_60, 70000); // bucket holds balance, not total
  });

  test('9. getCustomer360: open_invoices sorted by due_date ASC (most urgent first)', async () => {
    const db = makeDb();
    const { customer } = await seedCustomer(db, {
      invoices: [
        { invoice_number: 'INV-LATER',   issue_date: '2026-06-01', due_date: '2026-08-01', total_amd: 100000 },
        { invoice_number: 'INV-URGENT',  issue_date: '2026-04-01', due_date: '2026-05-01', total_amd:  50000 },
        { invoice_number: 'INV-MIDDLE',  issue_date: '2026-05-01', due_date: '2026-07-01', total_amd:  75000 },
      ],
    });
    const out = await getCustomer360(db, customer.id, 0, { today: '2026-06-21' });
    const numbers = out.open_invoices.map((i) => i.invoice_number);
    assert.deepEqual(numbers, ['INV-URGENT', 'INV-MIDDLE', 'INV-LATER']);
  });

  test('10. getCustomer360: recent_payments sorted by paid_at DESC, capped at recentPaymentsLimit', async () => {
    const db = makeDb();
    // 3 paid invoices — all should be in recent_payments (capped
    // at 10 by default; the test limit is well below that).
    const { customer } = await seedCustomer(db, {
      invoices: [
        { invoice_number: 'A', issue_date: '2026-01-01', due_date: '2026-02-01', total_amd: 10000, status: 'sent', paid_amd: 10000 },
        { invoice_number: 'B', issue_date: '2026-02-01', due_date: '2026-03-01', total_amd: 20000, status: 'sent', paid_amd: 20000 },
        { invoice_number: 'C', issue_date: '2026-03-01', due_date: '2026-04-01', total_amd: 30000, status: 'sent', paid_amd: 30000 },
      ],
    });
    const out = await getCustomer360(db, customer.id, 0, { today: '2026-06-21', recentPaymentsLimit: 2 });
    assert.equal(out.recent_payments.length, 2, 'should be capped at recentPaymentsLimit');
    // All 3 payments happened at datetime('now') in close
    // succession; the test only asserts the limit is respected,
    // not the exact order (timestamps are noisy at sub-ms).
  });

  test('11. getCustomer360: invalid customerId throws ValueError', async () => {
    const db = makeDb();
    await assert.rejects(
      () => getCustomer360(db, 0, 0),
      /customerId must be a positive integer/,
    );
    await assert.rejects(
      () => getCustomer360(db, -1, 0),
      /customerId must be a positive integer/,
    );
  });

  test('12. getCustomer360: invalid tenantId throws ValueError', async () => {
    const db = makeDb();
    await assert.rejects(
      () => getCustomer360(db, 1, -1),
      /tenantId must be a non-negative integer/,
    );
  });
});
