-- 0013_catalog_v2.sql
-- Catalog v2 — extends the existing catalog module
-- (Wave 7) with:
--   1. Proper categories: add slug + description to
--      the existing catalog_categories table; the
--      slug is a unique partial index per tenant
--      (null slugs are allowed; only non-null slugs
--      are uniqueness-constrained). The table already
--      has parent_id (hierarchical structure); this
--      migration adds the metadata fields.
--   2. Variants exposed: the catalog_variants table
--      already exists in 0007_inventory.sql; this
--      migration adds an updated_at column + a
--      tenant_id+sku unique index for the new
--      createVariant pure function.
--
-- The pure functions are in server/finance/catalog.js:
--   createCategory(db, input, tenantId)
--   listCategories(db, tenantId, parentId?)
--   getCategory(db, categoryId, tenantId)
--   getCategoryPath(db, categoryId, tenantId) — full
--     path from root to this category
--   createVariant(db, input, tenantId)
--   listVariants(db, tenantId, itemId?)
--   getVariant(db, variantId, tenantId)
--
-- Phase 2 catalog v2 wave 1 (W76-1): schema
-- extension + pure functions + tests. Wave 2
-- (future): route wiring + smoke check.
--
-- Migration safety: the ALTER TABLE statements
-- use SQLite's "ADD COLUMN" with NULL default.
-- For fresh installs (the smoke deploy case),
-- the columns are added cleanly. For existing
-- installs with data, the NULL default means
-- existing rows have null slug + null
-- description — the new pure functions handle
-- null slug (it's optional, with a unique
-- partial index), so existing data is preserved.

-- ───────────── Categories: add slug + description ─────────────

ALTER TABLE finance.catalog_categories
    ADD COLUMN slug TEXT;
ALTER TABLE finance.catalog_categories
    ADD COLUMN description TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS catalog_categories_slug_idx
    ON finance.catalog_categories (tenant_id, slug)
    WHERE slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS catalog_categories_parent_idx
    ON finance.catalog_categories (parent_id);

-- ───────────── Variants: add updated_at + sku unique ─────────────

ALTER TABLE finance.catalog_variants
    ADD COLUMN updated_at TEXT
    NOT NULL DEFAULT (datetime('now'));

CREATE UNIQUE INDEX IF NOT EXISTS catalog_variants_sku_idx
    ON finance.catalog_variants (tenant_id, sku);
