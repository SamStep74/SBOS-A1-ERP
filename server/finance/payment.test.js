// Tests for the finance payment recording + reconciliation module.
//
// Like server/finance/migrate.test.js, all tests use in-memory mock DBs so we
// don't need a real Postgres or sqlite. We exercise both driver branches
// (pg-style `db.query(sql, params)` and better-sqlite3-style `db.exec` /
// `db.prepare`) by swapping the mock per test.
//
// The mocks model three tables: finance.customers, finance.invoices,
// finance.payments. They track every SQL statement issued by the production
// adapter and pattern-match each query into a model-mutating handler so the
// test can assert on the post-state of the mock "DB".
//
// TDD: this file lands in commit A (RED). The payment.js module is a stub
// that throws NotImplementedError on every export. Tests are expected to
// fail until commit B introduces the real implementation.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// ────────────────────────────────────────────────────────────────────────────
// In-memory mock DBs
// ────────────────────────────────────────────────────────────────────────────

/**
 * Tiny SQL classifier used by both mocks: returns a tag describing what kind
 * of statement this is, so the handler can dispatch to the right model
 * mutation. Matching is loose-by-design (case-insensitive, whitespace-tolerant)
 * because the production adapter writes hand-rolled SQL with consistent
 * shape but not strict formatting.
 */
function classifySql(sql) {
  const t = sql.trim();
  if (/^SELECT\s+/i.test(t)) {
    if (/FROM\s+finance\.payments/i.test(t) && /SUM\s*\(\s*amount_amd\s*\)/i.test(t)) {
      return 'select-sum-payments';
    }
    if (/FROM\s+finance\.invoices/i.test(t)) return 'select-invoice';
    if (/FROM\s+finance\.payments/i.test(t)) return 'select-payments';
  }
  if (/^INSERT\s+INTO\s+finance\.payments/i.test(t)) return 'insert-payment';
  if (/^UPDATE\s+finance\.invoices\s+SET\s+status/i.test(t)) return 'update-invoice-status';
  return 'passthrough';
}

function newCounters() {
  return { customer: 0, invoice: 0, payment: 0 };
}

function newTables() {
  return {
    customers: new Map(),
    invoices: new Map(),
    payments: new Map(),
  };
}

/**
 * Build a pg-style mock DB. Pattern-matches every `db.query(sql, params)`
 * call and updates an in-memory model so tests can assert on it.
 */
function makePgMock() {
  const tables = newTables();
  const counters = newCounters();
  const statements = [];

  const db = {
    kind: 'pg',
    tables,
    counters,
    statements,
    async query(sql, params = []) {
      statements.push({ sql, params });
      const tag = classifySql(sql);
      switch (tag) {
        case 'select-sum-payments': {
          const [invoiceId] = params;
          let sum = 0;
          for (const p of tables.payments.values()) {
            if (p.invoice_id === invoiceId) sum += Number(p.amount_amd);
          }
          return { rows: [{ paid_amd: sum }] };
        }
        case 'select-invoice': {
          // SELECT id, customer_id, total_amd, status FROM finance.invoices WHERE id = $1
          const [id] = params;
          const inv = tables.invoices.get(Number(id));
          if (!inv) return { rows: [] };
          // Project to the columns the caller asked for, but return the whole row
          // so tests that read `.status` / `.total_amd` still work.
          return { rows: [{ ...inv }] };
        }
        case 'select-payments': {
          const [invoiceId] = params;
          const rows = [...tables.payments.values()]
            .filter((p) => p.invoice_id === Number(invoiceId))
            .sort((a, b) => {
              if (a.paid_at < b.paid_at) return -1;
              if (a.paid_at > b.paid_at) return 1;
              return a.id - b.id;
            })
            .map((p) => ({ ...p }));
          return { rows };
        }
        case 'insert-payment': {
          // INSERT INTO finance.payments (invoice_id, paid_at, amount_amd, method, reference)
          // VALUES ($1, $2, $3, $4, $5) RETURNING *
          const [invoice_id, paid_at, amount_amd, method, reference] = params;
          counters.payment += 1;
          const row = {
            id: counters.payment,
            invoice_id: Number(invoice_id),
            paid_at,
            amount_amd: Number(amount_amd),
            method,
            reference: reference ?? null,
            created_at: new Date().toISOString(),
          };
          tables.payments.set(row.id, row);
          return { rows: [{ ...row }] };
        }
        case 'update-invoice-status': {
          // UPDATE finance.invoices SET status = $1, updated_at = $2 WHERE id = $3
          const [status, updated_at, id] = params;
          const inv = tables.invoices.get(Number(id));
          if (!inv) return { rows: [] };
          inv.status = status;
          inv.updated_at = updated_at;
          tables.invoices.set(inv.id, inv);
          return { rows: [] };
        }
        default:
          return { rows: [] };
      }
    },
  };
  return db;
}

