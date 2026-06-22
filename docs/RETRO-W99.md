# W99 Summary — Phase 3 AI agents wave 3 (apply customer merge)

**Date:** 2026-06-22.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W94-1 shipped the ADVISORY layer: `suggestMergeCandidates`
returns a list of "merge these two customers" plans with
the count of invoices + payments that would be
re-assigned. The operator still had to apply the merge
manually (or not at all).

W99-1 ships the MUTATION: `applyCustomerMerge` actually
does it. The advisory → mutation handoff closes the W93-1
+ W94-1 loop. From a CFO's perspective: "show me the data
quality issues" → "do the right thing automatically".

## What shipped

- `server/finance/migrations/0028_customer_merge.sql` (new):
  - `ALTER TABLE finance.customers ADD COLUMN archived
    INTEGER NOT NULL DEFAULT 0` (soft-delete flag)
  - Partial index `(tenant_id, archived) WHERE archived = 0`
    for "active customers in tenant X" queries
  - `CREATE TABLE finance.customer_merge_log` (append-only
    audit table: primary_id, secondary_id, invoice/payment
    counts, applied_by_user_id, reason, created_at)
  - 3 indexes: tenant+created_at DESC, primary, secondary
- `server/finance/dataQuality.js` (extended):
  - `applyCustomerMerge(db, input, tenantId)`:
    1. Validate primary_id, secondary_id (positive ints,
       different)
    2. Verify both customers exist in tenant (404 if
       missing — distinguished from 400 by message
       prefix at the route layer)
    3. Verify secondary is NOT archived (400 — prevents
       double-merging the same customer into two
       primaries)
    4. Count invoices + payments BEFORE the update
    5. `UPDATE finance.invoices SET customer_id = primary
       WHERE tenant_id = $ AND customer_id = secondary`
    6. Count again AFTER the update (delta = re-assigned)
    7. `UPDATE finance.customers SET archived = 1` on
       the secondary
    8. `INSERT INTO finance.customer_merge_log` (audit
       row, append-only)
    Returns `{ merge_log_id, primary_id, secondary_id,
    invoices_reassigned, payments_reassigned }`
  - `listCustomerMergeLog(db, tenantId, { primaryId,
    secondaryId, limit })` — query the audit log
- `server/finance/dataQualityMerge.test.js` (new, 19 tests):
  - `applyCustomerMerge` (14 tests): happy path, payment
    count via invoice join, all input validation paths,
    cross-tenant 404, same primary/secondary 400, already
    archived 400, optional reason + applied_by_user_id
  - `listCustomerMergeLog` (3 tests): tenant filter,
    primaryId filter, limit validation
