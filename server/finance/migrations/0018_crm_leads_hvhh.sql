-- Migration 0018: Add hvhh column to crm_leads for A1-Validator integration.
--
-- A lead represents a prospective customer. The lead's company may have
-- its own Armenian TIN (HHVH) distinct from any existing customer's hvhh
-- (the lead may or may not yet be a customer). Wired into the
-- A1-Validator in v0.8.0 (same fail-soft pattern as customer.hvhh +
-- vendor.hvhh + crm_contacts.hvhh).
--
-- The column is nullable (most leads won't have a TIN — that's only
-- populated when the lead has been formally quoted with a company).
--
-- No data backfill: existing CRM leads have no hvhh (the previous
-- schema didn't have the column).

ALTER TABLE finance.crm_leads ADD COLUMN hvhh TEXT;

-- Same partial index pattern as finance.customers — the lookup only
-- matters for leads that actually have a hvhh.
CREATE INDEX idx_finance_crm_leads_hvhh ON finance.crm_leads (hvhh)
  WHERE hvhh IS NOT NULL;