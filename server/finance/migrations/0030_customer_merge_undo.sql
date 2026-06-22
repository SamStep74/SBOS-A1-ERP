-- 0030_customer_merge_undo.sql
-- Phase 3 AI agents wave 4 (W102-1) — undo customer merge.
--
-- W99-1 shipped applyCustomerMerge — the MUTATION that
-- re-assigns the secondary's invoices to the primary,
-- archives the secondary, and records the audit row.
-- The original audit row stored the COUNTS of re-assigned
-- invoices + payments, but not the LIST of IDs.
--
-- W102-1 ships undoCustomerMerge — the inverse. For the
-- undo to know which invoices to restore, the audit log
-- must remember the actual list of IDs that were moved.
--
-- This migration adds 5 columns to finance.customer_merge_log:
--   1. reassigned_invoice_ids TEXT  — JSON array of invoice
--      ids that were re-assigned by the original merge
--      (populated by applyCustomerMerge going forward;
--      NULL for pre-W102-1 merges — those can't be undone)
--   2. reassigned_payment_ids TEXT  — JSON array of payment
--      ids that were re-assigned (same caveat)
--   3. undone_at TEXT  — ISO timestamp when undoCustomerMerge
--      ran (NULL = the merge is still active)
--   4. undone_by_user_id BIGINT  — the operator who undid it
--   5. undone_reason TEXT  — operator note on the undo
--
-- The merge log row is the source of truth for both the
-- original merge AND the undo. A "currently active" merge
-- has `undone_at IS NULL`. A "undone" merge has all 3 undo
-- fields populated.

ALTER TABLE finance.customer_merge_log
  ADD COLUMN reassigned_invoice_ids TEXT;

ALTER TABLE finance.customer_merge_log
  ADD COLUMN reassigned_payment_ids TEXT;

ALTER TABLE finance.customer_merge_log
  ADD COLUMN undone_at TEXT;

ALTER TABLE finance.customer_merge_log
  ADD COLUMN undone_by_user_id INTEGER;

ALTER TABLE finance.customer_merge_log
  ADD COLUMN undone_reason TEXT;

-- Partial index: "show me active merges for tenant X" is
-- the hot path for the audit UI. Undone merges are
-- historical; the operator rarely queries them by default.
CREATE INDEX IF NOT EXISTS idx_finance_customer_merge_log_tenant_active
    ON finance.customer_merge_log (tenant_id, created_at DESC)
    WHERE undone_at IS NULL;
