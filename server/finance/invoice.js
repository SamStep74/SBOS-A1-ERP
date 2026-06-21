// SBOS-A1-ERP invoice CRUD + status lifecycle — TDD GREEN.
//
// Public API (all functions async, take a duck-type DB):
//   createInvoice(db, input)       → full invoice row + lines
//   getInvoice(db, id)             → invoice row + lines, or null
//   listInvoices(db, filters)      → array of invoice rows
//   updateInvoice(db, id, patch)   → updated invoice row + lines
//   voidInvoice(db, id, reason)    → invoice row with void_reason + voided_at
//
// Status transitions managed here (other transitions are the payment
// worker's responsibility):
//   draft → sent  (records sent_at)
//   * → void       (records voided_at + void_reason; voidInvoice() only)
//
// All money fields are whole drams (BIGINT in the schema). Use roundAmd
// from l10n-am to enforce the no-float discipline.

import { roundAmd } from '../l10n-am/localization.js';
import { validateHvhh as _a1ValidateHvhh } from './hvhh-validator.js';

/**
 * Async HVVH validation for invoice customers — re-validates the
 * customer's HVVH at invoice-create time. Mirrors the customer and
 * vendor patterns.
 *
 * Returns the normalized form (whitespace stripped) on success.
 * Throws ValueError on invalid input (caught by the route handler as 400).
 * For customers without an hvhh (null/undefined/empty), returns null.
 */
export async function assertValidInvoiceCustomerHvhhAsync(input) {
  const r = await _a1ValidateHvhh(input);
  if (r.ok) {
    return r.normalized ?? null;
  }
  throw new ValueError(r.error || 'customer hvhh is invalid');
}

// ────────────────────────────────────────────────────────────────────────
// Custom error class — callers can match by class, not just message.
// ────────────────────────────────────────────────────────────────────────

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Duck-type DB dispatch — pg-style .query(sql, params) or sqlite-style
// .prepare(sql).run/all/get / .exec(sql). Mirrors server/finance/migrate.js.
// ────────────────────────────────────────────────────────────────────────

function isPgStyle(db) {
  return typeof db.query === 'function';
}

async function runQuery(db, sql, params) {
  if (isPgStyle(db)) {
    return await db.query(sql, params ?? []);
  }
  // sqlite style
  const trimmed = sql.trim();
  const isSelect = /^\s*select/i.test(trimmed);
  if (isSelect) {
    const stmt = db.prepare(sql);
    const rows = await stmt.all(...(params ?? []));
    return { rows };
  }
  const stmt = db.prepare(sql);
  await stmt.run(...(params ?? []));
  return { rows: [] };
}

// ────────────────────────────────────────────────────────────────────────
// Validation helpers.
// ────────────────────────────────────────────────────────────────────────

function assertId(id, name = 'id') {
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValueError(`${name} must be a positive integer`);
  }
}

function assertDate(s, name) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new ValueError(`${name} must be in YYYY-MM-DD format`);
  }
}

function assertLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ValueError('lines must have at least one line item (empty arrays are not allowed)');
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.description || typeof l.description !== 'string') {
      throw new ValueError(`lines[${i}].description must be a non-empty string`);
    }
    if (typeof l.quantity !== 'number' || l.quantity <= 0) {
      throw new ValueError(`lines[${i}].quantity must be a positive number greater than 0`);
    }
    if (typeof l.unit_price_amd !== 'number' || l.unit_price_amd < 0) {
      throw new ValueError(`lines[${i}].unit_price_amd must be a non-negative number`);
    }
  }
}

function validateCreateInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  const { customer_id, invoice_number, issue_date, due_date, lines, vat_amd } = input;
  assertId(customer_id, 'customer_id');
  if (
    typeof invoice_number !== 'string' ||
    invoice_number.length === 0 ||
    invoice_number.length > 32
  ) {
    throw new ValueError('invoice_number must be a non-empty string up to 32 characters');
  }
  assertDate(issue_date, 'issue_date');
  assertDate(due_date, 'due_date');
  if (due_date < issue_date) {
    throw new ValueError('due_date must be greater than or equal to issue_date');
  }
  assertLines(lines);
  if (vat_amd !== undefined && (typeof vat_amd !== 'number' || vat_amd < 0)) {
    throw new ValueError('vat_amd must be a non-negative number when provided');
  }
}

// ────────────────────────────────────────────────────────────────────────
// Public API.
// ────────────────────────────────────────────────────────────────────────

