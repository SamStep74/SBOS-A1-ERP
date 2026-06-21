-- 0011_desk.sql
-- Desk (ticketing / support) foundation for
-- Phase 2 of the ERP plan. Ported from
-- packages/erp/src/desk/*.ts in A1-Suite-Local
-- (the user's private R&D monorepo). All orgId
-- references renamed to tenant_id for
-- consistency with the rest of SBOS-A1-ERP.
--
-- Tables:
--   desk_cases   — support tickets (status: open
--                  / pending / resolved / closed;
--                  priority: low / normal / high
--                  / urgent)
--   desk_replies — replies on a case (append-
--                  only log of customer + agent
--                  replies)
--
-- The pure functions use these tables in the
-- obvious way:
--   createCase(db, input, tenantId)    — INSERT
--   listCases(db, tenantId, status?)   — SELECT
--                                          (optional
--                                          status
--                                          filter)
--   getCase(db, caseId, tenantId)      — SELECT
--                                          one
--   createReply(db, caseId, input, ...) — INSERT
--   listReplies(db, caseId, tenantId)  — SELECT
--                                          (ordered
--                                          by
--                                          created_at)
--
-- The customer_id is OPTIONAL (a case may be
-- from a prospect not yet on-boarded). The
-- contact_id is OPTIONAL (a case may be from
-- someone who isn't in the contacts table
-- yet; future waves add the CRM integration).
--
-- Phase 2 desk wave 1 (W72-1): schema + pure
-- functions + tests. Wave 2 (future): route
-- wiring + permission keys + smoke check.

-- ───────────── Cases ─────────────

CREATE TABLE IF NOT EXISTS finance.desk_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  -- Optional FK to finance.customers
  customer_id INTEGER,
  -- Optional FK to finance.crm_contacts
  contact_id INTEGER,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  assignee_id INTEGER,
  -- Optional: the customer-facing
  -- tracking number (printed on the
  -- case email reply).
  tracking_number TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS desk_cases_tenant_idx
    ON finance.desk_cases (tenant_id);
CREATE INDEX IF NOT EXISTS desk_cases_status_idx
    ON finance.desk_cases (status);
CREATE INDEX IF NOT EXISTS desk_cases_priority_idx
    ON finance.desk_cases (priority);
CREATE UNIQUE INDEX IF NOT EXISTS desk_cases_tracking_idx
    ON finance.desk_cases (tenant_id, tracking_number)
    WHERE tracking_number IS NOT NULL;

-- ───────────── Replies ─────────────

CREATE TABLE IF NOT EXISTS finance.desk_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  case_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  -- The author: 'customer' (came in via the
  -- public form / email) or 'agent' (a
  -- support agent on the SBOSS side).
  author TEXT NOT NULL,
  author_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS desk_replies_tenant_idx
    ON finance.desk_replies (tenant_id);
CREATE INDEX IF NOT EXISTS desk_replies_case_idx
    ON finance.desk_replies (case_id);
