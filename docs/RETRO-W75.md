# W75 Summary — Phase 2 projects wave 2 (route wiring + smoke)

**Date:** 2026-06-21.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W74-1 shipped Phase 2 projects
wave 1: schema (0012_projects.sql)
+ 3 tables (projects,
project_tasks, project_time_entries)
+ 8 pure functions + 29 tests.
The module existed but wasn't
HTTP-accessible.

W75-1 ships the wave 2: route
wiring (8 endpoints across 3
tables) + ValueError → 404
conversion for single-entity
GETs + smoke check extension
(11 new checks: 4 reads + 3
404s + 3 POSTs + 4 post-
creation GETs).

**Phase 2 projects is now
end-to-end functional**:
the operator can `GET
/api/finance/projects` and
`POST /api/finance/projects`
and `POST
/api/finance/projects/:id/tasks`
and `POST
/api/finance/projects/:id/tasks/:taskId/time-entries`
against the bootable HTTP
server.

## What shipped

### W75-1 — projects route wiring (8 endpoints)

Added 8 new endpoints to
`server/finance/routes.js`,
using a **fully-nested URL
hierarchy**:

```
/api/finance/projects                          (list + create)
/api/finance/projects/:id                      (get single)
/api/finance/projects/:id/tasks                (list + create)
/api/finance/projects/:id/tasks/:taskId        (get single)
/api/finance/projects/:id/tasks/:taskId/time-entries  (list + create)
```

**Endpoint inventory:**

- `GET  /api/finance/projects`
  — list projects for the
  tenant (`readTenant` +
  `listProjects`; optional
  `?status=` filter; ordered
  by id DESC)
- `POST /api/finance/projects`
  — create a project
  (requireTenant +
  `projects.project.create`
  perm + `wrapFinanceRoute`;
  body: name, code?,
  description?, customer_id?,
  status?, start_date?,
  end_date?, owner_id?)
- `GET  /api/finance/projects/:id`
  — get a single project
  (`getProject`; inline
  ValueError → 404 conversion)
- `GET  /api/finance/projects/:id/tasks`
  — list tasks for a project
  (`listTasks` with optional
  `?status=` filter; inline
  ValueError → 404 conversion
  on missing project)
- `POST /api/finance/projects/:id/tasks`
  — create a task under a
  project (requireTenant +
  `projects.task.create` perm
  + `wrapFinanceRoute`; the
  `project_id` is injected
  from the URL into the input
  body; pure function validates
  via project existence check)
- `GET  /api/finance/projects/:id/tasks/:taskId`
  — get a single task
  (`getTask`; inline ValueError
  → 404 conversion; the
  `project_id` in the URL is
  for URL consistency only —
  the pure function's
  existence check is on the
  task, not the project)
- `GET  /api/finance/projects/:id/tasks/:taskId/time-entries`
  — list time entries for a
  task (`listTimeEntries`;
  inline ValueError → 404
  conversion on missing task)
- `POST /api/finance/projects/:id/tasks/:taskId/time-entries`
  — add a time entry
  (requireTenant +
  `projects.time.create` perm
  + `wrapFinanceRoute`; the
  `task_id` is injected from
  the URL; pure function
  validates via task existence
  check + hours precision +
  billable normalization)

**6 perm keys** (all already
existed): `projects.project.read`,
`projects.project.create`,
`projects.task.read`,
`projects.task.create`,
`projects.time.read`,
`projects.time.create` — all
in the `ProjectsOperator` perm
set in
`server/rbac/matrix.js`. No
permission set changes needed
for W75-1.

**Updated the endpoint
inventory comment at the top
of `routes.js`** to list the
8 new endpoints.

### W75-1.1 — smoke check extension (11 new checks)

- `GET  /api/finance/projects
   tenant=0` (empty DB →
   200, items: [])
- `GET  /api/finance/projects?status=active
   tenant=0` (status filter;
   empty DB → 200)
- `GET  /api/finance/projects/1
   (404 for missing project)` —
   the ValueError → 404
   regression guard
- `GET  /api/finance/projects/1/tasks
   (404 for missing project)` —
   the listTasks existence
   check + ValueError → 404
   conversion
- `POST /api/finance/projects
   (returns id > 0)` — the
   wave-14 production pg
   adapter regression guard
- `POST /api/finance/projects/1/tasks
   (returns id > 0)` — note:
   uses project_id from the
   URL (not the body)
- `POST /api/finance/projects/1/tasks/1/time-entries
   (returns id > 0)` — note:
   uses task_id from the URL;
   body has user_id, work_date,
   hours, billable
- `GET  /api/finance/projects/1
   (returns the project
   created above)`
- `GET  /api/finance/projects/1/tasks
   (returns the task created
   above)`
- `GET  /api/finance/projects/1/tasks/1
   (returns the task created
   above)`
- `GET  /api/finance/projects/1/tasks/1/time-entries
   (returns the entry created
   above)`

11 new smoke checks (4 reads
+ 2 404s + 3 POSTs + 4 post-
creation GETs); all 11 pass.

## Test baseline

- **1159 / 1159** tests pass
  (was 1157 before W75-1; +2
  from the team's CRM
  ValueError audit wave that
  was on origin/main)
- **`npm run check`** clean
- **`scripts/deploy-smoke.sh`**
  50+ / 50+ (was 50 before
  W75-1; +11 projects checks)
- **13 migrations** applied
  (0001_init through
  0012_projects)

## Why it matters

**Phase 2 projects is now
end-to-end functional.** The
operator can:

