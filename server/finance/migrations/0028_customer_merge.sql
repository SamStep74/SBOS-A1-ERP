-- 0028_customer_merge.sql
-- Phase 3 AI agents wave 3 (W99-1) — apply customer merge.
--
-- W94-1 shipped the ADVISORY layer: suggestMergeCandidates
-- proposes a primary + secondary for each duplicate group,
-- with the count of invoices + payments that would be
-- re-assigned. The operator still had to apply the merge
-- manually.
--
-- W99-1 ships the MUTATION: applyCustomerMerge actually
-- re-assigns the secondary's invoices to the primary, sets
-- the secondary's `archived = 1`, and records an audit row
-- in finance.customer_merge_log.
--
-- The mutation has two design invariants:
--   1. Soft delete (not hard delete). The secondary row is
--      kept (archived = 1) so the audit history of who
--      merged what + when is preserved. A future undo-merge
--      wave could flip archived back to 0.
--   2. Explicit audit row. The finance.customer_merge_log
--      table records WHO applied the merge, WHEN, the
--      reason, and the counts of invoices + payments that
--      were re-assigned. This is the operator's "show me
--      what AI did" log.

-- ───────────── Add `archived` column to finance.customers ─────────────
--
-- Soft-delete flag. 0 = active, 1 = archived. Most queries
-- filter to archived = 0; only the merge-audit + undo-merge
-- paths care about archived = 1.
ALTER TABLE finance.customers ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

-- Partial index on (tenant_id, archived) — most queries are
-- "active customers for tenant X", which benefits from a
-- small index keyed on the active subset.
CREATE INDEX IF NOT EXISTS idx_finance_customers_tenant_archived
    ON finance.customers (tenant_id, archived)
    WHERE archived = 0;

-- ───────────── Audit log table ─────────────
--
-- One row per applied merge. The row stores enough context
-- to reconstruct the merge:
--   - The two customer IDs (primary + secondary)
--   - The counts of re-assigned invoices + payments
--   - The operator who applied the merge (applied_by_user_id)
--   - The reason (operator note + system default)
--   - The timestamps (created_at only — we never update a
--     merge log row, it's append-only)
--
-- The composite index (tenant_id, created_at DESC) is the
-- hot path for "show me recent merges for this tenant" in
-- the audit UI.
CREATE TABLE finance.customer_merge_log (
  id                          BIGSERIAL PRIMARY KEY,
  tenant_id                   BIGINT NOT NULL DEFAULT 0,
  primary_customer_id         BIGINT NOT NULL REFERENCES finance.customers(id),
  secondary_customer_id       BIGINT NOT NULL REFERENCES finance.customers(id),
  invoices_reassigned_count   BIGINT NOT NULL DEFAULT 0,
  payments_reassigned_count   BIGINT NOT NULL DEFAULT 0,
  applied_by_user_id          BIGINT,
  reason                      TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_finance_customer_merge_log_tenant_created_at
    ON finance.customer_merge_log (tenant_id, created_at DESC);
CREATE INDEX idx_finance_customer_merge_log_primary
    ON finance.customer_merge_log (primary_customer_id);
CREATE INDEX idx_finance_customer_merge_log_secondary
    ON finance.customer_merge_log (secondary_customer_id);