/**
 * Build a sqlite-style mock DB. Same model as the pg mock but routes through
 * `db.exec(sql)`, `db.prepare(sql).run(...params)` (for INSERT/UPDATE),
 * `db.prepare(sql).all()` (for SELECT).
 *
 * Because better-sqlite3 has no RETURNING clause, INSERTs return no rows
 * from `.run()` — the adapter must follow up with a SELECT to fetch the
 * inserted row. Our model returns the row from `.run()` via a side channel
 * (`_lastInserted`) that the production adapter is not expected to use;
 * the tests can use it directly to verify the insert landed.
 */
function makeSqliteMock() {
  const tables = newTables();
  const counters = newCounters();
  const statements = [];

  const db = {
    kind: 'sqlite',
    tables,
    counters,
    statements,
    _lastInserted: null,
    exec(sql) {
      statements.push({ sql, via: 'exec' });
      // exec is used for multi-statement DDL — none of our production SQL uses it.
      return undefined;
    },
    prepare(sql) {
      statements.push({ sql, via: 'prepare' });
      const tag = classifySql(sql);
      const stmt = {
        run(...params) {
          if (tag === 'insert-payment') {
            const [invoice_id, paid_at, amount_amd, method, reference] = params;
            counters.payment += 1;
            const row = {
              id: counters.payment,
              invoice_id: Number(invoice_id),
              paid_at,
              amount_amd: Number(amount_amd),
              method,
              reference: reference ?? null,
              created_at: new Date().toISOString(),
            };
            tables.payments.set(row.id, row);
            db._lastInserted = row;
            return { changes: 1, lastInsertRowid: row.id };
          }
          if (tag === 'update-invoice-status') {
            const [status, updated_at, id] = params;
            const inv = tables.invoices.get(Number(id));
            if (inv) {
              inv.status = status;
              inv.updated_at = updated_at;
              tables.invoices.set(inv.id, inv);
            }
            return { changes: inv ? 1 : 0 };
          }
          return { changes: 0 };
        },
        all(...params) {
          if (tag === 'select-sum-payments') {
            const [invoiceId] = params;
            let sum = 0;
            for (const p of tables.payments.values()) {
              if (p.invoice_id === invoiceId) sum += Number(p.amount_amd);
            }
            return [{ paid_amd: sum }];
          }
          if (tag === 'select-invoice') {
            const [id] = params;
            const inv = tables.invoices.get(Number(id));
            return inv ? [{ ...inv }] : [];
          }
          if (tag === 'select-payments') {
            const [invoiceId] = params;
            return [...tables.payments.values()]
              .filter((p) => p.invoice_id === Number(invoiceId))
              .sort((a, b) => {
                if (a.paid_at < b.paid_at) return -1;
                if (a.paid_at > b.paid_at) return 1;
                return a.id - b.id;
              })
              .map((p) => ({ ...p }));
          }
          return [];
        },
        get(...params) {
          // Used for SELECT ... LIMIT 1 or single-row reads if the adapter needs it.
          const rows = stmt.all(...params);
          return rows[0] ?? undefined;
        },
      };
      return stmt;
    },
  };
  return db;
}

// ────────────────────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────────────────────

