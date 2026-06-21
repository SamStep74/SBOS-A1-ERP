# W73 Summary — Phase 2 desk wave 2 (route wiring + smoke)

**Date:** 2026-06-21.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W72-2 shipped Phase 2 desk
wave 1: schema (0011_desk.sql)
+ pure functions (createCase,
listCases, getCase,
createReply, listReplies) +
14 tests. The module existed
but wasn't HTTP-accessible.

W73-1 ships the wave 2: route
wiring (5 endpoints) + ValueError
→ 404 conversion for single-
entity GETs + smoke check
extension (4 new checks: 2
404s + 2 POST returns-id).

**Phase 2 desk is now
end-to-end functional**:
the operator can `GET
/api/finance/desk/cases` and
`POST /api/finance/desk/cases`
and `POST
/api/finance/desk/cases/:id/replies`
against the bootable HTTP
server.

## What shipped

### W73-1 — desk route wiring (5 endpoints)

Added 5 new endpoints to
`server/finance/routes.js`:

- `GET  /api/finance/desk/cases`
  — list cases for the tenant
  (`readTenant` + `listCases`,
  optional `?status=` filter;
  ordered by id DESC)
- `GET  /api/finance/desk/cases/:id`
  — get a single case
  (`getCase`; inline
  ValueError → 404 conversion)
- `POST /api/finance/desk/cases`
  — create a case
  (requireTenant + `desk.case.create`
  perm + `wrapFinanceRoute`;
  body: subject, body,
  status?, priority?, ...)
- `GET  /api/finance/desk/cases/:id/replies`
  — list replies for a case
  (existence check via
  `getCase` → 404 inline +
  `listReplies` for the items;
  no existence-oracle leak)
- `POST /api/finance/desk/cases/:id/replies`
  — add a reply to a case
  (requireTenant + `desk.reply.create`
  perm + `wrapFinanceRoute`;
  body: body, author, author_id?)

The `desk.case.read`,
`desk.case.create`,
`desk.reply.create` perm
keys already existed in
`server/rbac/permissions.js`
+ the `DeskOperator` perm set
already had all 3 keys in
`server/rbac/matrix.js`. No
permission set changes were
needed for W73-1.

**Updated the endpoint
inventory comment at the
top of `routes.js`** to list
the 5 new endpoints.

### W73-1.1 — ValueError class fix (the only gotcha)

The `ValueError` class in
`desk.js` was defined as
`export class ValueError
extends Error {}` — the
inherited `name` property
defaults to `"Error"`, NOT
`"ValueError"`. This meant
the route handler's check
`err.name === 'ValueError'`
always failed, and the
single-entity GET endpoints
returned **500** (not 404)
for missing cases.

**Fix:** added a constructor
that sets `this.name =
'ValueError'`:

```js
export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}
```

This is the same pattern as
`customer.js` and
`inventory.js`. The CRM
module (`crm.js`) had the
same bug but it didn't
matter because CRM has no
single-entity GETs that
throw — only list endpoints
which return empty arrays,
not ValueError.

**Lesson for future module
ports:** the `ValueError`
class in a new module must
set `this.name = 'ValueError'`
in its constructor, or the
route layer's ValueError →
404 conversion will silently
fail. The class is a copy-
paste candidate from existing
modules; the existing
modules have the fix, the new
modules need it added
explicitly.

### W73-1.2 — smoke check extension (4 new checks)

- `GET  /api/finance/desk/cases
   tenant=0` (empty DB →
   200, items: [])
- `GET  /api/finance/desk/cases?status=open
   tenant=0` (status filter;
   empty DB → 200)
- `GET  /api/finance/desk/cases/1
   (404 for missing case)` —
   the ValueError → 404
   regression guard
- `GET  /api/finance/desk/cases/1/replies
   (404 for missing case)`
- `POST /api/finance/desk/cases
   (returns id > 0)` — the
   wave-14 production pg
   adapter regression guard
- `POST /api/finance/desk/cases/1/replies
   (returns id > 0)`
- `GET  /api/finance/desk/cases/1
   (returns the case created
   above)`
- `GET  /api/finance/desk/cases/1/replies
   (returns the reply created
   above)`

8 new smoke checks (2 reads
+ 2 404s + 2 POSTs + 2
post-creation GETs); all 8
pass.

## Test baseline

- **1118 / 1118** tests pass
  (no regressions; the 14
  desk tests from W72-1 still
  pass after the ValueError
  class fix)
- **`npm run check`** clean
- **`scripts/deploy-smoke.sh`**
  50 / 50 (was 42 before
  W73-1; +8 desk checks)
- **12 migrations** applied
  (0001_init through
  0011_desk; the 2
  `0009_*.sql` files
  alphabetically order as
  `0009_crm.sql` then
  `0009_replenishment.sql` —
  pre-existing, not introduced
  by W73-1)