export async function createInvoice(db, input, tenantId = 0) {
  validateCreateInput(input);
  const {
    customer_id,
    invoice_number,
    issue_date,
    due_date,
    lines,
    vat_amd = 0,
    notes = null,
  } = input;

  // FK: customer must exist (scoped to the caller's tenant — a customer
  // in another tenant is invisible here, so the FK check correctly fails).
  // We also fetch hvhh in the same query so the A1-Validator pass below
  // can re-validate it without an extra round-trip.
  const custCheck = await runQuery(
    db,
    'SELECT id, hvhh FROM finance.customers WHERE tenant_id = $1 AND id = $2',
    [tenantId, customer_id],
  );
  if (!custCheck.rows || custCheck.rows.length === 0) {
    throw new ValueError(`customer_id ${customer_id} does not exist (foreign-key violation)`);
  }

  // A1-Validator pass — re-validate the customer's HVVH at invoice-create
  // time. Same fail-soft pattern as createCustomer and createVendor:
  // - A1_VALIDATOR_URL unset → skip (trust the FK-resolved customer row)
  // - A1_VALIDATOR_URL set but unreachable → skip
  // - A1_VALIDATOR_URL set + reachable + invalid → throw 400
  // This catches drift: a customer's HVVH could have become invalid since
  // the customer was created (e.g. the A1-Validator algorithm was updated,
  // or the customer was imported with the validator disabled).
  await assertValidInvoiceCustomerHvhhAsync({ hvhh: custCheck.rows[0].hvhh });

  // UNIQUE: invoice_number must not already exist WITHIN the tenant.
  // (invoice_number is globally unique per the schema's UNIQUE
  // constraint, but we still scope the existence check so the error
  // message reflects "this tenant already has it".)
  const uniqCheck = await runQuery(
    db,
    'SELECT id FROM finance.invoices WHERE tenant_id = $1 AND invoice_number = $2',
    [tenantId, invoice_number],
  );
  if (uniqCheck.rows && uniqCheck.rows.length > 0) {
    throw new ValueError(
      `invoice_number "${invoice_number}" already exists (uniqueness violation)`,
    );
  }

  // Compute totals. roundAmd enforces whole-dram discipline.
  const subtotalRaw = lines.reduce((sum, l) => sum + l.quantity * l.unit_price_amd, 0);
  const subtotal_amd = roundAmd(subtotalRaw);
  const vat_amd_rounded = roundAmd(vat_amd);
  const total_amd = subtotal_amd + vat_amd_rounded;

  const now = new Date().toISOString();

  // INSERT the invoice header. Use RETURNING id (pg-style) — the mock and
  // real pg both honor it; the sqlite branch falls through to lastInsertRowid.
  const insertResult = await runQuery(
    db,
    `INSERT INTO finance.invoices
       (customer_id, invoice_number, issue_date, due_date,
        subtotal_amd, vat_amd, total_amd, status, notes,
        tenant_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      customer_id,
      invoice_number,
      issue_date,
      due_date,
      subtotal_amd,
      vat_amd_rounded,
      total_amd,
      'draft',
      notes,
      tenantId,
      now,
      now,
    ],
  );

  let invoiceId;
  if (insertResult.rows && insertResult.rows.length > 0 && insertResult.rows[0].id != null) {
    invoiceId = Number(insertResult.rows[0].id);
  } else {
    // sqlite path: no RETURNING clause honored.
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    invoiceId = Number(lastId.rows[0].id);
  }

  // INSERT each line item. tenant_id is propagated so a future
  // "all lines for tenant X" query can use the column without a join.
  for (const line of lines) {
    const line_total_amd = roundAmd(line.quantity * line.unit_price_amd);
    await runQuery(
      db,
      `INSERT INTO finance.invoice_lines
         (invoice_id, description, quantity, unit_price_amd, line_total_amd, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [invoiceId, line.description, line.quantity, line.unit_price_amd, line_total_amd, tenantId],
    );
  }

  return await getInvoice(db, invoiceId, tenantId);
}

export async function getInvoice(db, id, tenantId = 0) {
  assertId(id, 'id');
  const invResult = await runQuery(
    db,
    'SELECT * FROM finance.invoices WHERE tenant_id = $1 AND id = $2',
    [tenantId, id],
  );
  if (!invResult.rows || invResult.rows.length === 0) {
    return null;
  }
  const invoice = invResult.rows[0];
  const linesResult = await runQuery(
    db,
    'SELECT * FROM finance.invoice_lines WHERE tenant_id = $1 AND invoice_id = $2',
    [tenantId, id],
  );
  invoice.lines = linesResult.rows || [];
  return invoice;
}

