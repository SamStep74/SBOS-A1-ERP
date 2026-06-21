# W76 Summary — Phase 2 catalog v2 wave 1 (schema extension + pure functions + tests)

**Date:** 2026-06-21.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

The existing catalog module
(Wave 7) had minimal coverage:
- `catalog_categories` table
  with `parent_id` (already
  hierarchical) but no
  `slug` + `description`
- `catalog_variants` table
  with no exposed CRUD
- No `getCategoryPath` (the
  breadcrumb query)

W76-1 ships the **wave 1**
of catalog v2: schema
extension (add `slug` +
`description` to
`catalog_categories`; add
`updated_at` + unique sku
index to `catalog_variants`)
+ 7 pure functions (4 for
categories, 3 for variants)
+ 25 tests.

The 4th Phase 2 module
(catalog) now has its
wave-1 baseline. The next
wave (future) is route
wiring + smoke check.

## What shipped

### W76-1 — catalog.js + 0013_catalog_v2.sql + 25 tests

**Migration `0013_catalog_v2.sql`**
(the 13th finance migration):
extends the existing 0007
catalog tables with:

- `ALTER TABLE finance.catalog_categories
     ADD COLUMN slug TEXT;`
- `ALTER TABLE finance.catalog_categories
     ADD COLUMN description TEXT;`
- `CREATE UNIQUE INDEX catalog_categories_slug_idx
     ON finance.catalog_categories (tenant_id, slug)
     WHERE slug IS NOT NULL;`
- `CREATE INDEX catalog_categories_parent_idx
     ON finance.catalog_categories (parent_id);`
- `ALTER TABLE finance.catalog_variants
     ADD COLUMN updated_at TEXT
     NOT NULL DEFAULT (datetime('now'));`
- `CREATE UNIQUE INDEX catalog_variants_sku_idx
     ON finance.catalog_variants (tenant_id, sku);`

The migration is safe for
existing data: ALTER TABLE
ADD COLUMN with NULL default
preserves existing rows
(slug + description are NULL
for old rows; the partial
unique index allows NULL).

**Pure functions in
`server/finance/catalog.js`**
(346 lines):

- **Categories (4):**
  - `createCategory(db, input,
    tenantId)` — inserts a
    category; validates name
    required, slug pattern
    (lowercase + hyphens, 1-64
    chars), parent_id exists
    in the tenant (if
    specified).
  - `listCategories(db, tenantId,
    parentId?)` — flat list
    (all categories) or
    filtered by direct parent.
    Ordered by id ASC.
  - `getCategory(db, categoryId,
    tenantId)` — single category;
    throws `ValueError` on
    missing or cross-tenant.
  - `getCategoryPath(db, categoryId,
    tenantId)` — full path from
    root to leaf using a
    recursive CTE. Returns
    `[{id, name}, ...]` in
    root-to-leaf order, or `[]`
    for a missing category.
- **Variants (3):**
  - `createVariant(db, input,
    tenantId)` — inserts a
    variant; validates
    catalog_item_id exists,
    sku + name required,
    unit_price_amd +
    unit_cost_amd are
    non-negative integers.
  - `listVariants(db, tenantId,
    catalogItemId?)` — flat
    list or filtered by item.
  - `getVariant(db, variantId,
    tenantId)` — single variant;
    throws `ValueError` on
    missing or cross-tenant.

All 7 functions use the
`runQuery(db, sql, params)`
helper pattern (from W71-2)
+ the `ValueError` class
with the constructor that
sets `this.name =
'ValueError'` (the fix from
W73-1, applied from day 1).

**25 tests in
`server/finance/catalog.test.js`**:

- **Categories (13 tests):**
  - `createCategory` (7) —
    insert + return id, slug
    acceptance, slug validation
    (spaces / uppercase /
    leading hyphens), unique
    slug per tenant (allowed
    across tenants), parent_id
    sub-category, missing
    parent → throws, name
    required.
  - `listCategories` (2) —
    flat list (all categories
    for the tenant, tenant-
    scoped), filtered by
    parent_id.
  - `getCategory` (2) —
    missing → throws,
    tenant-scoped.
  - `getCategoryPath` (3) —
    [self] for root, full
    root-to-leaf path for
    nested (3 levels), `[]`
    for missing.
