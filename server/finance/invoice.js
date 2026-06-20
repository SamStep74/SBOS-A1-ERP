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

export async function createInvoice(db, input) {
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

  // FK: customer must exist.
  const custCheck = await runQuery(db, 'SELECT 1 FROM finance.customers WHERE id = $1', [
    customer_id,
  ]);
  if (!custCheck.rows || custCheck.rows.length === 0) {
    throw new ValueError(`customer_id ${customer_id} does not exist (foreign-key violation)`);
  }

  // UNIQUE: invoice_number must not already exist.
  const uniqCheck = await runQuery(
    db,
    'SELECT id FROM finance.invoices WHERE invoice_number = $1',
    [invoice_number],
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
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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

  // INSERT each line item.
  for (const line of lines) {
    const line_total_amd = roundAmd(line.quantity * line.unit_price_amd);
    await runQuery(
      db,
      `INSERT INTO finance.invoice_lines
         (invoice_id, description, quantity, unit_price_amd, line_total_amd)
       VALUES ($1, $2, $3, $4, $5)`,
      [invoiceId, line.description, line.quantity, line.unit_price_amd, line_total_amd],
    );
  }

  return await getInvoice(db, invoiceId);
}

export async function getInvoice(db, id) {
  assertId(id, 'id');
  const invResult = await runQuery(db, 'SELECT * FROM finance.invoices WHERE id = $1', [id]);
  if (!invResult.rows || invResult.rows.length === 0) {
    return null;
  }
  const invoice = invResult.rows[0];
  const linesResult = await runQuery(
    db,
    'SELECT * FROM finance.invoice_lines WHERE invoice_id = $1',
    [id],
  );
  invoice.lines = linesResult.rows || [];
  return invoice;
}

export async function listInvoices(db, filters = {}) {
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

  // Build the WHERE clause dynamically.
  const conds = [];
  const params = [];
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

  let sql = 'SELECT * FROM finance.invoices';
  if (conds.length > 0) {
    sql += ' WHERE ' + conds.join(' AND ');
  }
  sql += ' ORDER BY id DESC';
  if (filters.limit !== undefined) {
    params.push(filters.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await runQuery(db, sql, params);
  return result.rows || [];
}

export async function updateInvoice(db, id, patch) {
  assertId(id, 'id');
  if (!patch || typeof patch !== 'object') {
    throw new ValueError('patch must be an object');
  }

  const current = await getInvoice(db, id);
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

    // Replace all lines.
    await runQuery(db, 'DELETE FROM finance.invoice_lines WHERE invoice_id = $1', [id]);
    for (const line of patch.lines) {
      const line_total_amd = roundAmd(line.quantity * line.unit_price_amd);
      await runQuery(
        db,
        `INSERT INTO finance.invoice_lines
           (invoice_id, description, quantity, unit_price_amd, line_total_amd)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, line.description, line.quantity, line.unit_price_amd, line_total_amd],
      );
    }
    await runQuery(
      db,
      `UPDATE finance.invoices
         SET subtotal_amd = $1, vat_amd = $2, total_amd = $3, updated_at = $4
       WHERE id = $5`,
      [newSubtotal, newVat, newTotal, now, id],
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
         WHERE id = $4`,
        ['sent', now, now, id],
      );
    } else if (patch.status !== current.status) {
      throw new ValueError(
        `invalid status transition: cannot move from "${current.status}" to "${patch.status}" via updateInvoice (use voidInvoice for void transitions)`,
      );
    }
    // patch.status === current.status → no-op, no error.
  }

  return await getInvoice(db, id);
}

export async function voidInvoice(db, id, reason) {
  assertId(id, 'id');
  if (!reason || typeof reason !== 'string' || reason.length === 0) {
    throw new ValueError('voidInvoice requires a non-empty reason string');
  }
  if (reason.length > 500) {
    throw new ValueError('void reason must be 500 characters or fewer');
  }

  const current = await getInvoice(db, id);
  if (!current) {
    throw new ValueError(`invoice ${id} not found`);
  }

  const now = new Date().toISOString();
  await runQuery(
    db,
    `UPDATE finance.invoices
       SET status = $1, voided_at = $2, void_reason = $3, updated_at = $4
     WHERE id = $5`,
    ['void', now, reason, now, id],
  );

  return await getInvoice(db, id);
}
