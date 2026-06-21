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
-- The ledger stores ONE active row per tenant (id = 1 within the tenant).
-- The composite PK (tenant_id, id) is what makes the multi-tenant bank work
-- — without it, the carry-forward would be a single global row that
-- clobbers across tenants. The application (server/finance/vatLedger.js)
-- is the only writer; the schema is a single-row upsert target per tenant.

CREATE TABLE IF NOT EXISTS finance.vat_carry_forward (
  id              INTEGER NOT NULL,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  balance_amd     INTEGER NOT NULL DEFAULT 0,
  as_of_period    TEXT NOT NULL,                -- 'YYYY-MM' the bank was last set
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, id)
);

-- No extra index needed: the PK already provides the lookup.
