-- Phase 3 reporting wave 3 (W96-1) — scheduled report runs.
--
-- This migration adds the schema for defining + tracking
-- scheduled report runs. The actual scheduler (a cron-like
-- worker that triggers report runs on a schedule) is out of
-- scope for wave 3; wave 3 ships the data model + the API
-- to create/track schedules. A future wave can add the
-- scheduler worker (e.g. a setInterval-based runner in
-- bin/sbos-server.mjs).
--
-- Two new tables:
--
--   1. finance.report_schedules — the "definition" of a
--      scheduled report. One row per schedule. The
--      schedule is a cron expression (e.g. '0 9 * * 1' =
--      every Monday at 9am). The params column is JSON
--      (the report-specific inputs).
--
--   2. finance.report_executions — the "history" of past
--      runs. One row per execution. The status state
--      machine: pending → running → completed | failed.
--      The result_json column stores the report output
--      (or the error_message if the run failed).
--
-- The report_type column is a free-text string. The valid
-- values are defined by the client (matching the
-- report functions in server/finance/reports.js):
--   - 'ar_aging'           — getArAging
--   - 'monthly_revenue'    — getMonthlyRevenue
--   - 'top_customers'      — getTopCustomers
--   - 'data_quality'       — getDataQualitySummary
--   - 'revenue_trend'      — listMonthlyRevenueTrend
--   - 'customer_breakdown' — getCustomerRevenueBreakdown
-- The CHECK constraint is intentionally NOT applied at
-- the schema level (the report types are a client/server
-- contract, not a schema invariant — new types can be
-- added without a migration).

CREATE TABLE IF NOT EXISTS finance.report_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    -- Human-friendly name (e.g. "Weekly AR aging report",
    -- "Daily top customers"). NOT unique per tenant
    -- (the same name can be reused for different report
    -- types — the schedule_id is the unique identifier).
    name TEXT NOT NULL,
    -- The report function to run. See comments above for
    -- the valid values. Stored as TEXT (not ENUM) so
    -- new report types can be added without a migration.
    report_type TEXT NOT NULL,
    -- Cron expression (5-field standard cron: minute,
    -- hour, day-of-month, month, day-of-week). Examples:
    --   '0 9 * * 1'  = every Monday at 9am
    --   '0 0 1 * *'  = first of every month at midnight
    --   '*/30 * * * *' = every 30 minutes
    -- The scheduler worker (future wave) is responsible
    -- for parsing the cron + triggering runs.
    cron_expression TEXT NOT NULL,
    -- 1 = enabled (will run on schedule), 0 = disabled
    -- (paused; the scheduler skips it). Default enabled.
    enabled INTEGER NOT NULL DEFAULT 1
        CHECK (enabled IN (0, 1)),
    -- JSON-encoded params for the report (e.g. for
    -- 'monthly_revenue' this would be { yearMonth: '2026-01' }).
    -- Stored as TEXT (not JSONB) because the production
    -- schema uses sqlite + TEXT. The scheduler parses
    -- the JSON at run time.
    params TEXT,
    -- Optional email to send the report to when the run
    -- completes. NULL = no email (the report is just
    -- stored in report_executions and viewed via API).
    -- Future wave can add SMTP integration.
    notify_email TEXT,
    -- Last run timestamp (NULL until the first run completes).
    last_run_at TEXT,
    -- Next scheduled run timestamp (computed by the
    -- scheduler at the time of the last run). The
    -- scheduler uses this to know WHEN to trigger the
    -- next run. NULL = never run yet.
    next_run_at TEXT,
    -- The user who created the schedule.
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS report_schedules_tenant_idx
    ON finance.report_schedules (tenant_id);
CREATE INDEX IF NOT EXISTS report_schedules_enabled_idx
    ON finance.report_schedules (enabled);
CREATE INDEX IF NOT EXISTS report_schedules_next_run_idx
    ON finance.report_schedules (next_run_at)
    WHERE next_run_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS finance.report_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    -- FK to finance.report_schedules.id (NOT enforced —
    -- the scheduler writes rows here without a SQL FK
    -- because the cross-migration FK is messy).
    schedule_id INTEGER NOT NULL,
    -- Mirror the report_type from the schedule (denormalized
    -- for query speed: listReportExecutions can filter by
    -- report_type without joining to report_schedules).
    report_type TEXT NOT NULL,
    -- Status: pending (queued, not started) | running
    -- (worker is computing the result) | completed
    -- (result is in result_json) | failed (error_message
    -- is populated).
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    -- When the worker started the run.
    started_at TEXT,
    -- When the worker finished the run (success or failure).
    completed_at TEXT,
    -- Wall-clock duration of the run (in milliseconds).
    duration_ms INTEGER,
    -- JSON-encoded result of the report. NULL while
    -- pending/running; populated on completed; NULL on
    -- failed (the error_message is populated instead).
    result_json TEXT,
    -- Error message on failure. NULL on success.
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS report_executions_tenant_idx
    ON finance.report_executions (tenant_id);
CREATE INDEX IF NOT EXISTS report_executions_schedule_idx
    ON finance.report_executions (schedule_id);
CREATE INDEX IF NOT EXISTS report_executions_status_idx
    ON finance.report_executions (status);
CREATE INDEX IF NOT EXISTS report_executions_report_type_idx
    ON finance.report_executions (report_type);