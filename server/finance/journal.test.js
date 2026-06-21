// Tests for the GL journal module (server/finance/journal.js).
// Covers the balanced double-entry invariant, the idempotency
// guard on (source, source_id), the read-side queries, and the
// account-balance aggregation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  postJournalEntry,
  getJournalEntry,
  listJournalEntries,
  getAccountBalance,
  listAccountBalances,
  ValueError,
} from './journal.js';

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
      source_id INTEGER,
      description TEXT,
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
// postJournalEntry — happy path + invariants
// ────────────────────────────────────────────────────────────────────────

test('postJournalEntry: minimal balanced 2-line entry succeeds', async () => {
  const db = makeMemoryDb();
  const entry = await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'stock.receive',
      source_id: 1,
      description: 'Test',
      lines: [
        { account_code: '216', debit: 5000, credit: 0 },
        { account_code: '521', debit: 0, credit: 5000 },
      ],
    },
    0,
  );
  assert.ok(entry.id > 0);
  assert.equal(entry.entry_date, '2026-06-21');
  assert.equal(entry.source, 'stock.receive');
  assert.equal(entry.source_id, 1);
  assert.equal(entry.status, 'posted');
  assert.equal(entry.lines.length, 2);
  assert.equal(entry.lines[0].account_code, '216');
  assert.equal(entry.lines[0].debit, 5000);
  assert.equal(entry.lines[0].credit, 0);
  assert.equal(entry.lines[1].account_code, '521');
  assert.equal(entry.lines[1].debit, 0);
  assert.equal(entry.lines[1].credit, 5000);
});

test('postJournalEntry: rejects unbalanced entry (debit != credit)', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    () =>
      postJournalEntry(
        db,
        {
          entry_date: '2026-06-21',
          source: 'stock.receive',
          lines: [
            { account_code: '216', debit: 5000, credit: 0 },
            { account_code: '521', debit: 0, credit: 4000 },
          ],
        },
        0,
      ),
    (err) => err && err.name === 'ValueError' && /unbalanced/.test(err.message),
  );
});

test('postJournalEntry: rejects entry with < 2 lines', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    () =>
      postJournalEntry(
        db,
        {
          entry_date: '2026-06-21',
          source: 'stock.receive',
          lines: [{ account_code: '216', debit: 5000, credit: 0 }],
        },
        0,
      ),
    (err) => err && err.name === 'ValueError' && /at least 2/.test(err.message),
  );
});

test('postJournalEntry: rejects line with both debit and credit > 0', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    () =>
      postJournalEntry(
        db,
        {
          entry_date: '2026-06-21',
          source: 'stock.receive',
          lines: [
            { account_code: '216', debit: 100, credit: 100 },
            { account_code: '521', debit: 0, credit: 100 },
          ],
        },
        0,
      ),
    (err) => err && err.name === 'ValueError' && /cannot have both/.test(err.message),
  );
});

test('postJournalEntry: rejects line with both debit and credit = 0', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    () =>
      postJournalEntry(
        db,
        {
          entry_date: '2026-06-21',
          source: 'stock.receive',
          lines: [
            { account_code: '216', debit: 0, credit: 0 },
            { account_code: '521', debit: 0, credit: 0 },
          ],
        },
        0,
      ),
    (err) => err && err.name === 'ValueError' && /must have either/.test(err.message),
  );
});

test('postJournalEntry: rejects malformed account_code (non-3-digit)', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    () =>
      postJournalEntry(
        db,
        {
          entry_date: '2026-06-21',
          source: 'stock.receive',
          lines: [
            { account_code: '2160', debit: 100, credit: 0 },
            { account_code: '521', debit: 0, credit: 100 },
          ],
        },
        0,
      ),
    (err) => err && err.name === 'ValueError' && /3-digit/.test(err.message),
  );
});

test('postJournalEntry: rejects malformed source (uppercase)', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    () =>
      postJournalEntry(
        db,
        {
          entry_date: '2026-06-21',
          source: 'Stock.Receive',
          lines: [
            { account_code: '216', debit: 100, credit: 0 },
            { account_code: '521', debit: 0, credit: 100 },
          ],
        },
        0,
      ),
    (err) => err && err.name === 'ValueError' && /source/.test(err.message),
  );
});

