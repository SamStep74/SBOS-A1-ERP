# W89 Summary — Phase 3 POS basics wave 3 (refunds + voids)

**Date:** 2026-06-22.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W87-1 shipped the POS data model + pure functions
(register → shift → sale → line → payment). W88-1 wired
HTTP routes + perm keys + smoke checks for the create +
list + read paths.

W89-1 closes the sale lifecycle:
- **completeSale** — finalize an open sale (status → completed)
- **voidSale** — cancel an open sale (status → voided, no refund)
- **refundSale** — refund a completed sale (status → voided + refund row)
- **listRefunds** — list refunds for a sale

A real POS needs all four: a cashier may receive payment,
then the customer returns goods (refund); or the cashier
may realize mid-sale that the wrong item was rung (void);
or may simply finalize a sale (complete).

The minimal viable POS lifecycle is now:
```
register → shift → sale → line(s) → payment(s)
                                    ↓
                              completeSale
                                    ↓
                          refundSale / voidSale → shift.close
```

## What shipped

### 1. New migration `0023_pos_refunds.sql`

5 indexes; 1 new table (`finance.pos_refunds`):

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `tenant_id INTEGER NOT NULL`
- `sale_id INTEGER NOT NULL` (FK to pos_sales.id, NOT enforced)
- `payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'card', 'mobile', 'bank_transfer', 'other'))`
- `amount_amd INTEGER NOT NULL CHECK (amount_amd > 0)`
- `reason TEXT` (optional free-text)
- `created_by INTEGER NOT NULL`
- `created_at TEXT NOT NULL DEFAULT (datetime('now'))`

The refund row is the audit trail of "money flowed back to
the customer". The amount_amd is always POSITIVE — the
"negative payment" semantic is implicit. The payment_method
mirrors pos_payments.payment_method (cash refunds come out
of the drawer; card refunds reverse the terminal capture).

A refund is a DISTINCT event from a payment. The schema
separation enforces this: refunds live in pos_refunds,
payments live in pos_payments. The two never share a table.

### 2. New pure functions in `server/finance/pos.js`

```
completeSale(db, saleId, tenantId)
  → flips status open → completed + stamps completed_at
voidSale(db, saleId, input, tenantId)
  → flips status open → voided (no pos_refunds row)
refundSale(db, saleId, input, tenantId)
  → inserts pos_refunds row + flips status completed → voided
listRefunds(db, tenantId, { saleId })
  → lists refunds for a sale (chronological)
```

State-machine guards:
- completeSale: rejects already-completed / voided sales
- voidSale: rejects completed (must use refundSale) /
  voided sales
- refundSale: rejects open (must voidSale) / voided sales

All four use `info.changes === 0` to detect concurrent
state-machine transitions (the same pattern as closeShift
+ addSaleLine from W87-1).

### 3. New routes in `server/finance/routes.js`

```
POST /api/finance/pos/sales/:id/complete  (perm: pos.sale.create)
POST /api/finance/pos/sales/:id/void       (perm: pos.sale.void)
POST /api/finance/pos/sales/:id/refund     (perm: pos.refund.create)
GET  /api/finance/pos/sales/:id/refunds    (perm: pos.refund.create)
```

The perm keys REUSE the existing 9 pos.* keys from
permissions.js (no new additions). The mapping:
- completeSale → pos.sale.create (finalizing a sale is part
  of creating it)
- voidSale → pos.sale.void
- refundSale → pos.refund.create
- listRefunds → pos.refund.create (the same perm covers
  read; fine-grained read perm is out of scope for wave 3)

### 4. New smoke checks in `scripts/deploy-smoke.sh`

5 new write checks (full lifecycle: open → completed →
refunded → new sale → voided → close shift):

```
POST /api/finance/pos/sales/1/complete → 200
POST /api/finance/pos/sales/1/refund   → 201 (refund id > 0)
GET  /api/finance/pos/sales/1/refunds  → 200 (returns the refund)
POST /api/finance/pos/sales            → 201 (sale 2 — for void path)
POST /api/finance/pos/sales/2/void     → 200 (open → voided)
```

## Test baseline

- **1437 / 1437 unit tests pass** (was 1393 pre-W89-1; +44
  from W89-1's 12 lifecycle tests + 32 from the team's v0.9.0
  A1-Validator on POS sales work)
- **`npm run check`** clean (lint + typecheck + format +
  boundary-check + 1437 tests + l10n-am audit)
- **`scripts/deploy-smoke.sh`** **RESULT: PASS** (137+
  smoke checks; 18 POS-related checks including 5 new
  W89-1 lifecycle checks)
- **23 finance migrations applied** (was 22 pre-W89-1; +1
  for `0023_pos_refunds.sql`)

## Migration renumbering (closing a long-running issue)

The team's v0.9.0 release commit (`31bd986`) had an
incomplete migration renumber: it renamed
`0009_replenishment → 0019_replenishment` and
`0014_lots_serials → 0020_lots_serials` but did NOT rename
`0016_recall.sql`. The recall.sql tries to ALTER TABLE lots,
but the lots table is now in 0020_lots_serials.sql — so
recall.sql ran BEFORE lots was created, breaking the smoke
with "no such table: lots".

W89-1 completes the renumbering:
- `0016_recall.sql → 0021_recall.sql`
- `0017_recall_status.sql → 0022_recall_status.sql`
- `0019_pos_refunds.sql` (W89-1 migration) → `0023_pos_refunds.sql`

