-- 0031_report_run_now.sql
-- Phase 3 reporting wave 6 (W103-1) — "run now" admin endpoint.
--
-- W97-1 ships the scheduler worker — it ticks on a cron
-- and dispatches due reports. The operator has no way
-- to manually trigger a schedule (e.g. to verify a fix
-- without waiting for the next cron fire, or to re-run
-- a report that failed).
--
-- W103-1 ships the "run now" admin endpoint. The operator
-- hits POST /api/finance/reports/schedules/:id/run-now,
-- the server dispatches the report immediately, and
-- records the execution in finance.report_executions
-- (same as a scheduled tick).
--
-- To distinguish "manual" (forced) runs from "scheduler"
-- (cron) runs, this migration adds a `triggered_by` TEXT
-- column to finance.report_executions. Default 'scheduler'
-- for the W97-1 path; 'manual' for the new run-now path.
-- The audit UI can filter by this column to show "this
-- report was manually triggered" vs "this report was
-- triggered by the scheduler".

ALTER TABLE finance.report_executions
  ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'scheduler';

-- Partial index: "show me manual runs for this tenant" is
-- the operational view the CFO wants when verifying their
-- own "run now" actions.
CREATE INDEX IF NOT EXISTS idx_finance_report_executions_tenant_manual
    ON finance.report_executions (tenant_id, created_at DESC)
    WHERE triggered_by = 'manual';
