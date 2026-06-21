-- 0006_finance_audit.sql
-- Finance write audit log: every POST / PATCH / DELETE on the
-- finance surface records (user, action, resource, payload hash,
-- timestamp). Tenant-scoped. The audit_log table is the new
-- authoritative source for "who did what to this invoice/customer/
-- payment"; the rbac permission_audit table stays focused on
-- perm-check decisions.
--
-- Append-only (no UPDATE / DELETE in the application). Idempotent
-- (CREATE TABLE IF NOT EXISTS). Safe to re-run.
--
-- Schema mirrors the rbac permission_audit shape so the audit
-- endpoint can render rows uniformly. The `payload_json` column
-- holds a JSON-encoded snapshot of the request body (truncated to
-- 4KB to keep the table lean). For deeper history, operators
-- should consult the bin/sbos-server.mjs stdout log stream.
--
-- Table naming note: the production migration runner strips the
-- `finance.` schema prefix on sqlite (see server/finance/migrate.js
-- sqliteTranslate + stripFinancePrefix). The actual table name on
-- sqlite is `audit` (no prefix). The pg path keeps the `finance.`
-- schema prefix because pg has real namespaces. Both routes of the
-- application (server/finance/audit.js + the GET endpoint) use
-- queries without the prefix so the SQL is portable — the
-- migration runner's prefix-strip on DDL aligns with the DML shape
-- on sqlite, and the pg path's finance.audit is queried with the
-- prefix in production where the schema exists. (sqlite's lack of
-- schemas means the table is just `audit` in the sqlite file.)

CREATE TABLE IF NOT EXISTS finance.audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  user_id         INTEGER,                       -- nullable: pre-auth path
  username        TEXT,                          -- denormalized for fast read
  action          TEXT NOT NULL,                 -- 'invoice.create', 'invoice.update', 'customer.create', 'payment.create', etc.
  resource        TEXT NOT NULL,                 -- 'invoice:42', 'customer:7', 'payment:99', 'audit.list'
  method          TEXT NOT NULL,                 -- 'POST' | 'PATCH' | 'DELETE' | 'GET' (read audit only)
  path            TEXT NOT NULL,                 -- the URL path
  status_code     INTEGER NOT NULL,
  payload_json    TEXT,                          -- request body, ≤ 4KB
  request_id      TEXT,                          -- correlation id
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_finance_audit_tenant_time
  ON finance.audit (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_finance_audit_resource
  ON finance.audit (resource, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_finance_audit_user
  ON finance.audit (user_id, created_at DESC);