The migration order is now lex-stable: 0001..0022 with no
duplicates, then 0023 (W89-1). The smoke is unblocked.

## Why it matters

**POS basics is now feature-complete at the data model +
HTTP layer.** A cashier can:
1. Register a register
2. Open a shift (start of day)
3. Ring up a sale (start of sale)
4. Add line items
5. Take payment
6. Complete the sale (finalize)
7. Issue a refund (customer returns goods)
   OR cancel an open sale (void — wrong item rung)
8. Close the shift (end of day with cash count)

Wave 3 closes the lifecycle; future waves can add Z-report,
end-of-day reconciliation, register transfer, and
multi-currency support.

## Carry-forward

The remaining Phase 3 work (not blocking; future plans):

- **Phase 3 HR basics** (next natural step — user requested)
- **Phase 3 reporting wave 2** — extension of W85
- **Phase 3 AI agents** — data quality + reconciliation

**W70 / W71 / W72 / W73 / W74 / W75 / W76 / W77 / W78 / W79 /
W80 / W81-W85 / W86 / W87 / W88 / W89 established the 3-wave
pattern for Phase 2 + Phase 3 module ports across 5 modules
(CRM + desk + projects + catalog v2 + Phase 3 reporting + POS
basics).**

## Lessons learned

1. **State-machine guards on void vs refund: void does NOT
   insert a pos_refunds row.** The first iteration of the
   voidSale function was tempted to insert a "void" row in
   pos_refunds for symmetry with refundSale. But that's
   semantically wrong: a void is a cancellation BEFORE
   payment (no money changed hands), a refund is money
   flowing BACK to the customer (after payment). The test
   "pos: voidSale does NOT insert a pos_refunds row
   (refund-only)" catches this — it explicitly checks that
   listRefunds returns 0 rows after a void. The lesson:
   **void and refund are distinct events in the audit
   trail** — conflate them and you lose the distinction
   between "no payment received" (void) and "payment
   returned to customer" (refund). Real-world POS systems
   make this distinction for tax reporting, chargeback
   analysis, and cash-drawer reconciliation.

2. **Insert refund BEFORE flipping sale status, so the
   audit trail captures the refund attempt even if the
   concurrent UPDATE fails.** refundSale does:
   ```
   INSERT INTO pos_refunds ...
   UPDATE pos_sales SET status = 'voided' WHERE status = 'completed'
   ```
   If a concurrent refund is in flight (two cashiers race
   on the same sale), the INSERT will create one refund row
   that "wins" + the UPDATE will fail with `info.changes === 0`
   for the "loser" — that loser throws a clean ValueError.
   The order matters: INSERT first means even if the UPDATE
   fails, the audit trail shows the refund attempt. The
   reverse order (UPDATE first, INSERT second) would leave
   the sale in a stuck "completed" state if the INSERT
   fails (no refund row, no status change → cashier
   confused). The lesson: **for two-statement state-machine
   transitions, do the audit-row INSERT FIRST, then the
   state-flip UPDATE**. The audit trail is the source of
   truth; the status column is just a query-speed cache.

3. **State-machine guards use the original `status`, not
   the just-fetched `status` from the WHERE clause.** The
   UPDATE has `WHERE id = $1 AND status = 'completed'` —
   that's the "concurrent update" guard. The pure function
   ALSO checks `if (sale.status !== 'completed')` before
   the UPDATE. Why both? The pure-function check gives a
   clear error message ("sale is open, only completed sales
   can be refunded"); the WHERE clause catches concurrent
   races. Without the pure-function check, the route
   would 500 (the UPDATE silently affected 0 rows). With
   the WHERE clause alone, the cashier sees no error and
   the refund doesn't apply. The lesson: **state-machine
   guards are TWO layers**: (a) explicit pre-check for a
   clean error message, (b) WHERE clause on the UPDATE for
   race safety. Both are needed.

4. **Migration renumbering is fragile across parallel
   commits.** The team's v0.9.0 release commit
   (`31bd986`) had an incomplete renumber: it renamed 2
   migrations but left `0016_recall.sql` at 0016 while
   moving `0014_lots_serials.sql` to 0020. The smoke
   broke because recall.sql now runs before lots is
   created. W89-1 completes the renumber (0021_recall,
   0022_recall_status, 0023_pos_refunds). The lesson:
   **migration renumbering is atomic** — you can't
   half-do it. Either renumber ALL colliding migrations
   in one commit, or renumber NONE. The team's v0.9.0
   commit missed `0016_recall.sql` and `0017_recall_status.sql`
   — the latter had `0017_pos_basics.sql` AND
   `0017_recall_status.sql` colliding. Both collisions
   resolved by W89-1.

5. **Smoke checks the lifecycle in lex order, not the
   natural event order.** The smoke flow goes:
   ```
   POST register → POST shift → POST sale → POST line →
   POST payment → POST complete → POST refund → GET refunds →
   POST sale (new) → POST void → POST shift close
   ```
   The "POST sale (new) → POST void" step is non-obvious:
   after refunding sale 1, it's now voided, so we need a
   fresh sale to test the void path. This is documented
   inline in the smoke check comments. The lesson: **smoke
   checks that exercise multiple state-machine transitions
   need inline comments explaining the cross-check
   dependency** — otherwise the next maintainer reorders
   them and breaks the chain.