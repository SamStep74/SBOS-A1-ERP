# W72 Summary — Phase 2 desk wave 1 (schema + pure functions + tests)

**Date:** 2026-06-21.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W71-3 shipped Phase 2 CRM
end-to-end. The next Phase 2
module in the carry-forward
plan was **desk** (ticketing
/ support: cases, replies,
tracking numbers).

W72-1 ships the **wave 1**:
schema (0011_desk.sql) +
pure functions (createCase,
listCases, getCase,
createReply, listReplies) +
14 tests. The module exists
and is unit-tested; the next
wave (route wiring + smoke)
will follow the same 3-wave
pattern as CRM (W71-1 +
W71-2).

## What shipped

### W72-1 — desk.js + 0011_desk.sql + 14 tests

**Migration `0011_desk.sql`**
(the 11th finance migration):

```sql
CREATE TABLE desk_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  customer_id INTEGER,
  contact_id INTEGER,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN
      ('open','pending','resolved','closed')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN
      ('low','normal','high','urgent')),
  assignee_id INTEGER,
  tracking_number TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX desk_cases_tracking_idx
    ON desk_cases (tenant_id, tracking_number)
    WHERE tracking_number IS NOT NULL;
CREATE TABLE desk_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  case_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL
    CHECK (author IN ('customer','agent')),
  author_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX desk_replies_case_idx
    ON desk_replies (case_id, created_at);
```

Two enums: `status`
(open/pending/resolved/closed)
and `priority`
(low/normal/high/urgent).
Reply `author` enum
(customer/agent). Tracking
number is a unique index
per tenant (partial: only
non-null values are
uniqueness-constrained).

**Pure functions in
`server/finance/desk.js`**
(281 lines):

- `createCase(db, input)` —
  inserts a case row; returns
  the new id. Validates
  subject + body, validates
  status + priority against
  the enums.
- `listCases(db, tenantId,
  { status })` — returns all
  cases for the tenant, most
  recent first. Optional
  status filter.
- `getCase(db, tenantId,
  caseId)` — returns a single
  case; throws `ValueError`
  on missing or cross-tenant
  access.
- `createReply(db, input)` —
  inserts a reply. Validates
  body + author (customer/agent
  enum). Throws `ValueError`
  if the case doesn't exist
  or is cross-tenant.
- `listReplies(db, tenantId,
  caseId)` — returns all
  replies for the case in
  chronological order.

All 5 functions use the
`runQuery(db, sql, params)`
helper pattern (from W71-2),
with `$N` placeholders +
`RETURNING id` (with
`LAST_INSERT_ROWID()`
fallback).

**14 tests in
`server/finance/desk.test.js`**
(production-shape harness
with `db.query()` returning
`{ rows: [...] }`):

- `createCase` (3 tests) —
  insert + return id, default
  status/priority, status +
  priority validation,
  subject + body required.
- `listCases` (3 tests) —
  returns cases for the
  tenant (most recent first),
  tenant-scoped, status filter.
- `getCase` (2 tests) — throws
  `ValueError` for missing
  case, tenant-scoped (cross-
  tenant access denied).
- `createReply` (3 tests) —
  insert + return id, throws
  `ValueError` for missing
  case, validates author
  enum.
- `listReplies` (2 tests) —
  returns replies for the case
  (chronological), tenant-
  scoped.

All 14 tests pass.

## Test baseline

- **1096 / 1096** tests pass
  (was 1082 before W72-1; the
  14 new desk tests account
  for the +14 delta).
- **`npm run check`** clean
  (lint + typecheck + format
  + boundary-check + 1096
  tests + l10n-am audit + new
  deploy-smoke step).
- **`scripts/deploy-smoke.sh`**
  47 / 47 (no changes; the
  desk endpoints aren't
  HTTP-wired yet — that's
  W72-2 / future wave 2).

## Why it matters

**The desk module is now a
real first-class citizen of
the finance layer.** The
schema is migrated, the
pure functions are tested,
and the module is ready for
the next wave (route wiring
+ smoke check extension).

The 3-wave pattern (W70 →
W71 → W72) is establishing
itself as the right cadence
for Phase 2 module ports:

1. **Wave 1 (schema + pure
   functions + unit tests):**
   the module exists in
   code, has a real DB
   table, and is unit-tested
   against a production-
   shape adapter.