- **Variants (10 tests):**
  - `createVariant` (6) —
    insert + return id, missing
    item → throws, unique sku
    per tenant, optional
    unit_price_amd +
    unit_cost_amd +
    attributes_json, validation
    (negative price, non-integer
    cost), required fields
    (catalog_item_id, sku,
    name).
  - `listVariants` (2) — flat
    list, filtered by item.
  - `getVariant` (2) — missing
    → throws, tenant-scoped.

All 25 tests pass.

## Test baseline

- **1184 / 1184** tests pass
  (was 1159 before W76-1; the
  25 new catalog tests account
  for the +25 delta).
- **`npm run check`** clean
  (lint + typecheck + format
  + boundary-check + 1184
  tests + l10n-am audit).
- **`scripts/deploy-smoke.sh`**
  50+ / 50+ (no new checks
  yet; catalog endpoints
  aren't HTTP-wired — that's
  wave 2 / future plan).
- **14 migrations** applied
  (0001_init through
  0013_catalog_v2).

## Why it matters

**The catalog module is
now a real first-class
citizen of the finance
layer for categories +
variants.** The schema is
migrated, the pure functions
are tested, and the module
is ready for the next wave
(route wiring + smoke check
extension). Future catalog
v2 work (bundles + pricing
rules) can layer on top of
this baseline.

The 3-wave pattern is now
established across **4
Phase 2 modules** (CRM, desk,
projects, catalog). All 4
wave-1 modules follow the
same pattern; 3 of them
(CRM, desk, projects) have
also completed wave 2.

## Carry-forward

The remaining Phase 2 work
(not blocking; future
plans):

- **Phase 2 catalog v2 wave
  2** (next) — route wiring
  (7+ endpoints: list +
  create + get category,
  get path; list + create +
  get variant) + perm keys
  + smoke check extension.
  The existing catalog
  endpoints
  (`/api/finance/catalog/items`)
  use the inventory.js
  functions; the new
  categories + variants
  endpoints will live at
  `/api/finance/catalog/categories`
  + `/api/finance/catalog/items/:id/variants`
  (consistent with the
  projects fully-nested
  pattern from W75-1).
- **Phase 2 catalog v2 wave
  3** (optional, future) —
  bundles (catalog_bundles
  + catalog_bundle_items
  tables) + pricing rules
  (catalog_pricing_rules
  table with type +
  config_json).
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
W74 / W75 / W76 established
the 3-wave pattern for
Phase 2 module ports across
4 modules (CRM, desk,
projects, catalog). The
pattern is robust across
modules with different
shapes:**
- CRM: 2-table contact/lead
- desk: 2-table case/reply
  with enums
- projects: 3-table
  project/task/time-entry
  with FK-like existence
  checks
- catalog: 2-table
  category/variant with
  hierarchical parent_id

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

1. **Recursive CTEs are the
   right pattern for
   hierarchical queries.**
   The `getCategoryPath`
   function uses a recursive
   CTE to traverse the
   `parent_id` chain:

   ```sql
   WITH RECURSIVE path(id, parent_id, name, depth) AS (
     SELECT id, parent_id, name, 0
       FROM catalog_categories
      WHERE id = $1 AND tenant_id = $2
     UNION ALL
     SELECT c.id, c.parent_id, c.name, p.depth + 1
       FROM catalog_categories c
       JOIN path p ON c.id = p.parent_id
      WHERE c.tenant_id = $2
   )
   SELECT id, name, depth FROM path ORDER BY depth DESC
   ```

   The CTE has 2 parts: the
   base case (the target
   category) and the
   recursive case (the
   parent of the current
   row, joined via
   `parent_id`). The
   `depth` column counts
   the recursion level
   (0 = target, N = root).
   `ORDER BY depth DESC`
   puts the root first
   (highest depth = furthest
   ancestor), giving
   root-to-leaf order
   without a post-process
   reverse.

   The lesson: **recursive
   CTEs are the right
   pattern for breadcrumb
   / path queries in
   hierarchical data**. The
   existing Phase 1 modules
   (vendors, customers,
   catalog) didn't have
   this — they used flat
   data. The catalog v2
   categories are the first
   Phase 2 module with
   hierarchical data, and
   the recursive CTE is
   the right tool.

