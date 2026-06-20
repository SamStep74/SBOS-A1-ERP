// SBOS-A1-ERP manual invoice adjustments — write-offs, refunds, and
// corrections. Allows the operator to mutate the effective paid_amd of
// an invoice without inserting a fake customer payment.
//
// Public API:
//   recordAdjustment(db, input) → { id, invoice_id, kind, amount_amd, ... }
//   listAdjustmentsForInvoice(db, invoice_id) → Array<{ id, ... }>
//   getEffectivePaidAmd(db, invoice_id) → number
//     (sum of customer payments + corrections, minus writeoffs/refunds)
//
// The table (finance.invoice_adjustments) is append-only — no UPDATE.
// If the operator needs to correct a mistake, they record a NEW
// adjustment that nets out the discrepancy. The audit trail of every
// adjustment is preserved.
//
// Sign convention (enforced by recordAdjustment):
//   writeoff:    +amount_amd → effective_paid_amd decreases
//   refund:      +amount_amd → effective_paid_amd decreases
//   correction:  +amount_amd → effective_paid_amd increases
//
// All money in whole drams (BIGINT AMD); roundAmd from
// server/l10n-am/localization.js on the way in.

import { roundAmd } from '../l10n-am/localization.js';

export const ADJUSTMENT_KINDS = Object.freeze(['writeoff', 'refund', 'correction']);

// ────────────────────────────────────────────────────────────────────────
// Custom error
// ────────────────────────────────────────────────────────────────────────

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────

function assertKind(kind) {
  if (!ADJUSTMENT_KINDS.includes(kind)) {
    throw new ValueError(
      `kind must be one of ${ADJUSTMENT_KINDS.join(', ')}; got "${kind}"`,
    );
  }
}

function assertInvoiceId(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValueError('invoice_id must be a positive integer');
  }
}

function assertAmount(n) {
  const v = roundAmd(n);
  if (!Number.isInteger(v) || v <= 0) {
    throw new ValueError('amount_amd must be a positive integer (whole drams)');
  }
  return v;
}

function assertReason(r) {
  if (typeof r !== 'string' || r.trim().length === 0) {
    throw new ValueError('reason is required and must be a non-empty string');
  }
  if (r.length > 500) {
    throw new ValueError('reason must be 500 characters or fewer');
  }
}

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

/**
 * Record a manual adjustment (write-off / refund / correction).
 * Append-only — never updates an existing row.
 *
 * @param {Db} db
 * @param {{
 *   invoice_id: number,
 *   kind: 'writeoff' | 'refund' | 'correction',
 *   amount_amd: number,
 *   reason: string,
 *   approved_by?: string,
 * }} input
 * @returns {Promise<{ id, invoice_id, kind, amount_amd, reason, approved_by, created_at }>}
 */
export async function recordAdjustment(db, input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  assertInvoiceId(input.invoice_id);
  assertKind(input.kind);
  const amount = assertAmount(input.amount_amd);
  assertReason(input.reason);
  const approvedBy = input.approved_by || null;

  // Verify the invoice exists; FK will catch it on INSERT but a
  // friendly error is better than a raw SQL constraint violation.
  const inv = await db.query(
    'SELECT id FROM finance.invoices WHERE id = $1',
    [input.invoice_id],
  );
  if (!inv.rows || inv.rows.length === 0) {
    throw new ValueError(`invoice ${input.invoice_id} not found`);
  }

  const result = await db.query(
    `INSERT INTO finance.invoice_adjustments
       (invoice_id, kind, amount_amd, reason, approved_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, invoice_id, kind, amount_amd, reason, approved_by, created_at`,
    [input.invoice_id, input.kind, amount, input.reason, approvedBy],
  );
  return result.rows && result.rows[0]
    ? result.rows[0]
    : { id: null, invoice_id: input.invoice_id, kind: input.kind, amount_amd: amount, reason: input.reason, approved_by: approvedBy, created_at: new Date().toISOString() };
}

/**
 * List all adjustments for an invoice, ordered by created_at ASC.
 * Returns an empty array if the invoice has no adjustments.
 */
export async function listAdjustmentsForInvoice(db, invoice_id) {
  assertInvoiceId(invoice_id);
  const result = await db.query(
    `SELECT id, invoice_id, kind, amount_amd, reason, approved_by, created_at
     FROM finance.invoice_adjustments
     WHERE invoice_id = $1
     ORDER BY created_at ASC, id ASC`,
    [invoice_id],
  );
  return result.rows || [];
}

/**
 * Compute the effective paid_amd for an invoice:
 *   sum(customer payments) + sum(corrections) - sum(writeoffs) - sum(refunds)
 *
 * Used by the dashboard / reconcile paths to compute the real balance
 * after manual adjustments.
 */
export async function getEffectivePaidAmd(db, invoice_id) {
  assertInvoiceId(invoice_id);
  // Sum of customer payments (finance.payments).
  const payResult = await db.query(
    `SELECT COALESCE(SUM(amount_amd), 0) AS paid_amd
     FROM finance.payments
     WHERE invoice_id = $1`,
    [invoice_id],
  );
  const paid = Number(payResult.rows?.[0]?.paid_amd ?? 0) || 0;

  // Sum of corrections (positive additions).
  const corrResult = await db.query(
    `SELECT COALESCE(SUM(amount_amd), 0) AS amt
     FROM finance.invoice_adjustments
     WHERE invoice_id = $1 AND kind = 'correction'`,
    [invoice_id],
  );
  const corrections = Number(corrResult.rows?.[0]?.amt ?? 0) || 0;

  // Sum of writeoffs + refunds (negative subtractions).
  const decResult = await db.query(
    `SELECT COALESCE(SUM(amount_amd), 0) AS amt
     FROM finance.invoice_adjustments
     WHERE invoice_id = $1 AND kind IN ('writeoff','refund')`,
    [invoice_id],
  );
  const decreases = Number(decResult.rows?.[0]?.amt ?? 0) || 0;

  return roundAmd(paid + corrections - decreases);
}