- `server/rbac/permissions.js` (new key):
  - `finance.customer.merge` (high sensitivity — "use
    with care, one-way, audit-logged")
- `server/rbac/matrix.js`: `finance.customer.merge` added
  to the CRMOperator role (which already holds
  `finance.customer.create` + `.update`)
- `server/finance/routes.js` (2 new routes):
  - `POST /api/finance/ai/apply-merge`
    - Body: `{ primary_id, secondary_id, reason?,
      applied_by_user_id? }`
    - Perm gate: `finance.customer.merge`
    - Defaults `applied_by_user_id` to `req.user.id` if
      not in body
    - Distinguishes 400 (bad input) from 404 (not found)
      by message prefix
  - `GET /api/finance/ai/merge-log`
    - Query: `primary_id?`, `secondary_id?`, `limit?`
      (default 50, max 500)
- `scripts/deploy-smoke.sh` (STEP 7n, 8 checks):
  - 404 on non-existent primary
  - 200 happy path: 1 invoice re-assigned, audit row
  - 400 on re-apply (secondary is now archived)
  - 400 on same primary/secondary
  - Direct SQL: invoice now belongs to primary
  - Direct SQL: `secondary.archived = 1`
  - Direct SQL: `customer_merge_log` has 1 row
  - `GET /api/finance/ai/merge-log` returns the audit row

## Test baseline

- 1598/1598 unit tests pass (was 1579; +19 new)
- 28 finance migrations (was 27; +1 new)
- `npm run check` clean
- `scripts/deploy-smoke.sh` RESULT: PASS

## Lessons learned

1. **Advisory → mutation handoff is the real value of the
   AI agent.** W93-1 (data quality) and W94-1 (merge
   candidates) shipped the ADVISORY half: "here are the
   issues, here are the proposed fixes". Without the
   mutation, the operator has to manually apply the
   fixes — which is exactly the operational burden the
   AI agent was supposed to remove. W99-1 ships the
   MUTATION half. The lesson: **AI agent design is
   incomplete without the mutation layer**. The advisory
   without the mutation is a "see the problem, do
   nothing about it" UI. The advisory + mutation is
   "see the problem, do the right thing automatically,
   audit-log it for review".

2. **BEFORE/AFTER count is the right pattern for
   "how many rows did this update change?"** The naive
   approach is "trust the rowCount from the UPDATE
   statement" — but pg returns rowCount, sqlite returns
   `changes`, and the wrappers in `runQuery` normalize
   differently. The adapter-agnostic approach is to
   count BEFORE the update + count AFTER + delta. This
   is one extra SELECT per side but the cost is
   trivial (both are indexed by `(tenant_id,
   customer_id)`) and the result is unambiguous. The
   lesson: **when the action changes the count of rows
   matching some filter, the adapter-agnostic pattern
   is SELECT-BEFORE + UPDATE + SELECT-AFTER, not
   rowCount-on-UPDATE**. The first version of the
   function tried to use the UPDATE's return value and
   got tangled in adapter differences; the
   SELECT-BEFORE/UPDATE/SELECT-AFTER pattern is what
   survived the tests.

3. **Soft delete (archived flag) is the right pattern
   for "we want to keep the history".** The alternative
   — hard delete the secondary — would lose the audit
   trail of "this customer existed, was merged, and
   here's where their invoices went". Soft delete
   keeps the row, sets `archived = 1`, and adds a
   `customer_merge_log` row that points at it. A future
   undo-merge wave could flip `archived = 0` and
   re-assign the invoices back. The lesson: **for any
   destructive action that the operator might want to
   reverse, soft delete + audit log beats hard delete**.
   Hard delete is for "this row was clearly invalid from
   day 1, no one ever referenced it". Soft delete is
   for "this row was real, we're transforming it into
   something else, keep the history".

4. **The perm gate for a MUTATION needs to be a
   DIFFERENT key from the advisory.** The W94-1
   advisory uses `reports.dashboard.read` (existing key,
   held by the read-side roles). W99-1 introduces
   `finance.customer.merge` (new key, high sensitivity,
   held only by CRMOperator). The separation matters
   because the advisory is "see the suggestion" — every
   user with dashboard read access should see that. The
   mutation is "actually do it" — only users with
   explicit merge permission should be able to. The
   lesson: **advisory and mutation permissions should
   be distinct keys, so the role matrix can grant the
   advisory to a wide audience and the mutation to a
   narrow one**. A single perm key for both would
   either over-grant (readers can also mutate) or
   under-grant (mutators can't see what they're
   mutating).

5. **The 404 vs 400 split at the route layer is a
   message-prefix hack that works.** The pure function
   throws `ValueError` for both "not found" and "bad
   input". The route layer distinguishes them by
   matching the error message against `/not found/i` —
   404 if it matches, 400 otherwise. The hack is
   fragile (a future refactor could change the message
   and break the route), but it works for the current
   surface area. A future refactor could introduce a
   `NotFoundError` class and check `err.name ===
   'NotFoundError'` instead — that would be the
   "right" way. The lesson: **when a pure function has
   to cover multiple error types with a single error
   class, the route layer can disambiguate by message
   prefix as a stopgap**. The stopgap is good enough
   for shipping; a future wave can refactor to typed
   errors when more error types accumulate.

6. **The `assertPositiveInt` rename (was
   `_assertPositiveInt`) was driven by use, not by
   design.** The W93-1 + W94-1 functions in
   dataQuality.js used direct inline checks for
   positive integers (the function bodies were short
   enough to inline). W99-1's `applyCustomerMerge` has
   3 places that need the same check (primary_id,
   secondary_id, applied_by_user_id), so the inline
   pattern doesn't scale. The W93-1 wave had added
   `_assertPositiveInt` as a stub for "future
   functions" — that future is now. The lesson: **the
   helper function with the leading underscore (the
   "reserved for future use" pattern) should be
   promoted to public use the moment a second caller
   appears**. The leading underscore was a signal to
   the linter, not a permanent API contract. Three
   call sites in W99-1 = remove the underscore.