2. **Wave 2 (route wiring +
   perm keys + smoke check
   extension):** the module
   is HTTP-accessible and
   end-to-end tested.
3. **Wave 3 (optional,
   future):** advanced
   features — state
   machines, transitions,
   activity log, etc.

## Carry-forward

The next Phase 2 work
(not blocking; future
plans):

- **Phase 2 desk wave 2**
  (next) — route wiring (4+
  endpoints: list cases,
  get case, create case +
  reply) + perm keys
  (`desk.case.read`,
  `desk.case.create`,
  `desk.reply.create`) +
  smoke check extension.
  The `DeskAgent` perm set
  may need to be added to
  `rbac/matrix.js` (CRM had
  `CRMOperator` already; desk
  may not).
- **Phase 2 projects wave 1**
  — project management
  (tasks, time entries,
  milestones).
- **Phase 2 catalog v2** —
  categories, variants,
  bundles, pricing rules
  (the current catalog is
  minimal: SKU + name + UOM
  + unit cost).
- **Phase 2 CRM wave 3**
  — update + archive
  endpoints + deal/pipeline
  tracking + lead status
  transitions.

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

## Lessons learned

1. **`runQuery` is the
   canonical adapter
   pattern.** Every finance
   module in Phase 2 (CRM
   + desk, and the existing
   customer + inventory
   modules) uses the same
   `runQuery(db, sql, params)`
   helper. **The pure
   functions speak the
   production adapter shape
   (`db.query()` returning
   `{ rows: [...] }`) from
   day 1**, even though the
   tests use a sqlite-shaped
   in-memory harness. The
   test harness was updated
   in W71-2 to expose the
   production shape, and
   the desk tests followed
   the same convention. The
   lesson: **the test
   harness shape is the
   production shape**, not
   a relaxed mock. Mock
   tests are a regression
   net for the *interface
   contract*, not a
   substitute for
   integration testing.

2. **The SQLite partial
   unique index is not
   re-creatable in
   `node:sqlite` with a
   `finance.` schema
   prefix.** The test
   harness uses
   `ATTACH DATABASE ':memory:'
   AS finance` + `CREATE
   TABLE finance.desk_cases`
   to mimic the production
   schema isolation. The
   `CREATE UNIQUE INDEX
   finance.desk_cases_*
   WHERE tracking_number IS
   NOT NULL` raises
   `near '.': syntax error`
   in `node:sqlite` —
   `CREATE INDEX` with a
   `finance.` prefix is not
   supported in this
   version of the driver.
   The test harness omits
   the indexes (CRM had
   none too); the queries
   work without them (just
   slower). The migration
   itself (which runs
   against the production
   driver, not the test
   harness) creates the
   indexes normally. The
   lesson: **test schema
   simplification is OK as
   long as the migration
   itself is verified to
   run cleanly against a
   fresh real DB** (which
   `npm run smoke:deploy`
   does — it boots the
   server from a fresh
   `.sbos.db` and runs the
   full migration set).

3. **Existing perm sets
   may not cover the new
   module.** CRM had
   `CRMOperator` already in
   `rbac/matrix.js` (with
   the `crm.*` keys from
   earlier work). **Desk
   has no equivalent
   `DeskAgent` perm set
   yet** — the next wave
   (route wiring) will need
   to either add a new perm
   set OR reuse an existing
   one (`FinanceAdmin` or
   `FinanceClerk`). This
   is a small follow-up;
   the lesson is to check
   the existing perm sets
   *during* the route
   wiring wave, not
   beforehand, so the
   perm decisions are made
   alongside the route
   decisions.

4. **The desk schema is
   multi-table, with a
   unique index on
   `tracking_number`.** The
   unique index uses a
   `WHERE tracking_number
   IS NOT NULL` partial
   constraint — meaning
   most cases will have
   `tracking_number = NULL`
   (auto-generated cases
   don't need a tracking
   number), and only cases
   that *do* have a
   tracking number are
   uniqueness-constrained.
   The use case: a
   customer email / web
   form can submit a case
   with a `tracking_number`
   (e.g. "INC-12345" from
   an external ticketing
   system) and the system
   enforces uniqueness
   per tenant. The lesson:
   **partial unique indexes
   are the right tool for
   "optional external
   reference" fields.**
