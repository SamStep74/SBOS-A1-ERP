-- 0004_invoice_adjustments.sql
-- Manual operator adjustments to invoices: write-offs, refunds, and
-- corrections. Recorded separately from finance.payments so the audit
-- trail is clear (a write-off is NOT a customer payment — it's an
-- operator action that mutates the invoice's effective paid_amd).
--
-- Sign convention (the application enforces):
--   writeoff:    amount_amd > 0 — operator agrees the invoice is
--                uncollectable; reduces the effective paid_amd by
--                amount_amd (treated as if the operator paid themselves
--                out of the owed amount).
--   refund:      amount_amd > 0 — the customer was paid back; reduces
--                the effective paid_amd by amount_amd.
--   correction:  amount_amd > 0 — a positive adjustment that ADDS
--                to the effective paid_amd (e.g. an under-recorded
--                payment the operator discovered later).
--
-- The application (server/finance/adjustments.js) is the single writer;
-- the table is append-only (no UPDATE) so the audit trail is preserved.
-- Corrections are recorded as NEW adjustment rows; if the original
-- amount is wrong, the operator records a new correction that nets
-- out the discrepancy.

CREATE TABLE IF NOT EXISTS finance.invoice_adjustments (
  id              BIGSERIAL PRIMARY KEY,
  invoice_id      BIGINT NOT NULL REFERENCES finance.invoices(id),
  kind            TEXT NOT NULL
                    CHECK (kind IN ('writeoff','refund','correction')),
  amount_amd      BIGINT NOT NULL CHECK (amount_amd > 0),
  reason          TEXT NOT NULL,
  approved_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_invoice_adjustments_invoice
  ON finance.invoice_adjustments (invoice_id);
