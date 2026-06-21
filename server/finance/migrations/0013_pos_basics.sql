-- 0013_pos_basics.sql
-- POS basics (Phase 3 W87-1) — minimum viable point-of-sale:
-- registers, shifts, sales, sale lines, payments.
--
-- Tables (5):
--   pos_registers       — cash register metadata
--                         (id, tenant_id, code, name, location, active)
--   pos_shifts          — shift open/close lifecycle
--                         (id, tenant_id, register_id, opened_by,
--                         opened_at, closed_by, closed_at,
--                         opening_cash_amd, closing_cash_amd,
--                         status: open | closed)
--   pos_sales           — sale header
--                         (id, tenant_id, shift_id, register_id,
--                         cashier_id, customer_id, total_amd,
--                         tax_amd, status: open | completed |
--                         voided, created_at, completed_at)
--   pos_sale_lines      — sale line items
--                         (id, tenant_id, sale_id, catalog_item_id,
--                         quantity, unit_price_amd, line_total_amd,
--                         line_tax_amd)
--   pos_payments        — payment method records
--                         (id, tenant_id, sale_id, payment_method:
--                         cash | card | mobile | bank_transfer |
--                         other, amount_amd, tendered_amd,
--                         change_amd, reference)
--
-- The pure functions are in server/finance/pos.js:
--   openShift(db, input, tenantId)            — starts a shift on a register
--   listShifts(db, tenantId, { registerId, status })
--   getShift(db, shiftId, tenantId)
--   closeShift(db, shiftId, input, tenantId) — closes a shift (status check)
--   addSale(db, input, tenantId)             — creates a sale header under an open shift
--   addSaleLine(db, input, tenantId)         — adds a line item to an open sale
--   addPayment(db, input, tenantId)          — records a payment for an open sale
--
-- Phase 3 POS basics wave 1 (W87-1): schema + pure functions + tests.
-- Wave 2 (future): route wiring + perm keys + smoke checks.
-- Wave 3 (future): end-of-day reports, reconciliation, refunds.
--
-- Migration safety: this migration creates 5 new tables. It does
-- NOT alter any existing tables. Safe for both fresh installs (the
-- smoke deploy case) and existing installs.
--
-- Tenant scope: tenant_id on every table (multi-tenant SaaS
-- invariant — every row is scoped to exactly one tenant). The
-- pure functions thread tenantId through every read + write.

-- ───────────── Registers ─────────────

