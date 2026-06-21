-- 0008_purchase.sql
-- Purchase + vendor-bill foundation for Phase 1 of the ERP plan.
-- Ported from packages/erp/src/{purchase,vendor-bills}.ts in
-- A1-Suite-Local (the user's private R&D monorepo). All orgId
-- references renamed to tenant_id for consistency with the rest
-- of SBOS-A1-ERP.
--
-- Tables:
--   vendors             — supplier master (Armenian HVVH, name, address)
--   purchase_orders     — PO header (status: rfq / confirmed /
--                          partial / received / billed / cancelled)
--   purchase_order_lines — line items (catalog_item_id, qty, unit_cost)
--   purchase_receipts   — receipt header (against a PO; tracks
--                          partial vs full receipt)
--   purchase_receipt_lines — line items (received qty, unit_cost)
--   vendor_bills        — AP bill header (status: draft / confirmed /
--                          posted / paid / void)
--   vendor_bill_lines   — bill line items
--
-- State machine (purchase orders):
--   rfq → confirmed (operator confirms the quote)
--   confirmed → received (full receipt via receivePurchaseOrder)
--   confirmed → partial (partial receipt; supplier can deliver
--                          in multiple shipments)
--   partial → received (final receipt completes the order)
--   received → billed (createVendorBillFromReceipt mints the AP bill)
--   any non-final → cancelled (operator cancels the order)
--
-- State machine (vendor bills):
--   draft → confirmed → posted → paid
--   any → void (with a reason)
--
-- The pure functions in server/purchase/*.js own these state
-- transitions; the table doesn't have CHECK constraints because
-- the source-of-truth is the application layer (consistent with
-- the existing finance module conventions).

-- ───────────── Vendors (suppliers) ─────────────

CREATE TABLE IF NOT EXISTS finance.vendors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  hvhh            TEXT,                        -- Armenian tax id (8 digits)
  address         TEXT,
  email           TEXT,
  phone           TEXT,
  contact_name    TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_tenant_code
  ON finance.vendors (tenant_id, code);

-- ───────────── Purchase orders ─────────────

CREATE TABLE IF NOT EXISTS finance.purchase_orders (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id               INTEGER NOT NULL DEFAULT 0,
  order_number            TEXT NOT NULL,       -- human-readable, e.g. 'PO-ARM-0001'
  vendor_id               INTEGER NOT NULL,
  vendor_name             TEXT NOT NULL,       -- denormalized for history
  vendor_hvhh             TEXT,                -- denormalized
  status                  TEXT NOT NULL DEFAULT 'rfq',  -- rfq / confirmed / partial / received / billed / cancelled
  order_date              TEXT NOT NULL,       -- YYYY-MM-DD
  expected_date           TEXT,
  received_quantity       INTEGER NOT NULL DEFAULT 0,
  notes                   TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at            TEXT,
  cancelled_reason        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_orders_tenant_number
  ON finance.purchase_orders (tenant_id, order_number);

CREATE TABLE IF NOT EXISTS finance.purchase_order_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  order_id        INTEGER NOT NULL,
  catalog_item_id INTEGER NOT NULL,
  quantity        INTEGER NOT NULL,
  unit_cost       INTEGER NOT NULL DEFAULT 0,
  description     TEXT,
  line_order      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_purchase_order_lines_order
  ON finance.purchase_order_lines (tenant_id, order_id);

-- ───────────── Purchase receipts ─────────────

CREATE TABLE IF NOT EXISTS finance.purchase_receipts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  order_id        INTEGER NOT NULL,
  receipt_number  TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS finance.purchase_receipt_lines (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id           INTEGER NOT NULL DEFAULT 0,
  receipt_id          INTEGER NOT NULL,
  order_line_id       INTEGER NOT NULL,
  catalog_item_id     INTEGER NOT NULL,
  received_quantity   INTEGER NOT NULL,
  unit_cost           INTEGER NOT NULL DEFAULT 0,
  destination_location_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_purchase_receipt_lines_receipt
  ON finance.purchase_receipt_lines (tenant_id, receipt_id);

-- ───────────── Vendor bills (AP) ─────────────

CREATE TABLE IF NOT EXISTS finance.vendor_bills (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  bill_number     TEXT NOT NULL,
  vendor_id       INTEGER NOT NULL,
  vendor_name     TEXT NOT NULL,
  purchase_order_id INTEGER,                -- nullable for standalone bills
  status          TEXT NOT NULL DEFAULT 'draft',  -- draft / confirmed / posted / paid / void
  subtotal        INTEGER NOT NULL DEFAULT 0,
  vat             INTEGER NOT NULL DEFAULT 0,
  total           INTEGER NOT NULL DEFAULT 0,
  bill_date       TEXT NOT NULL,
  due_date        TEXT,
  notes           TEXT,
  posted_at       TEXT,
  paid_at         TEXT,
  voided_at       TEXT,
  voided_reason   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_bills_tenant_number
  ON finance.vendor_bills (tenant_id, bill_number);

CREATE TABLE IF NOT EXISTS finance.vendor_bill_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  bill_id         INTEGER NOT NULL,
  catalog_item_id INTEGER,
  description     TEXT NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 1,
  unit_cost       INTEGER NOT NULL DEFAULT 0,
  line_subtotal   INTEGER NOT NULL DEFAULT 0,
  vat             INTEGER NOT NULL DEFAULT 0,
  line_total      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_vendor_bill_lines_bill
  ON finance.vendor_bill_lines (tenant_id, bill_id);
