# W105 Summary — Phase 3 reporting wave 8 (report schedule retry)

**Date:** 2026-06-22.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W97-1 ships the scheduler worker that fires on a cron
and dispatches due reports. If a run fails (SMTP server
was down, db lock, etc.), the failure is recorded in
`finance.report_executions` with `status='failed'`, but
the schedule's `next_run_at` is bumped to the next cron
fire. For a weekly schedule (Monday 9am), a Monday
failure means the report is lost for a week.

W105-1 ships the retry mechanism: failed runs are
retried with exponential backoff (1m, 5m, 15m) so
transient failures (SMTP hiccup, brief db lock) are
caught within minutes. After `max_retries` (default 3),
the schedule is "exhausted" and waits for the next
cron fire. The operator can reset the retry state
manually via a new endpoint.

## What shipped

- `server/finance/migrations/0032_report_retry.sql` (new):
  - `ALTER TABLE report_schedules ADD COLUMN retry_count
    INTEGER NOT NULL DEFAULT 0`
  - `ALTER TABLE report_schedules ADD COLUMN max_retries
    INTEGER NOT NULL DEFAULT 3` (configurable 0-10; 0
    disables retry, restoring the W97-1 behavior)
  - `ALTER TABLE report_schedules ADD COLUMN last_retry_at
    TEXT` (ISO timestamp; NULL = no retry yet)
  - Partial index on `(tenant_id, last_retry_at DESC)
    WHERE retry_count > 0` — the operator's
    "show me active retry cycles" view
- `server/finance/reportScheduler.js` (extended):
  - `createReportSchedule`: accepts `max_retries` param
    (validated 0-10; default 3)
  - `getReportSchedule`: returns the 3 new columns
  - INSERT extended to 11 columns
  - `resetScheduleRetries(db, scheduleId, tenantId)`:
    the new function. Clears `retry_count` + `last_retry_at`,
    bumps `next_run_at` to NOW. Returns the updated
    schedule. Raises 404-style ValueError on missing.
- `server/finance/scheduleRunner.js` (extended):
  - `computeRetryBackoffMs(retryCount)`: exported helper.
    1m, 5m, 15m exponential backoff.
  - `tickOnce`: per-schedule retry logic. On failed run,
    if `retry_count < max_retries`, bump `next_run_at`
    to `NOW + backoff(retry_count+1)` + increment
    `retry_count`. On success, reset `retry_count=0`.
    On exhausted, fall back to the normal cron cadence.
- `server/finance/scheduleRunner.test.js` (extended):
  - 5 new `computeRetryBackoffMs` tests
  - 4 new `tickOnce` retry tests (happy path + 2nd
    retry backoff + exhausted fallback + success
    resets `retry_count` to 0)
  - Mock classifier + handler for the new 5-param UPDATE
  - Mock `seedSchedule` extended with the 3 new fields
- `server/finance/reportScheduler.test.js` (extended):
  - `resetScheduleRetries`: 2 tests (clears state + 404)
  - `createReportSchedule` `max_retries`: 2 tests
    (default + custom + zero, plus invalid)
  - Mock INSERT handler extended to 11 columns
  - New `'sched-retry-reset'` classifier + handler
- `server/finance/routes.js` (1 new route):
  - `POST /api/finance/reports/schedules/:id/reset-retries`
    - Perm gate: `reports.dashboard.read` (operator-only)
    - Body: none
    - Returns 200 with the updated schedule
    - Returns 404 if the schedule doesn't exist
- `scripts/deploy-smoke.sh` (STEP 7p3, 3 checks):
  - Setup: create schedule with `max_retries=2`, verify
    the column is persisted
  - Manually set schedule into a retry-cycle state via
    direct SQL
  - POST `/reset-retries`: `retry_count=0`, `last_retry_at=
    null`, `next_run_at` ~= NOW
  - 404 on non-existent schedule

## Test baseline