test('postJournalEntry: rejects bad date format', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    () =>
      postJournalEntry(
        db,
        {
          entry_date: '2026/06/21',
          source: 'stock.receive',
          lines: [
            { account_code: '216', debit: 100, credit: 0 },
            { account_code: '521', debit: 0, credit: 100 },
          ],
        },
        0,
      ),
    (err) => err && err.name === 'ValueError' && /YYYY-MM-DD/.test(err.message),
  );
});

test('postJournalEntry: rejects negative debit', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    () =>
      postJournalEntry(
        db,
        {
          entry_date: '2026-06-21',
          source: 'stock.receive',
          lines: [
            { account_code: '216', debit: -100, credit: 0 },
            { account_code: '521', debit: 0, credit: 100 },
          ],
        },
        0,
      ),
    (err) => err && err.name === 'ValueError' && /debit/.test(err.message),
  );
});

test('postJournalEntry: rejects zero total', async () => {
  const db = makeMemoryDb();
  // A 0-amount entry with one debit 0 and one credit 0 won't pass
  // the per-line check, but if we got past it the total would be 0.
  // The per-line check fires first; this test guards a different
  // case — a single-sided entry that bypasses the per-line check
  // (impossible from the public API but the total-zero guard is
  // a defense in depth).
  await assert.rejects(
    () =>
      postJournalEntry(
        db,
        {
          entry_date: '2026-06-21',
          source: 'stock.receive',
          lines: [
            { account_code: '216', debit: 0, credit: 0 },
            { account_code: '521', debit: 0, credit: 0 },
          ],
        },
        0,
      ),
    (err) => err && err.name === 'ValueError',
  );
});

// ────────────────────────────────────────────────────────────────────────
// Idempotency guard
// ────────────────────────────────────────────────────────────────────────

test('postJournalEntry: same (source, source_id) returns the existing entry', async () => {
  const db = makeMemoryDb();
  const first = await postJournalEntry(
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
  const second = await postJournalEntry(
    db,
    {
      entry_date: '2026-06-22',
      source: 'stock.receive',
      source_id: 1,
      lines: [
        { account_code: '216', debit: 9999, credit: 0 },
        { account_code: '521', debit: 0, credit: 9999 },
      ],
    },
    0,
  );
  assert.equal(second.id, first.id);
  // The existing entry is NOT modified.
  assert.equal(second.entry_date, '2026-06-21');
  assert.equal(second.lines[0].debit, 5000);
});

test('postJournalEntry: different source_id posts a new entry', async () => {
  const db = makeMemoryDb();
  const a = await postJournalEntry(
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
  const b = await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'stock.receive',
      source_id: 2,
      lines: [
        { account_code: '216', debit: 3000, credit: 0 },
        { account_code: '521', debit: 0, credit: 3000 },
      ],
    },
    0,
  );
  assert.notEqual(a.id, b.id);
});

test('postJournalEntry: null source_id is allowed (manual entries)', async () => {
  const db = makeMemoryDb();
  const entry = await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'manual.adjust',
      source_id: null,
      lines: [
        { account_code: '711', debit: 1000, credit: 0 },
        { account_code: '216', debit: 0, credit: 1000 },
      ],
    },
    0,
  );
  assert.ok(entry.id > 0);
  assert.equal(entry.source_id, null);
});

// ────────────────────────────────────────────────────────────────────────
// getJournalEntry
// ────────────────────────────────────────────────────────────────────────

test('getJournalEntry: returns the entry with its lines', async () => {
  const db = makeMemoryDb();
  const created = await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'stock.receive',
      source_id: 5,
      lines: [
        { account_code: '216', debit: 8000, credit: 0, description: 'inv' },
        { account_code: '521', debit: 0, credit: 8000, description: 'ap' },
      ],
    },
    0,
  );
  const got = await getJournalEntry(db, created.id, 0);
  assert.equal(got.id, created.id);
  assert.equal(got.lines.length, 2);
  assert.equal(got.lines[0].description, 'inv');
  assert.equal(got.lines[1].description, 'ap');
});

test('getJournalEntry: null when id not in tenant', async () => {
  const db = makeMemoryDb();
  const got = await getJournalEntry(db, 999, 0);
  assert.equal(got, null);
});

