// End-to-end integration tests for the finance module.
//
// Exercises the full boot → migrate → invoice → payment → reconcile flow
// against an in-memory mock DB. The mock DB exposes BOTH the pg-style
// surface (`db.query(sql, params)`) and the sqlite-style surface
// (`db.prepare(sql).run/.all` and `db.exec(sql)`) — the dual adapter is the
// point. By default the boot wiring dispatches to the pg branch via
// duck-type, but the mock is shaped so the sqlite path is reachable too.
//
// `createInvoice`, `recordPayment`, and `reconcileInvoice` are inlined here
// because `invoice.js` / `payment.js` live on parallel branches and are not
// importable from this worktree. Their SQL shape and status transitions
// mirror what the real modules will use, so the boot wiring + migration
// application are exercised end-to-end.
//
// TDD: this file lands in commit A (RED). `boot.js` does not exist yet on
// this branch, so the import errors and the suite reports a single failed
// file. Commit B adds the implementation.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ────────────────────────────────────────────────────────────────────────────
// Dual-adapter mock DB
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a mock DB that satisfies both pg-style and sqlite-style adapters.
 * Holds in-memory models of finance.customers, finance.invoices,
 * finance.payments, and finance.migration_history. Dispatches by regex on
 * the SQL so the tests don't need real Postgres or sqlite.
 *
 * The boot wiring picks pg-style (because `db.query` exists). The sqlite
 * branch is reachable by deleting `db.query` on a clone.
 */
function makeDualMock() {
  const customers = [];
  const invoices = [];
  const payments = [];
  const history = [];
  let nextCustomerId = 1;
  let nextInvoiceId = 1;
  let nextPaymentId = 1;
  let nextHistoryId = 1;
  const pgStatements = [];
  const sqliteLog = [];

  // Sync dispatch — returns `{ rows }` like pg, or `[]` like sqlite depending
  // on caller. Both surfaces reuse this so the in-memory model stays
  // consistent regardless of which adapter the runner picks.
  function dispatch(sql, params) {
    const t = sql.trim();

    // ── migration_history bookkeeping ───────────────────────────────────
    if (/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?finance\.migration_history/i.test(t)) {
      return { rows: [] };
    }
    if (/SELECT\s+name\s+FROM\s+finance\.migration_history/i.test(t)) {
      return { rows: history.map((h) => ({ name: h.name })) };
    }
    if (/INSERT\s+INTO\s+finance\.migration_history/i.test(t)) {
      const [name, appliedAt] = params ?? [];
      history.push({ id: nextHistoryId++, name, applied_at: appliedAt });
      return { rows: [] };
    }

    // ── customers ───────────────────────────────────────────────────────
    if (/INSERT\s+INTO\s+finance\.customers/i.test(t)) {
      const [name, hvhh = null, address = null] = params ?? [];
      const id = nextCustomerId++;
      customers.push({ id, name, hvhh, address });
      return { rows: [{ id }] };
    }

    // ── invoices ────────────────────────────────────────────────────────
    if (/INSERT\s+INTO\s+finance\.invoices/i.test(t)) {
      const [
        customer_id,
        invoice_number,
        issue_date,
        due_date,
        subtotal_amd,
        vat_amd,
        total_amd,
        status = 'draft',
        notes = null,
      ] = params ?? [];
      const id = nextInvoiceId++;
      invoices.push({
        id,
        customer_id,
        invoice_number,
        issue_date,
        due_date,
        subtotal_amd,
        vat_amd,
        total_amd,
        status,
        notes,
      });
      return { rows: [{ id }] };
    }
    if (/UPDATE\s+finance\.invoices\s+SET\s+status\s*=\s*\$1\s+WHERE\s+id\s*=\s*\$2/i.test(t)) {
      const [status, id] = params ?? [];
      const inv = invoices.find((i) => i.id === Number(id));
      if (inv) inv.status = status;
      return { rows: [] };
    }
    if (/SELECT[\s\S]+FROM\s+finance\.invoices\s+WHERE\s+id\s*=\s*\$1/i.test(t)) {
      const [id] = params ?? [];
      const inv = invoices.find((i) => i.id === Number(id));
      return { rows: inv ? [{ ...inv }] : [] };
    }

    // ── payments ────────────────────────────────────────────────────────
    if (/INSERT\s+INTO\s+finance\.payments/i.test(t)) {
      const [invoice_id, amount_amd, method = 'bank_transfer', reference = null] = params ?? [];
      const inv = invoices.find((i) => i.id === Number(invoice_id));
      if (!inv) {
        throw new Error(`invoice ${invoice_id} not found`);
      }
      if (inv.status === 'draft') {
        const err = new Error(`cannot record payment on draft invoice ${invoice_id}`);
        err.name = 'ValueError';
        throw err;
      }
      const id = nextPaymentId++;
      payments.push({ id, invoice_id, amount_amd, method, reference });
      return { rows: [{ id }] };
    }
    if (
      /SELECT[\s\S]+SUM\(amount_amd\)[\s\S]+FROM\s+finance\.payments\s+WHERE\s+invoice_id\s*=\s*\$1/i.test(
        t,
      )
    ) {
      const [invoice_id] = params ?? [];
      const total = payments
        .filter((p) => p.invoice_id === Number(invoice_id))
        .reduce((sum, p) => sum + Number(p.amount_amd), 0);
      // PG returns BIGINT as a string; preserve that for the inline helpers.
      return { rows: [{ total: total.toString() }] };
    }

    // Default: accept silently so CREATE TABLE / CREATE INDEX bodies work.
    return { rows: [] };
  }

  const db = {
    kind: 'dual',
    customers,
    invoices,
    payments,
    history,
    pgStatements,
    sqliteLog,

    async query(sql, params) {
      pgStatements.push(sql);
      return dispatch(sql, params ?? []);
    },

    prepare(sql) {
      // Mirror better-sqlite3's prepare(...).run/.all/.get surface.
      const stmt = {
        run(...params) {
          sqliteLog.push({ kind: 'run', sql, params });
          dispatch(sql, params);
          return undefined;
        },
        all(...params) {
          sqliteLog.push({ kind: 'all', sql, params });
          return dispatch(sql, params).rows;
        },
        get(...params) {
          sqliteLog.push({ kind: 'get', sql, params });
          const rows = dispatch(sql, params).rows;
          return rows[0] ?? undefined;
        },
      };
      return stmt;
    },

    exec(sql) {
      sqliteLog.push({ kind: 'exec', sql });
      // exec runs a multi-statement body without returning rows. The
      // migration runner only uses exec for CREATE TABLE migration_history,
      // which dispatch() already handles by returning `{ rows: [] }`.
    },
  };
  return db;
}

