# W80 Summary — Phase 2 catalog v2 wave 3c (pricing rules)

**Date:** 2026-06-21.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W79-1 shipped Phase 2 catalog
v2 wave 3b (bundles route
wiring): 5 endpoints + 4 perm
keys + smoke checks. The
catalog v2 module was
end-to-end functional across
3 sub-features (categories +
variants + bundles).

W80-1 ships the **wave 3c
(pricing rules)**: schema (1
new table: catalog_pricing_rules)
+ 3 pure functions + 11 new
tests. This is the 4th
sub-feature of the catalog
v2 module (the last planned
for now).

Pricing rules are
tenant-scoped configuration
records that describe price
overrides:
- `volume_discount`: buy N+
  get X% off
- `time_based`: date-range
  discount (e.g. holiday
  sale)
- `category_discount`:
  category-based discount

The rule itself is just a
record (header + config_json
blob); the actual price-
application logic (which
rule applies to which item,
how to compute the final
price) is a future concern
(a follow-up wave that
integrates the rules with
the catalog + invoice flow).

## What shipped

### W80-1 — catalog.js extensions + 0015_catalog_pricing.sql + 11 tests

**Migration
`0015_catalog_pricing.sql`**
(the 15th finance migration):
1 new table + 3 new indexes:

- `finance.catalog_pricing_rules` —
  the rule header (id,
  tenant_id, name, type,
  config_json, priority,
  valid_from, valid_to,
  archived, created_at,
  updated_at).
  - `type` is a CHECK
    constraint that
    constrains to 3 values:
    `volume_discount`,
    `time_based`,
    `category_discount`.
    New types require a
    migration.
  - `config_json` is an
    opaque JSON blob (the
    application layer
    interprets it based on
    the type).
  - `priority` is the
    conflict resolution
    field (lower = higher
    priority; the rule
    with the lowest
    priority value wins
    when multiple rules
    match). Default is 100.
  - `valid_from` +
    `valid_to` are
    optional YYYY-MM-DD
    date range (null =
    always valid).
  - `archived` is a
    soft-delete flag (0 =
    active, 1 = archived).
  - 3 indexes for tenant /
    type / archived lookups.

The migration is safe for
both fresh installs (the
smoke deploy case) and
existing installs: it
creates 1 new table + 3
new indexes, and does NOT
alter any existing tables.

**3 new pure functions in
`server/finance/catalog.js`**
(the file now has 15 pure
functions: 4 categories +
3 variants + 5 bundles + 3
pricing rules):

- `createPricingRule(db, input,
  tenantId)` — inserts a
  pricing rule; returns the
  new id. Validates name +
  type required, type must
  be one of 3 supported
  values, config_json +
  priority + valid_from +
  valid_to are optional.
- `listPricingRules(db, tenantId,
  { archived, type } = {})` —
  returns rules for the
  tenant. Default
  (`archived=false`) returns
  only non-archived rules;
  `archived=true` returns all.
  Optional `type` filter
  (returns only rules of the
  given type). Ordered by
  priority ASC (lowest
  priority value = highest
  priority; the most-
  applicable rule appears
  first), then by id ASC.
- `getPricingRule(db, ruleId,
  tenantId)` — single rule;
  throws `ValueError` on
  missing or cross-tenant.

All 3 functions use the
`runQuery(db, sql, params)`
helper pattern (from W71-2)
+ the `ValueError` class
with the constructor that
sets `this.name =
'ValueError'` (the fix from
W73-1, applied from day 1).

**11 new tests in
`server/finance/catalog.test.js`**
(was 39, +11 = 50 total):

- `createPricingRule` (4) —
  insert + return id, default
  priority=100, type
  validation, requires
  name + type, validates
  config_json + priority +
  dates.
- `listPricingRules` (4) —
  returns all non-archived
  rules for the tenant,
  orders by priority ASC
  (lowest first), filters by
  type, tenant-scoped.
- `getPricingRule` (2) —
  throws `ValueError` for
  missing rule, tenant-scoped.

All 11 new tests pass; all
39 W76-1 + W78-1 tests still
pass (no regressions from
the schema extension).

## Test baseline

- **1227 / 1227** tests pass
  (was 1216 before W80-1; the
  11 new catalog pricing
  tests account for the +11
  delta).
- **`npm run check`** clean
  (lint + typecheck + format
  + boundary-check + 1227
  tests + l10n-am audit).
- **`scripts/deploy-smoke.sh`**
  70+ / 70+ (no new checks
  yet; pricing rule
  endpoints aren't HTTP-
  wired — that's wave 3d /
  future plan).
- **16 migrations** applied
  (0001_init through
  0015_catalog_pricing).

## Why it matters

**The catalog v2 module now
has 4 sub-features: categories
(hierarchical), variants
(per-item), bundles (compound
items), and pricing rules
(configuration).** The
schema is migrated, the pure
functions are tested, and the
module is ready for the next
wave (route wiring + smoke
check extension).

Pricing rules enable a
common catalog use case:
configurable price overrides
(volume discounts, holiday
sales, category-wide
promotions). The rule itself
is just a record; the
application logic that
consumes the rules is a
separate concern (a follow-
up wave that integrates the
rules with the catalog +
invoice flow).

