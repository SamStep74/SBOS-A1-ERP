-- 0014_catalog_bundles.sql
-- Catalog v2 wave 3 (bundles) — adds compound
-- items to the catalog. A bundle is a multi-item
-- kit with a fixed price (e.g. "Starter Pack:
-- chair + desk + lamp for $X"). The schema is
-- normalized: a bundle has a header row
-- (catalog_bundles) + N child rows
-- (catalog_bundle_items) that reference the
-- catalog_items table.
--
-- Tables:
--   catalog_bundles       — the bundle header
--                           (sku, name, description,
--                           bundle_price_amd, archived)
--   catalog_bundle_items  — the child rows (bundle_id,
--                           catalog_item_id, quantity)
--
-- The pure functions are in server/finance/catalog.js:
--   createBundle(db, input, tenantId)
--   listBundles(db, tenantId, { archived } = {})
--   getBundle(db, bundleId, tenantId)
--   addBundleItem(db, bundleId, input, tenantId)
--     — checks the bundle + the catalog item exist
--       in the tenant
--   listBundleItems(db, bundleId, tenantId)
--     — checks the bundle exists in the tenant
--
-- Phase 2 catalog v2 wave 3a (W78-1): schema +
-- pure functions + tests. Wave 3b (future):
-- route wiring + perm keys + smoke check.
-- (Pricing rules are deferred to wave 3c — a
-- separate scope.)
--
-- Migration safety: this migration creates 2 new
-- tables + 3 new indexes. It does NOT alter any
-- existing tables. Safe for both fresh installs
-- (the smoke deploy case) and existing installs.

-- ───────────── Bundles ─────────────

CREATE TABLE IF NOT EXISTS finance.catalog_bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  -- Human-friendly SKU (unique per tenant, only for
  -- non-archived rows; archived rows can have the
  -- same SKU as a non-archived row).
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- The fixed bundle price (integer AMD; nullable
  -- when the bundle's price is computed dynamically
  -- — future work).
  bundle_price_amd INTEGER,
  -- Soft-delete flag: 0 = active, 1 = archived.
  -- Archived bundles are excluded from the default
  -- listBundles response (the operator can opt-in
  -- via { archived: true } for cleanup views).
  archived INTEGER NOT NULL DEFAULT 0
    CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS catalog_bundles_tenant_idx
    ON finance.catalog_bundles (tenant_id);
CREATE INDEX IF NOT EXISTS catalog_bundles_archived_idx
    ON finance.catalog_bundles (archived);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_bundles_sku_idx
    ON finance.catalog_bundles (tenant_id, sku)
    WHERE archived = 0;

-- ───────────── Bundle items ─────────────

CREATE TABLE IF NOT EXISTS finance.catalog_bundle_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  bundle_id INTEGER NOT NULL,
  catalog_item_id INTEGER NOT NULL,
  -- The quantity of the item in the bundle. Must
  -- be > 0. CHECK constraint enforces at the DB
  -- level; the pure function also validates.
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS catalog_bundle_items_tenant_idx
    ON finance.catalog_bundle_items (tenant_id);
CREATE INDEX IF NOT EXISTS catalog_bundle_items_bundle_idx
    ON finance.catalog_bundle_items (bundle_id);
CREATE INDEX IF NOT EXISTS catalog_bundle_items_item_idx
    ON finance.catalog_bundle_items (catalog_item_id);
