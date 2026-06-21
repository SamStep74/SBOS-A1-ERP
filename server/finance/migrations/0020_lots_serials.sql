-- 0020_lots_serials.sql
--
-- Phase 2 ERP — lot + serial tracking for the inventory module.
--
-- Background:
--   The existing stock_quants table (0007_inventory.sql) tracks
--   quantity per (catalog_item, location) with weighted-average cost.
--   That's fine for fungible goods (grain, screws, oil), but two
--   product classes need finer tracking:
--
--     1. LOTS — batch-tracked goods where each batch has its own
--        identity (supplier lot number, expiry date, certification).
--        Examples: food (with expiry), pharmaceuticals (with lot),
--        electronics (with firmware version per batch).
--     2. SERIALS — unit-tracked goods where each physical unit
--        has its own identity (serial number, warranty, repair
--        history). Examples: electronics (every MacBook has a
--        unique serial), capital equipment, anything you'd
--        service or recall by unit.
--
-- This migration adds:
--   finance.lots     — one row per lot received from a supplier
--   finance.serials  — one row per unit-serial-numbered item
--
-- Both are tenant-scoped. Both are append-only at the row level;
-- status changes (sold, returned, lost) update the row in place.
--
-- Wave 37 ships the schema + pure functions for create/list/get.
-- Wave 38 (next) wires the stock.move integration: receiveStock
-- accepts lot_id + serial_ids; deliverStock decrements from the
-- oldest lot first (FEFO — first-expiry-first-out) by default.
--
-- Notes on table design:
--   - lots.code is the operator-friendly identifier (e.g. "LOT-2026-A").
--     UNIQUE per tenant. supplier_lot_number is the upstream label.
--   - serials.serial_number is UNIQUE per tenant. Format is free-form
--     but capped at 64 chars (most manufacturers use 8-20).
--   - serials.current_location_id is nullable: NULL means the
--     serial is not in stock (sold, returned, lost, scrap, in-transit).
--   - serials.lot_id is nullable: some serials don't need a lot
--     (e.g. tools bought individually). The lot link is for
--     traceability — recall a lot → all serials in that lot → flag
--     customers for service.

CREATE TABLE IF NOT EXISTS finance.lots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id           INTEGER NOT NULL DEFAULT 0,
  code                TEXT NOT NULL,             -- operator ID, e.g. 'LOT-2026-A'
  supplier_lot_number TEXT,                      -- upstream label (optional)
  catalog_item_id     INTEGER NOT NULL,         -- which item this lot is for
  expiry_date         TEXT,                      -- YYYY-MM-DD (food, pharma); NULL for non-perishable
  received_at         TEXT NOT NULL,             -- when we received the goods
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lots_tenant_code
  ON finance.lots (tenant_id, code);

CREATE INDEX IF NOT EXISTS idx_lots_tenant_item
  ON finance.lots (tenant_id, catalog_item_id);

CREATE INDEX IF NOT EXISTS idx_lots_tenant_expiry
  ON finance.lots (tenant_id, expiry_date)
  WHERE expiry_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS finance.serials (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id             INTEGER NOT NULL DEFAULT 0,
  serial_number         TEXT NOT NULL,             -- unique per tenant
  catalog_item_id       INTEGER NOT NULL,
  lot_id                INTEGER,                  -- nullable; some serials have no lot
  status                TEXT NOT NULL DEFAULT 'in_stock'
                          CHECK (status IN ('in_stock','sold','returned','lost','scrap')),
  current_location_id   INTEGER,                  -- NULL when not in stock
  received_at           TEXT NOT NULL,
  sold_at               TEXT,
  notes                 TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_serials_tenant_number
  ON finance.serials (tenant_id, serial_number);

CREATE INDEX IF NOT EXISTS idx_serials_tenant_item
  ON finance.serials (tenant_id, catalog_item_id);

CREATE INDEX IF NOT EXISTS idx_serials_tenant_lot
  ON finance.serials (tenant_id, lot_id)
  WHERE lot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_serials_tenant_status
  ON finance.serials (tenant_id, status);

-- Lot → quantity at a location (per-item, per-location lot balance).
-- Mirrors stock_quants but at the lot level. The sum of
-- stock_lots.quantity across lots = stock_quants.quantity for the
-- (item, location) pair.
CREATE TABLE IF NOT EXISTS finance.stock_lots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  lot_id          INTEGER NOT NULL,
  location_id     INTEGER NOT NULL,
  catalog_item_id INTEGER NOT NULL,             -- denormalized for query speed
  quantity        INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_lots_lot_location
  ON finance.stock_lots (tenant_id, lot_id, location_id);

CREATE INDEX IF NOT EXISTS idx_stock_lots_tenant_item_location
  ON finance.stock_lots (tenant_id, catalog_item_id, location_id);