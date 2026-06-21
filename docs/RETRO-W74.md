# W74 Summary — Phase 2 projects wave 1 (schema + pure functions + tests)

**Date:** 2026-06-21.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W73-1 shipped Phase 2 desk
end-to-end (wave 1 + wave 2
+ smoke checks). The next
Phase 2 module in the
carry-forward plan was
**projects** (project
management: projects, tasks,
time entries).

W74-1 ships the **wave 1**:
schema (0012_projects.sql)
+ pure functions (8 functions
across 3 tables) + 29 tests.
The module exists and is
unit-tested; the next wave
(route wiring + smoke) will
follow the same 3-wave
pattern as CRM (W70 / W71)
and desk (W72 / W73).

## What shipped

### W74-1 — projects.js + 0012_projects.sql + 29 tests

**Migration `0012_projects.sql`**
(the 12th finance migration):
3 tables + 12 indexes:

- `finance.projects` — the
  project (id, tenant_id,
  code, name, description,
  customer_id, status,
  start_date, end_date,
  owner_id, created_at,
  updated_at). Statuses:
  active / on_hold /
  completed / cancelled. Code
  is a partial unique index
  per tenant.
- `finance.project_tasks` —
  tasks under a project (id,
  tenant_id, project_id,
  name, description, status,
  priority, assignee_id,
  due_date, created_at,
  updated_at). Statuses: todo
  / in_progress / done /
  blocked. Priorities: low /
  normal / high / urgent.
- `finance.project_time_entries`
  — time tracking on tasks
  (id, tenant_id, task_id,
  user_id, work_date, hours,
  billable, description,
  created_at). hours: 0 <
  hours ≤ 24, 2 decimal
  places. billable: 0/1 with
  CHECK constraint.

**Pure functions in
`server/finance/projects.js`**
(442 lines):

- **Projects (3):**
  - `createProject(db, input,
    tenantId)` — inserts a
    project; returns the new
    id. Validates name, code,
    description, customer_id,
    status, start_date,
    end_date, owner_id.
  - `listProjects(db, tenantId,
    status?)` — returns all
    projects for the tenant,
    most recent first.
    Optional status filter.
  - `getProject(db, projectId,
    tenantId)` — returns a
    single project; throws
    `ValueError` on missing or
    cross-tenant.
- **Tasks (3):**
  - `createTask(db, input,
    tenantId)` — inserts a
    task; checks the project
    exists in the tenant
    before INSERT. Throws
    `ValueError` on missing
    project.
  - `listTasks(db, projectId,
    tenantId, status?)` —
    returns tasks for the
    project (chronological).
    Checks project exists
    first; throws `ValueError`
    on missing project.
  - `getTask(db, taskId,
    tenantId)` — returns a
    single task; throws
    `ValueError` on missing or
    cross-tenant.
- **Time entries (2):**
  - `createTimeEntry(db,
    input, tenantId)` —
    inserts a time entry;
    checks the task exists in
    the tenant before INSERT.
    Validates user_id, work_date
    (YYYY-MM-DD), hours (0 <
    hours ≤ 24, 2 decimal
    places), billable (0/1
    /true/false, normalized
    to 0/1).
  - `listTimeEntries(db,
    taskId, tenantId)` —
    returns time entries for
    the task (chronological
    by work_date). Checks
    task exists first; throws
    `ValueError` on missing.

All 8 functions use the
`runQuery(db, sql, params)`
helper pattern (from W71-2)
+ the `ValueError` class
with the constructor that
sets `this.name =
'ValueError'` (the fix from
W73-1 / the memory entry).

**29 tests in
`server/finance/projects.test.js`**
(production-shape harness
with `db.query()` returning
`{ rows: [...] }`):

- **Projects (10 tests):**
  - `createProject` (5) —
    insert + return id, default
    status, status validation,
    name required, date format
    validation.
  - `listProjects` (3) — most
    recent first, tenant-scoped,
    status filter.
  - `getProject` (2) — throws
    `ValueError` for missing,
    tenant-scoped.
- **Tasks (10 tests):**
  - `createTask` (5) — insert
    + return id, missing project
    → throws, default status +
    priority, status + priority
    validation, name required.
  - `listTasks` (4) —
    chronological, missing
    project → throws,
    tenant-scoped, status
    filter.
  - `getTask` (2) — throws
    `ValueError` for missing,
    tenant-scoped.
- **Time entries (8 tests):**
  - `createTimeEntry` (4) —
    insert + return id, missing
    task → throws, hours
    validation (> 0, ≤ 24, 2
    decimal places),
    billable normalization
    (true → 1, false → 0).
  - `listTimeEntries` (3) —
    chronological, missing
    task → throws, tenant-scoped
    (cross-tenant access denied).

All 29 tests pass.

## Test baseline

- **1147 / 1147** tests pass
  (was 1118 before W74-1; the
  29 new projects tests
  account for the +29 delta).
- **`npm run check`** clean
- **`scripts/deploy-smoke.sh`**
  green (no new checks yet;
  projects endpoints aren't
  HTTP-wired — that's wave
  2 / future plan).
