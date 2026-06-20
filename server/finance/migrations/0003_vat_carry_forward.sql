-- 0003_vat_carry_forward.sql
-- Multi-period carry-forward ledger per RA Tax Code art. 68. A single
-- row stores the current banked credit. When a VAT period closes with
-- a negative net, the bank grows. When the next period opens, the
-- prior credit is applied to the current net.
--
-- Schema mirrors the rest of the finance module:
--   - `finance.` prefix (works on pg with the schema; works on sqlite
--     when the test harness ATTACHes a `:memory:` database as `finance`).
--   - whole-dram balance (BIGINT / INTEGER), no floats.
--   - `as_of_period` (YYYY-MM) records which period last wrote the bank
--     so the operator can audit the carry-forward history.
--
-- Idempotent (IF NOT EXISTS) so re-running the migration is a no-op on
-- fresh and existing schemas.
--
-- The ledger stores AT MOST ONE active row (id = 1). When a period
-- closes with a positive net that fully absorbs the prior credit, the
-- bank is reset to 0; when the net is negative, the bank grows; when
-- the net is positive but smaller than the prior credit, the bank
-- holds the leftover. The application (server/finance/vatLedger.js)
-- is the only writer; the schema is a single-row upsert target.

CREATE TABLE IF NOT EXISTS finance.vat_carry_forward (
  id              INTEGER PRIMARY KEY,
  balance_amd     INTEGER NOT NULL DEFAULT 0,
  as_of_period    TEXT NOT NULL,                -- 'YYYY-MM' the bank was last set
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Only one row is ever active. The unique constraint is implicit on the
-- PRIMARY KEY (id=1), so no extra index is needed.
