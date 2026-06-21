-- 0015_catalog_pricing.sql
-- Catalog v2 wave 3c (pricing rules) — adds
-- configurable price overrides for the catalog. A
-- pricing rule is a tenant-scoped record with:
--   - name: a human-friendly label
--   - type: the rule type (volume_discount,
--     time_based, category_discount)
--   - config_json: the rule config (opaque JSON
--     blob; the application logic that consumes
--     the config is a future concern)
--   - priority: conflict resolution (lower =
--     higher priority; multiple rules can match,
--     and the rule with the lowest priority value
--     wins)
--   - valid_from + valid_to: optional date range
--     (null = always valid)
--   - archived: soft-delete flag
--
-- Tables:
--   catalog_pricing_rules — the rule header (id,
--     tenant_id, name, type, config_json,
--     priority, valid_from, valid_to, archived)
--
-- The pure functions are in server/finance/catalog.js:
--   createPricingRule(db, input, tenantId)
--   listPricingRules(db, tenantId, { archived, type })
--   getPricingRule(db, ruleId, tenantId)
--
-- Phase 2 catalog v2 wave 3c (W80-1): schema +
-- pure functions + tests. Wave 3d (future): route
-- wiring + perm keys + smoke check.
--
-- Migration safety: this migration creates 1 new
-- table + 3 new indexes. It does NOT alter any
-- existing tables. Safe for both fresh installs
-- (the smoke deploy case) and existing installs.

-- ───────────── Pricing rules ─────────────

CREATE TABLE IF NOT EXISTS finance.catalog_pricing_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  -- The rule type:
  --   'volume_discount'  — buy N+ get X% off
  --   'time_based'       — date-range discount
  --   'category_discount' — category-based discount
  -- The CHECK constraint enforces the 3 supported
  -- types. New types require a migration.
  type TEXT NOT NULL CHECK (type IN
    ('volume_discount', 'time_based', 'category_discount')),
  -- The rule config (opaque JSON; the application
  -- layer interprets it based on the type). Example
  -- for volume_discount:
  --   {"tiers":[{"min_qty":10,"discount_pct":5},
  --            {"min_qty":50,"discount_pct":10}]}
  config_json TEXT,
  -- Conflict resolution priority (lower = higher
  -- priority). When multiple rules match a given
  -- item, the rule with the lowest priority value
  -- wins. The default is 100 (mid-range); the
  -- operator can adjust per rule.
  priority INTEGER NOT NULL DEFAULT 100,
  -- Optional date range (null = always valid).
  -- YYYY-MM-DD strings (consistent with the
  -- projects + tasks date convention).
  valid_from TEXT,
  valid_to TEXT,
  -- Soft-delete flag: 0 = active, 1 = archived.
  archived INTEGER NOT NULL DEFAULT 0
    CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS catalog_pricing_rules_tenant_idx
    ON finance.catalog_pricing_rules (tenant_id);
CREATE INDEX IF NOT EXISTS catalog_pricing_rules_type_idx
    ON finance.catalog_pricing_rules (type);
CREATE INDEX IF NOT EXISTS catalog_pricing_rules_archived_idx
    ON finance.catalog_pricing_rules (archived);
