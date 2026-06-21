-- 0010_journal.sql
-- The general-ledger journal: every stock-valuation event
-- (receive / deliver / adjust) and every vendor-bill post writes
-- a balanced journal entry. The journal table stores the entry
-- header; the lines table stores the per-account Dr/Cr split.
--
-- Why a new table pair instead of reusing an existing one:
--   The finance module has invoice + payment + VAT tables, but
--   none of them is a journal — they record transaction-level
--   evidence (who / what / when) but not the GL postings
--   (which account moved, debit vs credit). The journal is the
--   bridge between the inventory + purchase modules and the
--   Armenian chart of accounts (216 Ապdelays / 711 COGS / 521 AP).
--
-- Schema notes:
--   - tenant_id BIGINT NOT NULL DEFAULT 0 (multi-tenant kernel)
--   - entry_date YYYY-MM-DD (the financial date; the book_date
--     defaults to now() and is the audit wall-clock)
--   - source TEXT (e.g. 'stock.receive', 'stock.deliver',
--     'stock.adjust', 'vendor_bill.post') — used by the
--     `listJournalEntries` filter
--   - source_id INTEGER — the id of the source row (stock_move.id
--     or vendor_bill.id), for cross-referencing
--   - currency TEXT DEFAULT 'AMD' — currently AMD-only; the
--     field is here so a future multi-currency tenant can switch
--     without a schema migration
--   - status TEXT (posted / reversed) — only 'posted' in this
--     migration; reversing an entry is a future operation
--   - lines.debit / lines.credit INTEGER (whole drams, no floats)
--   - UNIQUE (tenant_id, source, source_id) — a stock move posts
--     exactly one journal entry. The unique constraint is the
--     idempotency guard: re-running the posting for the same
--     move_id is a no-op (the INSERT fails, the wrapping code
--     catches and moves on).

CREATE TABLE IF NOT EXISTS finance.journal_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  entry_date      TEXT NOT NULL,                -- YYYY-MM-DD (financial date)
  source          TEXT NOT NULL,                -- 'stock.receive' | 'stock.deliver' | ...
  source_id       INTEGER,                      -- the source row id (nullable for manual)
  description     TEXT,
  currency        TEXT NOT NULL DEFAULT 'AMD',
  status          TEXT NOT NULL DEFAULT 'posted',  -- 'posted' | 'reversed'
  book_date       TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_tenant_source
  ON finance.journal_entries (tenant_id, source, source_id);

CREATE INDEX IF NOT EXISTS idx_journal_entries_tenant_date
  ON finance.journal_entries (tenant_id, entry_date);

CREATE TABLE IF NOT EXISTS finance.journal_entry_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  entry_id        INTEGER NOT NULL,
  line_order      INTEGER NOT NULL DEFAULT 0,
  account_code    TEXT NOT NULL,                 -- RA chart-of-accounts code
  debit           INTEGER NOT NULL DEFAULT 0,
  credit          INTEGER NOT NULL DEFAULT 0,
  description     TEXT
);

CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_entry
  ON finance.journal_entry_lines (tenant_id, entry_id);

CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_account
  ON finance.journal_entry_lines (tenant_id, account_code);
