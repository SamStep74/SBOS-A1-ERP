-- Migration 0016: Add hvhh column to crm_contacts for A1-Validator integration.
--
-- A self-employed contact may have their own Armenian TIN (HHVH) that's
-- distinct from their employer's. Wired into the A1-Validator in v0.7.0
-- (same fail-soft pattern as customer.hvhh + vendor.hvhh).
--
-- The column is nullable (most contacts at customer companies don't have
-- their own TIN — only self-employed contacts do).
--
-- No data backfill: existing CRM contacts have no hvhh (the previous
-- schema didn't have the column).

ALTER TABLE finance.crm_contacts ADD COLUMN hvhh TEXT;

-- Same partial index pattern as finance.customers — the lookup only matters
-- for contacts that actually have a hvhh.
CREATE INDEX idx_finance_crm_contacts_hvhh ON finance.crm_contacts (hvhh)
  WHERE hvhh IS NOT NULL;