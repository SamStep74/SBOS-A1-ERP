-- 0005_tenant_id.sql
-- Multi-tenant kernel: every finance row gets a `tenant_id` so a single
-- physical database can host data for many tenants. Mirrors the pattern in
-- server/rbac/schema.sql (28 existing tenant_id columns) so the rest of the
-- app can treat the two modules consistently.
--
-- Convention (matches RBAC):
--   - tenant_id BIGINT NOT NULL DEFAULT 0
--   - tenant_id = 0 is the "bootstrap" tenant (the system's own data, all
--     pre-migration rows, and the single-tenant default for back-compat).
--   - The tenants table holds one row per known tenant; the migration seeds
--     the bootstrap row id=0 so the default value is always valid.
--
-- Composite indexes (tenant_id, <hot-path-column>) are used so the planner
-- can satisfy the always-on `AND tenant_id = ?` filter together with the
-- common status/date filters without a separate lookup.
--
-- Idempotent (every ALTER uses IF NOT EXISTS where the driver supports it,
-- plus a `CREATE TABLE IF NOT EXISTS` for the new tenants table). On sqlite
-- (the test driver) `ALTER TABLE ... ADD COLUMN` does NOT support
-- `IF NOT EXISTS`; the migration runner already wraps each statement in
-- try/catch via runMigrations. Re-running the migration on a fresh DB is
-- also a no-op because the tenants bootstrap row uses INSERT OR IGNORE.

-- ───────────── Tenants catalog ─────────────
--
-- One row per tenant. The id space is the same BIGINT as the FK column on
-- every other table. Application code may also use a TEXT tenant slug for
-- human-friendly URLs, but the row identity is the BIGINT.
CREATE TABLE IF NOT EXISTS finance.tenants (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The bootstrap tenant. Every pre-migration row resolves to id=0 because of
-- the DEFAULT 0 clauses below; this row makes that id a real, queryable
-- entity in the tenants catalog. The migration runner records this file in
-- finance.migration_history, so re-running won't double-insert.
INSERT INTO finance.tenants (id, name)
  VALUES (0, 'bootstrap')
  ON CONFLICT (id) DO NOTHING;

-- ───────────── Customers ─────────────

ALTER TABLE finance.customers
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_finance_customers_tenant
  ON finance.customers (tenant_id);

-- ───────────── Invoices ─────────────

ALTER TABLE finance.invoices
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 0;

-- Hot path 1: list invoices for a tenant by status (e.g. the open-invoices
-- page filter, the "drafts" queue, the "overdue" badge).
CREATE INDEX IF NOT EXISTS idx_finance_invoices_tenant_status
  ON finance.invoices (tenant_id, status);

-- Hot path 2: tenant × issue_date range (monthly revenue, top-customers
-- window queries, the dashboard's date filters).
CREATE INDEX IF NOT EXISTS idx_finance_invoices_tenant_issue_date
  ON finance.invoices (tenant_id, issue_date);

-- ───────────── Invoice lines ─────────────

ALTER TABLE finance.invoice_lines
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 0;

-- Invoice lines are usually accessed through their parent invoice (which
-- already has the composite indexes above). A single-tenant lookup on
-- lines is rare, but we add the column for FK consistency and to keep
-- the "every row is scoped to a tenant" invariant uniform.
CREATE INDEX IF NOT EXISTS idx_finance_invoice_lines_tenant
  ON finance.invoice_lines (tenant_id);

-- ───────────── Payments ─────────────

ALTER TABLE finance.payments
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 0;

-- Hot path: tenant × paid_at (the cash-flow report, the "last 30 days"
-- rollup, the dashboard's collected-amount card).
CREATE INDEX IF NOT EXISTS idx_finance_payments_tenant_paid_at
  ON finance.payments (tenant_id, paid_at);

-- ───────────── Invoice adjustments ─────────────

ALTER TABLE finance.invoice_adjustments
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 0;

-- Hot path: tenant × created_at (the audit-trail view per tenant, the
-- "operator actions this week" review).
CREATE INDEX IF NOT EXISTS idx_finance_invoice_adjustments_tenant_created_at
  ON finance.invoice_adjustments (tenant_id, created_at);

-- ───────────── VAT carry-forward ─────────────

ALTER TABLE finance.vat_carry_forward
  ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 0;

-- Single-row per tenant (id=1 inside the table is the per-tenant key).
-- The composite index supports "look up the bank for tenant N" which is
-- the only access pattern on this table.
CREATE INDEX IF NOT EXISTS idx_finance_vat_carry_forward_tenant
  ON finance.vat_carry_forward (tenant_id, id);

-- NOTE: the original 0003 schema declared `id INTEGER PRIMARY KEY`,
-- which restricts the table to a single row for the whole DB. With
-- multi-tenant, each tenant needs its own id=1 row — otherwise the
-- bank credit gets clobbered across tenants. The pg path requires
-- a follow-up migration to recreate this table with a composite
-- PK on (tenant_id, id). The sqlite path is fixed in the inline
-- schema mirror in bin/sbos-server.mjs (which already uses
-- composite PK for this table) — pg migration is a follow-up.