```bash
TOKEN=$(cat /var/lib/sbos-a1-erp/admin-token)
curl -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" \
     http://127.0.0.1:3000/api/finance/projects

# Create a project
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" -H "Content-Type: application/json" \
     -d '{"name": "Q3 Migration", "code": "PROJ-Q3-2026", "start_date": "2026-07-01"}' \
     http://127.0.0.1:3000/api/finance/projects

# Create a task
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" -H "Content-Type: application/json" \
     -d '{"name": "Set up staging", "priority": "high"}' \
     http://127.0.0.1:3000/api/finance/projects/1/tasks

# Log time
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" -H "Content-Type: application/json" \
     -d '{"user_id": 1, "work_date": "2026-06-21", "hours": 1.5, "billable": true}' \
     http://127.0.0.1:3000/api/finance/projects/1/tasks/1/time-entries

# List time entries
curl -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" \
     http://127.0.0.1:3000/api/finance/projects/1/tasks/1/time-entries
```

The projects module now matches
the shape of the other finance
modules (CRM, desk, customers,
vendors, catalog): HTTP
endpoints with perm gates +
audit logging + tenant isolation
+ 404 for missing entities.

## Carry-forward

The remaining Phase 2 work
(not blocking; future
plans):

- **Phase 2 catalog v2** —
  categories, variants,
  bundles, pricing rules (the
  current catalog is minimal:
  SKU + name + UOM + unit
  cost). The next major module
  port; the existing catalog
  module is at Wave 7.
- **Phase 2 desk wave 3**
  (optional, future) —
  status transitions
  (open → pending → resolved
  → closed) + assignee
  management + case
  escalation + knowledge
  base.
- **Phase 2 CRM wave 3**
  (optional, future) —
  update + archive endpoints
  + deal/pipeline tracking +
  lead status state machine.
- **Phase 2 projects wave 3**
  (optional, future) — task
  status transitions
  (todo → in_progress → done
  → blocked) + assignee
  management + project
  billing/profitability
  reports (the
  `projects.billing.*` and
  `projects.profitability.read`
  perms exist but the
  reports are not built yet).

**W70 / W71 / W72 / W73 /
W74 / W75 established the
3-wave pattern for Phase 2
module ports. All 3 wave-1
modules (CRM, desk, projects)
follow the same pattern; all
3 wave-2 modules (CRM, desk,
projects) also follow the
same pattern. The catalog
v2 module is the next port;
it can follow the same
pattern with confidence.**

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
  stale (should be 50+;
  pre-existing, out of scope).

## Lessons learned

1. **The fully-nested URL
   hierarchy is the right
   pattern for hierarchical
   modules.** Projects is a
   3-table hierarchy (project
   → task → time entry). The
   URL hierarchy matches the
   table hierarchy:
   `/projects/:id/tasks/:taskId/time-entries`.
   The alternative — flat URLs
   like `/projects/tasks/:taskId`
   — would be inconsistent
   with the create endpoints
   (which need the parent
   project_id to create a
   child task). The fully-
   nested pattern is more
   verbose but is consistent
   across read + create. The
   lesson: **the URL hierarchy
   should match the data
   hierarchy** for hierarchical
   modules. The desk module
   already followed this
   pattern (`/cases/:id/replies`).
   The projects module extends
   it one more level deep
   (`/projects/:id/tasks/:taskId/time-entries`).

2. **The URL parameter
   injection pattern.** The
   `createTask` pure function
   takes `input.project_id`
   from the body. The route
   extracts the `project_id`
   from the URL parameter
   (`req.params.id`) and
   injects it into the input
   body via spread:
   ```js
   const input = { ...(req.body || {}), project_id: projectId };
   const out = await createTask(pgAdapter, input, tenantId);
   ```
   This way the client doesn't
   have to repeat the
   `project_id` in the body
   (it's already in the URL).
   The pure function's
   validation still applies
   (the project_id is checked
   for existence + tenant
   isolation). The same
   pattern applies to
   `createTimeEntry` with
   `task_id` from the URL.
   The lesson: **URL
   parameters should be the
   source of truth for parent
   IDs**; the body should not
   have to repeat them. The
   pure function still takes
   the ID from the body (for
   testability + consistency
   with non-HTTP callers),
   but the route injects the
   URL parameter.

3. **The `ValueError` class
   fix is now the default
   for new modules.** The
   projects.js `ValueError`
   class has the constructor
   that sets `this.name =
   'ValueError'`, applied from
   day 1 (the W73-1 lesson +
   the team's Wave 23 CRM
   audit that closed the gap
   for CRM). The inline
   `err.name === 'ValueError'
   && /not found in tenant/i`
   check in the route handlers
   is now the standard pattern
   for single-entity GETs.
   The lesson: **the
   `ValueError` class is now
   a copy-paste candidate
   with the fix applied**;
   the inline 404 conversion
   is now the standard pattern
   for single-entity GETs.
   The combination is
   enforced by:
   - The memory entry
     (W73-1)
   - The unit tests
     (projects.test.js has
     8 tests that check
     `err.name === 'ValueError'`
     indirectly via regex
     matching)
   - The smoke checks
     (W73-1 + W75-1 both
     have 404 expectations
     for missing entities)
   - The team's Wave 23
     audit (4d707d4) that
     added a regression
     test for the CRM
     ValueError fix

4. **3 wave-1 modules + 3
   wave-2 modules completed
   in 1 session.** The 3-wave
   pattern is now established
   across 3 modules (CRM +
   desk + projects). The
   session shipped 6 waves
   (W70 / W71 / W72 / W73 /
   W74 / W75) end-to-end. The
   catalog v2 module is the
   next port and can follow
   the same pattern. The
   lesson: **the 3-wave
   pattern is the right
   cadence for Phase 2 module
   ports**, and a single
   focused session can ship
   2-3 complete module ports
   if the work is bounded.