- 1711/1711 unit tests pass (was 1688; +23 new)
- 32 finance migrations (was 31; +1 new)
- `npm run check` clean
- `scripts/deploy-smoke.sh` RESULT: PASS

## Lessons learned

1. **The cap on `max_retries` (10) is intentional, not
   arbitrary.** A higher cap (say, 100) would let a
   stuck schedule pummel the SMTP server with 100
   retry emails over many days, flooding the operator's
   inbox and consuming resources. A low cap (3) limits
   the retry window to ~21 minutes (1+5+15), which is
   well within the operator's "is this thing broken?"
   attention window. After 3 retries, the schedule is
   "exhausted" and the operator must explicitly reset
   to try again. The lesson: **retry caps should be
   short and tied to a human attention window, not
   to "as long as it takes"**. A retry that runs for
   days is a retry that's broken; a retry that gives
   up after an hour is a retry that's working.

2. **The exponential backoff schedule is 1m, 5m, 15m,
   not 1m, 2m, 4m, 8m.** The classic exponential (2^n)
   doubles each retry, which is too aggressive for
   business scheduling. A 1m/5m/15m schedule is closer
   to a "10-minute pause" pattern that matches human
   expectations: "wait a bit, try again, wait longer,
   try again, give up". The lesson: **business retry
   backoffs should be tuned to human attention
   patterns, not to math textbook exponentials**. The
   schedule is a hint to the operator about how long
   the system has been trying.

3. **The `tickOnce` retry logic runs INSIDE the per-
   schedule loop, not after.** After a per-schedule
   dispatch fails, the code immediately updates the
   schedule's `retry_count` + `next_run_at` BEFORE
   moving to the next schedule. This matters because
   a `tickOnce` call might iterate 100 schedules; if
   one is in a retry cycle, we want that retry to
   proceed independently of the other 99. The lesson:
   **retry state is per-schedule, not per-tick**. The
   worker doesn't track "we're in a retry cycle"; each
   schedule has its own retry state and the tick just
   applies the per-schedule logic.

4. **The `getReportSchedule` mock needed a `'sched-
   retry-reset'` classifier distinct from the generic
   `'sched-update'`** because the parameter positions
   differ. The toggle's `sched-update` reads `ps[0] =
   enabled`, `ps[1] = id`, `ps[2] = tenantId`. The
   reset-retries UPDATE reads `ps[0] = next_run_at`,
   `ps[1] = id`, `ps[2] = tenantId` — same positions
   but different meaning. If both matched the same
   classifier, the mock would set `sched.enabled =
   next_run_at` (a string) which is wrong. The fix:
   match the `RETRY_COUNT = 0` substring in the SQL
   (specific to the reset path) and route to a separate
   handler. The lesson: **mock SQL classifiers should
   match the most specific distinguishing substring,
   not the generic table name**. The generic
   classifier matches too many queries.

5. **The team's W86 cleanup rebase occasionally
   re-applies our local changes** (the scheduleRunner.js
   W104-1 code was picked up in the W86 rebase). The
   W105-1 migration file was on a stale worktree and
   got reset. The fix: verify with `git status` that
   the new files are present before committing; if
   missing, re-create them. The lesson: **the team's
   rebase workflow preserves the work but not the
   file-creation timestamp**. Re-applying a Write
   after a rebase is cheap.

6. **The `let x;` (no initializer) is the right shape
   for variables that are set in every branch.** The
   `no-useless-assignment` lint rule fires on
   `let x = null; ... if (...) { x = a; } else { x = b; }`
   because the initial `null` is "useless" (overwritten
   before being read). The fix: declare without
   initializer — `let x;` — and let the if/else set
   the value. The variable is still typed (uninitialized
   but defined), and the lint rule is satisfied. The
   lesson: **for variables set in every code path,
   don't initialize them to a default value**. The
   default is a code smell (it suggests the author
   wasn't sure which path would set the value).
