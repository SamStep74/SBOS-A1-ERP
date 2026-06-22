# W96 Summary — Phase 3 reporting wave 3 (scheduled report runs)

**Date:** 2026-06-22.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W85 + W92 shipped the report functions (aggregate +
drill-down) and the executive dashboard. Wave 3 closes
the loop: a CFO who wants the AR aging report every
Monday at 9am can now define a schedule; the scheduler
worker (future wave) will trigger the run + record the
result.

W96-1 ships the data model + API for the schedule
definitions + execution history. The actual scheduler
worker (the setInterval-based runner that calls the
schedules) is OUT of scope for wave 3 — the worker is a
future wave that just calls the existing API.

## What shipped

- `server/finance/migrations/0027_report_schedules.sql`:
  2 new tables + 7 indexes
  - `finance.report_schedules` (id, tenant_id, name,
    report_type, cron_expression, enabled, params JSON,
    notify_email, last_run_at, next_run_at, created_by)
  - `finance.report_executions` (id, tenant_id,
    schedule_id, report_type, status
    pending/running/completed/failed, started_at,
    completed_at, duration_ms, result_json, error_message)
- `server/finance/reportScheduler.js`: 6 new pure
  functions
  - `createReportSchedule(input, tenantId)` — creates
    a schedule; validates name (1-128 chars), report_type
    (6 valid values: ar_aging / monthly_revenue /
    top_customers / data_quality / revenue_trend /
    customer_breakdown), and 5-field cron expression
  - `listReportSchedules(tenantId, { enabled })` — list
    with optional enabled filter
  - `getReportSchedule(scheduleId, tenantId)` — single
    by id (404 cross-tenant)
  - `toggleReportSchedule(scheduleId, input, tenantId)` —
    flip the enabled flag (0 = disabled, 1 = enabled)
  - `recordReportExecution(input, tenantId)` — record a
    run (called by the future scheduler worker; updates
    `last_run_at` on completed/failed)
  - `listReportExecutions(tenantId, { scheduleId, status })`
    — history with optional scheduleId + status filters
- `server/finance/reportScheduler.test.js`: 16 new
  unit tests
- `server/finance/routes.js`: 6 new HTTP routes
  - GET/POST /api/finance/reports/schedules + GET /:id
  - POST /api/finance/reports/schedules/:id/toggle
  - POST /api/finance/reports/executions
  - GET /api/finance/reports/executions
- `scripts/deploy-smoke.sh`: 3 new smoke checks
  (create + get + toggle on schedule id=1)

## Test baseline

- 1549/1549 unit tests pass (was 1533; +16 new scheduler
  tests)
- `npm run check` clean
- `scripts/deploy-smoke.sh` RESULT: PASS

## Lessons learned

1. **Minimal cron validation is enough at the API layer.**
   The schedule's `cron_expression` is a 5-field string
   (minute hour day-of-month month day-of-week). The API
   validates the shape (5 fields, each matches a small
   regex for *, */N, or N[-N][,N[-N]]*) but does NOT
   compute "next fire time" — that's the scheduler
   worker's job. The lesson: **the API layer validates
   syntax; the scheduler layer validates semantics**.
   The API is a contract about "is this a valid cron
   string?"; the scheduler is the contract about "when
   does this fire?". Mixing them would couple the API
   to cron parsing libraries.

2. **The `report_type` column is TEXT, not ENUM.** New
   report types can be added without a migration —
   server/finance/reports.js gains a new function, and
   the report_type values list is updated in the
   application layer. The schema-level CHECK constraint
   is intentionally absent. The lesson: **for
   client/server contract values (like report types),
   prefer TEXT over ENUM** — the schema is the data
   store, not the contract registry. The application
   layer (assertReportType in reportScheduler.js) is the
   registry.

3. **The schedule and execution tables are split — the
   schedule is the definition (one row per recurring
   report), the execution is the history (one row per
   run).** This is a one-to-many relationship: one
   schedule has many executions. Splitting the tables
   avoids bloating the schedule row with historical
   data + makes it easy to list "last 10 runs of this
   schedule" with a simple `WHERE schedule_id = $1 ORDER BY
   id DESC`. The lesson: **for any "definition +
   history" relationship, use two tables, not one with
   a JSON column** — JSON columns are great for
   arbitrary metadata, but they're hard to index and
   hard to query. Execution history is a first-class
   queryable entity, so it deserves its own table.

4. **The mockDb classifier needed a word-boundary regex
   to distinguish the sched-get query from the list
   query.** The sched-get query has `WHERE id = $1 AND
   tenant_id = $2`; the list query has `WHERE tenant_id
   = $1`. Both queries contain the substring `id = $1`
   (the `tenant_id = $1` part). Adding `\b` to the regex
   (`/\bid\s*=\s*\$1/`) restricts the match to a word
   boundary, so the sched-get pattern only matches the
   single-row query. The lesson: **when distinguishing
   similar SQL shapes by column name, use word
   boundaries in the regex** — `id` is a common suffix
   in column names (tenant_id, schedule_id, etc.).

5. **The future scheduler worker is a small, well-defined
   next step.** It would:
   - On server boot, list all enabled schedules
   - For each schedule, compute next_run_at (via a cron
     library)
   - setInterval(checkSchedules, 60_000): every minute,
     find schedules where next_run_at <= now() and
     trigger the report function
   - Call recordReportExecution with the result
   - Update next_run_at to the next fire time
   - Send the email if notify_email is set (SMTP
     integration)
   The data model + API are already in place. The worker
   is just a few hundred lines of Node.js glue.