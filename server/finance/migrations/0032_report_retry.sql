-- 0032_report_retry.sql
-- Phase 3 reporting wave 8 (W105-1) — retry on failed runs.
--
-- W97-1 ships the scheduler worker that fires on a cron.
-- If a run fails (SMTP server was down, db lock, etc.),
-- the failure is recorded in finance.report_executions
-- with status='failed', but the schedule's next_run_at
-- is bumped to the next cron fire. For a weekly schedule
-- (Monday 9am), a Monday failure means the report is
-- lost for a week.
--
-- W105-1 adds the retry mechanism:
--   1. retry_count     — how many retries have happened for
--      the most recent failure cycle (resets to 0 on success)
--   2. max_retries     — cap on retries per failure cycle
--      (default 3, configurable per-schedule)
--   3. last_retry_at   — ISO timestamp of the most recent
--      retry (NULL = no retry has happened yet)
--
-- The retry uses exponential backoff: 1m, 5m, 15m. After
-- max_retries, the schedule is "exhausted" and waits for
-- the next cron fire. The operator can reset the retry
-- state via POST /api/finance/reports/schedules/:id/reset-retries
-- (a future wave) to trigger an immediate retry.

ALTER TABLE finance.report_schedules
  ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE finance.report_schedules
  ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3;

ALTER TABLE finance.report_schedules
  ADD COLUMN last_retry_at TEXT;

-- Partial index: "show me schedules that have failed and
-- need operator attention" is the audit query the operator
-- runs. Schedules with retry_count > 0 are the active
-- retry candidates.
CREATE INDEX IF NOT EXISTS idx_finance_report_schedules_retrying
    ON finance.report_schedules (tenant_id, last_retry_at DESC)
    WHERE retry_count > 0;
