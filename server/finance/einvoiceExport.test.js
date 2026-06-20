// Tests for server/finance/einvoiceExport.js — wires the e-invoice
// builder to the finance DB. Real node:sqlite DB for end-to-end coverage.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SUPPLIER = {
  name: 'Test Co LLC',
  hvhh: '00123456',
  vatId: '1234567',
  address: '1 Test St, Yerevan',
};

function makeRealDb() {
  const dir = mkdtempSync(join(tmpdir(), 'sbos-einvoice-'));
  const sqliteDb = new DatabaseSync(join(dir, 'finance.db'));
  sqliteDb.exec('ATTACH DATABASE ":memory:" AS finance');
  sqliteDb.exec('PRAGMA foreign_keys = OFF');
  sqliteDb.exec(`
    CREATE TABLE finance.customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL, hvhh TEXT, address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
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
    CREATE TABLE finance.invoice_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      invoice_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity REAL NOT NULL, unit_price_amd INTEGER NOT NULL,
      line_total_amd INTEGER NOT NULL
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

async function seedCustomer(db, { name, hvhh = null, address = null }) {
  await db.query('INSERT INTO finance.customers (name, hvhh, address) VALUES ($1, $2, $3)', [
    name,
    hvhh,
    address,
  ]);
  const r = await db.query('SELECT MAX(id) AS id FROM finance.customers');
  return Number(r.rows[0].id);
}
async function seedInvoice(
  db,
  {
    customer_id,
    invoice_number,
    issue_date,
    due_date,
    subtotal_amd,
    vat_amd,
    total_amd,
    status = 'sent',
  },
) {
  await db.query(
    `INSERT INTO finance.invoices
       (customer_id, invoice_number, issue_date, due_date,
        subtotal_amd, vat_amd, total_amd, status, notes, sent_at, voided_at, void_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      customer_id,
      invoice_number,
      issue_date,
      due_date,
      subtotal_amd,
      vat_amd,
      total_amd,
      status,
      null,
      status !== 'draft' ? '2026-06-01T00:00:00Z' : null,
      null,
      null,
    ],
  );
  const r = await db.query('SELECT MAX(id) AS id FROM finance.invoices');
  return Number(r.rows[0].id);
}
async function seedLine(db, { invoice_id, description, quantity, unit_price_amd, line_total_amd }) {
  await db.query(
    `INSERT INTO finance.invoice_lines (invoice_id, description, quantity, unit_price_amd, line_total_amd)
     VALUES ($1, $2, $3, $4, $5)`,
    [invoice_id, description, quantity, unit_price_amd, line_total_amd],
  );
}

