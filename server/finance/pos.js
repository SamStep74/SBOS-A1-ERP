// POS basics (Phase 3 W87-1) — minimum viable point-of-sale.
//
// This module ships the POS lifecycle: registers → shifts → sales
// → sale lines → payments. Each step enforces tenant isolation,
// parent-existence checks, and status state-machine guards.
//
// Wave 1 (W87-1) scope:
//   - openShift / listShifts / getShift / closeShift
//   - addSale / addSaleLine / addPayment
//
// Wave 2 (future) scope:
//   - route wiring + perm keys + smoke checks
//
// Wave 3 (future) scope:
//   - end-of-day reconciliation
//   - refunds / voids / exchanges
//   - register transfer (cashier A → cashier B mid-shift)

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// DB adapter helper (matches the pattern in customer.js /
// inventory.js / crm.js / desk.js / projects.js / catalog.js)
// ────────────────────────────────────────────────────────────────────────

async function runQuery(db, sql, params) {
  const result = await db.query(sql, params || []);
  if (result && Array.isArray(result.rows)) return result;
  return { rows: [] };
}

// ────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────

const SHIFT_STATUSES = ['open', 'closed'];
const SALE_STATUSES = ['open', 'completed', 'voided'];
const PAYMENT_METHODS = ['cash', 'card', 'mobile', 'bank_transfer', 'other'];

function _assertString(value, name, { min = 1, max = 8192 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new ValueError(`${name} must be a string of ${min}-${max} characters`);
  }
}

function assertOptionalString(value, name, { max = 8192 } = {}) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string' || value.length > max) {
    throw new ValueError(`${name} must be a string up to ${max} characters or null`);
  }
}

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValueError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInt(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValueError(`${name} must be a non-negative integer`);
  }
}

function assertOptionalInt(value, name) {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new ValueError(`${name} must be a non-negative integer or null`);
  }
}

function _assertShiftStatus(value) {
  if (value === null || value === undefined) return;
  if (!SHIFT_STATUSES.includes(value)) {
    throw new ValueError(`shift status must be one of: ${SHIFT_STATUSES.join(', ')}`);
  }
}

function _assertSaleStatus(value) {
  if (value === null || value === undefined) return;
  if (!SALE_STATUSES.includes(value)) {
    throw new ValueError(`sale status must be one of: ${SALE_STATUSES.join(', ')}`);
  }
}