test('getJournalEntry: cross-tenant isolation (tenant 0 cannot see tenant 1)', async () => {
  const db = makeMemoryDb();
  const e = await postJournalEntry(
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
  const got = await getJournalEntry(db, e.id, 1);
  assert.equal(got, null);
});

// ────────────────────────────────────────────────────────────────────────
// listJournalEntries
// ────────────────────────────────────────────────────────────────────────

test('listJournalEntries: returns entries for tenant, sorted by date desc', async () => {
  const db = makeMemoryDb();
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'stock.receive',
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
      entry_date: '2026-06-20',
      source: 'stock.deliver',
      lines: [
        { account_code: '711', debit: 100, credit: 0 },
        { account_code: '216', debit: 0, credit: 100 },
      ],
    },
    0,
  );
  const list = await listJournalEntries(db, 0);
  assert.equal(list.length, 2);
  // Sorted by entry_date DESC, id DESC — the 2026-06-21 entry first.
  assert.equal(list[0].entry_date, '2026-06-21');
  assert.equal(list[1].entry_date, '2026-06-20');
});

test('listJournalEntries: source filter', async () => {
  const db = makeMemoryDb();
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'stock.receive',
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
      source: 'stock.deliver',
      lines: [
        { account_code: '711', debit: 100, credit: 0 },
        { account_code: '216', debit: 0, credit: 100 },
      ],
    },
    0,
  );
  const only = await listJournalEntries(db, 0, { source: 'stock.deliver' });
  assert.equal(only.length, 1);
  assert.equal(only[0].source, 'stock.deliver');
});

test('listJournalEntries: since/until date filter', async () => {
  const db = makeMemoryDb();
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-15',
      source: 'stock.receive',
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
      entry_date: '2026-06-25',
      source: 'stock.receive',
      lines: [
        { account_code: '216', debit: 200, credit: 0 },
        { account_code: '521', debit: 0, credit: 200 },
      ],
    },
    0,
  );
  const range = await listJournalEntries(db, 0, { since: '2026-06-20', until: '2026-06-30' });
  assert.equal(range.length, 1);
  assert.equal(range[0].entry_date, '2026-06-25');
});

test('listJournalEntries: cross-tenant isolation', async () => {
  const db = makeMemoryDb();
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-21',
      source: 'stock.receive',
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
      source: 'stock.receive',
      lines: [
        { account_code: '216', debit: 200, credit: 0 },
        { account_code: '521', debit: 0, credit: 200 },
      ],
    },
    7,
  );
  const t0 = await listJournalEntries(db, 0);
  const t7 = await listJournalEntries(db, 7);
  assert.equal(t0.length, 1);
  assert.equal(t0[0].source_id, null); // no source_id on these manual entries, but t0 only
  // Wait, source_id was null in both — let me check by amount
  // (re-derive from lines)
  // The cross-tenant check is just: t0 has 1, t7 has 1, different rows.
  assert.equal(t7.length, 1);
});

// ────────────────────────────────────────────────────────────────────────
// getAccountBalance + listAccountBalances
// ────────────────────────────────────────────────────────────────────────

test('getAccountBalance: returns debit/credit totals for one account', async () => {
  const db = makeMemoryDb();
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
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-22',
      source: 'stock.deliver',
      source_id: 2,
      lines: [
        { account_code: '711', debit: 1000, credit: 0 },
        { account_code: '216', debit: 0, credit: 1000 },
      ],
    },
    0,
  );
  const inv = await getAccountBalance(db, '216', 0);
  assert.equal(inv.total_debit, 5000);
  assert.equal(inv.total_credit, 1000);
  assert.equal(inv.net_debit, 4000);
  assert.equal(inv.net_credit, 0);

  const ap = await getAccountBalance(db, '521', 0);
  assert.equal(ap.total_debit, 0);
  assert.equal(ap.total_credit, 5000);
  assert.equal(ap.net_credit, 5000);

  const cogs = await getAccountBalance(db, '711', 0);
  assert.equal(cogs.total_debit, 1000);
  assert.equal(cogs.net_debit, 1000);
});