export async function listInvoices(db, filters = {}, tenantId = 0) {
  // Validate filter types.
  if (filters.status !== undefined && typeof filters.status !== 'string') {
    throw new ValueError('filters.status must be a string');
  }
  if (filters.customer_id !== undefined) {
    assertId(filters.customer_id, 'filters.customer_id');
  }
  if (filters.since !== undefined) {
    assertDate(filters.since, 'filters.since');
  }
  if (filters.until !== undefined) {
    assertDate(filters.until, 'filters.until');
  }
  if (filters.limit !== undefined) {
    if (!Number.isInteger(filters.limit) || filters.limit <= 0) {
      throw new ValueError('filters.limit must be a positive integer');
    }
  }

  // Build the WHERE clause dynamically. tenant_id is the first condition
  // so the planner can use the composite (tenant_id, status) /
  // (tenant_id, issue_date) indexes.
  const conds = ['tenant_id = $1'];
  const params = [tenantId];
  if (filters.status !== undefined) {
    params.push(filters.status);
    conds.push(`status = $${params.length}`);
  }
  if (filters.customer_id !== undefined) {
    params.push(filters.customer_id);
    conds.push(`customer_id = $${params.length}`);
  }
  if (filters.since !== undefined) {
    params.push(filters.since);
    conds.push(`issue_date >= $${params.length}`);
  }
  if (filters.until !== undefined) {
    params.push(filters.until);
    conds.push(`issue_date <= $${params.length}`);
  }

  let sql = 'SELECT * FROM finance.invoices WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY id DESC';
  if (filters.limit !== undefined) {
    params.push(filters.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await runQuery(db, sql, params);
  return result.rows || [];
}

export async function updateInvoice(db, id, patch, tenantId = 0) {
  assertId(id, 'id');
  if (!patch || typeof patch !== 'object') {
    throw new ValueError('patch must be an object');
  }

  const current = await getInvoice(db, id, tenantId);
  if (!current) {
    throw new ValueError(`invoice ${id} not found`);
  }

  const now = new Date().toISOString();

  // Lines: only allowed on draft invoices. Recompute totals.
  if (patch.lines !== undefined) {
    if (current.status !== 'draft') {
      throw new ValueError(
        `cannot update lines on invoice ${id} (status=${current.status}); lines are immutable once the invoice is no longer in draft`,
      );
    }
    assertLines(patch.lines);
    const newVat = patch.vat_amd !== undefined ? roundAmd(patch.vat_amd) : current.vat_amd;
    const newSubtotal = roundAmd(
      patch.lines.reduce((sum, l) => sum + l.quantity * l.unit_price_amd, 0),
    );
    const newTotal = newSubtotal + newVat;

    // Replace all lines. Scoped to the tenant so a stray row from
    // another tenant (which shouldn't exist, but defense in depth) is
    // not deleted here.
    await runQuery(
      db,
      'DELETE FROM finance.invoice_lines WHERE tenant_id = $1 AND invoice_id = $2',
      [tenantId, id],
    );
    for (const line of patch.lines) {
      const line_total_amd = roundAmd(line.quantity * line.unit_price_amd);
      await runQuery(
        db,
        `INSERT INTO finance.invoice_lines
           (invoice_id, description, quantity, unit_price_amd, line_total_amd, tenant_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, line.description, line.quantity, line.unit_price_amd, line_total_amd, tenantId],
      );
    }
    await runQuery(
      db,
      `UPDATE finance.invoices
         SET subtotal_amd = $1, vat_amd = $2, total_amd = $3, updated_at = $4
       WHERE tenant_id = $5 AND id = $6`,
      [newSubtotal, newVat, newTotal, now, tenantId, id],
    );
  }

  // Status transitions: only draft → sent is handled here. Other transitions
  // (sent → paid, etc.) are the payment worker's responsibility.
  if (patch.status !== undefined) {
    if (patch.status === 'sent' && current.status === 'draft') {
      await runQuery(
        db,
        `UPDATE finance.invoices
           SET status = $1, sent_at = $2, updated_at = $3
         WHERE tenant_id = $4 AND id = $5`,
        ['sent', now, now, tenantId, id],
      );
    } else if (patch.status !== current.status) {
      throw new ValueError(
        `invalid status transition: cannot move from "${current.status}" to "${patch.status}" via updateInvoice (use voidInvoice for void transitions)`,
      );
    }
    // patch.status === current.status → no-op, no error.
  }

  return await getInvoice(db, id, tenantId);
}

export async function voidInvoice(db, id, reason, tenantId = 0) {
  assertId(id, 'id');
  if (!reason || typeof reason !== 'string' || reason.length === 0) {
    throw new ValueError('voidInvoice requires a non-empty reason string');
  }
  if (reason.length > 500) {
    throw new ValueError('void reason must be 500 characters or fewer');
  }

  const current = await getInvoice(db, id, tenantId);
  if (!current) {
    throw new ValueError(`invoice ${id} not found`);
  }

  const now = new Date().toISOString();
  await runQuery(
    db,
    `UPDATE finance.invoices
       SET status = $1, voided_at = $2, void_reason = $3, updated_at = $4
     WHERE tenant_id = $5 AND id = $6`,
    ['void', now, reason, now, tenantId, id],
  );

  return await getInvoice(db, id, tenantId);
}
