-- 0009_crm.sql
-- CRM (customer relationship management)
-- foundation for Phase 2 of the ERP plan.
-- Ported from packages/erp/src/crm/*.ts in A1-Suite-Local
-- (the user's private R&D monorepo). All orgId references
-- renamed to tenant_id for consistency with the rest of
-- SBOS-A1-ERP.
--
-- Tables:
--   crm_contacts — people at customer companies (separate
--                  from the financial customer in
--                  finance.customers; a contact may or may
--                  not be linked to a financial customer)
--   crm_leads    — potential customers / sales pipeline
--                  (status: new / qualified / proposal /
--                   won / lost)
--
-- The pure functions use these tables in the obvious way:
--   createContact(db, input, tenantId) — INSERT
--   listContacts(db, tenantId)         — SELECT active (ordered by name)
--   createLead(db, input, tenantId)    — INSERT
--   listLeads(db, tenantId, status?)   — SELECT (ordered by id DESC
--                                        because SQLite's
--                                        datetime('now') is
--                                        second-precision; multiple
--                                        inserts in the same second
--                                        share the same created_at,
--                                        but the auto-incrementing
--                                        id is unique and reflects
--                                        insertion order)
--
-- Note: crm_contacts.customer_id is OPTIONAL (a contact
-- may exist before the financial customer is created).
-- crm_leads.company is OPTIONAL (a lead may be a person
-- or a company).
--
-- Phase 2 wave 1 (W70-2): schema + pure functions + tests.
-- Phase 2 wave 2 (future): route wiring + permission keys
-- + smoke check.

-- ───────────── Contacts ─────────────

CREATE TABLE IF NOT EXISTS finance.crm_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  -- Optional FK to finance.customers
  customer_id INTEGER,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS crm_contacts_tenant_idx
    ON finance.crm_contacts (tenant_id);
CREATE INDEX IF NOT EXISTS crm_contacts_customer_idx
    ON finance.crm_contacts (customer_id);

-- ───────────── Leads ─────────────

CREATE TABLE IF NOT EXISTS finance.crm_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  estimated_value_amd INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS crm_leads_tenant_idx
    ON finance.crm_leads (tenant_id);
CREATE INDEX IF NOT EXISTS crm_leads_status_idx
    ON finance.crm_leads (status);