function assertPaymentMethod(value) {
  if (!PAYMENT_METHODS.includes(value)) {
    throw new ValueError(`payment method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }
}

function validateOpenShiftInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('shift input is required');
  }
  assertPositiveInt(input.register_id, 'register_id');
  assertPositiveInt(input.opened_by, 'opened_by');
  assertNonNegativeInt(input.opening_cash_amd || 0, 'opening_cash_amd');
}

function validateCloseShiftInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('shift close input is required');
  }
  assertPositiveInt(input.closed_by, 'closed_by');
  assertNonNegativeInt(input.closing_cash_amd || 0, 'closing_cash_amd');
}

function validateAddSaleInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('sale input is required');
  }
  assertPositiveInt(input.shift_id, 'shift_id');
  assertPositiveInt(input.register_id, 'register_id');
  assertPositiveInt(input.cashier_id, 'cashier_id');
  assertOptionalInt(input.customer_id, 'customer_id');
}

function validateAddSaleLineInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('sale line input is required');
  }
  assertPositiveInt(input.sale_id, 'sale_id');
  assertPositiveInt(input.catalog_item_id, 'catalog_item_id');
  assertPositiveInt(input.quantity, 'quantity');
  assertNonNegativeInt(input.unit_price_amd, 'unit_price_amd');
}

function validateAddPaymentInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('payment input is required');
  }
  assertPositiveInt(input.sale_id, 'sale_id');
  assertPaymentMethod(input.payment_method);
  assertPositiveInt(input.amount_amd, 'amount_amd');
  assertPositiveInt(input.tendered_amd, 'tendered_amd');
  assertNonNegativeInt(input.change_amd || 0, 'change_amd');
  assertOptionalString(input.reference, 'reference', { max: 255 });
}

// ────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────

async function fetchShift(db, shiftId, tenantId) {
  const result = await runQuery(
    db,
    `SELECT id, tenant_id, register_id, opened_by, opened_at,
            closed_by, closed_at, opening_cash_amd,
            closing_cash_amd, status, created_at, updated_at
       FROM finance.pos_shifts
      WHERE id = $1 AND tenant_id = $2`,
    [shiftId, tenantId],
  );
  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`shift ${shiftId} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}

async function fetchSale(db, saleId, tenantId) {
  const result = await runQuery(
    db,
    `SELECT id, tenant_id, shift_id, register_id, cashier_id,
            customer_id, total_amd, tax_amd, status,
            created_at, completed_at
       FROM finance.pos_sales
      WHERE id = $1 AND tenant_id = $2`,
    [saleId, tenantId],
  );
  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`sale ${saleId} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}

// ────────────────────────────────────────────────────────────────────────
// Shifts
// ────────────────────────────────────────────────────────────────────────

export async function openShift(db, input, tenantId = 0) {
  validateOpenShiftInput(input);
  // Verify the register exists in the tenant AND is active
  // (soft-delete via the active flag: 1 = active, 0 = retired).
  const reg = await runQuery(
    db,
    `SELECT id, active FROM finance.pos_registers
      WHERE id = $1 AND tenant_id = $2`,
    [input.register_id, tenantId],
  );
  if (!reg.rows || reg.rows.length === 0) {
    throw new ValueError(
      `register ${input.register_id} not found in tenant ${tenantId}`,
    );
  }
  if (Number(reg.rows[0].active) === 0) {
    throw new ValueError(
      `register ${input.register_id} is retired (cannot open new shifts)`,
    );
  }
  // The partial unique index pos_shifts_one_open_per_register_idx
  // enforces the "at most one open shift per register" invariant
  // at the DB level. We also check it here (with a clear error
  // message) so the caller gets a 400 instead of a 500 from the
  // UNIQUE constraint violation.
  const existing = await runQuery(
    db,
    `SELECT id FROM finance.pos_shifts
      WHERE register_id = $1 AND tenant_id = $2 AND status = 'open'`,
    [input.register_id, tenantId],
  );
  if (existing.rows && existing.rows.length > 0) {
    throw new ValueError(
      `register ${input.register_id} already has an open shift (id=${existing.rows[0].id})`,
    );
  }
  const ins = await runQuery(
    db,
    `INSERT INTO finance.pos_shifts
       (tenant_id, register_id, opened_by, opening_cash_amd, status)
     VALUES ($1, $2, $3, $4, 'open')
     RETURNING id`,
    [
      tenantId,
      input.register_id,
      input.opened_by,
      input.opening_cash_amd ?? 0,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function listShifts(
  db,
  tenantId = 0,
  { registerId = null, status = null } = {},
) {
  // Order by id DESC (most recent first; consistent
  // with listProjects / listCases / listBundles).
  // When registerId is set: only shifts for that register.
  // When status is set: only shifts with that status.
  // Both can be combined (e.g. all open shifts for register 3).
  let result;
  if (registerId !== null && status !== null) {
    result = await runQuery(
      db,
      `SELECT id, register_id, opened_by, opened_at,
              closed_by, closed_at, opening_cash_amd,
              closing_cash_amd, status, created_at, updated_at
         FROM finance.pos_shifts
        WHERE tenant_id = $1 AND register_id = $2 AND status = $3
        ORDER BY id DESC`,
      [tenantId, registerId, status],
    );
  } else if (registerId !== null) {
    result = await runQuery(
      db,
      `SELECT id, register_id, opened_by, opened_at,
              closed_by, closed_at, opening_cash_amd,
              closing_cash_amd, status, created_at, updated_at
         FROM finance.pos_shifts
        WHERE tenant_id = $1 AND register_id = $2
        ORDER BY id DESC`,
      [tenantId, registerId],
    );
  } else if (status !== null) {
    result = await runQuery(
      db,
      `SELECT id, register_id, opened_by, opened_at,
              closed_by, closed_at, opening_cash_amd,
              closing_cash_amd, status, created_at, updated_at
         FROM finance.pos_shifts
        WHERE tenant_id = $1 AND status = $2
        ORDER BY id DESC`,
      [tenantId, status],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, register_id, opened_by, opened_at,
              closed_by, closed_at, opening_cash_amd,
              closing_cash_amd, status, created_at, updated_at
         FROM finance.pos_shifts
        WHERE tenant_id = $1
        ORDER BY id DESC`,
      [tenantId],
    );
  }
  return result.rows;
}

