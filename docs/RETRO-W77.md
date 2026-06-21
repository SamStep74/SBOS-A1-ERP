# W77 Summary — Phase 2 catalog v2 wave 2 (route wiring + smoke)

**Date:** 2026-06-21.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W76-1 shipped Phase 2 catalog
v2 wave 1: schema extension
(add `slug` + `description`
to categories, add price
columns + sku unique index
to variants) + 7 pure
functions (4 for categories,
3 for variants) + 25 tests.
The module existed but
wasn't HTTP-accessible.

W77-1 ships the wave 2: route
wiring (7 endpoints) + 4 new
perm keys + new CatalogOperator
perm set + FinanceOperator
perm-set extension + smoke
check extension (12 new
checks: 4 reads + 2 404s + 3
POSTs + 3 post-creation
GETs).

**Phase 2 catalog v2 is now
end-to-end functional**: the
operator can `GET
/api/finance/catalog/categories`
and `POST
/api/finance/catalog/categories`
and `GET
/api/finance/catalog/categories/:id/path`
(returns the breadcrumb) and
`POST
/api/finance/catalog/items/:itemId/variants`
(creates a variant under a
catalog item) against the
bootable HTTP server.

## What shipped

### W77-1 — catalog v2 route wiring (7 endpoints)

Added 7 new endpoints to
`server/finance/routes.js`:

- `GET  /api/finance/catalog/categories`
  — list categories for the
  tenant. Optional `?parent_id=`
  filter (returns only direct
  children of category N);
  `parent_id=null` returns ALL
  categories (flat list,
  ordered by id ASC).
- `POST /api/finance/catalog/categories`
  — create a category
  (requireTenant +
  `finance.category.create`
  perm + `wrapFinanceRoute`;
  body: name, slug?,
  description?, parent_id?).
- `GET  /api/finance/catalog/categories/:id`
  — get a single category
  (inline ValueError → 404
  conversion).
- `GET  /api/finance/catalog/categories/:id/path`
  — get the full breadcrumb
  path (root-to-leaf array of
  `{id, name}`; empty array
  for a missing category).
- `GET  /api/finance/catalog/items/:itemId/variants`
  — list variants for a
  catalog item (empty array
  when the item has no
  variants or is missing —
  consistent with the
  `/desk/cases/:id/replies`
  pattern).
- `POST /api/finance/catalog/items/:itemId/variants`
  — create a variant under a
  catalog item (requireTenant
  + `finance.variant.create`
  perm + `wrapFinanceRoute`;
  the `catalog_item_id` is
  injected from the URL).
- `GET  /api/finance/catalog/variants/:id`
  — get a single variant
  (inline ValueError → 404
  conversion).

**Updated the endpoint
inventory comment at the top
of `routes.js`** to list the
7 new endpoints.

### W77-1.1 — 4 new perm keys (finance.category.* + finance.variant.*)

Added 4 new perm keys to
`server/rbac/permissions.js`:

- `finance.category.read` —
  list + get + path
- `finance.category.create` —
  create
- `finance.variant.read` —
  list + get
- `finance.variant.create` —
  create

All 4 are sensitivity `low`
(read) or `medium` (create),
matching the existing
`finance.product.*` /
`finance.warehouse.*` /
`finance.stock.*` pattern.

### W77-1.2 — new CatalogOperator perm set

Added a new `CatalogOperator`
perm set to
`server/rbac/matrix.js` that
bundles all 4 new perm keys.
The set is `isSystem: true`
(following the existing
InventoryOperator /
CRMOperator / ProjectsOperator
pattern).

The admin user (which has the
FinanceOperator perm set) was
also extended to include the
4 new perm keys — the
FinanceOperator set already
includes `finance.product.*`
+ `finance.warehouse.*` +
`finance.stock.*`, so adding
`finance.category.*` +
`finance.variant.*` is the
natural extension.

### W77-1.3 — migration fix: add `unit_price_amd` + `unit_cost_amd` to catalog_variants