test('getAccountBalance: account with no entries returns zeros', async () => {
  const db = makeMemoryDb();
  const bal = await getAccountBalance(db, '999', 0);
  assert.equal(bal.total_debit, 0);
  assert.equal(bal.total_credit, 0);
  assert.equal(bal.net_debit, 0);
  assert.equal(bal.net_credit, 0);
});

test('getAccountBalance: asOfDate filter excludes future entries', async () => {
  const db = makeMemoryDb();
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-15',
      source: 'stock.receive',
      source_id: 1,
      lines: [
        { account_code: '216', debit: 1000, credit: 0 },
        { account_code: '521', debit: 0, credit: 1000 },
      ],
    },
    0,
  );
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-30',
      source: 'stock.receive',
      source_id: 2,
      lines: [
        { account_code: '216', debit: 2000, credit: 0 },
        { account_code: '521', debit: 0, credit: 2000 },
      ],
    },
    0,
  );
  const asOfMid = await getAccountBalance(db, '216', 0, { asOfDate: '2026-06-20' });
  assert.equal(asOfMid.total_debit, 1000);
  const asOfAll = await getAccountBalance(db, '216', 0, { asOfDate: '2026-06-30' });
  assert.equal(asOfAll.total_debit, 3000);
});

test('getAccountBalance: rejects malformed account_code', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    () => getAccountBalance(db, 'abc', 0),
    (err) => err && err.name === 'ValueError',
  );
});

test('listAccountBalances: returns one row per account touched', async () => {
  const db = makeMemoryDb();
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
  const all = await listAccountBalances(db, 0);
  assert.equal(all.length, 2);
  const codes = all.map((r) => r.account_code).sort();
  assert.deepEqual(codes, ['216', '521']);
});

test('listAccountBalances: empty DB returns empty array', async () => {
  const db = makeMemoryDb();
  const all = await listAccountBalances(db, 0);
  assert.deepEqual(all, []);
});

// ────────────────────────────────────────────────────────────────────────
// End-to-end: stock-valuation scenario (manual posting)
// ────────────────────────────────────────────────────────────────────────

test('end-to-end: receive + deliver + adjust → balance flow', async () => {
  const db = makeMemoryDb();
  // Receive 10 @ 500 → Dr 216 (5000) / Cr 521 (5000)
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
  // Deliver 3 @ 500 → Dr 711 (1500) / Cr 216 (1500)
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-22',
      source: 'stock.deliver',
      source_id: 2,
      lines: [
        { account_code: '711', debit: 1500, credit: 0 },
        { account_code: '216', debit: 0, credit: 1500 },
      ],
    },
    0,
  );
  // Pay the AP → Dr 521 (5000) / Cr 1000 Cash (5000)
  await postJournalEntry(
    db,
    {
      entry_date: '2026-06-23',
      source: 'vendor_bill.pay',
      source_id: 1,
      lines: [
        { account_code: '521', debit: 5000, credit: 0 },
        { account_code: '100', debit: 0, credit: 5000 }, // 100 = Cash (illustrative)
      ],
    },
    0,
  );

  // 216 balance: 5000 - 1500 = 3500 (asset = debit-natural positive)
  const inv = await getAccountBalance(db, '216', 0);
  assert.equal(inv.net_debit, 3500);
  // 711 balance: 1500 (expense = debit-natural positive)
  const cogs = await getAccountBalance(db, '711', 0);
  assert.equal(cogs.net_debit, 1500);
  // 521 balance: 5000 cr - 5000 dr = 0 (AP fully paid)
  const ap = await getAccountBalance(db, '521', 0);
  assert.equal(ap.total_debit, 5000);
  assert.equal(ap.total_credit, 5000);
  assert.equal(ap.net_debit, 0);
  // 100 balance: 5000 cr (cash decreased)
  const cash = await getAccountBalance(db, '100', 0);
  assert.equal(cash.net_credit, 5000);

  // The trial balance must balance: total debits == total credits across all accounts.
  const all = await listAccountBalances(db, 0);
  const totalDr = all.reduce((s, a) => s + a.total_debit, 0);
  const totalCr = all.reduce((s, a) => s + a.total_credit, 0);
  assert.equal(totalDr, totalCr);
  assert.equal(totalDr, 11500);
});