export async function getShift(db, shiftId, tenantId = 0) {
  assertPositiveInt(shiftId, 'shiftId');
  return await fetchShift(db, shiftId, tenantId);
}

export async function closeShift(db, shiftId, input, tenantId = 0) {
  assertPositiveInt(shiftId, 'shiftId');
  validateCloseShiftInput(input);
  const shift = await fetchShift(db, shiftId, tenantId);
  // State-machine guard: only 'open' shifts can be closed.
  // The shift may have already been closed by a concurrent
  // caller (race condition between two cashiers at the same
  // register — unlikely but possible during handover).
  if (shift.status !== 'open') {
    throw new ValueError(
      `shift ${shiftId} is already ${shift.status} (cannot close)`,
    );
  }
  // Tender the close: stamp closed_by + closed_at + closing_cash_amd
  // + flip status to 'closed' in a single UPDATE. The DB-side
  // CHECK constraint on status enforces the new value.
  const upd = await runQuery(
    db,
    `UPDATE finance.pos_shifts
        SET closed_by = $1,
            closed_at = datetime('now'),
            closing_cash_amd = $2,
            status = 'closed',
            updated_at = datetime('now')
      WHERE id = $3 AND tenant_id = $4 AND status = 'open'`,
    [input.closed_by, input.closing_cash_amd ?? 0, shiftId, tenantId],
  );
  // If the UPDATE affected 0 rows, the shift was closed by a
  // concurrent caller. The pg-style adapter returns
  // { rows: [], changes: <n> }; the sqlite test harness returns
  // { rows: [], changes: <n> } too. The number of affected rows is
  // the discriminator (0 = no row matched the WHERE; 1 = matched).
  if (typeof upd.changes === 'number' && upd.changes === 0) {
    throw new ValueError(
      `shift ${shiftId} is no longer open (concurrent close?)`,
    );
  }
  return { id: shiftId };
}

// ────────────────────────────────────────────────────────────────────────
// Sales
// ────────────────────────────────────────────────────────────────────────