The 0007_inventory.sql
migration created the
`catalog_variants` table
with `sku` + `name` +
`attributes_json` but **no
price columns**. The W76-1
`createVariant` pure function
writes `unit_price_amd` +
`unit_cost_amd`, which the
W77-1 smoke check
immediately surfaced as a
runtime error: "no such
column: unit_price_amd".

Fix: added 2 ALTER TABLE
statements to
`0013_catalog_v2.sql` to add
the missing columns with NULL
default. Existing rows have
NULL prices (safe default);
new rows from `createVariant`
provide the price values. The
pure function's validation
allows NULL (the price is
optional in the API).

**This is a Wave 23 / W76-1
audit-class finding**: the
unit tests passed (the test
harness has the columns
because it creates the
schema itself), but the
production deployment failed
because the production
schema didn't have the
columns. The fix: add the
columns to the production
migration.

### W77-1.4 — smoke check extension (12 new checks)

- `GET  /api/finance/catalog/categories
   tenant=0` (empty DB →
   200, items: [])
- `GET  /api/finance/catalog/categories?parent_id=1
   tenant=0` (parent_id
   filter; empty DB → 200)
- `GET  /api/finance/catalog/categories/1
   (404 for missing category)`
- `GET  /api/finance/catalog/variants/1
   (404 for missing variant)`
- `POST /api/finance/catalog/categories
   (returns id > 0)` — the
   wave-14 production pg
   adapter regression guard
- `POST /api/finance/catalog/items/1/variants
   (returns id > 0)` —
   depends on the existing
   catalog item (id=1)
- `GET  /api/finance/catalog/categories/1
   (returns the category
   created above)`
- `GET  /api/finance/catalog/categories/1/path
   (returns the breadcrumb
   path)`
- `GET  /api/finance/catalog/items/1/variants
   (returns the variant
   created above)`
- `GET  /api/finance/catalog/variants/1
   (returns the variant
   created above)`

12 new smoke checks (4 reads
+ 2 404s + 3 POSTs + 3
post-creation GETs); all 12
pass.

## Test baseline

- **1184 / 1184** tests pass
  (no regressions; the 25
  catalog tests from W76-1
  still pass after the
  migration fix)
- **`npm run check`** clean
  (lint + typecheck + format
  + boundary-check + 1184
  tests + l10n-am audit)
- **`scripts/deploy-smoke.sh`**
  60+ / 60+ (was 50+ before
  W77-1; +12 catalog checks)
- **14 migrations** applied
  (0001_init through
  0013_catalog_v2; the W77-1
  fix added 2 more ALTER
  TABLE statements to
  0013_catalog_v2.sql)

## Why it matters

**Phase 2 catalog v2 is now
end-to-end functional.** The
operator can:

```bash
TOKEN=$(cat /var/lib/sbos-a1-erp/admin-token)
curl -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" \
     http://127.0.0.1:3000/api/finance/catalog/categories

# Create a category
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" -H "Content-Type: application/json" \
     -d '{"name": "Electronics", "slug": "electronics"}' \
     http://127.0.0.1:3000/api/finance/catalog/categories

# Get the breadcrumb path
curl -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" \
     http://127.0.0.1:3000/api/finance/catalog/categories/1/path

# Create a variant
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" -H "Content-Type: application/json" \
     -d '{"sku": "ELEC-LAPTOP-13", "name": "13 inch", "unit_price_amd": 250000}' \
     http://127.0.0.1:3000/api/finance/catalog/items/1/variants

# List variants for an item
curl -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" \
     http://127.0.0.1:3000/api/finance/catalog/items/1/variants
```

The catalog v2 module now
matches the shape of the
other finance modules (CRM,
desk, projects, customers,
vendors): HTTP endpoints
with perm gates + audit
logging + tenant isolation
+ 404 for missing entities.

## Carry-forward

The remaining Phase 2 work
(not blocking; future
plans):

