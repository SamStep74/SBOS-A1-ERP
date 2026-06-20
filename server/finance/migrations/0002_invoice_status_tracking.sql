-- 0002_invoice_status_tracking.sql
-- Adds the lifecycle columns that the invoice CRUD module's status
-- transitions write to. Without these columns, updateInvoice({status:'sent'})
-- and voidInvoice(...) fail at runtime with "no such column: sent_at" /
-- "voided_at" / "void_reason" — the test mocks had the columns in their
-- in-memory rows, so the unit/integration tests passed, but a real database
-- (sqlite or pg) would reject the writes.
--
-- Idempotent (IF NOT EXISTS) so a fresh schema that already has these
-- columns can run this migration without error.
--
-- Note: split into 3 separate ALTER TABLE statements because SQLite's
-- `ALTER TABLE ADD COLUMN` only supports one column at a time. Postgres
-- accepts both forms.

ALTER TABLE finance.invoices ADD COLUMN IF NOT EXISTS sent_at     TIMESTAMPTZ;
ALTER TABLE finance.invoices ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
ALTER TABLE finance.invoices ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- Index on sent_at for the "overdue / pending-send" queries the reporting
-- module will need in wave 6+. Cheap on the small invoice table but worth
-- having now so the index exists when reports land.
CREATE INDEX IF NOT EXISTS idx_finance_invoices_sent_at
  ON finance.invoices (sent_at)
  WHERE sent_at IS NOT NULL;
