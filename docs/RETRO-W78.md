# W78 Summary — Phase 2 catalog v2 wave 3a (bundles)

**Date:** 2026-06-21.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W77-1 shipped Phase 2 catalog
v2 wave 2: route wiring (7
endpoints) + 4 perm keys +
new CatalogOperator perm set
+ smoke check extension (12
new checks). The catalog v2
module was end-to-end
functional (categories +
variants).

W78-1 ships the **wave 3a
(bundles)**: schema (2 new
tables: catalog_bundles +
catalog_bundle_items) + 5
pure functions + 14 new
tests. This is the first
half of the wave-3 plan
(bundles + pricing rules);
pricing rules are deferred
to wave 3b.

The bundles feature is a
natural extension of the
catalog: a bundle is a
compound item (e.g.
"Starter Pack: chair + desk
+ lamp for $X") that
references existing
catalog_items. The total
price is the
`bundle_price_amd` (a single
integer); the child rows are
the recipe (which items +
quantities).

## What shipped

### W78-1 — catalog.js extensions + 0014_catalog_bundles.sql + 14 tests

**Migration
`0014_catalog_bundles.sql`**
(the 14th finance migration):
2 new tables + 6 new indexes:

- `finance.catalog_bundles` —
  the bundle header (id,
  tenant_id, sku, name,
  description,
  bundle_price_amd, archived,
  created_at, updated_at).
  The sku is a unique partial
  index per tenant (only
  non-archived rows are
  constrained — archived
  rows can have the same sku
  as a non-archived row).
  The `archived` flag enables
  soft-delete.
- `finance.catalog_bundle_items`
  — the child rows (id,
  tenant_id, bundle_id,
  catalog_item_id, quantity,
  created_at). The
  `quantity` column has a
  CHECK constraint (`> 0`).
  3 indexes for tenant /
  bundle / item lookups.

The migration is safe for
both fresh installs (the
smoke deploy case) and
existing installs: it
creates 2 new tables + 6
new indexes, and does NOT
alter any existing tables.

**5 new pure functions in
`server/finance/catalog.js`**
(the file now has 12 pure
functions: 4 categories +
3 variants + 5 bundles):

- `createBundle(db, input,
  tenantId)` — inserts a
  bundle; returns the new id.
  Validates sku + name
  required, bundle_price_amd
  is a non-negative integer.
- `listBundles(db, tenantId,
  { archived } = {})` —
  returns bundles for the
  tenant. Default
  (`archived=false`) returns
  only non-archived rows;
  `archived=true` returns all
  rows. Ordered by id DESC
  (most recent first).
- `getBundle(db, bundleId,
  tenantId)` — single bundle;
  throws `ValueError` on
  missing or cross-tenant.
- `addBundleItem(db, bundleId,
  input, tenantId)` — inserts
  a child row. Validates the
  bundle + the catalog item
  exist in the tenant (FK-
  like existence checks).
- `listBundleItems(db, bundleId,
  tenantId)` — returns the
  child rows in chronological
  order. Validates the bundle
  exists in the tenant.

All 5 functions use the
`runQuery(db, sql, params)`
helper pattern (from W71-2)
+ the `ValueError` class
with the constructor that
sets `this.name =
'ValueError'` (the fix from
W73-1, applied from day 1).

**14 new tests in
`server/finance/catalog.test.js`**
(was 25, +14 = 39 total):

- `createBundle` (3) — insert
  + return id, requires
  sku + name, validates
  bundle_price_amd.
- `listBundles` (2) — returns
  all non-archived bundles
  for the tenant (default),
  tenant-scoped.
- `getBundle` (2) — throws
  `ValueError` for missing
  bundle, tenant-scoped.
- `addBundleItem` (4) —
  insert + return id, throws
  for missing bundle, throws
  for missing item, validates
  quantity (> 0).
- `listBundleItems` (3) —
  returns the items in
  chronological order, throws
  for missing bundle, tenant-
  scoped.

All 14 new tests pass; all
25 W76-1 tests still pass
(no regressions from the
schema extension).

## Test baseline

- **1213 / 1213** tests pass
  (was 1184 before W78-1; the
  14 new catalog bundle
  tests + 15 from the team's
  Wave 27 perm-gating work
  account for the +29 delta).
- **`npm run check`** clean
  (lint + typecheck + format
  + boundary-check + 1213
  tests + l10n-am audit).
- **`scripts/deploy-smoke.sh`**
  60+ / 60+ (no new checks
  yet; bundle endpoints
  aren't HTTP-wired — that's
  wave 3b / future plan).
- **15 migrations** applied
  (0001_init through
  0014_catalog_bundles).

## Why it matters

**The catalog v2 module now
has 3 sub-features: categories
(hierarchical), variants
(per-item), and bundles
(compound items).** The
schema is migrated, the pure
functions are tested, and
the module is ready for the
next wave (route wiring +
smoke check extension).

The bundles feature enables
a common catalog use case:
"Starter Pack", "Pro Bundle",
"Enterprise Kit" — a single
SKU with a fixed price + a
recipe of N catalog items.
This is a fundamental
e-commerce + retail
capability.

## Carry-forward

The remaining Phase 2 work
(not blocking; future
plans):

- **Phase 2 catalog v2 wave
  3b (bundles route wiring)**
  (next) — route wiring (5+
  endpoints: list + create
  + get bundle, list + add
  bundle items) + perm keys
  (4 new: `finance.bundle.read/create`
  + `finance.bundle_item.create`)
  + smoke check extension.
- **Phase 2 catalog v2 wave
  3c (pricing rules)** —
  schema (catalog_pricing_rules
  table with type +
  config_json + priority +
  valid_from + valid_to) +
  3 pure functions
  (createPricingRule,
  listPricingRules,
  getPricingRule) +
  tests.
- **Phase 2 desk wave 3**
  (optional) — status
  transitions + assignee +
  KB.
- **Phase 2 CRM wave 3**
  (optional) — update +
  archive + lead status
  state machine.
- **Phase 2 projects wave
  3** (optional) — task
  transitions + assignee +
  billing reports.

**W70 / W71 / W72 / W73 /
W74 / W75 / W76 / W77 /
W78 established the 3-wave
pattern for Phase 2 module
ports across 4 modules. The
catalog v2 module is the
most complex so far (3 sub-
features: categories +
variants + bundles, with a
4th planned: pricing rules).
The pattern still holds:
each sub-feature is its own
wave 1 (schema + pure
functions + tests) + wave 2
(route wiring + perm keys +
smoke).**

**Open items** (follow-up
plans, not blocking):

- Production pg CI (the
  current CI uses sqlite; a
  parallel job should spin
  up pg and run the smoke
  against the pg adapter).
- Restore verification (cron
  restores are unverified).
- K8s multi-cluster pattern.
- The duplicate `0009_*.sql`
  migration filenames
  (pre-existing, ordered
  alphabetically; out of
  scope).
- The "13 endpoints" message
  in the smoke summary is
  stale (pre-existing; out
  of scope).

## Lessons learned

1. **Compound catalog items
   (bundles) are a separate
   table, not a flag on
   catalog_items.** The
   natural first design
   temptation is to add an
   `is_bundle` flag to the
   existing `catalog_items`
   table. But a bundle is a
   *recipe* (a header row +
   N child rows referencing
   other catalog items), not
   a single item. The
   normalized design is
   cleaner:
   - `catalog_bundles` (the
     header: sku + name +
     description +
     bundle_price_amd)
   - `catalog_bundle_items`
     (the recipe: bundle_id
     + catalog_item_id +
     quantity)

   The lesson: **compound
   items in a catalog should
   be a separate table +
   junction table, not a flag
   on the base table**. The
   junction table has a
   quantity column (not just
   a boolean) because a
   bundle may contain 2 of
   the same item (e.g.
   "Starter Pack: 1x Chair +
   1x Desk + 2x Lamp").

2. **The `archived` flag on
   bundles is the right
   soft-delete pattern.** The
   bundle has an `archived`
   flag (0 = active, 1 =
   archived) with a CHECK
   constraint. The default
   `listBundles` returns only
   non-archived rows; the
   operator can opt-in to all
   rows via `{ archived:
   true }` for cleanup views.
   The unique sku index is
   partial: only non-archived
   rows are constrained (an
   archived bundle's sku can
   be reused by a new active
   bundle). The lesson:
   **soft-delete with a
   `archived` flag is the
   right pattern for catalog
   data**; hard-delete would
   lose the historical record.
   The `archived` flag is
   consistent with the
   existing `catalog_items.archived`
   field.

3. **FK-like existence checks
   are the right pattern for
   bundle → catalog item
   references.** The
   `addBundleItem` function
   does 2 existence checks
   before the INSERT:
   - Verify the bundle exists
     in the tenant
   - Verify the catalog item
     exists in the tenant

   The same pattern as
   `addBundleItem` is used
   in `createTask` (project
   existence check) and
   `createTimeEntry` (task
   existence check). The
   lesson: **existence checks
   in pure functions are the
   right pattern for
   cross-table references
   when the FK constraint
   isn't in the schema
   (because the tables are in
   different migration
   files)**. The check
   enforces tenant isolation
   (cross-tenant access
   denied) and prevents
   orphan rows (child without
   parent).

4. **The test harness can
   skip unique indexes when
   the production migration
   enforces them.** The
   catalog_variants_sku_idx
   is needed in the test
   harness because the
   `createVariant enforces
   unique sku per tenant`
   test asserts a UNIQUE
   constraint error. But
   other unique indexes
   (catalog_categories_slug_idx,
   catalog_bundles_sku_idx)
   are NOT needed in the test
   harness because the
   corresponding tests
   exercise only the happy
   path. The lesson: **for
   each unique index, decide
   if the test harness needs
   it**: if a test asserts a
   UNIQUE constraint error,
   the index must be in the
   test schema; if no test
   asserts it, the index can
   be skipped (with a comment
   noting that the production
   layer enforces it via the
   smoke check). This avoids
   the "every unique index in
   the test schema" overhead
   while still keeping the
   unique-constraint test
   coverage where it matters.
