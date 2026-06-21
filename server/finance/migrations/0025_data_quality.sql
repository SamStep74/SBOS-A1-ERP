-- Phase 3 AI agents (W93-1) — add columns needed by the
-- data quality + reconciliation helpers.
--
-- Background:
--   The data quality module (server/finance/dataQuality.js)
--   reads finance.customers.code (to identify duplicates by
--   human-readable code) and finance.invoices.customer_hvhh
--   (to detect drift between the snapshot on the invoice and
--   the current customer.hvhh).
--
--   The original customers table (0001_init.sql) doesn't have
--   a code column — that field is managed in the application
--   layer (test mocks + the customer creation endpoint
--   generates 'CUST-{id}'). The data quality module benefits
--   from a stable code for reporting.
--
--   The original invoices table (0001_init.sql) doesn't have
--   a customer_hvhh column. The data quality module can
--   detect drift by JOINing customers to read the current
--   hvhh, but it can't tell WHAT the invoice's snapshot
--   was — for that we need a denormalized customer_hvhh
--   column on the invoice row.
--
-- Both columns are nullable (NULL = "not captured"). The
-- application layer is responsible for populating them on
-- create (the customer + invoice create paths should set
-- these from the customer row at issue time). For now
-- they're NULL for legacy rows.

ALTER TABLE finance.customers ADD COLUMN code TEXT;
ALTER TABLE finance.invoices ADD COLUMN customer_hvhh TEXT;

-- Add a unique index on customers.code per tenant (the
-- duplicate detection module relies on this). The
-- migration runner adds the index only after the column
-- exists, so this CREATE INDEX runs after the ALTER.
CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_customers_tenant_code
    ON finance.customers (code)
    WHERE code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_finance_invoices_customer_hvhh
    ON finance.invoices (customer_hvhh)
    WHERE customer_hvhh IS NOT NULL;