# W94 Summary — AI agents wave 2 (merge-candidates + alerts)

**Date:** 2026-06-22.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W93-1 shipped the deterministic data quality foundation
(3 pure functions: findDuplicateCustomers, findHvhhDrift,
getDataQualitySummary). Wave 1 surfaces the ISSUES but
doesn't propose what to do about them.

W94-1 ships the ADVISORY layer: deterministic
recommendations for fixing the issues. The functions are
read-only — they propose what to do, they do NOT mutate
state.

## What shipped

- `server/finance/dataQuality.js`: 2 new pure functions
  - `suggestMergeCandidates(tenantId)` — for each duplicate
    group, propose a primary (the record with hvhh; tie-
    break by oldest id) + secondary (to merge into primary)
    plan. Counts the invoices + payments that would be
    re-assigned so the operator can see the merge impact.
    Each plan has: `group_id`, `match_type`, `match_value`,
    `primary`, `secondary`, `invoice_count`, `payment_count`,
    `reason`.
  - `getDataQualityAlerts(tenantId, threshold=80)` —
    severity-sorted list of specific issues that exceed
    the threshold. Each alert has: `severity` (critical /
    warning / info), `code` (machine-readable), `message`,
    `count`, `recommended_action`. Sorted by severity
    (critical first) then count DESC.
- `server/finance/dataQuality.test.js`: 17 new unit tests
  + extended mockDb with 'inv-count' + 'pay-join'
  handlers + 'payments' Map + seedPayment helper.
- `server/finance/routes.js`: 2 new routes
  - GET /api/finance/ai/merge-candidates
  - GET /api/finance/ai/alerts?threshold=80
- `scripts/deploy-smoke.sh`: 2 new smoke checks
  (empty DB → 200, no candidates / no alerts)

## Test baseline

- 1516/1516 unit tests pass (was 1499; +17 new AI wave 2
  tests)
- `npm run check` clean
- `scripts/deploy-smoke.sh` RESULT: PASS

## Lessons learned

1. **The advisory layer must be DETERMINISTIC, not
   probabilistic.** The function picks the primary based on
   a simple rule (prefer record with hvhh; tie-break by
   oldest id). No LLM, no fuzzy matching, no "best guess"
   on which is correct. The operator can re-run the
   function any number of times and get the same result.
   The lesson: **advisory AI functions should be
   reproducible** — non-determinism in an advisory
   function undermines the operator's trust in the
   recommendation.

2. **The primary-selection logic mirrors the W93-1 lesson
   about duplicate severity tiers.** Same hvhh = definite
   duplicate (same legal entity). Same normalized name
   with different hvhh = possible duplicate. For the merge
   plan, the primary is the one with the TIN (hvhh). The
   tie-break (oldest) ensures consistency — every tenant
   with the same set of duplicates gets the same merge
   plan. The lesson: **the primary selection rule must be
   deterministic and explainable** — the operator needs to
   be able to verify "yes, that's the right primary" by
   looking at the plan.

3. **The mockDb classifier was the source of all the
   test friction this wave.** The suggestMergeCandidates
   function issues queries that the existing mockDb's
   'aggregate' classifier caught FIRST (because the SQL has
   `COUNT(*) AS n`, which matches the aggregate regex
   `SELECT\s+COUNT\(\*\)\s+AS\s+`). Reordering the
   classifiers — more specific patterns FIRST — fixed the
   false matches. The lesson: **the mockDb classifier
   patterns must be ordered by specificity** (most specific
   first). When adding a new pure function with a new
   query shape, the classifier should learn the new shape
   FIRST so the broader patterns don't false-match.

4. **`\b` word boundary in regex is critical for column
   names like `id`.** The test file's regex for the
   sched-get query (`WHERE id = $1 AND tenant_id = $2`)
   needed to distinguish from the list query (`WHERE
   tenant_id = $1`). Without `\b`, the regex `/id\s*=\s*\$1/`
   matched both queries because `tenant_id = $1` contains
   the substring `id = $1`. Adding `\b` (`/\bid\s*=\s*\$1/`)
   restricted the match to a word boundary. The lesson: **
   when distinguishing similar SQL shapes by column name,
   use word boundaries in the regex** — `id` is a common
   suffix in column names (tenant_id, schedule_id, etc.).