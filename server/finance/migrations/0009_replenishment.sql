-- 0009_replenishment.sql
-- Adds the `reorder_point` field to catalog_items so the replenishment
-- report can flag items whose total stock (across all locations) is
-- below the operator-defined threshold.
--
-- Pattern (matches 0002 / 0005 ALTER TABLE conventions):
--   - Use the `finance.` prefix on the table name; the production
--     migration runner strips it on sqlite (the test driver) but
--     keeps it on pg, so the same file works on both backends.
--   - `IF NOT EXISTS` on the column for idempotency (sqlite supports
--     this on ALTER TABLE ADD COLUMN; the migration runner also
--     try/catches each statement as a defense in depth).
--   - DEFAULT 0 so existing catalog rows pass through unchanged:
--     an item with no reorder_point set is treated as "no
--     replenishment trigger" (never appears in the report).
--
-- The replenishment report itself is a pure function in
-- server/finance/inventory.js (getReplenishmentReport) — no new
-- tables, no new relationships, just a denormalized threshold
-- column on the item.

ALTER TABLE finance.catalog_items
  ADD COLUMN IF NOT EXISTS reorder_point INTEGER NOT NULL DEFAULT 0;
