-- Wave 54: Mandatory reason + reason_category on stock adjustments.
--
-- Background: POST /api/finance/stock/adjust accepts a free-text
-- `reason` field but it was optional. The reason is required by
-- financial-control best practice: any change to on-hand quantity
-- that isn't tied to a PO receipt or customer delivery must be
-- explained (auditors need to be able to trace every variance
-- to a documented reason).
--
-- This migration adds:
--   1. reason_category TEXT — a controlled enum so the operator
--      picks from a known list rather than free-typing. Easier
--      to filter and report on.
--   2. An index on (tenant_id, reason_category) for the
--      GET /api/finance/stock/adjustments?category=... filter.
--
-- Backfill: existing rows get reason_category=NULL (the old
-- free-text reason is still in `notes`). They continue to work
-- with the GET endpoint (NULL category is included when no
-- filter is applied; excluded when the filter is set).

ALTER TABLE finance.stock_moves ADD COLUMN reason_category TEXT;

CREATE INDEX IF NOT EXISTS idx_stock_moves_adjustments
  ON finance.stock_moves (tenant_id, reason_category, created_at DESC)
  WHERE move_type = 'ADJUSTMENT';