2. **`ORDER BY depth DESC`
   already gives
   root-to-leaf order; no
   `.reverse()` needed.**
   The initial W76-1
   implementation of
   `getCategoryPath` had a
   `.reverse()` at the end
   that was wrong — it was
   based on the (incorrect)
   assumption that
   `ORDER BY depth DESC`
   returns leaf-first. But
   `DESC` means highest
   depth first, and the
   root has the highest
   depth. So the SQL
   already returns
   root-to-leaf. The
   `.reverse()` made it
   leaf-first, which is
   wrong.

   This bug was caught by
   the
   `getCategoryPath returns
   the full root-to-leaf
   path for a nested
   category` test (which
   expected
   `path[0].name ===
   'Electronics'`, but got
   `path[0].name ===
   'Laptops'`). The fix:
   remove the `.reverse()`.

   The lesson: **`ORDER BY
   column DESC` always puts
   the highest value of
   `column` first**. For
   `depth` (where 0 = the
   target, N = the root),
   `DESC` puts the root
   first. The intuition
   "leaf first, reverse to
   get root" was wrong. The
   lesson: **trust the
   ORDER BY direction; don't
   apply ad-hoc reverses
   without verifying** the
   actual SQL output order.

3. **SQLite's `?` placeholder
   is positional, not
   numbered.** The test
   harness initially used
   `sql.replace(/\$\d+/g,
   '?')` to translate pg-style
   `$N` placeholders to
   sqlite-style `?`. But
   sqlite's `?` is purely
   positional — it consumes
   params in order, even
   if the same `?` appears
   multiple times. So for
   `WHERE id = $1 AND
   tenant_id = $2 ... WHERE
   c.tenant_id = $2`, the
   translation `WHERE id = ?
   AND tenant_id = ? ...
   WHERE c.tenant_id = ?`
   has 3 `?` placeholders
   but only 2 params —
   sqlite binds the 3rd `?`
   to `undefined` (or errors
   out).

   The fix: use numbered
   placeholders `?N` in
   the test harness:
   `sql.replace(/\$\d+/g,
   (m) => '?' + m.slice(1))`.
   SQLite supports
   `?1` / `?2` / `?3`
   syntax (positional, but
   with explicit numbers).
   This way, the same `?2`
   can be reused across the
   query without losing
   the param identity.

   The lesson: **SQLite's
   `?` placeholder is
   positional; use `?N`
   for the same `$N`
   semantics**. This was
   also the bug that the
   team's `_pgStyle.js`
   refactor (82e7534) was
   designed to prevent, but
   the test harness didn't
   use `_pgStyle.js` (it's
   a separate test-only
   helper). The lesson:
   **test harnesses that
   translate pg-style
   placeholders to sqlite
   must use `?N`, not
   bare `?`**, when the
   same placeholder is
   reused.

4. **The test harness's
   "is this a SELECT" check
   must recognize CTE
   queries.** The test
   harness's query shim
   had `if
   (upper.startsWith('SELECT')
   || upper.includes('
   RETURNING'))` to
   determine if the query
   returns rows. But the
   `getCategoryPath` query
   starts with `WITH
   RECURSIVE`, not `SELECT`.
   So the harness treated
   the CTE as an INSERT
   (used `stmt.run()` instead
   of `stmt.all()`) and
   returned `{rows: []}`.

   The fix: add
   `upper.startsWith('WITH')`
   to the isRead check. The
   lesson: **test harness
   SELECT detection must
   recognize `WITH` (CTE)
   queries**. The existing
   harness predated the
   catalog v2 module, so
   the first recursive CTE
   query surfaced the bug.
   The fix is one line, and
   it now covers both
   regular CTEs (WITH
   ... SELECT) and
   recursive CTEs (WITH
   RECURSIVE ... SELECT).
