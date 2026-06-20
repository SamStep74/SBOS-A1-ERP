-- 0001_init.sql
-- Initial SBOS-A1-ERP finance schema. Mirrors server/finance/schema.sql (the
-- canonical fresh-install schema) but is the versioned migration that the
-- runner applies.
--
-- Money is stored as whole drams (BIGINT amd). No floats. Quantities on
-- invoice_lines use NUMERIC(12,3) for sub-unit precision (e.g. 1.5 hours).
--
-- See server/finance/schema.sql for the full design notes.

CREATE SCHEMA IF NOT EXISTS finance;

-- ───────────── Customers ─────────────

CREATE TABLE finance.customers (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  hvhh            TEXT,                        -- Armenian tax ID, nullable
  address         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_finance_customers_name ON finance.customers (name);
CREATE INDEX idx_finance_customers_hvhh ON finance.customers (hvhh)
  WHERE hvhh IS NOT NULL;

-- ───────────── Invoices ─────────────

CREATE TABLE finance.invoices (
  id              BIGSERIAL PRIMARY KEY,
  customer_id     BIGINT NOT NULL REFERENCES finance.customers(id),
  invoice_number  TEXT NOT NULL UNIQUE,        -- e.g. INV-2026-0001
  issue_date      DATE NOT NULL,
  due_date        DATE NOT NULL,
  subtotal_amd    BIGINT NOT NULL,              -- whole drams, no floats
  vat_amd         BIGINT NOT NULL DEFAULT 0,
  total_amd       BIGINT NOT NULL,              -- subtotal_amd + vat_amd
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','paid','overdue','void')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_finance_invoices_customer ON finance.invoices (customer_id);
CREATE INDEX idx_finance_invoices_status ON finance.invoices (status);
CREATE INDEX idx_finance_invoices_due_date ON finance.invoices (due_date);

-- ───────────── Invoice lines ─────────────

CREATE TABLE finance.invoice_lines (
  id              BIGSERIAL PRIMARY KEY,
  invoice_id      BIGINT NOT NULL REFERENCES finance.invoices(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  quantity        NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  unit_price_amd  BIGINT NOT NULL CHECK (unit_price_amd >= 0),
  line_total_amd  BIGINT NOT NULL                -- quantity * unit_price_amd (rounded)
);

CREATE INDEX idx_finance_invoice_lines_invoice ON finance.invoice_lines (invoice_id);

-- ───────────── Payments ─────────────

CREATE TABLE finance.payments (
  id              BIGSERIAL PRIMARY KEY,
  invoice_id      BIGINT NOT NULL REFERENCES finance.invoices(id),
  paid_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  amount_amd      BIGINT NOT NULL CHECK (amount_amd > 0),
  method          TEXT NOT NULL DEFAULT 'bank_transfer'
                    CHECK (method IN ('bank_transfer','cash','card','other')),
  reference       TEXT,                        -- bank ref, check #, etc.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_finance_payments_invoice ON finance.payments (invoice_id);
CREATE INDEX idx_finance_payments_paid_at ON finance.payments (paid_at);