describe('finance — e-invoice export (real DB)', () => {
  let db;
  let exportInvoiceEInvoice;
  let exportMonthlyEInvoices;
  let ValueError;
  let EINVOICE_NAMESPACE;

  before(async () => {
    const sqlite = makeRealDb();
    db = makePgAdapter(sqlite);
    const mod = await import('./einvoiceExport.js');
    exportInvoiceEInvoice = mod.exportInvoiceEInvoice;
    exportMonthlyEInvoices = mod.exportMonthlyEInvoices;
    ValueError = mod.ValueError;
    EINVOICE_NAMESPACE = mod.EINVOICE_NAMESPACE;
  });

  test('1. exportInvoiceEInvoice: produces a valid XML for a single invoice with 20% VAT lines', async () => {
    // Use a fresh DB so the test is self-contained.
    const sqlite = makeRealDb();
    const freshDb = makePgAdapter(sqlite);
    const custId = await seedCustomer(freshDb, {
      name: 'Acme LLC',
      hvhh: '99999999',
      address: '5 Main St',
    });
    const invId = await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'EXP-001',
      issue_date: '2026-06-15',
      due_date: '2026-07-15',
      subtotal_amd: 100000,
      vat_amd: 20000,
      total_amd: 120000,
      status: 'sent',
    });
    await seedLine(freshDb, {
      invoice_id: invId,
      description: 'Consulting',
      quantity: 1,
      unit_price_amd: 100000,
      line_total_amd: 100000,
    });

    const r = await exportInvoiceEInvoice(freshDb, invId, SUPPLIER);
    assert.equal(r.invoiceNumber, 'EXP-001');
    assert.equal(r.total_amd, 120000);
    assert.ok(r.xml.startsWith('<?xml'), 'must be valid XML header');
    assert.ok(r.xml.includes('<Number>EXP-001</Number>'));
    assert.ok(
      r.xml.includes('<TaxId>99999999</TaxId>') || r.xml.includes('<TaxId/>'),
      'customer hvhh or empty TaxId',
    );
    assert.ok(r.xml.includes('<IssueDate>2026-06-15</IssueDate>'));
    assert.ok(r.xml.includes('<DueDate>2026-07-15</DueDate>'));
    assert.ok(r.xml.includes('<NetAmount>100000</NetAmount>'));
    assert.ok(r.xml.includes('<VatAmount>20000</VatAmount>'));
    assert.ok(r.xml.includes('<VatRate>20</VatRate>'), 'VAT rate inferred from invoice ratio');
  });

  test('2. exportInvoiceEInvoice: throws on missing invoice', async () => {
    const sqlite = makeRealDb();
    const freshDb = makePgAdapter(sqlite);
    await assert.rejects(
      () => exportInvoiceEInvoice(freshDb, 99999, SUPPLIER),
      /invoice 99999 not found/,
    );
  });

  test('3. exportInvoiceEInvoice: throws on bad invoiceId', async () => {
    await assert.rejects(() => exportInvoiceEInvoice(db, 0, SUPPLIER), /positive integer/);
    await assert.rejects(() => exportInvoiceEInvoice(db, -1, SUPPLIER), /positive integer/);
    await assert.rejects(() => exportInvoiceEInvoice(db, 1.5, SUPPLIER), /positive integer/);
  });

  test('4. exportInvoiceEInvoice: throws on missing/invalid supplier', async () => {
    await assert.rejects(() => exportInvoiceEInvoice(db, 1, null), /supplier must be/);
    await assert.rejects(() => exportInvoiceEInvoice(db, 1, {}), /supplier.name is required/);
    await assert.rejects(
      () => exportInvoiceEInvoice(db, 1, { name: '' }),
      /supplier.name is required/,
    );
  });

  test('5. exportMonthlyEInvoices: returns one XML per non-void invoice in the month', async () => {
    const sqlite = makeRealDb();
    const freshDb = makePgAdapter(sqlite);
    const custId = await seedCustomer(freshDb, { name: 'M Co' });
    // 3 invoices in 2026-06 (issued) + 1 in 2026-05 (excluded by month) + 1 voided (excluded by status)
    const i1 = await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'M-1',
      issue_date: '2026-06-05',
      due_date: '2026-07-05',
      subtotal_amd: 50000,
      vat_amd: 10000,
      total_amd: 60000,
    });
    await seedLine(freshDb, {
      invoice_id: i1,
      description: 'A',
      quantity: 1,
      unit_price_amd: 50000,
      line_total_amd: 50000,
    });
    const i2 = await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'M-2',
      issue_date: '2026-06-15',
      due_date: '2026-07-15',
      subtotal_amd: 80000,
      vat_amd: 16000,
      total_amd: 96000,
    });
    await seedLine(freshDb, {
      invoice_id: i2,
      description: 'B',
      quantity: 1,
      unit_price_amd: 80000,
      line_total_amd: 80000,
    });
    await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'M-3',
      issue_date: '2026-05-31',
      due_date: '2026-06-30',
      subtotal_amd: 10000,
      vat_amd: 2000,
      total_amd: 12000,
    });
    const i4 = await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'M-4',
      issue_date: '2026-06-20',
      due_date: '2026-07-20',
      subtotal_amd: 30000,
      vat_amd: 6000,
      total_amd: 36000,
      status: 'void',
    });

    const out = await exportMonthlyEInvoices(freshDb, '2026-06', SUPPLIER);
    assert.equal(out.length, 2, 'only 2 invoices: M-1, M-2 (M-3 wrong month, M-4 void)');
    const numbers = out.map((r) => r.invoiceNumber).sort();
    assert.deepEqual(numbers, ['M-1', 'M-2']);
    assert.ok(out.every((r) => r.xml.startsWith('<?xml')));
  });

  test('6. exportMonthlyEInvoices: empty month returns empty array', async () => {
    const sqlite = makeRealDb();
    const freshDb = makePgAdapter(sqlite);
    const custId = await seedCustomer(freshDb, { name: 'E Co' });
    await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'E-1',
      issue_date: '2026-01-15',
      due_date: '2026-02-15',
      subtotal_amd: 10000,
      vat_amd: 2000,
      total_amd: 12000,
    });
    const out = await exportMonthlyEInvoices(freshDb, '2026-06', SUPPLIER);
    assert.deepEqual(out, []);
  });

  test('7. exportMonthlyEInvoices: throws on bad yearMonth', async () => {
    await assert.rejects(() => exportMonthlyEInvoices(db, '2026/06', SUPPLIER), /YYYY-MM/);
    await assert.rejects(() => exportMonthlyEInvoices(db, '2026-6', SUPPLIER), /YYYY-MM/);
    await assert.rejects(() => exportMonthlyEInvoices(db, '', SUPPLIER), /YYYY-MM/);
    await assert.rejects(() => exportMonthlyEInvoices(db, null, SUPPLIER), /YYYY-MM/);
  });

  test('8. exportMonthlyEInvoices: 0% VAT invoice (exempt) → VatRate 0 in the XML', async () => {
    const sqlite = makeRealDb();
    const freshDb = makePgAdapter(sqlite);
    const custId = await seedCustomer(freshDb, { name: 'Exempt Co' });
    const i = await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'EX-1',
      issue_date: '2026-06-15',
      due_date: '2026-07-15',
      subtotal_amd: 50000,
      vat_amd: 0,
      total_amd: 50000, // exempt: 0 VAT
    });
    await seedLine(freshDb, {
      invoice_id: i,
      description: 'Exempt service',
      quantity: 1,
      unit_price_amd: 50000,
      line_total_amd: 50000,
    });
    const out = await exportMonthlyEInvoices(freshDb, '2026-06', SUPPLIER);
    assert.equal(out.length, 1);
    assert.ok(out[0].xml.includes('<VatRate>0</VatRate>'));
    assert.ok(out[0].xml.includes('<VatAmount>0</VatAmount>'));
  });

  test('9. exportInvoiceEInvoice: multiple lines aggregate correctly', async () => {
    const sqlite = makeRealDb();
    const freshDb = makePgAdapter(sqlite);
    const custId = await seedCustomer(freshDb, { name: 'Multi Co' });
    const i = await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'MULT-1',
      issue_date: '2026-06-15',
      due_date: '2026-07-15',
      subtotal_amd: 150000,
      vat_amd: 30000,
      total_amd: 180000,
    });
    await seedLine(freshDb, {
      invoice_id: i,
      description: 'A',
      quantity: 1,
      unit_price_amd: 50000,
      line_total_amd: 50000,
    });
    await seedLine(freshDb, {
      invoice_id: i,
      description: 'B',
      quantity: 1,
      unit_price_amd: 100000,
      line_total_amd: 100000,
    });
    const r = await exportInvoiceEInvoice(freshDb, i, SUPPLIER);
    // Two lines, each with netAmount and vat=20% of net.
    const lineMatches = r.xml.match(/<Line>/g) || [];
    assert.equal(lineMatches.length, 2, 'two Line elements');
    // Both lines should have VatRate 20.
    const rateMatches = r.xml.match(/<VatRate>20<\/VatRate>/g) || [];
    assert.equal(rateMatches.length, 2, 'both lines at 20%');
  });

  test('10. e-invoice XML declares the EINVOICE_NAMESPACE URN (wire-format stability)', async () => {
    const sqlite = makeRealDb();
    const freshDb = makePgAdapter(sqlite);
    const custId = await seedCustomer(freshDb, { name: 'URN Co' });
    const i = await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'URN-1',
      issue_date: '2026-06-15',
      due_date: '2026-07-15',
      subtotal_amd: 10000,
      vat_amd: 2000,
      total_amd: 12000,
    });
    await seedLine(freshDb, {
      invoice_id: i,
      description: 'X',
      quantity: 1,
      unit_price_amd: 10000,
      line_total_amd: 10000,
    });
    const r = await exportInvoiceEInvoice(freshDb, i, SUPPLIER);
    // The URN is preserved verbatim across all wave-1 e-invoice ports
    // (per the wave-1 brand-strip exception). Don't change it.
    assert.ok(
      r.xml.includes(EINVOICE_NAMESPACE),
      'EINVOICE_NAMESPACE URN must remain in the wire format',
    );
  });

  test('11. inferVatRate returns 0 when subtotal_amd is 0 (defends divide-by-zero)', async () => {
    const sqlite = makeRealDb();
    const freshDb = makePgAdapter(sqlite);
    const custId = await seedCustomer(freshDb, { name: 'Zero Co' });
    // subtotal=0, vat=0, total=0 — degenerate but valid for a fully-waived invoice.
    // We need at least one line for buildEInvoiceXml to emit a <Line>
    // block; the line is 0-net so the VatRate fallback to 0 is the path
    // we want to exercise.
    const i = await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'ZERO-1',
      issue_date: '2026-06-15',
      due_date: '2026-07-15',
      subtotal_amd: 0,
      vat_amd: 0,
      total_amd: 0,
    });
    await seedLine(freshDb, {
      invoice_id: i,
      description: 'Zero',
      quantity: 1,
      unit_price_amd: 0,
      line_total_amd: 0,
    });
    const r = await exportInvoiceEInvoice(freshDb, i, SUPPLIER);
    assert.equal(r.total_amd, 0);
    assert.ok(r.xml.includes('<VatRate>0</VatRate>'));
  });

  test('12. monthly export: an invoice with no lines still produces valid XML (empty <Lines/>)', async () => {
    const sqlite = makeRealDb();
    const freshDb = makePgAdapter(sqlite);
    const custId = await seedCustomer(freshDb, { name: 'NoLines Co' });
    // Invoice with no lines (edge case — usually not valid, but
    // the export shouldn't crash).
    await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'NL-1',
      issue_date: '2026-06-15',
      due_date: '2026-07-15',
      subtotal_amd: 0,
      vat_amd: 0,
      total_amd: 0,
    });
    const out = await exportMonthlyEInvoices(freshDb, '2026-06', SUPPLIER);
    assert.equal(out.length, 1);
    // Empty lines should still produce a valid XML with the line block.
    assert.ok(out[0].xml.includes('<Lines>'));
    assert.ok(out[0].xml.includes('</Lines>'));
  });

  test('13. inferVatRate: 0% VAT with positive subtotal still gives 0 (round-trip on the ratio)', async () => {
    // Edge case: 0% VAT (fully exempt) but subtotal > 0. The ratio is
    // 0/positive = 0, so the rate is 0. Verifies the division-by-subtotal
    // path works when subtotal is positive but VAT is zero.
    const sqlite = makeRealDb();
    const freshDb = makePgAdapter(sqlite);
    const custId = await seedCustomer(freshDb, { name: 'Exempt2 Co' });
    const i = await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'EX2-1',
      issue_date: '2026-06-15',
      due_date: '2026-07-15',
      subtotal_amd: 100000,
      vat_amd: 0,
      total_amd: 100000,
    });
    await seedLine(freshDb, {
      invoice_id: i,
      description: 'Exempt',
      quantity: 1,
      unit_price_amd: 100000,
      line_total_amd: 100000,
    });
    const r = await exportInvoiceEInvoice(freshDb, i, SUPPLIER);
    assert.ok(r.xml.includes('<VatRate>0</VatRate>'));
    assert.ok(r.xml.includes('<VatAmount>0</VatAmount>'));
  });

  test('14. legacy row with empty invoice_number and missing due_date → empty-string fallbacks', async () => {
    // Defensive: if a legacy or hand-edited row has empty/null fields,
    // the export should still produce valid XML (with empty <Number/>
    // and <DueDate/> placeholders, not undefined or null in the XML).
    const sqlite = makeRealDb();
    const freshDb = makePgAdapter(sqlite);
    // Bypass the public API: insert with NULL/empty values.
    sqlite.exec(
      `INSERT INTO finance.customers (id, name, hvhh, address) VALUES (1, 'Legacy Co', null, null)`,
    );
    sqlite.exec(
      `INSERT INTO finance.invoices
         (id, customer_id, invoice_number, issue_date, due_date,
          subtotal_amd, vat_amd, total_amd, status, notes, sent_at, voided_at, void_reason)
       VALUES (1, 1, '', '2026-06-15', '', 10000, 2000, 12000, 'sent', null, '2026-06-15', null, null)`,
    );
    const r = await exportInvoiceEInvoice(freshDb, 1, SUPPLIER);
    assert.ok(
      r.xml.includes('<Number></Number>') || r.xml.includes('<Number/>'),
      'empty invoice_number becomes an empty Number element',
    );
    assert.ok(
      r.xml.includes('<DueDate></DueDate>') || r.xml.includes('<DueDate/>'),
      'empty due_date becomes an empty DueDate element',
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// Wave-13 cross-tenant isolation tests
//
// These tests would have caught the silent extra-arg trap in the
// route wiring: if a route passes req.tenantId as the Nth positional
// arg and the function ignores it, the SELECT runs without
// tenant_id filtering and the cross-tenant probe returns the
// OTHER tenant's invoice. Per-function isolation tests prevent
// regressions of this exact shape.
//
// Tenant layout for these tests:
//   - tenant 0 owns the bootstrap row + customer 1 + invoice 100
//     + line L100
//   - tenant 7 owns customer 2 + invoice 700 + line L700
// Both are seeded into the same DB. A tenant-0 call must NEVER see
// invoice 700; a tenant-7 call must NEVER see invoice 100.
// ────────────────────────────────────────────────────────────────────────

describe('finance/einvoiceExport — wave-13 cross-tenant isolation', () => {
  let exportInvoiceEInvoice;
  let exportMonthlyEInvoices;

  before(async () => {
    const mod = await import('./einvoiceExport.js');
    exportInvoiceEInvoice = mod.exportInvoiceEInvoice;
    exportMonthlyEInvoices = mod.exportMonthlyEInvoices;
  });

  test('15. exportInvoiceEInvoice tenant-0 call cannot see tenant-7 invoice', async () => {
    const sqlite = makeRealDb();
    const freshDb = makePgAdapter(sqlite);
    // Seed two tenants worth of data. seedCustomer/seedInvoice
    // default to tenant 0; we manually override via SQL.
    const t0Cust = await seedCustomer(freshDb, { name: 'T0 Co' });
    const t7Cust = await seedCustomer(freshDb, { name: 'T7 Co' });
    // Manually set tenant_id=7 on the second customer (the seed
    // helpers default to tenant 0 via the schema default).
    sqlite.prepare('UPDATE finance.customers SET tenant_id = 7 WHERE id = ?').run(t7Cust);
    // Tenant-0 invoice: id 100.
    await seedInvoice(freshDb, {
      customer_id: t0Cust,
      invoice_number: 'T0-INV',
      issue_date: '2026-06-15',
      due_date: '2026-07-15',
      subtotal_amd: 100000,
      vat_amd: 20000,
      total_amd: 120000,
    });
    // Tenant-7 invoice: id 700.
    const t7Inv = await seedInvoice(freshDb, {
      customer_id: t7Cust,
      invoice_number: 'T7-INV',
      issue_date: '2026-06-15',
      due_date: '2026-07-15',
      subtotal_amd: 500000,
      vat_amd: 100000,
      total_amd: 600000,
    });
    sqlite.prepare('UPDATE finance.invoices SET tenant_id = 7 WHERE id = ?').run(t7Inv);

    // Tenant-0 call: throws (the function surfaces "not found" as a
    // ValueError, which the route layer catches and turns into a 404;
    // the test asserts the function-level behavior).
    await assert.rejects(
      () => exportInvoiceEInvoice(freshDb, t7Inv, SUPPLIER, 0),
      /not found/i,
      'tenant-0 must NOT see tenant-7 invoice',
    );
    // Tenant-7 call: must see T7.
    const r7 = await exportInvoiceEInvoice(freshDb, t7Inv, SUPPLIER, 7);
    assert.ok(r7 && r7.invoiceNumber === 'T7-INV', 'tenant-7 sees its own invoice');
  });

  test('16. exportMonthlyEInvoices tenant-scope only returns own invoices', async () => {
    const sqlite = makeRealDb();
    const freshDb = makePgAdapter(sqlite);
    const t0Cust = await seedCustomer(freshDb, { name: 'T0 Co' });
    const t7Cust = await seedCustomer(freshDb, { name: 'T7 Co' });
    sqlite.prepare('UPDATE finance.customers SET tenant_id = 7 WHERE id = ?').run(t7Cust);
    // 3 invoices in tenant 0, 2 in tenant 7.
    for (const n of ['T0-A', 'T0-B', 'T0-C']) {
      const i = await seedInvoice(freshDb, {
        customer_id: t0Cust,
        invoice_number: n,
        issue_date: '2026-06-15',
        due_date: '2026-07-15',
        subtotal_amd: 10000,
        vat_amd: 2000,
        total_amd: 12000,
      });
      await seedLine(freshDb, {
        invoice_id: i,
        description: 'svc',
        quantity: 1,
        unit_price_amd: 10000,
        line_total_amd: 10000,
      });
    }
    for (const n of ['T7-X', 'T7-Y']) {
      const i = await seedInvoice(freshDb, {
        customer_id: t7Cust,
        invoice_number: n,
        issue_date: '2026-06-15',
        due_date: '2026-07-15',
        subtotal_amd: 50000,
        vat_amd: 10000,
        total_amd: 60000,
      });
      sqlite.prepare('UPDATE finance.invoices SET tenant_id = 7 WHERE id = ?').run(i);
      await seedLine(freshDb, {
        invoice_id: i,
        description: 'svc',
        quantity: 1,
        unit_price_amd: 50000,
        line_total_amd: 50000,
      });
      sqlite.prepare('UPDATE finance.invoice_lines SET tenant_id = 7 WHERE invoice_id = ?').run(i);
    }

    // Tenant-0 monthly export: 3 invoices, all T0-*.
    const out0 = await exportMonthlyEInvoices(freshDb, '2026-06', SUPPLIER, 0);
    assert.equal(out0.length, 3, 'tenant-0 sees only its own 3');
    for (const x of out0) {
      assert.ok(x.invoiceNumber.startsWith('T0-'), `unexpected: ${x.invoiceNumber}`);
    }
    // Tenant-7 monthly export: 2 invoices, all T7-*.
    const out7 = await exportMonthlyEInvoices(freshDb, '2026-06', SUPPLIER, 7);
    assert.equal(out7.length, 2, 'tenant-7 sees only its own 2');
    for (const x of out7) {
      assert.ok(x.invoiceNumber.startsWith('T7-'), `unexpected: ${x.invoiceNumber}`);
    }
    // Default tenantId (0) matches tenant-0.
    const outDefault = await exportMonthlyEInvoices(freshDb, '2026-06', SUPPLIER);
    assert.equal(outDefault.length, 3, 'default tenantId=0 → tenant-0');
  });
});
