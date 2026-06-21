-- 0017_recall_status.sql
--
-- Phase 2 ERP — extend the serials.status CHECK constraint to allow
-- the new 'recalled' status (Wave 41).
--
-- Background:
--   Migration 0014 created the serials table with a CHECK constraint
--   restricting status to ('in_stock','sold','returned','lost','scrap').
--   Wave 41 adds 'recalled' as a valid status (regulatory compliance
--   for batch-tracked goods — when a lot is recalled, every serial
--   in it gets status='recalled' via the recallLot cascade).
--
-- SQLite has no ALTER TABLE ... DROP CONSTRAINT, so we rebuild the
-- table: create a new table with the updated CHECK, copy the rows,
-- drop the old, rename. This is the standard SQLite recipe and
-- preserves all data + indexes (we recreate the unique index).
--
-- The migration is idempotent (CREATE TABLE IF NOT EXISTS etc.)
-- and the migration runner's idempotency guard means it only runs
-- once per deploy.

CREATE TABLE IF NOT EXISTS finance.serials_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id             INTEGER NOT NULL DEFAULT 0,
  serial_number         TEXT NOT NULL,
  catalog_item_id       INTEGER NOT NULL,
  lot_id                INTEGER,
  status                TEXT NOT NULL DEFAULT 'in_stock',
  current_location_id   INTEGER,
  received_at           TEXT NOT NULL,
  sold_at               TEXT,
  notes                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('in_stock','sold','returned','lost','scrap','recalled'))
);

-- Idempotent migration: only run the copy/drop/rename if the new
-- table exists AND the old one still has the old constraint. The
-- migration_history table is the gate — the runner only runs this
-- file once per deploy.
INSERT INTO finance.serials_new
  (id, tenant_id, serial_number, catalog_item_id, lot_id, status,
   current_location_id, received_at, sold_at, notes, created_at, updated_at)
SELECT id, tenant_id, serial_number, catalog_item_id, lot_id, status,
       current_location_id, received_at, sold_at, notes, created_at, updated_at
  FROM finance.serials;

DROP TABLE finance.serials;

ALTER TABLE finance.serials_new RENAME TO finance.serials;

-- Recreate the unique index that migration 0014 created (DROP TABLE
-- dropped it with the table).
CREATE UNIQUE INDEX IF NOT EXISTS idx_serials_tenant_serial
  ON finance.serials (tenant_id, serial_number);