CREATE TABLE IF NOT EXISTS finance.pos_registers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  -- Human-friendly code (unique per tenant). E.g.
  -- "REG-001" for the first register at a location.
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Optional location label (e.g. "Front Counter",
  -- "Drive-Through Window 2"). Nullable.
  location TEXT,
  -- Soft-delete flag: 0 = active, 1 = retired. Active
  -- registers accept new shifts + sales; retired
  -- registers are read-only (for historical reporting).
  active INTEGER NOT NULL DEFAULT 1
    CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS pos_registers_tenant_idx
    ON finance.pos_registers (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS pos_registers_code_idx
    ON finance.pos_registers (tenant_id, code);

-- ───────────── Shifts ─────────────

CREATE TABLE IF NOT EXISTS finance.pos_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  register_id INTEGER NOT NULL,
  -- The user who opened the shift (a users.id; not
  -- enforced as FK because users is in a different
  -- migration).
  opened_by INTEGER NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- The user who closed the shift (null while open).
  closed_by INTEGER,
  closed_at TEXT,
  -- The cash float at the start of the shift (in AMD).
  -- Used for end-of-day reconciliation (the closing
  -- cash should be opening_cash + sum(cash payments) -
  -- sum(cash refunds) for the shift).
  opening_cash_amd INTEGER NOT NULL DEFAULT 0 CHECK (opening_cash_amd >= 0),
  -- The cash counted at the close of the shift (in AMD).
  -- NULL while open.
  closing_cash_amd INTEGER,
  -- Status: 'open' | 'closed'. A register has at most
  -- ONE open shift at a time (the openShift pure function
  -- enforces this with an inline check before INSERT).
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS pos_shifts_tenant_idx
    ON finance.pos_shifts (tenant_id);
CREATE INDEX IF NOT EXISTS pos_shifts_register_idx
    ON finance.pos_shifts (register_id);
CREATE INDEX IF NOT EXISTS pos_shifts_status_idx
    ON finance.pos_shifts (status);
-- Partial unique index: at most ONE open shift per
-- register (the openShift pure function relies on this
-- for the "no concurrent shifts" invariant; the DB-level
-- constraint enforces it even if the pure function has
-- a race condition).
CREATE UNIQUE INDEX IF NOT EXISTS pos_shifts_one_open_per_register_idx
    ON finance.pos_shifts (tenant_id, register_id)
    WHERE status = 'open';

-- ───────────── Sales ─────────────

CREATE TABLE IF NOT EXISTS finance.pos_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  shift_id INTEGER NOT NULL,
  register_id INTEGER NOT NULL,
  -- The cashier who rang up the sale (a users.id).
  cashier_id INTEGER NOT NULL,
  -- Optional FK to finance.customers (a sale may be
  -- anonymous — e.g. a walk-in customer without an
  -- account).
  customer_id INTEGER,
  -- The total of the sale (sum of line_total_amd across
  -- all pos_sale_lines for this sale). Computed at
  -- sale-time by the addSaleLine pure function; the
  -- column is materialized for query speed.
  total_amd INTEGER NOT NULL DEFAULT 0 CHECK (total_amd >= 0),
  -- The tax portion of the total (subset of total_amd).
  -- For Armenia, this is the VAT amount (20% of
  -- pre-tax subtotal). NULL while the sale is open (the
  -- tax is computed at complete-time, not line-add-time).
  tax_amd INTEGER,
  -- Status: 'open' (lines + payments being added) |
  -- 'completed' (paid in full) | 'voided' (cancelled).
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completed', 'voided')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS pos_sales_tenant_idx
    ON finance.pos_sales (tenant_id);
CREATE INDEX IF NOT EXISTS pos_sales_shift_idx
    ON finance.pos_sales (shift_id);
CREATE INDEX IF NOT EXISTS pos_sales_register_idx
    ON finance.pos_sales (register_id);
CREATE INDEX IF NOT EXISTS pos_sales_status_idx
    ON finance.pos_sales (status);

-- ───────────── Sale lines ─────────────

CREATE TABLE IF NOT EXISTS finance.pos_sale_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  sale_id INTEGER NOT NULL,
  -- FK to finance.catalog_items.
  catalog_item_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  -- The unit price at the time of the sale (denormalized
  -- — the catalog item's price may change later).
  unit_price_amd INTEGER NOT NULL CHECK (unit_price_amd >= 0),
  -- The line total (quantity * unit_price_amd + line_tax).
  -- Computed at line-add time by the addSaleLine pure
  -- function.
  line_total_amd INTEGER NOT NULL CHECK (line_total_amd >= 0),
  -- The tax portion of the line. NULL while the sale
  -- is open (tax is computed at complete-time).
  line_tax_amd INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS pos_sale_lines_tenant_idx
    ON finance.pos_sale_lines (tenant_id);
CREATE INDEX IF NOT EXISTS pos_sale_lines_sale_idx
    ON finance.pos_sale_lines (sale_id);
CREATE INDEX IF NOT EXISTS pos_sale_lines_item_idx
    ON finance.pos_sale_lines (catalog_item_id);

-- ───────────── Payments ─────────────

CREATE TABLE IF NOT EXISTS finance.pos_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  sale_id INTEGER NOT NULL,
  -- The payment method:
  --   'cash'           — physical cash (change is computed)
  --   'card'           — credit / debit card (terminal ref)
  --   'mobile'         — mobile payment (Apple Pay, Google Pay, Idram, etc.)
  --   'bank_transfer'  — Armenian bank-to-bank (e.g. Ameriabank, Ardshinbank)
  --   'other'          — fallback for unlisted methods
  payment_method TEXT NOT NULL
    CHECK (payment_method IN ('cash', 'card', 'mobile', 'bank_transfer', 'other')),
  -- The amount applied to the sale (in AMD). For partial
  -- payments (e.g. split tender: $50 cash + $20 card
  -- on a $70 sale), there are 2+ pos_payments rows for
  -- the same sale_id.
  amount_amd INTEGER NOT NULL CHECK (amount_amd > 0),
  -- The amount tendered by the customer (>= amount_amd).
  -- For cash payments: amount_amd + change_amd =
  -- tendered_amd. For card / mobile / bank: tendered_amd
  -- == amount_amd (no change).
  tendered_amd INTEGER NOT NULL CHECK (tendered_amd >= amount_amd),
  -- The change given to the customer (cash only). 0 for
  -- non-cash payments.
  change_amd INTEGER NOT NULL DEFAULT 0 CHECK (change_amd >= 0),
  -- Optional external reference (card terminal ref,
  -- bank transaction id, mobile payment id).
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS pos_payments_tenant_idx
    ON finance.pos_payments (tenant_id);
CREATE INDEX IF NOT EXISTS pos_payments_sale_idx
    ON finance.pos_payments (sale_id);
CREATE INDEX IF NOT EXISTS pos_payments_method_idx
    ON finance.pos_payments (payment_method);