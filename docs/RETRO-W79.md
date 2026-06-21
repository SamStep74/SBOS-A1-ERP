# W79 Summary — Phase 2 catalog v2 wave 3b (bundles route wiring + smoke)

**Date:** 2026-06-21.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W78-1 shipped Phase 2 catalog
v2 wave 3a (bundles): schema
(2 new tables: catalog_bundles
+ catalog_bundle_items) + 5
pure functions + 14 tests.
The bundles module existed
but wasn't HTTP-accessible.

W79-1 ships the wave 3b:
route wiring (5 endpoints) +
4 new perm keys +
CatalogOperator extension +
FinanceOperator extension +
smoke check extension (8 new
checks: 4 reads + 2 404s + 2
POSTs + 2 post-creation
GETs).

**Phase 2 catalog v2 wave 3b
(bundles) is now end-to-end
functional**: the operator
can `GET
/api/finance/catalog/bundles`
and `POST
/api/finance/catalog/bundles`
and `GET
/api/finance/catalog/bundles/:id/items`
(returns the recipe) and
`POST
/api/finance/catalog/bundles/:id/items`
(adds an item to the
bundle's recipe) against the
bootable HTTP server.

**Combined with W76+W77, the
catalog v2 module is now
end-to-end functional across
3 sub-features: categories
(hierarchical), variants
(per-item), and bundles
(compound items).**

## What shipped

### W79-1 — bundles route wiring (5 endpoints)

Added 5 new endpoints to
`server/finance/routes.js`:

- `GET  /api/finance/catalog/bundles?archived=`
  — list bundles for the
  tenant. Default
  (`archived=false`) returns
  only non-archived bundles;
  `?archived=true` returns all
  bundles (including archived)
  — useful for cleanup views.
- `POST /api/finance/catalog/bundles`
  — create a bundle
  (requireTenant +
  `finance.bundle.create` perm
  + `wrapFinanceRoute`;
  body: sku, name,
  description?,
  bundle_price_amd?).
- `GET  /api/finance/catalog/bundles/:id`
  — get a single bundle
  (requireTenant +
  `finance.bundle.read` perm;
  inline ValueError → 404
  conversion).
- `GET  /api/finance/catalog/bundles/:id/items`
  — list recipe rows for a
  bundle (requireTenant +
  `finance.bundle_item.read`
  perm; inline ValueError →
  404 conversion on missing
  bundle).
- `POST /api/finance/catalog/bundles/:id/items`
  — add a recipe row to a
  bundle (requireTenant +
  `finance.bundle_item.create`
  perm + `wrapFinanceRoute`;
  the `bundle_id` is injected
  from the URL).

**Updated the endpoint
inventory comment at the top
of `routes.js`** to list the
5 new endpoints.

### W79-1.1 — 4 new perm keys (finance.bundle.* + finance.bundle_item.*)

Added 4 new perm keys to
`server/rbac/permissions.js`:

- `finance.bundle.read` —
  list + get bundle
- `finance.bundle.create` —
  create bundle
- `finance.bundle_item.read` —
  list bundle items
- `finance.bundle_item.create` —
  add bundle item

All 4 are sensitivity `low`
(read) or `medium` (create),
matching the existing
`finance.category.*` /
`finance.variant.*` pattern.

### W79-1.2 — CatalogOperator + FinanceOperator extension

The new `CatalogOperator`
perm set (added in W77-1)
was extended to include the
4 new perm keys — now 8
catalog v2 keys total
(finance.category.* + finance.variant.* + finance.bundle.* + finance.bundle_item.*).

The `FinanceOperator` set
was also extended to include
the 4 new perm keys — so
the admin user (who has the
FinanceOperator set) gets
the new keys transitively.

### W79-1.3 — smoke check extension (8 new checks)

- `GET  /api/finance/catalog/bundles
   tenant=0` (empty DB →
   200, items: [])
- `GET  /api/finance/catalog/bundles?archived=true
   tenant=0` (archived opt-in;
   empty DB → 200)
- `GET  /api/finance/catalog/bundles/1
   (404 for missing bundle)`
- `GET  /api/finance/catalog/bundles/1/items
   (404 for missing bundle)`
- `POST /api/finance/catalog/bundles
   (returns id > 0)` — the
   wave-14 production pg
   adapter regression guard
- `POST /api/finance/catalog/bundles/1/items
   (returns id > 0)` —
   depends on the bundle +
   catalog item (id=1, created
   by the earlier catalog
   item smoke check)
- `GET  /api/finance/catalog/bundles/1
   (returns the bundle
   created above)`
- `GET  /api/finance/catalog/bundles/1/items
   (returns the recipe item
   created above)`

8 new smoke checks (4 reads
+ 2 404s + 2 POSTs + 2
post-creation GETs); all 8
pass.

## Test baseline

- **1213 / 1213** tests pass
  (no regressions; the 14
  catalog bundle tests from
  W78-1 still pass after the
  route wiring + perm
  extensions)
- **`npm run check`** clean
  (lint + typecheck + format
  + boundary-check + 1213
  tests + l10n-am audit)
- **`scripts/deploy-smoke.sh`**
  70+ / 70+ (was 60+ before
  W79-1; +8 bundle checks)
- **15 migrations** applied
  (0001_init through
  0014_catalog_bundles)

## Why it matters

**Phase 2 catalog v2 is now
end-to-end functional across
3 sub-features**: categories
(hierarchical, with
breadcrumb paths),
variants (per-item size/color
attributes), and bundles
(compound items with a fixed
price + recipe). The
operator can now model a
complete product catalog:

```bash
TOKEN=$(cat /var/lib/sbos-a1-erp/admin-token)

# Create a category
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" -H "Content-Type: application/json" \
     -d '{"name": "Office Furniture", "slug": "office-furniture"}' \
     http://127.0.0.1:3000/api/finance/catalog/categories

# Create a variant
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" -H "Content-Type: application/json" \
     -d '{"sku": "CHAIR-RED", "name": "Red", "unit_price_amd": 50000}' \
     http://127.0.0.1:3000/api/finance/catalog/items/1/variants

# Create a bundle
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" -H "Content-Type: application/json" \
     -d '{"sku": "OFFICE-STARTER", "name": "Office Starter Pack", "bundle_price_amd": 200000}' \
     http://127.0.0.1:3000/api/finance/catalog/bundles

# Add an item to the bundle's recipe
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" -H "Content-Type: application/json" \
     -d '{"catalog_item_id": 1, "quantity": 1}' \
     http://127.0.0.1:3000/api/finance/catalog/bundles/1/items

# View the recipe
curl -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" \
     http://127.0.0.1:3000/api/finance/catalog/bundles/1/items
```

The catalog v2 module now
matches the shape of the
other finance modules (CRM,
desk, projects): HTTP
endpoints with perm gates +
audit logging + tenant
isolation + 404 for missing
entities.

## Carry-forward

The remaining Phase 2 work
(not blocking; future
plans):

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
W78 / W79 established the
3-wave pattern for Phase 2
module ports across 4
modules. The catalog v2
module is the most complex
(3 sub-features: categories
+ variants + bundles, with
a 4th planned: pricing
rules). All 3 sub-features
have shipped wave 1 + wave
2.**

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

1. **The catalog v2 module
   is 3 sub-features, each
   following the 3-wave
   pattern.** Categories
   (W76/W77), variants
   (W76/W77), and bundles
   (W78/W79) all follow the
   same pattern: wave 1 =
   schema + pure functions +
   tests; wave 2 = route
   wiring + perm keys +
   smoke checks. The catalog
   v2 module is the first
   Phase 2 module to span
   multiple "wave 1 + wave 2"
   cycles (each sub-feature
   is its own wave 1 + wave
   2 pair). The lesson:
   **the 3-wave pattern
   scales to multi-sub-
   feature modules** by
   treating each sub-feature
   as its own wave 1 + wave
   2 cycle. The catalog v2
   module has shipped
   categories + variants +
   bundles; pricing rules
   would be the 4th.

2. **The W77-1 / W78-1
   `requireTenant` +
   `requirePerm` pattern is
   now the standard.** Wave
   27 added `requirePerm` to
   all 33 finance GET routes
   (closing a security gap).
   Wave 28 added `requireTenant`
   to the same routes. The
   new W79-1 routes use the
   same pattern: every GET
   has `requireTenant` +
   `requirePerm('<key>.read')`;
   every POST has
   `requireTenant` +
   `requirePerm('<key>.create')`
   + `wrapFinanceRoute`. The
   inline ValueError → 404
   conversion is the W73-1
   pattern (still required
   because the global error
   handler returns 500 for
   everything). The lesson:
   **the perm gate +
   tenant middleware is the
   standard pattern for
   finance routes**; new
   routes should follow the
   same pattern from day 1.

3. **The catalog v2 module's
   8 perm keys are
   consolidated into 1 perm
   set (CatalogOperator).**
   The CatalogOperator set
   was introduced in W77-1
   with 4 keys; W79-1 added
   the 4 bundle keys (now 8).
   The 8 keys map to 5
   endpoints (12 routes if
   you count the variants
   endpoint + the bundle
   item endpoints). The
   FinanceOperator set also
   includes the 8 keys (so
   the admin user gets them
   transitively). The lesson:
   **a single perm set
   bundling all 8 catalog v2
   keys is the right
   granularity** — finer-
   grained sets (e.g.
   CategoryReader,
   VariantReader,
   BundleReader) would be
   more work for the operator
   (assigning 3 sets to a
   user vs 1) without a
   realistic use case (the
   user typically needs all
   catalog v2 perms together
   or none of them).

4. **The 3-wave pattern is
   now established across
   4 modules with 3 sub-
   features.** The pattern
   holds:
   - **CRM** (W70/W71): 2
     tables (contacts + leads)
   - **desk** (W72/W73): 2
     tables (cases + replies)
     with enums
   - **projects** (W74/W75):
     3 tables (projects +
     tasks + time entries)
     with FK-like existence
     checks
   - **catalog v2**
     (W76/W77 + W78/W79):
     5 tables (categories +
     variants + bundles +
     bundle items + the
     existing flat catalog)
     with hierarchical data

   The lesson: **the 3-wave
   pattern is robust across
   module shapes and
   sub-feature counts**. The
   pattern's invariants
   (schema + pure functions +
   tests in wave 1; route
   wiring + perm keys +
   smoke checks in wave 2)
   hold for any module with
   1+ tables and 3+ pure
   functions.
