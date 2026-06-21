-- 0007_inventory.sql
-- Inventory + product catalog foundation for Phase 1 of the ERP plan.
-- Ported from packages/erp/src/{product-catalog,stock-moves}.ts in
-- A1-Suite-Local (the user's private R&D monorepo). All orgId
-- references renamed to tenant_id for consistency with the rest
-- of SBOS-A1-ERP. The pure-function layer (server/inventory/*.js)
-- threads tenant_id into every read and write.
--
-- Tables:
--   catalog_categories — product taxonomy (parent-child)
--   unit_of_measures   — UoM codes (kg, m, pcs, etc.)
--   catalog_items      — the product master (sku unique per tenant)
--   catalog_variants   — optional product variants
--   warehouses         — top-level stock containers
--   stock_locations    — child locations within a warehouse (e.g.
--                         WH/STOCK, WH/DISPATCH); a tenant can have
--                         both INTERNAL (own stock) and CUSTOMER
--                         (consignment/drop-ship) and SUPPLIER
--                         (in-transit) location types
--   stock_quants       — current on-hand per (item, location)
--   stock_moves        — append-only log of every stock movement
--                         (RECEIPT / DELIVERY / ADJUSTMENT /
--                          TRANSFER / INTERNAL)
--
-- The pure functions use these tables in the obvious way:
--   receiveStock()      — INSERT stock_moves(RECEIPT), upsert
--                         stock_quants at the destination location
--                         (weighted-average cost update).
--   deliverStock()      — INSERT stock_moves(DELIVERY), decrement
--                         stock_quants at the source location
--                         (cogs: average cost at the time of move).
--   transferStock()     — INSERT stock_moves(TRANSFER), move
--                         stock_quants from source to dest.
--   adjustStock()       — INSERT stock_moves(ADJUSTMENT), set
--                         stock_quants.quantity to the new value.
--   listBalances()      — SELECT * FROM stock_quants WHERE tenant.

-- ───────────── Product catalog ─────────────

CREATE TABLE IF NOT EXISTS finance.catalog_categories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  parent_id       INTEGER,
  name            TEXT NOT NULL,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS finance.unit_of_measures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'count',  -- count / mass / volume / length / time
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS finance.catalog_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  sku             TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  type            TEXT NOT NULL DEFAULT 'STOCKABLE',  -- STOCKABLE / CONSUMABLE / SERVICE / DIGITAL
  category_id     INTEGER,
  uom_id          INTEGER,
  uom_code        TEXT NOT NULL DEFAULT 'pcs',
  barcode         TEXT,
  vat_class       TEXT NOT NULL DEFAULT 'VAT_STANDARD', -- VAT_STANDARD / VAT_REDUCED / VAT_EXEMPT / VAT_ZERO
  standard_price  INTEGER NOT NULL DEFAULT 0,         -- in AMD (whole drams, no floats)
  sale_price      INTEGER NOT NULL DEFAULT 0,
  standard_cost   INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_items_tenant_sku
  ON finance.catalog_items (tenant_id, sku);

CREATE TABLE IF NOT EXISTS finance.catalog_variants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  catalog_item_id INTEGER NOT NULL,
  sku             TEXT NOT NULL,
  name            TEXT NOT NULL,
  attributes_json TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────────── Warehouses + locations ─────────────

CREATE TABLE IF NOT EXISTS finance.warehouses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_tenant_code
  ON finance.warehouses (tenant_id, code);

CREATE TABLE IF NOT EXISTS finance.stock_locations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  warehouse_id    INTEGER NOT NULL,
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  location_type   TEXT NOT NULL DEFAULT 'INTERNAL',  -- INTERNAL / CUSTOMER / SUPPLIER
  parent_id       INTEGER,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_locations_warehouse_code
  ON finance.stock_locations (tenant_id, warehouse_id, code);

-- ───────────── Stock quants (current on-hand) ─────────────
--
-- One row per (item, location). Updated atomically by every stock
-- move. The average_cost is the weighted-average cost across
-- receipts; deliveries and transfers use the source's average
-- cost at the time of the move.
-- ─────────────

CREATE TABLE IF NOT EXISTS finance.stock_quants (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id           INTEGER NOT NULL DEFAULT 0,
  catalog_item_id     INTEGER NOT NULL,
  location_id         INTEGER NOT NULL,
  quantity            INTEGER NOT NULL DEFAULT 0,
  reserved_quantity   INTEGER NOT NULL DEFAULT 0,
  average_cost        INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_quants_item_location
  ON finance.stock_quants (tenant_id, catalog_item_id, location_id);

-- ───────────── Stock moves (append-only log) ─────────────
--
-- Every receive / deliver / transfer / adjustment writes one row.
-- The "quantity" is always positive; the move_type determines
-- direction (RECEIPT + source=NULL, DELIVERY + dest=NULL,
-- TRANSFER has both, ADJUSTMENT has the new absolute quantity
-- stored separately in the "delta" column).
-- ─────────────

CREATE TABLE IF NOT EXISTS finance.stock_moves (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id               INTEGER NOT NULL DEFAULT 0,
  move_type               TEXT NOT NULL,           -- RECEIPT / DELIVERY / ADJUSTMENT / TRANSFER / INTERNAL
  catalog_item_id         INTEGER NOT NULL,
  source_location_id      INTEGER,
  destination_location_id INTEGER,
  quantity                INTEGER NOT NULL,        -- always positive
  unit_cost               INTEGER NOT NULL DEFAULT 0,
  reference               TEXT,                    -- PO number, sales order number, etc.
  delta                   INTEGER,                 -- for ADJUSTMENT: the new absolute quantity
  notes                   TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  created_by              INTEGER                  -- user_id, nullable
);

CREATE INDEX IF NOT EXISTS idx_stock_moves_tenant_time
  ON finance.stock_moves (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_moves_item
  ON finance.stock_moves (tenant_id, catalog_item_id, created_at DESC);
