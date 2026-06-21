# W88 Summary — Phase 3 POS basics wave 2 (routes + perm keys + smoke)

**Date:** 2026-06-21.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W87-1 shipped the minimum viable POS data model + pure
functions: 5 tables, 7 pure functions, 27 unit tests. The
POS lifecycle (register → shift → sale → line → payment) was
modelled but unreachable from the HTTP layer.

W88-1 closes the loop: routes + perm keys + smoke checks. The
operator can now drive the full POS lifecycle via curl /
HTTP.

This is the standard Phase 2/3 wave-2 pattern:
- Wire routes around the wave-1 pure functions.
- Reuse existing perm keys (no new perm additions).
- Add smoke checks that exercise the full lifecycle end-to-end.

## What shipped

### 1. Three new pure functions in `server/finance/pos.js`

W87-1 shipped `openShift / listShifts / getShift / closeShift`
and `addSale / addSaleLine / addPayment` but did NOT ship the
register CRUD endpoints. The smoke flow couldn't bootstrap a
register via HTTP, so I closed the gap in W88-1:

- `addRegister(db, input, tenantId)` — creates a register;
  validates `code + name` are required; checks uniqueness
  per `(tenant_id, code)` with a clean 400 instead of a 500
  from the UNIQUE constraint violation.
- `listRegisters(db, tenantId)` — lists all registers for the
  tenant. Ordered by id ASC.
- `getRegister(db, registerId, tenantId)` — single register;
  throws ValueError on missing / cross-tenant.

### 2. 10 new routes in `server/finance/routes.js`

```
GET    /api/finance/pos/registers
POST   /api/finance/pos/registers           (audit: pos.session.open)
GET    /api/finance/pos/registers/:id
GET    /api/finance/pos/shifts              (filters: ?register_id=, ?status=)
POST   /api/finance/pos/shifts              (audit: pos.session.open)
GET    /api/finance/pos/shifts/:id
POST   /api/finance/pos/shifts/:id/close    (audit: pos.session.close)
POST   /api/finance/pos/sales               (audit: pos.sale.create)
POST   /api/finance/pos/sales/:id/lines     (audit: pos.sale.create)
POST   /api/finance/pos/sales/:id/payments  (audit: pos.sale.create)
```

**Perm key mapping (REUSE — no new keys):**

| Route | Perm key |
|---|---|
| `GET /pos/registers` | `pos.cash.read` |
| `POST /pos/registers` | `pos.session.open` (creating a register is part of opening a session) |
| `GET /pos/registers/:id` | `pos.cash.read` |
| `GET /pos/shifts` | `pos.cash.read` |
| `POST /pos/shifts` | `pos.session.open` |
| `GET /pos/shifts/:id` | `pos.cash.read` |
| `POST /pos/shifts/:id/close` | `pos.session.close` |
| `POST /pos/sales` | `pos.sale.create` |
| `POST /pos/sales/:id/lines` | `pos.sale.create` (adding a line is part of creating a sale) |
| `POST /pos/sales/:id/payments` | `pos.sale.create` (adding a payment completes a sale) |