export async function addSale(db, input, tenantId = 0) {
  validateAddSaleInput(input);
  // Verify the shift exists in the tenant + is 'open' (a sale
  // can only be added under an open shift). The shift's
  // register_id must match the sale's register_id (catches the
  // "wrong register" mistake when a cashier moves between
  // registers).
  const shift = await fetchShift(db, input.shift_id, tenantId);
  if (shift.status !== 'open') {
    throw new ValueError(
      `shift ${input.shift_id} is ${shift.status} (cannot add sale)`,
    );
  }
  if (Number(shift.register_id) !== Number(input.register_id)) {
    throw new ValueError(
      `shift ${input.shift_id} is on register ${shift.register_id}, not ${input.register_id}`,
    );
  }
  // Optional customer FK check (the customer_id may be null for
  // a walk-in customer; we don't enforce the FK at the DB layer
  // because customer is in a different migration).
  if (input.customer_id !== null && input.customer_id !== undefined) {
    const cust = await runQuery(
      db,
      `SELECT id FROM finance.customers
        WHERE id = $1 AND tenant_id = $2`,
      [input.customer_id, tenantId],
    );
    if (!cust.rows || cust.rows.length === 0) {
      throw new ValueError(
        `customer ${input.customer_id} not found in tenant ${tenantId}`,
      );
    }
  }
  const ins = await runQuery(
    db,
    `INSERT INTO finance.pos_sales
       (tenant_id, shift_id, register_id, cashier_id,
        customer_id, status)
     VALUES ($1, $2, $3, $4, $5, 'open')
     RETURNING id`,
    [
      tenantId,
      input.shift_id,
      input.register_id,
      input.cashier_id,
      input.customer_id ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

// ────────────────────────────────────────────────────────────────────────
// Sale lines
// ────────────────────────────────────────────────────────────────────────

export async function addSaleLine(db, input, tenantId = 0) {
  validateAddSaleLineInput(input);
  // Verify the sale exists in the tenant + is 'open' (lines
  // can only be added to an open sale). Closed / voided sales
  // are immutable.
  const sale = await fetchSale(db, input.sale_id, tenantId);
  if (sale.status !== 'open') {
    throw new ValueError(
      `sale ${input.sale_id} is ${sale.status} (cannot add line)`,
    );
  }
  // Verify the catalog item exists in the tenant (we don't have
  // a real FK because catalog_items is in a different migration).
  const item = await runQuery(
    db,
    `SELECT id FROM finance.catalog_items
      WHERE id = $1 AND tenant_id = $2`,
    [input.catalog_item_id, tenantId],
  );
  if (!item.rows || item.rows.length === 0) {
    throw new ValueError(
      `catalog item ${input.catalog_item_id} not found in tenant ${tenantId}`,
    );
  }
  // Compute the line total (quantity * unit_price_amd). Tax is
  // computed at complete-time (when the sale is paid in full),
  // not at line-add-time, so line_tax_amd stays NULL.
  const lineTotal = input.quantity * input.unit_price_amd;
  const ins = await runQuery(
    db,
    `INSERT INTO finance.pos_sale_lines
       (tenant_id, sale_id, catalog_item_id, quantity,
        unit_price_amd, line_total_amd)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      tenantId,
      input.sale_id,
      input.catalog_item_id,
      input.quantity,
      input.unit_price_amd,
      lineTotal,
    ],
  );
  let lineId;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    lineId = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    lineId = Number(lastId.rows[0].id);
  }
  // Recompute the sale's total_amd by summing all line totals.
  // This keeps total_amd in sync with the line items (the
  // materialized column is a query-speed optimization).
  await runQuery(
    db,
    `UPDATE finance.pos_sales
        SET total_amd = (
          SELECT COALESCE(SUM(line_total_amd), 0)
            FROM finance.pos_sale_lines
           WHERE sale_id = $1 AND tenant_id = $2
        ),
        updated_at = datetime('now')
      WHERE id = $3 AND tenant_id = $4`,
    [input.sale_id, tenantId, input.sale_id, tenantId],
  );
  return { id: lineId };
}

// ────────────────────────────────────────────────────────────────────────
// Payments
// ────────────────────────────────────────────────────────────────────────

export async function addPayment(db, input, tenantId = 0) {
  validateAddPaymentInput(input);
  // Validate the tendered amount >= the payment amount (already
  // enforced by the CHECK constraint on the schema, but the
  // pure-function validation gives a clearer error message).
  if (input.tendered_amd < input.amount_amd) {
    throw new ValueError(
      `tendered_amd (${input.tendered_amd}) must be >= amount_amd (${input.amount_amd})`,
    );
  }
  // For cash payments, change is tendered - amount. For
  // non-cash payments, change should be 0 (the caller is
  // expected to pass change_amd = 0 for non-cash).
  if (input.payment_method !== 'cash' && (input.change_amd || 0) > 0) {
    throw new ValueError(
      `change_amd must be 0 for non-cash payment_method '${input.payment_method}'`,
    );
  }
  // Verify the sale exists + is 'open' (payments can only be
  // added to an open sale — closed sales are immutable, voided
  // sales are cancelled).
  const sale = await fetchSale(db, input.sale_id, tenantId);
  if (sale.status !== 'open') {
    throw new ValueError(
      `sale ${input.sale_id} is ${sale.status} (cannot add payment)`,
    );
  }
  const ins = await runQuery(
    db,
    `INSERT INTO finance.pos_payments
       (tenant_id, sale_id, payment_method, amount_amd,
        tendered_amd, change_amd, reference)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      tenantId,
      input.sale_id,
      input.payment_method,
      input.amount_amd,
      input.tendered_amd,
      input.change_amd ?? 0,
      input.reference ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    id = Number(lastId.rows[0].id);
  }
  return { id };
}