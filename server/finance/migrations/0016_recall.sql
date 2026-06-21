-- 0016_recall.sql
--
-- Phase 2 ERP — product recall support for lots.
--
-- Wave 41 closes the recall story. Background:
--
--   Lots track batch-tracked goods (food with expiry, pharma, etc).
--   When a supplier issues a recall ("LOT-XYZ may be contaminated"),
--   the operator needs to:
--     1. Mark the lot as recalled (audit trail: when, by whom, why)
--     2. Cascade status='recalled' to every serial in that lot
--        (so unit-tracked items out in the field can be located
--        and returned)
--     3. List the recalled serials (so customer service can reach
--        out to whoever currently holds them)
--
-- The recall is a soft-delete: the data stays in the table,
-- status='recalled' makes them un-sellable, but the audit trail
-- of which lots went where and which serials belong to which
-- customer is preserved.
--
-- Schema additions:
--   lots.recalled_at     TIMESTAMP (NULL until the lot is recalled)
--   lots.recall_reason   TEXT (operator's note; required at recall time)
--   lots.recalled_by     INTEGER (user_id who triggered the recall)
--
-- Index on recalled_at so "list me the recently-recalled lots"
-- queries don't scan the whole lots table.

ALTER TABLE finance.lots ADD COLUMN recalled_at TEXT;
ALTER TABLE finance.lots ADD COLUMN recall_reason TEXT;
ALTER TABLE finance.lots ADD COLUMN recalled_by INTEGER;

CREATE INDEX IF NOT EXISTS idx_lots_tenant_recalled_at
  ON finance.lots (tenant_id, recalled_at);