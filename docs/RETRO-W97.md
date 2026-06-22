# W97 Summary — Phase 3 reporting wave 4 (scheduler worker)

**Date:** 2026-06-22.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W96-1 shipped the data model + API for scheduled report
runs (finance.report_schedules + finance.report_executions
+ 6 pure functions). The schedule definitions sat there
but nothing fired them.

W97-1 ships the WORKER that triggers report runs on a
cron schedule. It dispatches the right function based on
the schedule's report_type, records the execution
(status='completed' or 'failed'), and updates
`next_run_at` for the next fire.

## What shipped

- `server/finance/scheduleRunner.js` (new, ~340 lines):
  - `computeNextRunAt(cron, now)` — minimal 5-field cron
    parser with Vixie semantics for dom/dow (OR when one
    is wildcard, AND when both are restricted)
  - `dispatchReport(type, db, pgAdapter, paramsJson, now,
    dispatchTable)` — dispatches to the right report
    function via an injectable dispatch table
  - `tickOnce(db, pgAdapter, now, tenantId, dispatchTable)`
    — one pass: list enabled schedules, fire due ones,
    record executions, send email (stub), update
    next_run_at. Returns `{ fired, skipped, errors }`.
  - `startScheduler({ db, pgAdapter, tickMs, ... })` —
    wraps `tickOnce` in a setInterval. Returns handle
    with `.stop()` / `.tickOnce()` / `.tickMs`. The
    interval is `unref()`'d so it doesn't keep the event
    loop alive.
  - `sendNotificationEmail(to, reportType, resultJson)` —
    stub (logs shape; wave 5 will replace with SMTP)
- `server/finance/scheduleRunner.test.js` (new, 30 tests):
  - `computeNextRunAt` (7 tests): every-minute, every-5-min,
    daily-9am, mondays-at-9am, range, list, invalid
  - `dispatchReport` (10 tests): all 6 report types,
    default arg behavior, override args, unknown type,
    invalid JSON, non-object params
  - `sendNotificationEmail` (1 test): stub shape
  - `tickOnce` (7 tests): fire due, skip not-due, skip
    disabled, record failed on dispatch throw, empty
    list, email path, mixed due/not-due
  - `startScheduler` (5 tests): handle shape, stop
    idempotent, tickMs floor, missing db/pgAdapter
- `server/index.js` (modified):
  - `createApp()` now wires `startScheduler()` with
    `tickMs=60_000` by default
  - Pass `opts.scheduler = { tickMs, ... }` to override
  - Pass `opts.scheduler = false` to skip starting the
    worker (useful for tests)
  - Handle stored on `app.locals.scheduler`
- `scripts/deploy-smoke.sh` (modified):
  - STEP 7m: verify the `[scheduler] worker started`
    log line is present in the server log

## Test baseline

- 1579/1579 unit tests pass (was 1549; +30 new)
- `npm run check` clean
- `scripts/deploy-smoke.sh` RESULT: PASS

## Lessons learned

1. **Vixie cron semantics for dom/dow are subtle.** The
   standard Vixie rule is: if BOTH `dom` and `dow` are
   restricted (non-wildcard), match if EITHER matches (OR
   semantics). If ONE of them is `*` (wildcard), the other
   is the only constraint (so the wildcard is effectively
   ignored). If BOTH are `*`, every day matches. The bug
   I shipped on the first pass: I used `dom_matches ||
   dow_matches` unconditionally, which made `0 9 * * 1`
   (Mondays at 9am) match EVERY day, not just Mondays.
   Fix: track `wildcard` per field during parse, and use
   the four-way truth table (both-restricted OR / dom-only /
   dow-only / both-wildcard). The lesson: **when
   implementing a subset of a well-known spec, read the
   spec's behavior for the edge cases, not just the happy
   path.** The 6 cron fields have 20 years of battle-tested
   edge cases; "matches if both fields match" is wrong for
   dom/dow specifically.

2. **The dispatch table should be an injectable parameter,
   not a hidden import.** The first version of
   `dispatchReport` called the real report functions
   directly. The test wanted to verify "the right function
   is called with the right args" without running the
   full report chain. Refactoring to take a `dispatchTable`
   parameter (with the real functions as the default)
   made the test trivial AND made the dispatcher
   extensible — a future wave could add a new report
   type by extending the table, not by editing
   `dispatchReport`. The lesson: **table-driven dispatch
   beats hardcoded switch statements**, especially when
   the dispatch is between 6+ variants and the test
   needs to stub.

3. **`setInterval` + `unref()` is the right pattern for
   in-process background workers.** The interval keeps
   the worker ticking while the server is alive, but
   `unref()` makes sure the interval doesn't keep the
   event loop alive. This is critical for the test
   harness — tests that call `createApp()` then exit
   shouldn't hang waiting for the interval to clear.
   The pattern: `const interval = setInterval(...); if
   (typeof interval.unref === 'function') interval.unref();`.
   The lesson: **always `unref()` long-lived intervals**
   in shared infrastructure code, so callers can compose
   the worker with other lifecycle-managed resources
   without leaking event loop references.

4. **The dispatch table's `customer_breakdown` requires
   `params.customerId`.** A schedule for
   `customer_breakdown` is a recurring report for ONE
   specific customer. If the operator schedules it
   without `params.customerId`, the dispatch throws
   `ValueError`, the execution records status='failed'
   with the error message, and the next tick tries
   again. This is the right behavior — the operator
   gets clear feedback in the executions list. The
   lesson: **per-entity recurring reports (per customer,
   per vendor, per product) should require the entity ID
   in the schedule's params**. The alternative (run for
   ALL entities) would explode the result set; the
   operator should explicitly opt-in per entity.

5. **The boot log line `[scheduler] worker started` is
   the operational visibility hook.** Without it, the
   operator has no way to verify the worker is up
   without waiting 60s and observing a tick. The log
   line is the only signal that the worker is wired in
   and the interval is armed. The smoke check uses
   this log line. The lesson: **always log the start
   of a long-lived background worker** with the key
   config (tick interval, tenant scope) so the boot
   log is the source of truth for "is this thing up?".

6. **The dispatch table is the boundary between the
   scheduler and the report functions.** W97-1 doesn't
   import `getVatSummary` from `./reports.js` — it
   doesn't need to. The 6 report types it dispatches
   are the ones in the W96-1 `VALID_REPORT_TYPES` list.
   `getVatSummary` is exported for direct API use but
   not yet a schedulable type. The lesson: **the
   scheduler's surface area should match the
   schedule-types list, not the report-function
   exports**. A function being exported is not the same
   as a function being schedulable. The
   `dispatchTable` is the explicit registry of
   "schedulable types"; adding a new type requires
   adding an entry to BOTH `VALID_REPORT_TYPES` (the
   API validation list) and `dispatchTable` (the
   scheduler dispatch).