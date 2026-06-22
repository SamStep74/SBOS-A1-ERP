# W104 Summary — Phase 3 reporting wave 7 (scheduler concurrency guard)

**Date:** 2026-06-22.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W97-1 ships the scheduler worker — a setInterval-based loop
that ticks every 60s and dispatches due reports. The
worker had a real bug: if a tick takes longer than
`tickMs` (e.g. SMTP send is slow, or a report function
blocks), the next setInterval tick fires while the
previous is still running. This caused duplicate execution
rows + duplicate emails in production.

W104-1 ships the fix + observability. The fix is a
simple `inProgress` flag that prevents overlapping
ticks; the observability is a `metrics` object on the
handle that the operator can read to verify scheduler
health.

## What shipped

- `server/finance/scheduleRunner.js` (already in HEAD at
  `546697e` via the team's W86 cleanup rebase — the team
  rebased my W104-1 work onto their main):
  - `runOneTick()` helper — combines the `inProgress` guard,
    the metrics accounting, and the dispatch. Both the
    setInterval tick and the direct `tickOnce()` call go
    through this so the metrics are unified.
  - `inProgress` flag — if a tick is running, the next call
    returns early with `summary { fired: 0, skipped: 1,
    errors: 0 }`. The in-flight tick finishes, the next
    call picks up where it left off.
  - `metrics` object — live getters (`totalTicks`,
    `completedTicks`, `erroredTicks`, `inProgress`,
    `lastTickAt`, `lastTickDurationMs`, `lastTickError`).
    Read by the operator to verify scheduler health.
  - `erroredTicks` tracks **infrastructure** failures
    (db query failed, dispatch table missing, etc.).
    Per-schedule dispatch failures are recorded in
    `report_executions` (status='failed') and surfaced
    via the summary's `errors` counter, not via the
    metrics.
- `server/finance/scheduleRunner.test.js` (5 new tests):
  - metrics object exists with the right initial shape
  - tickOnce increments `totalTicks` + `completedTicks`
  - tickOnce sequential calls don't overlap
  - `erroredTicks` + `lastTickError` populated on tick throw
  - metrics.inProgress toggles correctly
- `scripts/deploy-smoke.sh` (STEP 7p2, 2 checks, numbered
  7p2 to avoid the team's existing STEP 7p + my STEP 7p1):
  - scheduler boot log shows `tick=60000ms`
  - server still healthy after scheduler start (proves
    the W104-1 refactor didn't break the boot path)

## Test baseline

- 1688/1688 unit tests pass (was 1683; +5 new)
- `npm run check` clean
- `scripts/deploy-smoke.sh` RESULT: PASS

## Lessons learned

1. **The `inProgress` flag is the simplest possible
   concurrency guard, and it's sufficient.** The
   alternative designs (a queue, a re-entrant lock, a
   distributed lock via Redis) are all over-engineering
   for a single-process Node.js worker. A boolean flag
   that flips on tick start and clears on tick end
   (in `.finally()`) is 5 lines of code and prevents the
   entire class of "overlapping tick" bugs. The lesson:
   **for in-process worker concurrency, a boolean
   guard beats a queue**. A queue is for "I want
   exactly-one-at-a-time AND I want to persist the
   pending work across restarts". For "I want
   at-most-one-at-a-time", the boolean is enough.

2. **The metrics object is a live getter bag, not a
   snapshot.** Each metric is a `get` property on the
   returned object, closing over the local variables
   inside `startScheduler`. Callers that want a
   snapshot should `JSON.stringify(handle.metrics)` (or
   copy the values). The benefit: the metrics update
   in real time as the worker runs, without needing
   the caller to know "when" to read them. The lesson:
   **for observable internal state, prefer live getters
   over a snapshot capture function**. A capture
   function adds a "when do I call this?" question that
   the caller can get wrong; a getter bag is always
   current.

3. **`erroredTicks` tracks infrastructure failures, not
   per-schedule dispatch failures.** This is a design
   choice that took some iteration to get right. The
   first attempt: track any throw inside the tick as an
   error. But `tickOnce` catches per-schedule errors and
   records them in `report_executions` (status='failed')
   — the per-schedule error doesn't propagate up. So
   `erroredTicks` only counts infrastructure failures
   (db query failed, dispatch table missing, etc.). The
   per-schedule success/failure lives in the execution
   table. The lesson: **separate "the worker is broken"
   metrics (erroredTicks) from "this specific schedule
   failed" data (report_executions.status)**. The
   metrics answer "is the worker healthy?"; the
   execution table answers "did this specific run work?".

4. **The summary's `errors` count is for execution-
   RECORDING failures, not dispatch failures.** A subtle
   detail: the original tickOnce code has TWO try/catch
   blocks — one around the dispatch (line 425) that
   sets `error` to a string and continues to record the
   execution, and one around `recordReportExecution`
   (line 448) that increments the summary's `errors`
   counter. The first try/catch makes per-schedule
   failures graceful (they get recorded as 'failed'
   executions, no error propagated). The second try/catch
   makes infrastructure failures (db is down) visible
   via the summary. The lesson: **the summary's
   `errors` field is the SECOND try/catch's counter, not
   the first**. Conflating "dispatch failed" with
   "recording failed" leads to misleading metrics. The
   dispatch failure is recorded in `report_executions`;
   the recording failure is in the summary's `errors`.

5. **The team rebased my W104-1 work onto main during
   their W86 cleanup, before I could commit it.** When
   I went to commit, scheduleRunner.js was already in
   HEAD (the team picked up the W104-1 changes from my
   worktree via the rebase). The test file was reset to
   its pre-W104-1 state. The lesson: **when working in
   parallel with the team, the team's W86 cleanup
   rebases may pick up local changes that aren't yet
   committed**. The fix: re-apply the test additions
   after the rebase lands. The work is preserved; the
   commit attribution differs.

6. **STEP numbering needs a per-wave prefix.** This
   wave's STEP is 7p2 (after the team's 7p + my 7p1).
   The convention: when two waves both want "STEP 7p",
   one gets "7p" and the other gets "7p1" (matching
   the W102-1 "7n2" pattern from earlier today). A
   more systematic fix would be a per-wave prefix like
   "STEP W104-1", but that's a bigger refactor. The
   lesson: **naming uniqueness is a per-SCRIPT problem,
   not a per-WAVE problem** — each smoke step needs a
   globally-unique label, regardless of which wave it
   came from.