function seedInvoice(db, overrides = {}) {
  const id = (db.counters.invoice += 1);
  const invoice = {
    id,
    customer_id: 1,
    invoice_number: `INV-TEST-${id}`,
    issue_date: '2026-01-01',
    due_date: '2026-01-31',
    subtotal_amd: 100_000,
    vat_amd: 20_000,
    total_amd: 120_000,
    status: 'sent',
    notes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  db.tables.invoices.set(id, invoice);
  return invoice;
}

function seedPayment(db, overrides = {}) {
  const id = (db.counters.payment += 1);
  const payment = {
    id,
    invoice_id: 1,
    paid_at: '2026-01-15T10:00:00.000Z',
    amount_amd: 10_000,
    method: 'bank_transfer',
    reference: null,
    created_at: '2026-01-15T10:00:00.000Z',
    ...overrides,
  };
  db.tables.payments.set(id, payment);
  return payment;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests — recordPayment
// ────────────────────────────────────────────────────────────────────────────

describe('recordPayment — happy path (pg mock)', () => {
  test('1. partial payment against sent invoice: returns payment, status stays sent', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { total_amd: 120_000, status: 'sent' });
    const { recordPayment } = await import('./payment.js');
    const result = await recordPayment(db, { invoice_id: invoice.id, amount_amd: 50_000 });
    assert.equal(result.amount_amd, 50_000);
    assert.equal(result.invoice_id, invoice.id);
    assert.equal(result.method, 'bank_transfer'); // default
    assert.equal(db.tables.invoices.get(invoice.id).status, 'sent');
  });

  test('2. full payment: status auto-transitions sent → paid', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { total_amd: 120_000, status: 'sent' });
    const { recordPayment } = await import('./payment.js');
    const result = await recordPayment(db, { invoice_id: invoice.id, amount_amd: 120_000 });
    assert.equal(result.amount_amd, 120_000);
    assert.equal(db.tables.invoices.get(invoice.id).status, 'paid');
  });

  test('3. overpayment: allowed, status = paid, balance_amd < 0', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { total_amd: 120_000, status: 'sent' });
    const { recordPayment, reconcileInvoice } = await import('./payment.js');
    await recordPayment(db, { invoice_id: invoice.id, amount_amd: 150_000 });
    const recon = await reconcileInvoice(db, invoice.id);
    assert.equal(recon.balance_amd, -30_000);
    assert.equal(recon.status, 'paid');
  });
});

describe('recordPayment — validation (pg mock)', () => {
  test('4. record against draft invoice: ValueError', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { status: 'draft' });
    const { recordPayment } = await import('./payment.js');
    await assert.rejects(
      () => recordPayment(db, { invoice_id: invoice.id, amount_amd: 10_000 }),
      (err) => {
        assert.equal(err.name, 'ValueError');
        assert.match(err.message, /draft/i);
        return true;
      },
    );
  });

  test('5. record against void invoice: ValueError', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { status: 'void' });
    const { recordPayment } = await import('./payment.js');
    await assert.rejects(
      () => recordPayment(db, { invoice_id: invoice.id, amount_amd: 10_000 }),
      (err) => {
        assert.equal(err.name, 'ValueError');
        assert.match(err.message, /void/i);
        return true;
      },
    );
  });

  test('6. record against fully-paid invoice (balance_amd = 0): ValueError', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { total_amd: 120_000, status: 'paid' });
    // Pre-seed a payment that already covers the total so reconcile shows balance=0.
    seedPayment(db, { invoice_id: invoice.id, amount_amd: 120_000 });
    const { recordPayment } = await import('./payment.js');
    await assert.rejects(
      () => recordPayment(db, { invoice_id: invoice.id, amount_amd: 1 }),
      (err) => {
        assert.equal(err.name, 'ValueError');
        return true;
      },
    );
  });

  test('7. amount_amd = 0: ValueError', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { total_amd: 120_000, status: 'sent' });
    const { recordPayment } = await import('./payment.js');
    await assert.rejects(
      () => recordPayment(db, { invoice_id: invoice.id, amount_amd: 0 }),
      (err) => {
        assert.equal(err.name, 'ValueError');
        assert.match(err.message, /amount/i);
        return true;
      },
    );
  });

  test('8. amount_amd < 0: ValueError', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { total_amd: 120_000, status: 'sent' });
    const { recordPayment } = await import('./payment.js');
    await assert.rejects(
      () => recordPayment(db, { invoice_id: invoice.id, amount_amd: -100 }),
      (err) => {
        assert.equal(err.name, 'ValueError');
        return true;
      },
    );
  });

  test('8b. unknown invoice_id: ValueError (FK violation surfaced as ValueError)', async () => {
    const db = makePgMock();
    const { recordPayment } = await import('./payment.js');
    await assert.rejects(
      () => recordPayment(db, { invoice_id: 9_999_999, amount_amd: 100 }),
      (err) => {
        assert.equal(err.name, 'ValueError');
        return true;
      },
    );
  });

  test('8c. invalid method: ValueError', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { total_amd: 120_000, status: 'sent' });
    const { recordPayment } = await import('./payment.js');
    await assert.rejects(
      () => recordPayment(db, { invoice_id: invoice.id, amount_amd: 10_000, method: 'bitcoin' }),
      (err) => {
        assert.equal(err.name, 'ValueError');
        assert.match(err.message, /method/i);
        return true;
      },
    );
  });

  test('8d. overdue invoice: payments allowed, status auto-transitions to paid', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { total_amd: 120_000, status: 'overdue' });
    const { recordPayment } = await import('./payment.js');
    await recordPayment(db, { invoice_id: invoice.id, amount_amd: 120_000 });
    assert.equal(db.tables.invoices.get(invoice.id).status, 'paid');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Tests — listPaymentsForInvoice