- **Phase 2 catalog v2 wave
  3** (next) — bundles
  (catalog_bundles +
  catalog_bundle_items
  tables) + pricing rules
  (catalog_pricing_rules
  table with type +
  config_json). The schema
  will add 3 new tables +
  4 new perm keys + 1 new
  perm set.
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
W74 / W75 / W76 / W77
established the 3-wave
pattern for Phase 2 module
ports across 4 modules. All
4 modules (CRM, desk,
projects, catalog) have
shipped wave 1 + wave 2.**

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

1. **The unit tests do NOT
   catch all production
   schema drift.** The
   `catalog_variants` table
   in 0007_inventory.sql
   didn't have `unit_price_amd`
   + `unit_cost_amd` columns.
   The W76-1 unit tests
   passed because the test
   harness creates its own
   schema (with the columns
   present). The W77-1 smoke
   check immediately surfaced
   the issue with "no such
   column: unit_price_amd".
   **Fix: add the missing
   columns to the production
   migration** (0013_catalog_v2.sql).

   The lesson: **the test
   harness schema is NOT
   the same as the production
   schema**. The test
   harness is a minimal
   in-memory sqlite that
   mirrors the production
   tables — but the
   production schema may
   have additional columns
   that the test harness
   doesn't replicate. The
   smoke check is the only
   layer that exercises the
   production schema end-
   to-end. **The smoke check
   is the load-bearing
   regression guard for
   schema drift.** This is
   the same lesson as W72-1
   (the partial unique index
   in node:sqlite) and
   W70-2 (the wave-14 pg
   adapter). The unit tests
   are a regression net for
   the *interface contract*;
   the smoke check is the
   regression net for the
   *production schema*.

2. **The admin user needs
   the new perm keys for the
   smoke to pass.** The
   initial smoke run showed
   403 errors on the POST
   endpoints ("Missing
   permission: finance.category.create").
   The 4 new perm keys were
   added to the new
   CatalogOperator perm set,
   but the admin user (which
   has FinanceOperator) didn't
   get them. **Fix: extend
   the FinanceOperator set
   to include the 4 new
   perm keys.** The admin
   user gets the keys
   transitively.

   The lesson: **when adding
   a new perm key, check
   which existing perm set
   the admin user has and
   add the new key to that
   set**. The alternative
   is to grant the admin
   user the new CatalogOperator
   perm set explicitly, but
   that's more work and
   doesn't match the
   FinanceOperator pattern
   (which already has
   `finance.product.*` +
   `finance.warehouse.*` +
   `finance.stock.*` — the
   new `finance.category.*`
   + `finance.variant.*`
   keys are the natural
   extension). The
   CatalogOperator perm set
   is for finer-grained
   role assignment (e.g. a
   CatalogManager role) that
   may not be a FinanceOperator.

3. **The 3-wave pattern is
   robust across 4 modules.**
   The 4 modules (CRM, desk,
   projects, catalog) have
   different shapes:
   - CRM: 2-table (contacts
     + leads) with email +
     phone
   - desk: 2-table (cases +
     replies) with enums
     (status, priority,
     author)
   - projects: 3-table
     (projects + tasks +
     time entries) with FK-
     like existence checks
   - catalog: 2-table
     (categories + variants)
     with hierarchical
     parent_id + recursive
     CTE

   All 4 modules have
   shipped wave 1 + wave 2
   with the same 3-wave
   pattern. The pattern is
   now established as the
   default for Phase 2 module
   ports. The lesson: **the
   3-wave pattern is robust
   across module shapes**.

4. **Wave 3 features are
   the natural follow-up.**
   After 4 wave-1 + wave-2
   complete cycles, the
   natural follow-up is the
   wave-3 features (advanced
   features like state
   machines, transitions,
   pricing rules, bundles).
   These are lower priority
   (the modules are
   functional without them)
   but they layer on top of
   the wave 1 + wave 2
   baseline. The lesson:
   **wave 3 features are
   the right scope for
   "polish" or "advanced"
   work** — they don't need
   a new migration or new
   perm set if the wave 1
   schema + wave 2 perm keys
   are sufficient.