## Why it matters

**Phase 2 desk is now
end-to-end functional.** The
operator can:

```bash
TOKEN=$(cat /var/lib/sbos-a1-erp/admin-token)
curl -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" \
     http://127.0.0.1:3000/api/finance/desk/cases

# Create a case
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" -H "Content-Type: application/json" \
     -d '{"subject": "Cant login", "body": "User cant log in", "priority": "high"}' \
     http://127.0.0.1:3000/api/finance/desk/cases

# Add a reply
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" -H "Content-Type: application/json" \
     -d '{"body": "Reset your password", "author": "agent"}' \
     http://127.0.0.1:3000/api/finance/desk/cases/1/replies

# List replies
curl -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" \
     http://127.0.0.1:3000/api/finance/desk/cases/1/replies
```

The desk module now matches
the shape of the other
finance modules (CRM,
customers, vendors, catalog):
HTTP endpoints with perm
gates + audit logging +
tenant isolation + 404 for
missing entities.

## Carry-forward

The remaining Phase 2 work
(not blocking; future
plans):

- **Phase 2 projects wave 1**
  — project management
  (tasks, time entries,
  milestones).
- **Phase 2 catalog v2** —
  categories, variants,
  bundles, pricing rules (the
  current catalog is minimal:
  SKU + name + UOM + unit
  cost).
- **Phase 2 desk wave 3**
  (optional, future) —
  status transitions
  (open → pending →
  resolved → closed) +
  assignee management +
  case escalation +
  knowledge base (the
  `desk.knowledge.read` /
  `desk.knowledge.update`
  perms exist but the
  module is not built yet).
- **Phase 2 CRM wave 3**
  (optional, future) —
  update + archive endpoints
  + lead status state machine.

**W70 / W71 / W72 / W73
established the 3-wave
pattern for Phase 2 module
ports:**

1. **Wave 1:** schema +
   pure functions + unit
   tests.
2. **Wave 2:** route wiring
   + ValueError → 404 inline
   conversion for single-
   entity GETs + perm keys
   (often pre-existing) +
   smoke check extension.
3. **Wave 3** (optional):
   state machines,
   transitions, advanced
   features.

The projects and catalog
modules can follow the same
3-wave pattern.

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
  alphabetically; could be
  renamed for clarity in a
  future plan — out of scope
  for W73).

## Lessons learned

1. **`ValueError.name` is
   a copy-paste trap.** The
   `ValueError` class in a
   new module must set
   `this.name = 'ValueError'`
   in its constructor. The
   minimal form `export class
   ValueError extends Error
   {}` is the bug — the
   inherited `name` defaults
   to `"Error"`, not
   `"ValueError"`, and the
   route layer's
   `err.name === 'ValueError'`
   check silently fails. The
   class is a copy-paste
   candidate from existing
   modules (`customer.js`,
   `inventory.js`); the
   existing modules have the
   fix, the new modules need
   it added explicitly.
   **The lesson:** when
   porting a new module, the
   `ValueError` class should
   be a verbatim copy of
   `customer.js`'s version,
   including the constructor.
   CRM had the same bug
   (`crm.js` defines the
   minimal form) but it
   didn't matter because CRM
   has no single-entity GETs
   that throw ValueError —
   only list endpoints which
   return empty arrays, not
   ValueError. The desk
   module's `getCase` is the
   first single-entity GET
   in a Phase 2 module, and
   it surfaced the bug.

2. **The single-entity GET
   pattern needs inline
   ValueError → 404.** The
   global error handler
   (`server/index.js` line
   362) returns 500 for
   everything. The
   `wrapFinanceRoute` helper
   handles ValueError → 404
   / 400 conversion, but only
   for routes wrapped with
   it. Single-entity GETs
   that need ValueError →
   404 conversion must do
   the conversion inline:
   ```js
   catch (err) {
     if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
       return res.status(404).json({ error: 'not_found', message: err.message });
     }
     next(err);
   }
   ```
   The CRM GETs use
   bare try/catch + `next(err)`
   because they don't have
   ValueError throws (list
   endpoints return empty
   arrays). The desk GETs
   need the inline conversion
   because `getCase` throws
   ValueError. The lesson:
   **single-entity GETs need
   inline 404 conversion**;
   list GETs and write
   endpoints can use the
   existing patterns.

3. **The 3-wave pattern is
   robust.** The 4 waves
   (W70 / W71 / W72 / W73)
   shipped 2 modules (CRM +
   desk) end-to-end with the
   same cadence. Each wave
   1 → wave 2 transition was
   clean: schema + pure
   functions + tests in
   wave 1, route wiring +
   perm keys + smoke check
   in wave 2. The lesson:
   **the 3-wave pattern is
   the right cadence for
   Phase 2 module ports**,
   and the projects +
   catalog modules can
   follow the same pattern
   with confidence.