## Carry-forward

The remaining Phase 2 work
(not blocking; future
plans):

- **Phase 2 catalog v2 wave
  3d (pricing rules route
  wiring)** (next) — route
  wiring (3+ endpoints: list
  + create + get pricing
  rule) + perm keys (2 new:
  `finance.pricing_rule.read/create`)
  + smoke check extension.
- **Phase 2 pricing rules
  application logic** (a
  follow-up to wave 3d) —
  the actual price-application
  logic that consumes the
  rules. The rule is a
  record; the application
  logic is the consumer.
  This is a separate scope
  (probably a future plan).
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
W78 / W79 / W80 established
the 3-wave pattern for
Phase 2 module ports across
4 modules. The catalog v2
module is the most complex
(4 sub-features: categories
+ variants + bundles +
pricing rules). All 4
sub-features have shipped
wave 1; 3 of them (categories
+ variants + bundles) have
also shipped wave 2.**

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

1. **The pricing rule is a
   configuration record, not
   an application.** The
   `catalog_pricing_rules`
   table is just a record
   (header + config_json
   blob). The actual price-
   application logic (which
   rule applies to which
   item, how to compute the
   final price) is a
   separate concern — a
   consumer of the rules,
   not a producer. The
   lesson: **the table
   stores the rule; the
   application logic
   consumes the rule**. The
   two are separate scopes.
   This split is important
   because:
   - The table can be
     created in wave 3c
     (the current wave);
   - The application logic
     can be a follow-up
     wave (a separate scope
     that integrates the
     rules with the catalog
     + invoice flow).

   The deferred application
   logic is explicitly called
   out in the catalog.js
   comment and the migration
   comments, so future
   readers know that the
   rule is a record and the
   application logic is a
   separate concern.

2. **The `type` field with a
   CHECK constraint is the
   right pattern for
   configurable rule types.**
   The pricing rule's
   `type` field is a CHECK
   constraint with 3 values
   (`volume_discount`,
   `time_based`,
   `category_discount`).
   The `config_json` blob is
   opaque (the application
   layer interprets it based
   on the type). This is the
   standard pattern for
   "polymorphic" rules:
   - The type field is a
     constrained enum
     (CHECK constraint at
     the DB level; the pure
     function also
     validates).
   - The config is an
     opaque JSON blob (the
     application layer
     parses it; the DB
     doesn't enforce a
     schema).
   - New types require a
     migration (the CHECK
     constraint must be
     updated).

   This pattern is extensible
   (a new rule type can be
   added by updating the
   CHECK constraint + the
   pure function's enum +
   the application's parser)
   without breaking existing
   rules (the existing rules'
   config_json is preserved
   as-is).

3. **The `priority` field
   resolves conflicts.** The
   `priority` field is a
   small integer (default
   100). When multiple rules
   match a given item, the
   rule with the lowest
   priority value wins
   (lower = higher priority).
   The `listPricingRules`
   orders by priority ASC
   (the most-applicable rule
   appears first) for UI
   display. The lesson:
   **a numeric priority
   field is the right
   conflict-resolution
   mechanism for
   configuration rules**;
   the alternative
   (timestamps, alphabetical,
   manual ordering) is less
   predictable. The default
   value of 100 is a
   reasonable middle ground
   (the operator can adjust
   per rule, but the default
   is sensible).

4. **`assertDateString` is
   a reusable assertion
   helper that's now defined
   in 3 finance modules.**
   The `assertDateString`
   function (validates
   YYYY-MM-DD format) was
   originally defined in
   `projects.js` (for
   `start_date` / `end_date`
   on the project + `due_date`
   on the task). The
   `catalog.js` module
   (which has `valid_from` +
   `valid_to` on the pricing
   rule) needed the same
   helper, so it was added
   to `catalog.js` (the W80-1
   fix). The helper is now
   duplicated in 3 places
   (`projects.js` +
   `catalog.js` + the
   function definition in
   each module). The lesson:
   **assertion helpers can
   be copy-pasted between
   modules when the schema
   is local to the module**.
   The alternative (a
   shared `_assertions.js`
   helper module) would be
   more work for a
   short helper that doesn't
   change often. The current
   pattern (define the
   helper in each module
   that needs it) is
   pragmatic.

5. **The test harness's
   `makeMemoryDb` is now
   schema-drift prone.** The
   test harness creates the
   tables it needs in the
   main schema. With the
   catalog module now having
   5 tables (categories,
   variants, bundles, bundle
   items, pricing rules), the
   test harness has to keep
   all 5 tables in sync with
   the production schema. So
   far the harness has been
   kept in sync manually (I
   added `catalog_pricing_rules`
   in W80-1). The risk: a
   new column added to the
   production schema in a
   future wave might be
   missed in the test
   harness. The lesson:
   **the test harness's
   schema must be kept in
   sync with the production
   schema manually** until a
   shared schema file (e.g.
   `tests/_schema.sql`) is
   created. The
   production-schema-drift
   lesson (saved to memory in
   W77-1) applies here too:
   the smoke check is the
   load-bearing regression
   guard, not the unit tests.
