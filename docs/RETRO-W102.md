# W102 Summary — Phase 3 AI agents wave 4 (undo customer merge)

**Date:** 2026-06-22.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W99-1 shipped `applyCustomerMerge` — the MUTATION that
re-assigns the secondary's invoices to the primary,
archives the secondary, and records an audit row. The
audit row stored the COUNTS of re-assigned invoices +
payments, but not the LIST of IDs that were moved.

W102-1 ships `undoCustomerMerge` — the inverse. The
audit log row is the source of truth for the undo: undo
reads the row, restores the secondary to active,
re-binds the listed invoices back to the secondary,
and stamps the row with the undo metadata
(`undone_at`, `undone_by_user_id`, `undone_reason`).

## What shipped

- `server/finance/migrations/0030_customer_merge_undo.sql` (new):
  - 5 new columns on `finance.customer_merge_log`:
    - `reassigned_invoice_ids TEXT` (JSON array of invoice
      ids, populated by `applyCustomerMerge` going forward;
      NULL for pre-W102-1 merges — those can't be undone)
    - `reassigned_payment_ids TEXT` (JSON array of payment
      ids, same caveat)
    - `undone_at TEXT` (NULL = merge is still active)
    - `undone_by_user_id INTEGER`
    - `undone_reason TEXT`
  - Partial index on `(tenant_id, created_at DESC) WHERE
    undone_at IS NULL` — the hot path for "show me active
    merges" in the audit UI
- `server/finance/dataQuality.js` (extended):
  - `applyCustomerMerge` now collects the list of invoice
    IDs (via `SELECT id FROM ... WHERE customer_id = $sec`)
    and payment IDs (via JOIN to invoices) BEFORE the
    re-assignment UPDATE. The list is JSON-serialized and
    stored in the new `reassigned_invoice_ids` /
    `reassigned_payment_ids` columns. Returns the lists
    in the result so the route layer can echo them.
  - `undoCustomerMerge(db, input, tenantId)` — the new
    function:
    1. Validates `merge_log_id` is a positive integer
    2. Optional `undone_reason` (≤ 1024 chars) +
       `undone_by_user_id`
    3. Looks up the merge log row (tenant-scoped, 404 if
       missing)
    4. Idempotency: refuses if already undone (400)
    5. Pre-W102-1 check: refuses if `reassigned_invoice_ids`
       is NULL (400 — operator must restore manually)
    6. Verifies the secondary still exists AND is still
       archived (400 if not — state inconsistent)
    7. Re-assigns the listed invoices back to the
       secondary via a single bulk UPDATE with
       `WHERE id IN (a, b, c, ...)`
    8. Counts how many invoices are now back on the
       secondary (may be less than the original count
       if some were voided in the meantime)
    9. Un-archives the secondary
    10. Stamps the audit log row with `undone_at` +
        `undone_by_user_id` + `undone_reason`
    Returns `{ merge_log_id, primary_id, secondary_id,
    invoices_restored, payments_restored }`
- `server/finance/dataQualityMerge.test.js` (extended):
  - `applyCustomerMerge` happy path now asserts the
    `reassigned_invoice_ids` / `reassigned_payment_ids`
    lists are populated
  - 12 new `undoCustomerMerge` tests (happy path, payment
    count, idempotency, 404 on missing, cross-tenant,
    pre-W102-1 check, secondary-not-archived, secondary-
    deleted, reason validation, `undone_by_user_id`
    validation, requires `merge_log_id`, input is required)
  - Mock extended with 5 new classifiers: `cust-get` (the
    undo's single-customer lookup), `cust-unarchive`
    (`UPDATE customers SET archived = 0`),
    `merge-log-get` (the undo's audit lookup),
    `merge-log-undo-stamp` (`UPDATE merge_log SET undone_*`),
    `inv-id-list` + `pay-id-list` (the list-collection
    queries for apply)
  - Mock also extended to support the `WHERE id IN (...)`
    filter on `inv-reassign` + `inv-count` + `pay-join`
    handlers (for the bulk restore in undo)
  - Added 3 inspector helpers: `_mergeLogGet`,
    `_customerGet`, `_customerDelete`
- `server/finance/routes.js` (already committed by the
  team in their W86 cleanup at `c173fe6`):
  - `POST /api/finance/ai/undo-merge`
    - Body: `{ merge_log_id, undone_reason?, undone_by_user_id? }`
    - Perm gate: `finance.customer.merge`
    - Defaults `undone_by_user_id` to `req.user.id`
    - Distinguishes 404 (not found) vs 400 (bad input) by
      message prefix
- `scripts/deploy-smoke.sh` (STEP 7n2, 6 checks, reordered
  to run AFTER STEP 7n):
  - 1 setup merge via direct SQL + apply-merge
  - 1 undo via the API: 1 invoice restored
  - Direct SQL: invoice is back on the secondary
  - Direct SQL: `secondary.archived = 0`
  - Direct SQL: `customer_merge_log.undone_at` is populated
  - 400 on re-undo (idempotency)
  - 404 on non-existent `merge_log_id`

## Test baseline

- 1666/1666 unit tests pass (was 1654; +12 new)
- 30 finance migrations (was 29; +1 new)
- `npm run check` clean
- `scripts/deploy-smoke.sh` RESULT: PASS

## Lessons learned

1. **The audit log is the source of truth for the undo.**
   W99-1's audit log stored the COUNTS of re-assigned
   rows. For the undo to work, the audit log has to
   remember the LIST of IDs that were moved. The W102-1
   migration adds `reassigned_invoice_ids` +
   `reassigned_payment_ids` columns, and W102-1 updates
   `applyCustomerMerge` to populate them. The lesson:
   **when adding a mutation, design the audit log to
   support the inverse operation from day 1**. Storing
   only the count is fine for "this happened" audit
   logs, but it breaks the "undo" use case. The cost
   of storing the list (a JSON-serialized array) is
   trivial — a few hundred bytes per row.

2. **Pre-existing rows are a migration hazard.** The
   `reassigned_invoice_ids` column is NULLABLE so the
   migration can apply to existing rows without a
   backfill. But that means the W102-1 undo CAN'T undo
   a pre-W102-1 merge — the function returns 400 with
   "pre-W102-1 merge; cannot undo automatically". The
   operator must restore manually via SQL. The lesson:
   **nullable audit columns are the right design for
   additive migrations, but the application layer must
   check for NULL and fail loud**. The silent-failure
   alternative (do nothing) would leave the operator
   thinking the undo worked when it didn't.

3. **Bulk UPDATE with `WHERE id IN (a, b, c, ...)` is the
   right pattern for "restore these specific rows".** The
   naive alternative is to issue one UPDATE per id —
   100 rows = 100 statements. The bulk pattern is one
   statement with N placeholders. For the W102-1 use
   case, the list is at most a few hundred ids (the
   number of invoices re-assigned in a single merge), so
   the parameterized list is well under the practical
   limit (~1000 placeholders before PG starts
   complaining). The lesson: **when restoring a known
   set of rows, prefer a single bulk UPDATE with a
   parameterized IN list over N individual UPDATEs**. The
   round-trip + parsing cost is one transaction, not N.

4. **The undo's "invoices_restored" count may be less
   than the original "invoices_reassigned" count.**
   Between the original merge and the undo, the operator
   may have voided some of the invoices. Voided invoices
   are filtered by the tenant scope; the undo's UPDATE
   only moves invoices that CURRENTLY exist and
   currently belong to the primary. The result
   `invoices_restored` is the actual count, not the
   original count. The lesson: **the undo's return value
   must reflect reality, not the original intent**. If
   the operator sees `invoices_restored = 2` but the
   original `invoices_reassigned = 5`, they need to know
   that 3 of the 5 invoices were voided in the meantime.
   The audit log row's `invoices_reassigned_count` is
   the original count; `invoices_restored` is the actual
   count from the undo.

5. **STEP 7n2 had to run AFTER STEP 7n, not before.** The
   first draft of the smoke step was inserted right
   after STEP 7n, but the original W99-1 STEP 7n
   asserted "1 merge log row exists". When 7n2 ran
   first and created a merge, 7n saw 2 rows and failed.
   The fix: reorder 7n2 to run AFTER 7n. The lesson:
   **smoke steps that share state (the merge log)
   must run in an order that respects each step's
   pre-conditions**. 7n assumes a fresh state (1 merge);
   7n2 assumes 1 merge already exists (to undo). Putting
   7n2 after 7n is the natural sequence.

6. **The team's W86 cleanup commit `c173fe6` had
   pre-committed my routes.js + eslint.config.js
   changes.** I had locally edited `server/finance/routes.js`
   to add the undo-merge route + import, and
   `eslint.config.js` to add the `AbortController`
   global. When I tried to commit them, they were
   already in HEAD (the team had rebased their W86
   carry-over work onto my W101-1 + W99-1 + W97-1
   commits, and the rebase picked up my local edits
   from a parallel merge). The lesson: **when working
   in parallel with a team, expect your local edits to
   sometimes appear in the team's commit before you
   commit them yourself**. The fix is just to verify
   with `git diff HEAD --stat` before committing, and
   skip the files that are already in HEAD. The work
   is the same; the commit attribution differs.