These perm keys already existed in `server/rbac/permissions.js`
(line 1343-1397) from a prior planning artifact. The naming
mismatch (`pos.session.*` vs the module's `pos_shifts`) is
intentional: the perm keys describe the operator-facing
permission ("can open / close a POS session"), the table
column names describe the data model.

### 3. 13 new smoke checks in `scripts/deploy-smoke.sh`

5 read checks (empty DB → 200, missing → 404):
```
GET /api/finance/pos/registers       → 200
GET /api/finance/pos/registers/1     → 404
GET /api/finance/pos/shifts          → 200
GET /api/finance/pos/shifts?status=open → 200
GET /api/finance/pos/shifts/1        → 404
```

8 write checks (full lifecycle — register → shift → sale →
line → payment → close):
```
POST /api/finance/pos/registers              → 201 (id > 0)
POST /api/finance/pos/shifts                 → 201 (id > 0)
GET  /api/finance/pos/registers/1            → 200 (the register above)
GET  /api/finance/pos/shifts/1               → 200 (the shift above)
POST /api/finance/pos/sales                  → 201 (id > 0)
POST /api/finance/pos/sales/1/lines          → 201 (id > 0)
POST /api/finance/pos/sales/1/payments       → 201 (id > 0)
POST /api/finance/pos/shifts/1/close         → 200 (state-machine guard open → closed)
```

### 4. Bug caught + fixed by the smoke check

**The smoke check is the load-bearing regression guard for
production schema drift.** W87-1's `addSaleLine` had an
UPDATE statement that referenced `pos_sales.updated_at`:

```sql
UPDATE finance.pos_sales
   SET total_amd = (...),
       updated_at = datetime('now')   -- BUG: column doesn't exist in prod
 WHERE id = $3 AND tenant_id = $4
```

The unit tests passed because my test harness's CREATE TABLE
included `updated_at` on `pos_sales`. The smoke check caught
the bug immediately:

```
FAIL 500 (expected 201) POST /api/finance/pos/sales/1/lines (returns id > 0)
| {"error":"internal_error","message":"no such column: updated_at"}
```

The production migration `0017_pos_basics.sql` (renamed from
W87-1's `0013_pos_basics.sql` to resolve the duplicate-0013
collision) does NOT include `updated_at` on `pos_sales`. The
audit trail on pos_sales is `created_at + completed_at`, not
`updated_at`. The fix:

1. Removed `updated_at = datetime('now')` from the addSaleLine
   UPDATE in pos.js.
2. Removed `updated_at TEXT NOT NULL DEFAULT (datetime('now'))`
   from the test harness CREATE TABLE for pos_sales — so the
   test harness matches production.

After the fix: 13/13 POS smoke checks pass.

## Test baseline

- **1393 / 1393 unit tests pass** (was 1387 pre-W88-1; +6 from
  the new register tests + boundary-check tooling)
- **`npm run check`** clean (lint + typecheck + format +
  boundary-check + 1393 tests + l10n-am audit)
- **`scripts/deploy-smoke.sh`** **RESULT: PASS** (123/123
  smoke checks; 13 new POS checks added)
- **17 migrations applied** (was 16 pre-W87-1; +1 for the POS
  basics migration `0017_pos_basics.sql`)

## Why it matters

**POS basics is now reachable from the HTTP layer.** A
cashier can:

1. POST /pos/registers → create the register
2. POST /pos/shifts → open the shift (start of day)
3. POST /pos/sales → ring up a customer (start of sale)
4. POST /pos/sales/N/lines → add line items
5. POST /pos/sales/N/payments → take payment
6. POST /pos/shifts/M/close → end of day (with cash count)

The full lifecycle is one curl chain. Combined with W87-1's
data model (5 tables, 13 indexes, partial unique index for
"one open shift per register"), POS basics is operational.

## Carry-forward

The remaining Phase 3 work (not blocking; future plans):

- **Phase 3 POS basics wave 3** (optional) — end-of-day
  reconciliation, refunds, voids, register transfer.
- **Phase 3 HR basics** — employee + contract + payroll.
- **Phase 3 reporting wave 2** — extension of W85 (per-module
  drill-downs, scheduled report runs).
- **Phase 3 AI agents** — data quality + reconciliation.

**W70 / W71 / W72 / W73 / W74 / W75 / W76 / W77 / W78 / W79 /
W80 / W81-W85 / W86 / W87 / W88 established the 3-wave pattern
for Phase 2 + Phase 3 module ports across 5 modules (CRM +
desk + projects + catalog v2 + Phase 3 reporting + POS
basics).**

## Lessons learned

1. **The smoke check is the load-bearing regression guard for
   production schema drift.** The W87-1 `addSaleLine` UPDATE
   referenced `pos_sales.updated_at`, which exists in the
   unit-test harness's CREATE TABLE but NOT in the production
   migration. Unit tests passed (29 → 32 in W88-1, all
   green); smoke caught the bug in seconds. The lesson:
   **the test harness's CREATE TABLE MUST mirror the
   production migration's CREATE TABLE — including the
   presence/absence of `updated_at`, `archived`, `completed_at`,
   etc.** A drift is silent until a runtime query hits the
   production schema. The smoke check is the only test that
   actually runs against the production schema. The fix is
   now baked into the test harness: pos_sales has no
   `updated_at` column, matching production.

2. **Naming mismatch between perm keys and data model is OK
   as long as the semantics align.** The existing `pos.*` perm
   keys use `session` terminology (`pos.session.open`,
   `pos.session.close`); the W87-1 module uses `shift`
   terminology (`pos_shifts` table, `openShift` function).
   These refer to the same concept (a cashier's day). I
   reused the existing keys without renaming either, with
   a one-line note in the route comment that the perm keys
   describe operator-facing permissions and the table column
   names describe the data model. The lesson: **don't rename
   existing perm keys to match a new module's naming** —
   RBAC perm keys are a stable contract; data model terms
   can evolve. Document the mapping in the route file.

3. **The smoke flow order matters for POST→GET chains.** The
   POS smoke flow chains 8 POSTs + 3 GETs in dependency
   order: register POST → register id=1, shift POST (depends
   on register id=1) → shift id=1, sale POST (depends on
   shift id=1 + register id=1) → sale id=1, line POST
   (depends on sale id=1 + catalog item id=1, created by the
   earlier catalog smoke check) → line id=1, payment POST
   (depends on sale id=1) → payment id=1, shift close POST
   (depends on shift id=1) → close. The earlier catalog smoke
   check creates `catalog_items.id=1`; the POS smoke relies
   on that. The lesson: **document the cross-test dependency
   in the smoke check comments** (the comment says
   "Order matters: shift depends on register; sale depends
   on shift + register; line + payment depend on sale.").

4. **The 3-wave pattern is now well-established across 5+
   modules.** W70/W71 (CRM), W72/W73 (desk), W74/W75
   (projects), W76/W77 (catalog v2), W78/W79 (catalog wave
   3b), W80/W81 (catalog wave 3c), W82 (desk wave 3),
   W83 (CRM wave 3), W84 (projects wave 3), W85 (Phase 3
   reporting), W87/W88 (POS basics). Each wave 1 = schema +
   pure functions + tests; each wave 2 = routes + perm keys
   + smoke checks; each wave 3 (optional) = state machine
   extensions + UX polish. The lesson: **the 3-wave pattern
   scales to any module with a clear data model and a clear
   HTTP surface**. Wave 1 is the largest (data model); wave
   2 is mechanical (route wiring); wave 3 is optional (UX
   polish).