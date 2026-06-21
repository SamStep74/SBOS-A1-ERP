# W93 Summary — Phase 3 AI agents wave 1 (data quality + reconciliation)

**Date:** 2026-06-22.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

Phase 3 needs AI/agent capabilities for the CFO. Wave 1
ships the deterministic foundation: read-only data-
quality scans that surface hygiene issues without
needing an LLM. The "AI" here means "intelligent scan",
not "machine learning" — these are SQL queries with
heuristics.

Future waves can layer an LLM on top (e.g. natural-
language explanations of the data-quality issues) but
the foundation is solid deterministic logic.

## What shipped

- `server/finance/migrations/0025_data_quality.sql`:
  adds 2 columns
  - `finance.customers.code TEXT` (nullable, with
    partial unique index WHERE code IS NOT NULL)
  - `finance.invoices.customer_hvhh TEXT` (nullable,
    with partial index WHERE customer_hvhh IS NOT NULL)
  The denormalized invoice.customer_hvhh lets the drift
  detector compare the snapshot value to the live
  customer.hvhh.
- `server/finance/dataQuality.js`: 3 new pure functions
  - `findDuplicateCustomers(tenantId)` — flags customers
    with the same hvhh (severe) OR the same normalized
    name (case-insensitive, whitespace-collapsed)
  - `findHvhhDrift(tenantId)` — invoices where the
    snapshot customer_hvhh differs from the live
    customer.hvhh (or is NULL when the customer has hvhh)
  - `getDataQualitySummary(tenantId)` — 0-100 score
    (weighted average of customers/vendors/employees/
    invoices sub-scores) + per-module totals + issue
    counts
- `server/finance/dataQuality.test.js`: 12 unit tests
- `server/finance/routes.js`: 3 new routes
  - GET /api/finance/ai/duplicates
  - GET /api/finance/ai/hvhh-drift
  - GET /api/finance/ai/data-quality
- `scripts/deploy-smoke.sh`: 3 new smoke checks (empty
  DB → 200, no issues)

Perm keys: REUSE existing `reports.dashboard.read`.
No new perm additions (read-only data exploration).

## Test baseline

- 1499/1499 unit tests pass (was 1487; +12 new AI tests)
- `npm run check` clean
- `scripts/deploy-smoke.sh` RESULT: PASS (25 finance
  migrations applied; +1 for 0025_data_quality.sql)

## Lessons learned

1. **The smoke check caught a real production schema
   drift.** The data quality module references 2 columns
   that didn't exist in the production schema:
   `customers.code` and `invoices.customer_hvhh`. The
   unit tests passed because the mockDb simulates the
   schema; the smoke check exposed the drift at runtime
   with `no such column: code` / `no such column:
   customer_hvhh`. The fix was to add migration
   0025_data_quality.sql with ALTER TABLE ADD COLUMN
   statements. **This is the canonical W88 lesson**:
   the smoke check is the load-bearing regression guard
   for production schema drift. Unit tests are not
   sufficient.

2. **The data quality module is read-only — no
   auto-correction.** The findHvhhDrift function flags
   invoices where the snapshot differs from the live
   customer.hvhh, but it does NOT auto-update the invoice
   (that would be a mutation, and mutations need a
   separate audit trail + approval workflow). The
   function is INFORMATIONAL — the operator decides
   whether to re-issue the invoice or accept the stale
   snapshot. The lesson: **AI agents in the data quality
   space should be advisory, not corrective**. Auto-
   correcting data quality issues can lead to cascading
   errors (e.g. fixing an invoice's hvhh might break a
   downstream report that expected the original value).

3. **The duplicate detection has two tiers of severity.**
   Same hvhh = same legal entity (definite duplicate —
   flag first). Same normalized name = probably two
   separate legal entities (worth flagging for review —
   flag second). The function sorts by match_type
   (hvhh first) so the UI renders the severe issues
   above the noisy ones. The lesson: **duplicate
   detection should rank by severity, not just by
   count**. A tenant with 2 same-hvhh duplicates needs
   immediate attention; a tenant with 5 same-name-but-
   different-hvhh customers is probably fine and just
   needs review.

4. **The mockDb classifier needed expansion for
   aggregate queries.** The data quality summary uses
   `SELECT COUNT(*) AS total` — different shape from the
   existing 'cust-groupby' / 'cust' / 'inv' handlers.
   Added an 'aggregate' handler that computes the counts
   in JS and returns `{ rows: [{ total, with_hvhh }] }`.
   The classifier distinguishes aggregate queries from
   the duplicate-detection queries by checking for
   `COUNT(*) AS ` (with AS alias). The lesson: **the
   mockDb classifier is the contract between the test
   and the production SQL shape** — when the production
   SQL adds a new shape (e.g. aggregations), the
   classifier needs to learn it.