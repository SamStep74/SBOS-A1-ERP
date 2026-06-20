// Tests for server/finance/dashboard.js — the server-rendered CFO
// dashboard. Verifies the HTML structure, the 5 report sections, the
// data flow-through, and HTML escaping for user-supplied fields.
//
// TDD: this file lands alongside the GREEN (dashboard.js). Both land
// in the same commit (the GREEN is small and the assertions guide the
// rendering choices).

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// ────────────────────────────────────────────────────────────────────────
// node:sqlite-backed Db (real DB) for end-to-end coverage of the
// dashboard's SQL aggregation paths. Mirrors the wave-5.1 realdb-smoke
// pattern: finance schema with the status-tracking columns from 0002.
// ────────────────────────────────────────────────────────────────────────

function makeRealDb() {
  const dir = mkdtempSync(join(tmpdir(), 'sbos-dash-'));
  const sqliteDb = new DatabaseSync(join(dir, 'finance.db'));
  sqliteDb.exec('ATTACH DATABASE ":memory:" AS finance');
  sqliteDb.exec('PRAGMA foreign_keys = OFF');
  sqliteDb.exec(`
    CREATE TABLE finance.customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, hvhh TEXT, address TEXT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
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
      tenant_id INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT, voided_at TEXT, void_reason TEXT
    );
    CREATE TABLE finance.invoice_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity REAL NOT NULL, unit_price_amd INTEGER NOT NULL,
      line_total_amd INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE finance.payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      paid_at TEXT NOT NULL DEFAULT (datetime('now')),
      amount_amd INTEGER NOT NULL, method TEXT NOT NULL DEFAULT 'bank_transfer',
      reference TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      tenant_id INTEGER NOT NULL DEFAULT 0
    );
  `);
  return sqliteDb;
}

// pg-style adapter (server.js uses $N; node:sqlite uses ?).
function makePgAdapter(sqliteDb) {
  return {
    async query(sql, params = []) {
      const translated = sql.replace(/\$\d+/g, '?').replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*/g, '');
      const stmt = sqliteDb.prepare(translated);
      return { rows: stmt.all(...(params || [])) };
    },
  };
}