// ────────────────────────────────────────────────────────────────────────────
// Inline invoice / payment helpers
//
// Stand-ins for `server/finance/invoice.js` and `server/finance/payment.js`,
// which live on parallel branches. The SQL shape and status transitions
// here are intentionally minimal — the goal of these tests is to exercise
// the boot wiring + migration application end-to-end, not to re-test the
// invoice/payment logic (those tests live on the sibling branches).
// ────────────────────────────────────────────────────────────────────────────

async function createCustomer(db, { name, hvhh = null, address = null }) {
  const res = await db.query(
    'INSERT INTO finance.customers (name, hvhh, address) VALUES ($1, $2, $3) RETURNING id',
    [name, hvhh, address],
  );
  return res.rows[0].id;
}

async function createInvoice(
  db,
  {
    customerId,
    invoiceNumber,
    issueDate,
    dueDate,
    subtotalAmd,
    vatAmd = 0,
    totalAmd,
    notes = null,
  },
) {
  const res = await db.query(
    `INSERT INTO finance.invoices
       (customer_id, invoice_number, issue_date, due_date,
        subtotal_amd, vat_amd, total_amd, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [customerId, invoiceNumber, issueDate, dueDate, subtotalAmd, vatAmd, totalAmd, 'draft', notes],
  );
  return res.rows[0].id;
}

async function updateInvoiceStatus(db, invoiceId, status) {
  await db.query('UPDATE finance.invoices SET status = $1 WHERE id = $2', [status, invoiceId]);
}

async function recordPayment(
  db,
  { invoiceId, amountAmd, method = 'bank_transfer', reference = null },
) {
  await db.query(
    `INSERT INTO finance.payments (invoice_id, amount_amd, method, reference)
     VALUES ($1, $2, $3, $4)`,
    [invoiceId, amountAmd, method, reference],
  );
}

async function reconcileInvoice(db, invoiceId) {
  const invRes = await db.query(
    'SELECT id, total_amd, status FROM finance.invoices WHERE id = $1',
    [invoiceId],
  );
  if (invRes.rows.length === 0) {
    throw new Error(`invoice ${invoiceId} not found`);
  }
  const inv = invRes.rows[0];
  const totalRes = await db.query(
    'SELECT COALESCE(SUM(amount_amd), 0) AS total FROM finance.payments WHERE invoice_id = $1',
    [invoiceId],
  );
  const totalPaid = Number(totalRes.rows[0].total);
  const balanceAmd = Number(inv.total_amd) - totalPaid;
  let status = inv.status;
  if (totalPaid > 0 && balanceAmd <= 0 && Number(inv.total_amd) > 0) {
    status = 'paid';
  }
  if (status !== inv.status) {
    await updateInvoiceStatus(db, invoiceId, status);
  }
  return { status, balance_amd: balanceAmd };
}

// ────────────────────────────────────────────────────────────────────────────
// Scratch migrations dir helper
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a temp directory with one minimal migration file (0001_init.sql).
 * The mock doesn't validate SQL — only dispatches by pattern — so the body
 * is just representative DDL that the runner will apply.
 */
function makeTempMigrationsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'finance-int-'));
  const migDir = join(dir, 'migrations');
  mkdirSync(migDir, { recursive: true });
  writeFileSync(
    join(migDir, '0001_init.sql'),
    [
      'CREATE SCHEMA IF NOT EXISTS finance;',
      'CREATE TABLE finance.customers (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL);',
      'CREATE TABLE finance.invoices (id BIGSERIAL PRIMARY KEY, customer_id BIGINT, invoice_number TEXT, issue_date DATE, due_date DATE, subtotal_amd BIGINT, vat_amd BIGINT, total_amd BIGINT, status TEXT, notes TEXT);',
      'CREATE TABLE finance.payments (id BIGSERIAL PRIMARY KEY, invoice_id BIGINT, amount_amd BIGINT, method TEXT, reference TEXT);',
    ].join('\n'),
  );
  return { dir, migDir };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('bootFinance — wiring + invoice/payment integration', () => {
  test('1. full lifecycle: customer → boot → invoice(draft) → sent → paid', async () => {
    const { dir, migDir } = makeTempMigrationsDir();
    try {
      const { bootFinance } = await import('./boot.js');
      const db = makeDualMock();

      const customerId = await createCustomer(db, { name: 'Acme LLC' });

      // Boot applies the migration.
      const bootResult = await bootFinance(db, { migrationsDir: migDir });
      assert.deepEqual(bootResult.applied, ['0001_init.sql']);
      assert.equal(bootResult.version, 1);

      // Create invoice (status defaults to 'draft').
      const invoiceId = await createInvoice(db, {
        customerId,
        invoiceNumber: 'INV-2026-0001',
        issueDate: '2026-01-01',
        dueDate: '2026-01-31',
        subtotalAmd: 1000,
        totalAmd: 1000,
      });
      assert.equal(db.invoices[invoiceId - 1].status, 'draft');

      // Move to 'sent' so payments can be recorded.
      await updateInvoiceStatus(db, invoiceId, 'sent');

      // Record a single full payment.
      await recordPayment(db, { invoiceId, amountAmd: 1000 });

      // Reconcile → status='paid', balance=0.
      const recon = await reconcileInvoice(db, invoiceId);
      assert.equal(recon.status, 'paid');
      assert.equal(recon.balance_amd, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('2. partial payment: invoice stays at "sent"', async () => {
    const { dir, migDir } = makeTempMigrationsDir();
    try {
      const { bootFinance } = await import('./boot.js');
      const db = makeDualMock();
      const customerId = await createCustomer(db, { name: 'Beta Inc' });
      await bootFinance(db, { migrationsDir: migDir });

      const invoiceId = await createInvoice(db, {
        customerId,
        invoiceNumber: 'INV-2026-0002',
        issueDate: '2026-02-01',
        dueDate: '2026-02-28',
        subtotalAmd: 1000,
        totalAmd: 1000,
      });
      await updateInvoiceStatus(db, invoiceId, 'sent');
      await recordPayment(db, { invoiceId, amountAmd: 500 });

      const recon = await reconcileInvoice(db, invoiceId);
      assert.equal(recon.status, 'sent');
      assert.equal(recon.balance_amd, 500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('3. multi-payment reconciliation: 600 + 400 → paid, balance 0', async () => {
    const { dir, migDir } = makeTempMigrationsDir();
    try {
      const { bootFinance } = await import('./boot.js');
      const db = makeDualMock();
      const customerId = await createCustomer(db, { name: 'Gamma LLC' });
      await bootFinance(db, { migrationsDir: migDir });

      const invoiceId = await createInvoice(db, {
        customerId,
        invoiceNumber: 'INV-2026-0003',
        issueDate: '2026-03-01',
        dueDate: '2026-03-31',
        subtotalAmd: 1000,
        totalAmd: 1000,
      });
      await updateInvoiceStatus(db, invoiceId, 'sent');
      await recordPayment(db, { invoiceId, amountAmd: 600, reference: 'wire-A' });
      await recordPayment(db, { invoiceId, amountAmd: 400, reference: 'wire-B' });

      const recon = await reconcileInvoice(db, invoiceId);
      assert.equal(recon.status, 'paid');
      assert.equal(recon.balance_amd, 0);
      // Both payments recorded against this invoice.
      assert.equal(db.payments.length, 2);
      assert.equal(db.payments.filter((p) => p.invoice_id === invoiceId).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('4. overpayment: 1500 on 1000 invoice → paid, balance -500', async () => {
    const { dir, migDir } = makeTempMigrationsDir();
    try {
      const { bootFinance } = await import('./boot.js');
      const db = makeDualMock();
      const customerId = await createCustomer(db, { name: 'Delta OOO' });
      await bootFinance(db, { migrationsDir: migDir });

      const invoiceId = await createInvoice(db, {
        customerId,
        invoiceNumber: 'INV-2026-0004',
        issueDate: '2026-04-01',
        dueDate: '2026-04-30',
        subtotalAmd: 1000,
        totalAmd: 1000,
      });
      await updateInvoiceStatus(db, invoiceId, 'sent');
      await recordPayment(db, { invoiceId, amountAmd: 1500 });

      const recon = await reconcileInvoice(db, invoiceId);
      assert.equal(recon.status, 'paid');
      assert.equal(recon.balance_amd, -500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('5. payment rejected on draft invoice (ValueError)', async () => {
    const { dir, migDir } = makeTempMigrationsDir();
    try {
      const { bootFinance } = await import('./boot.js');
      const db = makeDualMock();
      const customerId = await createCustomer(db, { name: 'Epsilon CJSC' });
      await bootFinance(db, { migrationsDir: migDir });

      const invoiceId = await createInvoice(db, {
        customerId,
        invoiceNumber: 'INV-2026-0005',
        issueDate: '2026-05-01',
        dueDate: '2026-05-31',
        subtotalAmd: 500,
        totalAmd: 500,
      });
      // Invoice is still 'draft' — recording payment must fail.
      await assert.rejects(
        () => recordPayment(db, { invoiceId, amountAmd: 500 }),
        (err) => {
          assert.equal(err.name, 'ValueError');
          assert.match(err.message, /draft/i);
          return true;
        },
      );
      // No payment row was created.
      assert.equal(db.payments.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('6. boot is idempotent: first run applies 0001_init, second run is no-op', async () => {
    const { dir, migDir } = makeTempMigrationsDir();
    try {
      const { bootFinance } = await import('./boot.js');
      const db = makeDualMock();

      const first = await bootFinance(db, { migrationsDir: migDir });
      assert.deepEqual(first.applied, ['0001_init.sql']);
      assert.equal(first.version, 1);

      const second = await bootFinance(db, { migrationsDir: migDir });
      assert.deepEqual(second.applied, []);
      assert.equal(second.version, 0);

      // History table has exactly one entry — no duplicates from the second run.
      assert.equal(db.history.length, 1);
      assert.equal(db.history[0].name, '0001_init.sql');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('7. (dual-adapter sanity) mock exposes both pg and sqlite surfaces', () => {
    // The boot wiring dispatches by duck-type. The mock supports BOTH so the
    // adapter duality isn't lost when we wrap the runner in integration tests.
    const db = makeDualMock();
    assert.equal(typeof db.query, 'function', 'pg-style .query must be exposed');
    assert.equal(typeof db.prepare, 'function', 'sqlite-style .prepare must be exposed');
    assert.equal(typeof db.exec, 'function', 'sqlite-style .exec must be exposed');

    // Drive a SELECT through the sqlite path so the dual adapter is real, not
    // just decorative. Duck-type would pick pg because .query exists, so we
    // prove the sqlite branch by calling prepare().all() directly.
    db.history.push({ id: 1, name: '0001_init.sql', applied_at: '2026-01-01' });
    const stmt = db.prepare('SELECT name FROM finance.migration_history');
    const rows = stmt.all();
    assert.deepEqual(rows, [{ name: '0001_init.sql' }]);
  });
});
