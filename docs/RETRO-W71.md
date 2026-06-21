# W71 Summary — Phase 2 CRM wave 2 (route wiring + smoke)

**Date:** 2026-06-21.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W70-2 shipped the Phase 2 CRM
wave 1: schema (0009_crm.sql)
+ pure functions (createContact,
listContacts, createLead,
listLeads) + 17 tests. The
module existed but wasn't
HTTP-accessible.

W71-2 ships the wave 2: route
wiring (4 endpoints) + smoke
check extension (5 checks).

**Phase 2 CRM is now
end-to-end functional**: the
operator can `GET
/api/finance/crm/contacts` and
`POST /api/finance/crm/leads`
against the bootable HTTP
server.

## What shipped

### W71-1 — CRM route wiring (4 endpoints)

Added 4 new endpoints to
`server/finance/routes.js`:

- `GET  /api/finance/crm/contacts`
  — list active contacts
  (crm.contact.read perm,
  returns `{ items: [...] }`)
- `POST /api/finance/crm/contacts`
  — create a contact
  (crm.contact.create perm;
  requireTenant guard;
  wrapFinanceRoute for audit
  + error handling)
- `GET  /api/finance/crm/leads?status=`
  — list leads (crm.lead.read
  perm; optional status filter;
  ordered by id DESC)
- `POST /api/finance/crm/leads`
  — create a lead
  (crm.lead.create perm; same
  guards as contacts)

The `crm.*` permission keys
already existed in
`server/rbac/permissions.js`
+ the `CRMOperator` role
already had all 4 keys in
`server/rbac/matrix.js`. No
permission set changes were
needed for W71-1.

**Updated the endpoint
inventory comment at the
top of `routes.js`** to list
the 4 new endpoints.

### W71-2 — refactor to runQuery + smoke check extension

**The W71-1 routes failed
the smoke check on first run**
with `db.all is not a function`
+ `db.run is not a function`.
The previous W70-2 implementation
used `db.run()` and `db.all()`
directly, which work with the
test harness but **not with the
production `pgAdapter`** (which
only exposes `db.query()`).

Refactored the CRM module to
use the `runQuery()` helper
pattern (matches
`customer.js` /
`inventory.js`):

- `runQuery(db, sql, params)` is
  a thin wrapper around
  `db.query(sql, params)`. The
  production adapter returns
  `{ rows: [...] }` (pg shape);
  the test harness does the
  same.
- The pure functions use `$N`
  placeholders (pg-style) +
  `RETURNING id` for the
  INSERT. Falls back to
  `LAST_INSERT_ROWID()` if
  the adapter doesn't support
  `RETURNING` (production
  safety net).
- The test harness was also
  updated to use `db.query()`
  returning `{ rows: [...] }`
  (production shape).

**Smoke check extension (5 new
checks):**

- `GET  /api/finance/crm/contacts tenant=0`
  (empty DB → 200, items: [])
- `GET  /api/finance/crm/leads tenant=0`
  (empty DB → 200, items: [])
- `GET  /api/finance/crm/leads?status=qualified`
  (status filter; empty DB → 200)
- `POST /api/finance/crm/contacts`
  (returns id > 0 — the
  wave-14 production pg
  adapter regression guard)
- `POST /api/finance/crm/leads`
  (returns id > 0)

All 5 new checks pass.

### W71-3 — push to `origin/main`

Pushed successfully at SHA
`0453cf4`.

## Test baseline

- **1071 / 1071** tests pass
  (no regressions; the 17
  CRM tests from W70-2 still
  pass after the refactor)
- **`npm run check`** clean
- **`scripts/deploy-smoke.sh`**
  18 / 18 GET + 13 / 13 POST
  checks green (was 13 + 11
  before W71-2)

## Why it matters

**Phase 2 CRM is now
end-to-end functional.** The
operator can:

```bash
TOKEN=$(cat /var/lib/sbos-a1-erp/admin-token)
curl -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" \
     http://127.0.0.1:3000/api/finance/crm/contacts

# Create a lead
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -H "X-Tenant-Id: 0" -H "Content-Type: application/json" \
     -d '{"name": "Acme Co", "company": "Acme", "status": "qualified"}' \
     http://127.0.0.1:3000/api/finance/crm/leads
```

The CRM module now matches the
shape of the other finance
modules (customers, vendors,
catalog, etc.): HTTP
endpoints with perm gates +
audit logging + tenant
isolation.

## Carry-forward

The SBOS-A1-ERP now has the
**first Phase 2 module fully
end-to-end functional**. The
remaining Phase 2 work:

- **Phase 2 CRM wave 3** (future)
  — update + archive endpoints
  + deal/pipeline tracking +
  activity log + lead status
  transitions (the
  `qualified` / `proposal` /
  `won` / `lost` transitions
  need a state-machine
  endpoint).
- **Phase 2 desk wave 1** —
  ticketing / support (cases,
  replies, KB).
- **Phase 2 projects wave 1**
  — project management (tasks,
  time entries, milestones).
- **Phase 2 catalog v2** —
  categories, variants,
  bundles, pricing rules (the
  current catalog is minimal:
  SKU + name + UOM + unit
  cost).

**W70-2 / W71-1 / W71-2
established the CRM module
shape**: schema + pure
functions + runQuery helper +
route wiring + perm keys +
smoke check. The desk and
projects modules can follow
the same 3-wave pattern.

**Open items** (follow-up
plans, not blocking):

- Production pg CI (the
  current CI uses sqlite;
  a parallel job should spin
  up pg and run the smoke
  against the pg adapter).
- Restore verification
  (cron restores are
  unverified).
- K8s multi-cluster pattern.

## Lessons learned

1. **Mock tests are necessary
   but not sufficient for
   production adapters.** The
   W70-2 CRM tests used
   `db.run()` + `db.all()`
   directly. The test harness
   exposed those methods
   (since the test was a
   minimal sqlite-shaped
   adapter), so all 17 tests
   passed. But the **production
   `pgAdapter` doesn't expose
   those methods** — it only
   has `db.query()`. The W71-1
   routes failed the smoke
   check immediately. Fix:
   use the same `runQuery()`
   helper that the other
   finance modules use, and
   update the test harness to
   expose the production shape.
   **The lesson:** pure
   functions should speak
   the production adapter
   shape from day 1. Mock
   tests are a regression net
   for the *interface contract*,
   not a substitute for
   integration testing.

2. **The 3-wave pattern for
   module ports is right.**
   Wave 1 (W70-2): schema +
   pure functions + unit
   tests. Wave 2 (W71-1 +
   W71-2): route wiring + perm
   keys + smoke check
   extension. The 2-wave
   pattern is the right
   cadence for a new module:
   the first wave is the
   "core" (the pure
   functions), the second
   wave is the "edge" (the
   HTTP layer). The desk and
   projects modules can
   follow the same pattern.

3. **Existing perm sets cover
   the new module.** The
   `crm.*` permission keys
   already existed in
   `permissions.js` (from
   earlier work), and the
   `CRMOperator` perm set
   already included
   `crm.contact.read`,
   `crm.contact.create`,
   `crm.lead.read`,
   `crm.lead.create`. **No
   permission set changes were
   needed for W71-1.** The
   pre-existing RBAC structure
   had already anticipated
   the CRM module. The
   lesson: when designing
   RBAC for a new module,
   check the existing perm
   sets FIRST. Adding new
   perms is the last resort,
   not the first move.