// Seed helpers — concise.
async function seedCustomer(db, { name, hvhh = null }) {
  await db.query('INSERT INTO finance.customers (name, hvhh) VALUES ($1, $2)', [name, hvhh]);
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
    total_amd,
    vat_amd = 0,
    status = 'sent',
    sent_at = null,
  },
) {
  const subtotal = total_amd - vat_amd;
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
      subtotal,
      vat_amd,
      total_amd,
      status,
      null,
      sent_at || (status !== 'draft' ? '2026-06-01T00:00:00Z' : null),
      null,
      null,
    ],
  );
  const r = await db.query('SELECT MAX(id) AS id FROM finance.invoices');
  return Number(r.rows[0].id);
}
async function seedPayment(db, { invoice_id, amount_amd, paid_at = '2026-06-15T00:00:00Z' }) {
  await db.query(
    `INSERT INTO finance.payments (invoice_id, paid_at, amount_amd, method, reference)
     VALUES ($1, $2, $3, $4, $5)`,
    [invoice_id, paid_at, amount_amd, 'bank_transfer', null],
  );
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('CFO dashboard — server-rendered HTML view', () => {
  let db;
  let renderDashboard;
  let ValueError;
  let serveDashboard;

  before(async () => {
    const sqlite = makeRealDb();
    db = makePgAdapter(sqlite);
    const mod = await import('./dashboard.js');
    renderDashboard = mod.renderDashboard;
    serveDashboard = mod.serveDashboard;
    ValueError = mod.ValueError;
  });

  test('1. renderDashboard returns a complete HTML page with the as-of date in the title', async () => {
    const html = await renderDashboard(db, '2026-06-20');
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'must start with DOCTYPE');
    assert.ok(
      html.includes('<title>CFO Dashboard — 2026-06-20</title>'),
      'title must include asOfDate',
    );
    assert.ok(html.includes('As of 2026-06-20'), 'meta must include asOfDate');
    assert.ok(html.includes('<style>'), 'inline CSS must be present');
  });

  test('2. all 5 report sections are present', async () => {
    const html = await renderDashboard(db, '2026-06-20');
    assert.ok(/<h2>AR Aging<\/h2>/.test(html), 'AR Aging section');
    assert.ok(/<h2>Overdue Invoices/.test(html), 'Overdue section');
    assert.ok(/<h2>This Month's Revenue<\/h2>/.test(html), 'Monthly Revenue section');
    assert.ok(/<h2>Top Customers<\/h2>/.test(html), 'Top Customers section');
    assert.ok(/<h2>VAT Summary/.test(html), 'VAT Summary section');
  });

  test('3. AR aging renders the 4 buckets with counts and amounts', async () => {
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    const custId = await seedCustomer(freshDb, { name: 'ARTest', hvhh: '11111111' });
    // 4 invoices across the 4 buckets.
    await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'AR-0_30',
      issue_date: '2026-06-15',
      due_date: '2026-07-15',
      total_amd: 50000,
      status: 'sent',
    });
    await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'AR-31_60',
      issue_date: '2026-04-15',
      due_date: '2026-05-15',
      total_amd: 80000,
      status: 'sent',
    });
    await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'AR-61_90',
      issue_date: '2026-03-15',
      due_date: '2026-04-15',
      total_amd: 120000,
      status: 'sent',
    });
    await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'AR-90',
      issue_date: '2026-01-15',
      due_date: '2026-02-15',
      total_amd: 200000,
      status: 'sent',
    });
    const html = await renderDashboard(freshDb, '2026-06-20');
    assert.ok(/0–30 days[\s\S]+1 inv[\s\S]+50 000 AMD/.test(html), '0-30 bucket 1 inv 50k');
    assert.ok(/31–60 days[\s\S]+1 inv[\s\S]+80 000 AMD/.test(html), '31-60 bucket 1 inv 80k');
    assert.ok(/61–90 days[\s\S]+1 inv[\s\S]+120 000 AMD/.test(html), '61-90 bucket 1 inv 120k');
    assert.ok(/90\+ days[\s\S]+1 inv[\s\S]+200 000 AMD/.test(html), '90+ bucket 1 inv 200k');
    assert.ok(/Total[\s\S]+450 000 AMD/.test(html), 'total 450k');
  });

  test('4. overdue invoices render the invoice_number, customer_name, balance, and days_overdue', async () => {
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    const custId = await seedCustomer(freshDb, { name: 'Overdue Co' });
    await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'OD-1',
      issue_date: '2026-01-01',
      due_date: '2026-05-01',
      total_amd: 100000,
      status: 'sent',
    });
    const html = await renderDashboard(freshDb, '2026-06-20');
    assert.ok(html.includes('OD-1'), 'invoice number OD-1');
    assert.ok(html.includes('Overdue Co'), 'customer name');
    assert.ok(html.includes('100 000 AMD'), 'balance 100k');
    assert.ok(/<td class="num">50<\/td>/.test(html), 'days overdue 50');
  });

  test('5. monthly revenue shows invoiced/collected/outstanding + collection rate', async () => {
    // Fresh DB so the counts and totals are exactly what this test
    // inserts (no leakage from earlier tests in the suite).
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    const custId = await seedCustomer(freshDb, { name: 'Monthly Co' });
    const inv = await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'MONTH-1',
      issue_date: '2026-06-10',
      due_date: '2026-07-10',
      total_amd: 200000,
      vat_amd: 20000,
      status: 'sent',
    });
    await seedPayment(freshDb, { invoice_id: inv, amount_amd: 50000 });
    const html = await renderDashboard(freshDb, '2026-06-20');
    // Invoiced 200k, collected 50k, outstanding 150k, 1 invoice, 0 paid, 25% collection
    assert.ok(/<td class="num">200 000 AMD<\/td>/.test(html), 'invoiced 200k');
    assert.ok(/<td class="num">50 000 AMD<\/td>/.test(html), 'collected 50k');
    assert.ok(/<td class="num">150 000 AMD<\/td>/.test(html), 'outstanding 150k');
    assert.ok(/<td class="num">1<\/td>/.test(html), 'invoice count 1');
    assert.ok(/<td class="num">0<\/td>/.test(html), 'paid count 0');
    assert.ok(/25\.0%/.test(html), '25% collection rate');
  });

  test('6. top customers section renders customer_name, hvhh, billed, paid, invoice_count', async () => {
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    const custId = await seedCustomer(freshDb, { name: 'Big Customer LLC', hvhh: '99999999' });
    await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'TOP-1',
      issue_date: '2026-03-15',
      due_date: '2026-04-15',
      total_amd: 1000000,
      status: 'paid',
    });
    const html = await renderDashboard(freshDb, '2026-06-20');
    assert.ok(html.includes('Big Customer LLC'), 'customer name');
    assert.ok(html.includes('99999999'), 'hvhh');
    assert.ok(html.includes('1 000 000 AMD'), 'billed 1M');
  });

  test('7. empty DB renders the "no overdue" / "no customers" empty-state messages', async () => {
    // Fresh DB: no customers, no invoices, no payments.
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    const html = await renderDashboard(freshDb, '2026-06-20');
    assert.ok(/No overdue invoices/.test(html), 'overdue empty state');
    assert.ok(/No customers in the selected window/.test(html), 'top customers empty state');
    assert.ok(/0 inv/.test(html), 'AR aging zero counts');
    assert.ok(/Total[\s\S]+0 AMD/.test(html), 'AR aging zero total');
  });

  test('8. HTML escapes user-supplied fields (XSS protection)', async () => {
    // Inject script + HTML in the customer name. A vulnerable renderer
    // would emit the raw <script> tag into the page. Our renderer must
    // escape it. Use a fresh DB so we control the customer_id precisely.
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    const xssCustId = await seedCustomer(freshDb, { name: '<script>alert("xss")</script>' });
    await seedInvoice(freshDb, {
      customer_id: xssCustId,
      invoice_number: 'INV"><img src=x>',
      issue_date: '2026-05-01',
      due_date: '2026-05-15',
      total_amd: 10000,
      status: 'sent',
    });
    const html = await renderDashboard(freshDb, '2026-06-20');
    // The raw <script> must NOT appear — must be escaped to &lt;script&gt;
    assert.ok(!html.includes('<script>alert'), 'raw <script> tag must not be in HTML');
    assert.ok(html.includes('&lt;script&gt;alert'), 'script tag must be HTML-escaped');
    assert.ok(!html.includes('INV"><img'), 'raw invoice number with attributes must not appear');
    assert.ok(
      html.includes('INV&quot;&gt;&lt;img'),
      'invoice number with HTML chars must be escaped',
    );
  });

  test('9. rejects bad asOfDate format', async () => {
    await assert.rejects(() => renderDashboard(db, '2026/06/20'), /YYYY-MM-DD/);
    await assert.rejects(() => renderDashboard(db, '20-06-2026'), /YYYY-MM-DD/);
    await assert.rejects(() => renderDashboard(db, ''), /YYYY-MM-DD/);
    await assert.rejects(() => renderDashboard(db, 12345), /YYYY-MM-DD/);
    await assert.rejects(() => renderDashboard(db, null), /YYYY-MM-DD/);
  });

  test('10. opts.overdueLimit caps the overdue list at N entries', async () => {
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    const custId = await seedCustomer(freshDb, { name: 'Limit Co' });
    for (let i = 0; i < 5; i++) {
      await seedInvoice(freshDb, {
        customer_id: custId,
        invoice_number: `L-${i}`,
        issue_date: '2026-01-01',
        due_date: `2026-05-0${i + 1}`,
        total_amd: 10000,
        status: 'sent',
      });
    }
    const html = await renderDashboard(freshDb, '2026-06-20', { overdueLimit: 2 });
    const matches = html.match(/L-\d/g) || [];
    assert.ok(matches.length <= 2, `overdueLimit=2 must cap to 2 rows; got ${matches.length}`);
  });

  test('11. fmtAmd formats with space thousands separator + currency suffix', async () => {
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    const custId = await seedCustomer(freshDb, { name: 'Fmt Co' });
    await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'FMT-1',
      issue_date: '2026-06-15',
      due_date: '2026-07-15',
      total_amd: 1234567,
      status: 'sent',
    });
    const html = await renderDashboard(freshDb, '2026-06-20');
    assert.ok(html.includes('1 234 567 AMD'), 'AMD formatted with space separators');
  });

  test('12. serveDashboard binds to the configured port and serves the dashboard on GET /', async () => {
    // Pick a free port (0 = ask the OS).
    const server = await serveDashboard(db, { port: 0, host: '127.0.0.1' });
    try {
      const addr = server.address();
      const res = await fetch(`http://${addr.address}:${addr.port}/`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.startsWith('<!DOCTYPE html>'), 'served HTML');
      assert.ok(body.includes('CFO Dashboard'), 'served title');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('13. serveDashboard returns 404 for non-root paths', async () => {
    const server = await serveDashboard(db, { port: 0, host: '127.0.0.1' });
    try {
      const addr = server.address();
      const res = await fetch(`http://${addr.address}:${addr.port}/api/foo`);
      assert.equal(res.status, 404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // i18n: locale option, query-string routing, fallback to default.
  // ──────────────────────────────────────────────────────────────────────

  test('14. renderDashboard: opts.locale="hy" returns Armenian headings', async () => {
    const html = await renderDashboard(db, '2026-06-20', { locale: 'hy' });
    assert.ok(html.includes('<html lang="hy">'), 'html lang attr set to hy');
    assert.ok(html.includes('CFO Վահանակ'), 'title is Armenian');
    assert.ok(html.includes('Դեբիտորական պարտքերի ժամկետներ'), 'AR Aging section is Armenian');
    assert.ok(html.includes('ԱԱՀ ամփոփում'), 'VAT section is Armenian');
    assert.ok(html.includes('0–30 օր'), 'bucket label is Armenian');
  });

  test('15. renderDashboard: opts.locale="ru" returns Russian headings', async () => {
    const html = await renderDashboard(db, '2026-06-20', { locale: 'ru' });
    assert.ok(html.includes('<html lang="ru">'), 'html lang attr set to ru');
    assert.ok(html.includes('Панель CFO'), 'title is Russian');
    assert.ok(html.includes('Дебиторская задолженность по срокам'), 'AR Aging is Russian');
    assert.ok(html.includes('Сводка НДС'), 'VAT section is Russian');
    assert.ok(html.includes('0–30 дней'), 'bucket label is Russian');
  });

  test('16. renderDashboard: opts.locale defaults to "en" (no locale = English)', async () => {
    const html = await renderDashboard(db, '2026-06-20');
    assert.ok(html.includes('<html lang="en">'), 'html lang attr defaults to en');
    assert.ok(html.includes('CFO Dashboard'), 'title is English');
    assert.ok(html.includes('AR Aging'), 'AR Aging is English');
  });

  test('17. renderDashboard: unknown locale falls back to "en"', async () => {
    const html = await renderDashboard(db, '2026-06-20', { locale: 'fr' });
    assert.ok(html.includes('<html lang="en">'), 'unknown locale falls back to en');
    assert.ok(html.includes('CFO Dashboard'), 'headings are English');
  });

  test('18. renderDashboard: case-insensitive locale is normalized', async () => {
    const html = await renderDashboard(db, '2026-06-20', { locale: 'HY' });
    assert.ok(html.includes('<html lang="hy">'), 'HY normalizes to hy');
    assert.ok(html.includes('CFO Վահանակ'), 'headings are Armenian');
  });

  test('19. serveDashboard: ?lang=hy query returns Armenian dashboard', async () => {
    const server = await serveDashboard(db, { port: 0, host: '127.0.0.1' });
    try {
      const addr = server.address();
      const res = await fetch(`http://${addr.address}:${addr.port}/?lang=hy`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('<html lang="hy">'), 'served as Armenian');
      assert.ok(html.includes('CFO Վահանակ'), 'served title in Armenian');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('20. serveDashboard: ?lang=ru query returns Russian dashboard', async () => {
    const server = await serveDashboard(db, { port: 0, host: '127.0.0.1' });
    try {
      const addr = server.address();
      const res = await fetch(`http://${addr.address}:${addr.port}/?lang=ru`);
      const html = await res.text();
      assert.ok(html.includes('<html lang="ru">'), 'served as Russian');
      assert.ok(html.includes('Панель CFO'), 'served title in Russian');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('21. serveDashboard: ?lang=xx (unknown) falls back to en', async () => {
    const server = await serveDashboard(db, { port: 0, host: '127.0.0.1' });
    try {
      const addr = server.address();
      const res = await fetch(`http://${addr.address}:${addr.port}/?lang=xx`);
      const html = await res.text();
      assert.ok(html.includes('<html lang="en">'), 'unknown lang falls back to en');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('22. dashboard still escapes user-supplied data (XSS safety preserved)', async () => {
    const freshSqlite = makeRealDb();
    const freshDb = makePgAdapter(freshSqlite);
    const custId = await seedCustomer(freshDb, {
      name: '<script>alert(1)</script>',
      hvhh: '11111111',
    });
    await seedInvoice(freshDb, {
      customer_id: custId,
      invoice_number: 'XSS-1',
      issue_date: '2026-06-01',
      due_date: '2026-07-01',
      total_amd: 50000,
      status: 'sent',
    });
    const html = await renderDashboard(freshDb, '2026-06-20', { locale: 'hy' });
    // User data must be escaped even when serving in Armenian.
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must not appear');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'escaped form must appear');
  });
});
