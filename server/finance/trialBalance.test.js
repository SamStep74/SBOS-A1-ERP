// Tests for the trial balance report (server/finance/trialBalance.js).
// Verifies the join with the COA, the natural-sign projection, and
// the balanced/footed totals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { renderTrialBalance, formatTrialBalanceText } from './trialBalance.js';
import { postJournalEntry } from './journal.js';

// ────────────────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────────────────

function makeMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      entry_date TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id INTEGER, description TEXT,
      currency TEXT NOT NULL DEFAULT 'AMD',
      status TEXT NOT NULL DEFAULT 'posted',
      book_date TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER
    );
    CREATE TABLE journal_entry_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      entry_id INTEGER NOT NULL,
      line_order INTEGER NOT NULL DEFAULT 0,
      account_code TEXT NOT NULL,
      debit INTEGER NOT NULL DEFAULT 0,
      credit INTEGER NOT NULL DEFAULT 0,
      description TEXT
    );
  `);
  return {
    async query(sql, params = []) {
      const translated = sql.replace(/\$\d+/g, '?');
      const stmt = db.prepare(translated);
      const upper = translated.trim().toUpperCase();
      if (upper.startsWith('SELECT') || upper.includes(' RETURNING')) {
        return { rows: stmt.all(...(params || [])) };
      }
      const info = stmt.run(...(params || []));
      return { rows: [], lastInsertRowid: info.lastInsertRowid };
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// renderTrialBalance
// ────────────────────────────────────────────────────────────────────────

test('renderTrialBalance: empty DB → empty accounts, 0 totals, balanced', async () => {
  const db = makeMemoryDb();
  const report = await renderTrialBalance(db, 0);
  assert.equal(report.tenant_id, 0);
  assert.equal(report.accounts.length, 0);
  assert.equal(report.total_debit, 0);
  assert.equal(report.total_credit, 0);
  assert.equal(report.is_balanced, true);
  assert.equal(report.delta, 0);
  assert.equal(report.account_count, 0);
});

test('renderTrialBalance: a single balanced entry → report is balanced', async () => {
  const db = makeMemoryDb();
  // Receive 5 @ 100 = 500. Dr 216 / Cr 521.
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'stock.receive',
      source_id: 1,
      lines: [
        { account_code: '216', debit: 500, credit: 0 },
        { account_code: '521', debit: 0, credit: 500 },
      ],
    },
    0,
  );
  const report = await renderTrialBalance(db, 0);
  assert.equal(report.accounts.length, 2);
  // 216 is asset (debit-natural) → debit 500.
  const inv = report.accounts.find((r) => r.code === '216');
  assert.equal(inv.natural_sign, 'debit');
  assert.equal(inv.debit, 500);
  assert.equal(inv.credit, 0);
  assert.equal(inv.class, 2);
  assert.equal(inv.type, 'asset');
  // 521 is liability (credit-natural) → credit 500.
  const ap = report.accounts.find((r) => r.code === '521');
  assert.equal(ap.natural_sign, 'credit');
  assert.equal(ap.debit, 0);
  assert.equal(ap.credit, 500);
  assert.equal(ap.class, 5);
  assert.equal(ap.type, 'liability');
  // The books balance.
  assert.equal(report.total_debit, 500);
  assert.equal(report.total_credit, 500);
  assert.equal(report.is_balanced, true);
});

test('renderTrialBalance: a complex flow (receive + deliver + bill) is balanced', async () => {
  const db = makeMemoryDb();
  // Receive 10 @ 500 = 5000. Dr 216 / Cr 521.
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'stock.receive',
      source_id: 1,
      lines: [
        { account_code: '216', debit: 5000, credit: 0 },
        { account_code: '521', debit: 0, credit: 5000 },
      ],
    },
    0,
  );
  // Deliver 3 @ 500 = 1500. Dr 711 / Cr 216.
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-22',
      source: 'stock.deliver',
      source_id: 1,
      lines: [
        { account_code: '711', debit: 1500, credit: 0 },
        { account_code: '216', debit: 0, credit: 1500 },
      ],
    },
    0,
  );
  // Bill with VAT. Dr 226 (VAT input) / Cr 521 (AP) — VAT 1000.
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-23',
      source: 'vendor_bill.post',
      source_id: 1,
      lines: [
        { account_code: '226', debit: 1000, credit: 0 },
        { account_code: '521', debit: 0, credit: 1000 },
      ],
    },
    0,
  );
  const report = await renderTrialBalance(db, 0);
  // 4 accounts touched.
  assert.equal(report.accounts.length, 4);
  // 711 is expense → debit 1500.
  const cogs = report.accounts.find((r) => r.code === '711');
  assert.equal(cogs.natural_sign, 'debit');
  assert.equal(cogs.debit, 1500);
  // 216 net = 5000 - 1500 = 3500 → debit 3500.
  const inv = report.accounts.find((r) => r.code === '216');
  assert.equal(inv.debit, 3500);
  // 521 net = 5000 + 1000 = 6000 → credit 6000.
  const ap = report.accounts.find((r) => r.code === '521');
  assert.equal(ap.credit, 6000);
  // 226 is asset (debit-natural, class 2) → debit 1000.
  const vat = report.accounts.find((r) => r.code === '226');
  assert.equal(vat.natural_sign, 'debit');
  assert.equal(vat.debit, 1000);
  // Total debits: 1500 + 3500 + 1000 = 6000. Total credits: 6000. Balanced.
  assert.equal(report.total_debit, 6000);
  assert.equal(report.total_credit, 6000);
  assert.equal(report.is_balanced, true);
});

test('renderTrialBalance: an out-of-balance journal is flagged is_balanced=false', async () => {
  const db = makeMemoryDb();
  // Try to post an unbalanced entry — postJournalEntry will throw
  // (the journal module validates the invariant). So this test
  // is a bit synthetic: we manually insert an unbalanced row.
  // Insert header.
  const hdr = db._raw || null;
  // The harness doesn't expose _raw. Use the adapter's query method
  // to insert directly.
  await db.query(
    `INSERT INTO journal_entries (tenant_id, entry_date, source, source_id, description, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'posted')`,
    [0, '2026-06-21', 'manual', null, 'test', 'AMD'],
  );
  const lastId = await db.query('SELECT LAST_INSERT_ROWID() AS id', []);
  const entryId = Number(lastId.rows[0].id);
  // Two lines that DON'T balance: 600 debit, 500 credit.
  await db.query(
    `INSERT INTO journal_entry_lines (tenant_id, entry_id, line_order, account_code, debit, credit, description)
     VALUES ($1, $2, 0, '216', 600, 0, 'inv')`,
    [0, entryId],
  );
  await db.query(
    `INSERT INTO journal_entry_lines (tenant_id, entry_id, line_order, account_code, debit, credit, description)
     VALUES ($1, $2, 1, '521', 0, 500, 'ap')`,
    [0, entryId],
  );
  const report = await renderTrialBalance(db, 0);
  assert.equal(report.total_debit, 600);
  assert.equal(report.total_credit, 500);
  assert.equal(report.is_balanced, false);
  assert.equal(report.delta, 100);
});

test('renderTrialBalance: an unknown / off-chart account falls back to debit-natural', async () => {
  const db = makeMemoryDb();
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'manual',
      lines: [
        { account_code: '999', debit: 100, credit: 0 },
        { account_code: '521', debit: 0, credit: 100 },
      ],
    },
    0,
  );
  const report = await renderTrialBalance(db, 0);
  const off = report.accounts.find((r) => r.code === '999');
  assert.equal(off.natural_sign, 'unknown');
  // Conservative default: net_debit is shown in the debit column.
  assert.equal(off.debit, 100);
  assert.equal(off.credit, 0);
});

test('renderTrialBalance: cross-tenant isolation (tenant 0 cannot see tenant 7)', async () => {
  const db = makeMemoryDb();
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'manual',
      lines: [
        { account_code: '216', debit: 100, credit: 0 },
        { account_code: '521', debit: 0, credit: 100 },
      ],
    },
    0,
  );
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'manual',
      lines: [
        { account_code: '216', debit: 200, credit: 0 },
        { account_code: '521', debit: 0, credit: 200 },
      ],
    },
    7,
  );
  const t0 = await renderTrialBalance(db, 0);
  const t7 = await renderTrialBalance(db, 7);
  assert.equal(t0.total_debit, 100);
  assert.equal(t0.total_credit, 100);
  assert.equal(t7.total_debit, 200);
  assert.equal(t7.total_credit, 200);
});

test('renderTrialBalance: rows are sorted by account code (chart order)', async () => {
  const db = makeMemoryDb();
  // Insert in reverse chart order.
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'manual',
      lines: [
        { account_code: '711', debit: 100, credit: 0 },
        { account_code: '216', debit: 100, credit: 0 },
        { account_code: '521', debit: 0, credit: 200 },
      ],
    },
    0,
  );
  const report = await renderTrialBalance(db, 0);
  const codes = report.accounts.map((r) => r.code);
  assert.deepEqual(codes, ['216', '521', '711']);
});

// ────────────────────────────────────────────────────────────────────────
// formatTrialBalanceText
// ────────────────────────────────────────────────────────────────────────

test('formatTrialBalanceText: Armenian header + Armenian labels + balanced footer', async () => {
  const db = makeMemoryDb();
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'manual',
      lines: [
        { account_code: '216', debit: 500, credit: 0 },
        { account_code: '521', debit: 0, credit: 500 },
      ],
    },
    0,
  );
  const report = await renderTrialBalance(db, 0);
  const text = formatTrialBalanceText(report, 'hy');
  // Armenian title.
  assert.match(text, /[Ա-Ֆ]/);
  // Armenian label for account 216 (Ապdelays).
  assert.match(text, /Ապ/);
  // BALANCED indicator.
  assert.match(text, /BALANCED/);
  // Code 216 appears in the report.
  assert.match(text, /216/);
});

test('formatTrialBalanceText: English header + English labels + OUT OF BALANCE on a broken report', async () => {
  const db = makeMemoryDb();
  // Synthetic unbalanced entry via direct inserts (see test above).
  await db.query(
    `INSERT INTO journal_entries (tenant_id, entry_date, source, source_id, description, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'posted')`,
    [0, '2026-06-21', 'manual', null, 'test', 'AMD'],
  );
  const lastId = await db.query('SELECT LAST_INSERT_ROWID() AS id', []);
  const entryId = Number(lastId.rows[0].id);
  await db.query(
    `INSERT INTO journal_entry_lines (tenant_id, entry_id, line_order, account_code, debit, credit, description)
     VALUES ($1, $2, 0, '216', 600, 0, 'inv')`,
    [0, entryId],
  );
  await db.query(
    `INSERT INTO journal_entry_lines (tenant_id, entry_id, line_order, account_code, debit, credit, description)
     VALUES ($1, $2, 1, '521', 0, 500, 'ap')`,
    [0, entryId],
  );
  const report = await renderTrialBalance(db, 0);
  const text = formatTrialBalanceText(report, 'en');
  assert.match(text, /Trial Balance/);
  assert.match(text, /OUT OF BALANCE/);
  // Footer shows the totals (600 debit, 500 credit).
  assert.match(text, /600/);
  assert.match(text, /500/);
});

test('formatTrialBalanceText: rejects a malformed report', () => {
  assert.throws(() => formatTrialBalanceText(null), /report must be/);
  assert.throws(() => formatTrialBalanceText({}), /accounts\[\]/);
});