// ────────────────────────────────────────────────────────────────────────────

describe('listPaymentsForInvoice (pg mock)', () => {
  test('9. returns [] for a fresh invoice, then N rows after N records', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { total_amd: 120_000, status: 'sent' });
    const { listPaymentsForInvoice, recordPayment } = await import('./payment.js');
    assert.deepEqual(await listPaymentsForInvoice(db, invoice.id), []);
    await recordPayment(db, { invoice_id: invoice.id, amount_amd: 30_000, paid_at: '2026-02-01T00:00:00.000Z' });
    await recordPayment(db, { invoice_id: invoice.id, amount_amd: 50_000, paid_at: '2026-02-10T00:00:00.000Z' });
    const rows = await listPaymentsForInvoice(db, invoice.id);
    assert.equal(rows.length, 2);
    // Order is paid_at ASC.
    assert.equal(rows[0].amount_amd, 30_000);
    assert.equal(rows[1].amount_amd, 50_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Tests — reconcileInvoice
// ────────────────────────────────────────────────────────────────────────────

describe('reconcileInvoice (pg mock)', () => {
  test('10. fully paid invoice: status=paid, balance_amd=0', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { total_amd: 120_000, status: 'sent' });
    seedPayment(db, { invoice_id: invoice.id, amount_amd: 120_000 });
    const { reconcileInvoice } = await import('./payment.js');
    const recon = await reconcileInvoice(db, invoice.id);
    assert.equal(recon.total_amd, 120_000);
    assert.equal(recon.paid_amd, 120_000);
    assert.equal(recon.balance_amd, 0);
    assert.equal(recon.status, 'sent'); // reconcile reads current invoice status, doesn't transition
  });

  test('11. partially paid invoice: status=sent, balance_amd > 0', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { total_amd: 120_000, status: 'sent' });
    seedPayment(db, { invoice_id: invoice.id, amount_amd: 40_000 });
    const { reconcileInvoice } = await import('./payment.js');
    const recon = await reconcileInvoice(db, invoice.id);
    assert.equal(recon.total_amd, 120_000);
    assert.equal(recon.paid_amd, 40_000);
    assert.equal(recon.balance_amd, 80_000);
    assert.equal(recon.status, 'sent');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Tests — replay / duplicate payment (cumulative sums, not idempotency keys)
// ────────────────────────────────────────────────────────────────────────────

describe('replay / duplicate payment (pg mock)', () => {
  test('12. duplicate payment: cumulative sums still produce a sensible reconcile', async () => {
    const db = makePgMock();
    const invoice = seedInvoice(db, { total_amd: 120_000, status: 'sent' });
    seedPayment(db, { invoice_id: invoice.id, amount_amd: 50_000, paid_at: '2026-02-01T00:00:00.000Z' });
    // Simulate a retry that double-inserts the same logical payment (the spec
    // documents this as a known limitation: cumulative sums, no idempotency
    // keys). The reconciliation should still return *a* total — but it will
    // be wrong, which is the point of the documentation.
    seedPayment(db, { invoice_id: invoice.id, amount_amd: 50_000, paid_at: '2026-02-01T00:00:00.000Z' });
    const { reconcileInvoice } = await import('./payment.js');
    const recon = await reconcileInvoice(db, invoice.id);
    assert.equal(recon.total_amd, 120_000);
    // The duplicate doubled the recorded paid amount: 100,000 instead of 50,000.
    assert.equal(recon.paid_amd, 100_000);
    assert.equal(recon.balance_amd, 20_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Tests — sqlite dispatch
// ────────────────────────────────────────────────────────────────────────────

describe('sqlite dispatch (smoke)', () => {
  test('13. recordPayment works end-to-end against a better-sqlite3-shaped mock', async () => {
    const db = makeSqliteMock();
    seedInvoice(db, { total_amd: 100_000, status: 'sent' });
    const { recordPayment, listPaymentsForInvoice, reconcileInvoice } = await import(
      './payment.js'
    );
    const p = await recordPayment(db, { invoice_id: 1, amount_amd: 100_000 });
    assert.equal(p.amount_amd, 100_000);
    const rows = await listPaymentsForInvoice(db, 1);
    assert.equal(rows.length, 1);
    const recon = await reconcileInvoice(db, 1);
    assert.equal(recon.balance_amd, 0);
    assert.equal(recon.status, 'paid');
  });
});
