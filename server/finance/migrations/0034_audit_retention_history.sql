-- 0034_audit_retention_history.sql
-- W63: track per-tenant purge history for the retention dashboard.
--
-- Each audit_retention row now carries the timestamp + row count
-- of the LAST purge that ran for that tenant. Nullable — tenants
-- on the default 365d config don't have a row at all, so
-- recordPurgeRun() is a no-op for them (the dashboard reads
-- audit rows directly to find the default tenants).
--
-- Schema naming: same convention as 0033 — `finance.audit_retention`
-- on pg, `audit_retention` on sqlite (the migration runner
-- strips the `finance.` prefix on DDL because sqlite has no
-- schemas).
--
-- Idempotent: ALTER TABLE ADD COLUMN is not natively idempotent
-- in sqlite (it fails with "duplicate column" on the second run).
-- The migration runner catches this error specifically and treats
-- "duplicate column" as success — see server/finance/migrate.js
-- sqliteTranslate for the canonical pattern.

ALTER TABLE finance.audit_retention ADD COLUMN last_purge_at TEXT;
ALTER TABLE finance.audit_retention ADD COLUMN last_purge_count INTEGER;
ALTER TABLE finance.audit_retention ADD COLUMN last_purge_days INTEGER;