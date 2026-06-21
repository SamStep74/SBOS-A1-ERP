-- Phase 3 POS basics wave 3 (W89-1) — refunds + voids.
--
-- This migration adds the pos_refunds table. A refund is a
-- distinct event from a payment: it represents the cashier
-- giving money BACK to the customer for a previously-completed
-- sale. Refunds are append-only events (you cannot edit a
-- refund after the fact — the cashier would void the refund
-- and re-issue it).
--
-- A void is NOT a refund. A void flips a sale's status to
-- 'voided' WITHOUT recording a refund row. This matches
-- real-world POS behavior: a cashier can cancel a sale
-- BEFORE payment (void) or issue a refund AFTER payment
-- (refund). Both end with status='voided', but only the
-- refund path inserts a pos_refunds row.
--
-- Schema notes:
--   - payment_method mirrors pos_payments.payment_method
--     (the original payment method that is being refunded —
--     cash refunds come out of the drawer, card refunds
--     reverse the terminal capture, etc.).
--   - amount_amd is the AMOUNT REFUNDED, always positive.
--     The "negative payment" semantic is implicit (a refund
--     row means the customer's balance decreases).
--   - reason is optional free-text (e.g. "defective unit",
--     "customer changed mind", "wrong item rung").
--   - created_by is the user id who issued the refund
--     (manager approval may be required for refunds above
--     a threshold — out of scope for wave 3).
--
-- Lifecycle:
--   1. Sale is created (status='open')
--   2. Line items + payments added (still status='open')
--   3. Sale is completed (status='completed', completed_at stamped)
--   4. Customer returns goods → cashier issues refund
--      (status='completed' → 'voided' + pos_refunds row)
--
-- OR for an in-progress cancellation:
--   1. Sale is created (status='open')
--   2. Cashier decides to cancel → voidSale
--      (status='open' → 'voided', NO pos_refunds row)

CREATE TABLE IF NOT EXISTS finance.pos_refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    -- FK to finance.pos_sales.id (NOT enforced as a SQL FK
    -- because pos_sales lives in 0017_pos_basics.sql and we
    -- don't want a cross-migration FK constraint that breaks
    -- the migration runner's idempotency story).
    sale_id INTEGER NOT NULL,
    -- The original payment method being refunded (cash refunds
    -- take cash out of the drawer; card refunds reverse the
    -- terminal capture; bank_transfer refunds reverse the
    -- bank credit; etc.). Mirrors pos_payments.payment_method.
    payment_method TEXT NOT NULL
        CHECK (payment_method IN ('cash', 'card', 'mobile', 'bank_transfer', 'other')),
    -- The amount refunded, in AMD. Always POSITIVE — the
    -- "negative payment" semantic is implicit (a refund row
    -- means money flows back to the customer).
    amount_amd INTEGER NOT NULL CHECK (amount_amd > 0),
    -- Optional reason text (e.g. "defective unit", "wrong
    -- item", "customer changed mind"). Manager-readable
    -- audit trail; up to 1024 chars.
    reason TEXT,
    -- The user id who issued the refund. Mirrors pos_payments
    -- in NOT enforcing a FK to users (different migration).
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes — same shape as pos_payments (the table is conceptually
-- a sister to pos_payments: same columns, same FKs, different
-- event semantics).
CREATE INDEX IF NOT EXISTS pos_refunds_tenant_idx
    ON finance.pos_refunds (tenant_id);
CREATE INDEX IF NOT EXISTS pos_refunds_sale_idx
    ON finance.pos_refunds (sale_id);
CREATE INDEX IF NOT EXISTS pos_refunds_payment_method_idx
    ON finance.pos_refunds (payment_method);