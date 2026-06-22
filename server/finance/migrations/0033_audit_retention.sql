-- 0033_audit_retention.sql
-- W60: audit-log retention config.
--
-- One row per tenant with the retention window in days. Missing
-- row = the default 365-day window (synthesised by
-- getAuditRetention; the row is written only when the operator
-- explicitly sets a non-default value).
--
-- Append-only on the data side — there's no UPDATE/DELETE in
-- the application code. The application UPSERTs on conflict to
-- support the "set then reset then set again" admin flow.
--
-- Schema naming: `finance.audit_retention` follows the same
-- convention as `finance.audit` (migration 0006). The migration
-- runner strips the `finance.` prefix on sqlite because sqlite
-- has no schemas; pg keeps it.

CREATE TABLE IF NOT EXISTS finance.audit_retention (
  tenant_id       INTEGER PRIMARY KEY,
  -- 0 = keep forever; N > 0 = keep the most recent N days.
  -- 365 is the default (one year — typical regulatory window
  -- for financial records in many jurisdictions).
  retention_days  INTEGER NOT NULL DEFAULT 365
                  CHECK (retention_days >= 0
                    AND retention_days <= 50 * 365),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by      INTEGER
);