- **13 migrations** applied
  (0001_init through
  0012_projects).

## Why it matters

**The projects module is
now a real first-class
citizen of the finance
layer.** The schema is
migrated, the pure functions
are tested, and the module
is ready for the next wave
(route wiring + smoke check
extension).

The 3-wave pattern is now
established across **2
complete module ports**
(CRM + desk) + **1 wave 1
in progress** (projects):

1. **Wave 1:** schema +
   pure functions + unit
   tests.
2. **Wave 2:** route wiring +
   perm keys + smoke check
   extension.
3. **Wave 3** (optional):
   state machines,
   transitions, advanced
   features.

## Carry-forward

The next Phase 2 work
(not blocking; future
plans):

- **Phase 2 projects wave 2**
  (next) — route wiring
  (8+ endpoints: list +
  get + create for projects;
  list + get + create for
  tasks; list + create for
  time entries) + perm keys
  (6 keys: `projects.project.read`,
  `projects.project.create`,
  `projects.task.read`,
  `projects.task.create`,
  `projects.time.read`,
  `projects.time.create`)
  + smoke check extension.
  The `ProjectsOperator`
  perm set already has all
  6 keys.
- **Phase 2 catalog v2** —
  categories, variants,
  bundles, pricing rules
  (the current catalog is
  minimal: SKU + name + UOM
  + unit cost).
- **Phase 2 desk wave 3**
  (optional, future) —
  status transitions +
  assignee management + KB.
- **Phase 2 CRM wave 3**
  (optional, future) —
  update/archive + lead
  status state machine.

**W70 / W71 / W72 / W73 /
W74 established the 3-wave
pattern for Phase 2 module
ports.** All 3 wave-1 modules
(CRM, desk, projects) follow
the same pattern; all 2
wave-2 modules (CRM, desk)
also follow the same pattern.
The lesson: **the 3-wave
pattern is robust across
modules with different
shapes** (CRM is a 2-table
contact/lead structure; desk
is a 2-table case/reply
structure with enums; projects
is a 3-table project/task/
time-entry structure with
FK-like existence checks).

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

## Lessons learned

1. **The 3-table project
   structure with FK-like
   existence checks is the
   right shape for nested
   modules.** Projects has 3
   tables (`projects` → `project_tasks`
   → `project_time_entries`)
   where each child table
   references a parent. The
   pure functions implement
   this as "before INSERT,
   SELECT the parent's id
   within the tenant". The
   check is the same as the
   foreign-key check would
   be, but implemented at the
   application layer (since
   the schema doesn't have a
   real FK constraint — the
   tables are in different
   migrations). The lesson:
   **existence checks in
   pure functions are the
   right pattern for parent/
   child relationships
   across separate migration
   files**. The check enforces
   tenant isolation (cross-
   parent access denied) and
   prevents orphan rows
   (child without parent).

2. **The `list*` functions
   for child tables check
   the parent exists.** Like
   `listReplies` in desk.js,
   `listTasks` and
   `listTimeEntries` check
   the parent (project or
   task) exists in the tenant
   before returning the
   children. This prevents
   an empty-array response on
   a missing parent from
   masking a real client bug
   (the user accidentally
   requested children of a
   missing parent). The
   throw `ValueError('project
   N not found in tenant M')`
   is the right behavior —
   it surfaces the client bug
   early instead of returning
   a confusing empty array.
   The lesson: **list
   functions for child
   tables should check the
   parent exists in the
   tenant** (consistent with
   single-entity GETs). The
   same pattern as
   `listReplies` in desk.js.

3. **The `ValueError` class
   with the constructor fix
   (from W73-1 / memory) is
   now applied from day 1.**
   The projects.js `ValueError`
   class has the constructor
   that sets `this.name =
   'ValueError'`, not the
   minimal form. The desk
   module was the first to
   surface the bug (single-
   entity GETs return 500
   instead of 404); the
   projects module ships with
   the fix already applied.
   The lesson: **the
   `ValueError` class is now
   a copy-paste candidate
   from existing modules with
   the constructor fix
   applied from day 1**. The
   memory entry from W73-1
   captured this lesson; the
   projects module proves the
   lesson is now embedded in
   the workflow.

4. **`assert.rejects` is the
   right test pattern for
   async validation throws.**
   The first version of
   `projects.test.js` used
   `assert.throws` to test
   synchronous `ValueError`
   throws from `createProject`
   (e.g. status validation,
   name required, date format).
   But `createProject` is an
   `async` function — its
   validation throws become
   rejected promises, not
   thrown errors. The
   `assert.throws` check
   failed silently because
   the promise was returned,
   not thrown. The fix: use
   `await assert.rejects(
   asyncFn(), /regex/)` (the
   same pattern as `desk.test.js`).
   The lesson: **for async
   pure functions, use
   `assert.rejects` with
   `await`, not `assert.throws`**.
   The desk test file already
   had this pattern; the
   projects test file
   initially used the
   synchronous form and had
   to be fixed.
