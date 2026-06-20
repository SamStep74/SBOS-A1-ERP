// SBOS-A1-ERP finance payment recording + reconciliation.
//
// Public API:
//   - recordPayment(db, input)          → records a payment, auto-transitions invoice to paid
//   - listPaymentsForInvoice(db, id)    → all payments for an invoice, paid_at ASC
//   - reconcileInvoice(db, id)          → { total_amd, paid_amd, balance_amd, status }
//
// Duck-type DB dispatch: same pattern as server/finance/migrate.js.
//   - pg-style: db.query(sql, params) → { rows }
//   - better-sqlite3-style: db.exec / db.prepare(sql).run(...) / .all() / .get()
//
// All money is in whole drams (BIGINT AMD). roundAmd() from
// server/l10n-am/localization.js enforces the discipline at the boundary.
//
// Status transitions handled here: sent → paid and overdue → paid. Overpayment
// is allowed; the operator refunds out-of-band. The reconciliation summary
// reflects overpayment as a negative balance_amd.

import { roundAmd } from '../l10n-am/localization.js';

// ────────────────────────────────────────────────────────────────────────────
// Custom error
// ────────────────────────────────────────────────────────────────────────────

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const ALLOWED_METHODS = Object.freeze(['bank_transfer', 'cash', 'card', 'other']);
const ALLOWED_METHOD_SET = new Set(ALLOWED_METHODS);
const DEFAULT_METHOD = 'bank_transfer';
const REFERENCE_MAX = 256;

// Statuses the production DB accepts a payment against.
const PAYABLE_STATUSES = new Set(['sent', 'overdue']);

// ────────────────────────────────────────────────────────────────────────────
// Adapter dispatch
// ────────────────────────────────────────────────────────────────────────────

function pickAdapter(db) {
  if (db && typeof db.query === 'function') return pgAdapter(db);
  if (db && (typeof db.prepare === 'function' || typeof db.exec === 'function')) {
    return sqliteAdapter(db);
  }
  throw new Error(
    'payment.js: db must expose either `query(sql, params?)` (pg-style) ' +
      'or `prepare/exec` (better-sqlite3-style)',
  );
}

function pgAdapter(db) {
  return {
    kind: 'pg',
    async getInvoice(id) {
      const { rows } = await db.query(
        `SELECT id, customer_id, invoice_number, issue_date, due_date,
                subtotal_amd, vat_amd, total_amd, status, notes,
                created_at, updated_at
         FROM finance.invoices
         WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    },
    async sumPayments(invoiceId) {
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(amount_amd), 0)::bigint AS paid_amd
         FROM finance.payments
         WHERE invoice_id = $1`,
        [invoiceId],
      );
      return Number(rows[0]?.paid_amd ?? 0);
    },
    async insertPayment(p) {
      const { rows } = await db.query(
        `INSERT INTO finance.payments
           (invoice_id, paid_at, amount_amd, method, reference)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, invoice_id, paid_at, amount_amd, method, reference, created_at`,
        [p.invoice_id, p.paid_at, p.amount_amd, p.method, p.reference],
      );
      return rows[0];
    },
    async updateInvoiceStatus(id, status) {
      const updated_at = new Date().toISOString();
      await db.query(
        `UPDATE finance.invoices
         SET status = $1, updated_at = $2
         WHERE id = $3`,
        [status, updated_at, id],
      );
    },
    async listPayments(invoiceId) {
      const { rows } = await db.query(
        `SELECT id, invoice_id, paid_at, amount_amd, method, reference
         FROM finance.payments
         WHERE invoice_id = $1
         ORDER BY paid_at ASC, id ASC`,
        [invoiceId],
      );
      return rows;
    },
  };
}

function sqliteAdapter(db) {
  return {
    kind: 'sqlite',
    async getInvoice(id) {
      const row = db
        .prepare(
          `SELECT id, customer_id, invoice_number, issue_date, due_date,
                  subtotal_amd, vat_amd, total_amd, status, notes,
                  created_at, updated_at
           FROM finance.invoices
           WHERE id = ?`,
        )
        .get(id);
      return row ?? null;
    },
    async sumPayments(invoiceId) {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(amount_amd), 0) AS paid_amd
           FROM finance.payments
           WHERE invoice_id = ?`,
        )
        .get(invoiceId);
      return Number(row?.paid_amd ?? 0);
    },
    async insertPayment(p) {
      const info = db
        .prepare(
          `INSERT INTO finance.payments
             (invoice_id, paid_at, amount_amd, method, reference)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(p.invoice_id, p.paid_at, p.amount_amd, p.method, p.reference);
      const id = Number(info.lastInsertRowid);
      // Sqlite has no RETURNING — fetch the row back so the caller sees the
      // DB-assigned id and created_at.
      const row = db
        .prepare(
          `SELECT id, invoice_id, paid_at, amount_amd, method, reference, created_at
           FROM finance.payments
           WHERE id = ?`,
        )
        .get(id);
      return row ?? null;
    },
    async updateInvoiceStatus(id, status) {
      const updated_at = new Date().toISOString();
      db.prepare(
        `UPDATE finance.invoices
           SET status = ?, updated_at = ?
           WHERE id = ?`,
      ).run(status, updated_at, id);
    },
    async listPayments(invoiceId) {
      return db
        .prepare(
          `SELECT id, invoice_id, paid_at, amount_amd, method, reference
           FROM finance.payments
           WHERE invoice_id = ?
           ORDER BY paid_at ASC, id ASC`,
        )
        .all(invoiceId);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Strict ISO-8601 timestamp validator. Accepts the shape produced by
 * `Date.prototype.toISOString()` and any timezone offset in ±HH:MM form.
 * Rejects date-only strings (YYYY-MM-DD), bare dates, or malformed input.
 */
function isValidIsoTimestamp(s) {
  if (typeof s !== 'string') return false;
  // Basic shape: YYYY-MM-DDTHH:MM:SS[.fraction][Z|±HH:MM]
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    return false;
  }
  // Cross-check: Date.parse must agree the string is a real instant.
  const t = Date.parse(s);
  return Number.isFinite(t);
}

function validateAmount(amount) {
  // roundAmd coerces non-finite / NaN to 0; the >0 check below catches it.
  const n = roundAmd(amount);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new ValueError(`amount_amd must be a positive integer (got ${String(amount)})`);
  }
  return n;
}

function validateMethod(method) {
  if (method === undefined || method === null) return DEFAULT_METHOD;
  if (!ALLOWED_METHOD_SET.has(method)) {
    throw new ValueError(
      `method must be one of ${ALLOWED_METHODS.join(', ')} (got ${String(method)})`,
    );
  }
  return method;
}

function validateReference(reference) {
  if (reference === undefined || reference === null) return null;
  if (typeof reference !== 'string') {
    throw new ValueError(`reference must be a string (got ${typeof reference})`);
  }
  if (reference.length > REFERENCE_MAX) {
    throw new ValueError(`reference must be ≤ ${REFERENCE_MAX} chars (got ${reference.length})`);
  }
  return reference;
}

function validatePaidAt(paidAt) {
  if (paidAt === undefined || paidAt === null) {
    return new Date().toISOString();
  }
  if (!isValidIsoTimestamp(paidAt)) {
    throw new ValueError(`paid_at must be a valid ISO timestamp (got ${String(paidAt)})`);
  }
  return paidAt;
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Record a payment against an invoice. Updates the invoice's `status` to
 * 'paid' if the cumulative paid amount now covers (or exceeds) the
 * invoice's `total_amd`. The transaction boundary is the caller's
 * responsibility — the adapter issues sequential statements; wrap with a
 * real BEGIN/COMMIT in production if your DB requires it.
 *
 * @param {Db} db pg-style or better-sqlite3-style DB.
 * @param {{
 *   invoice_id: number,
 *   amount_amd: number,    // > 0
 *   method?: 'bank_transfer' | 'cash' | 'card' | 'other',
 *   reference?: string,    // ≤ 256 chars
 *   paid_at?: string       // ISO timestamp; defaults to now()
 * }} input
 * @returns {Promise<{id: number, invoice_id: number, paid_at: string, amount_amd: number, method: string, reference: string|null, created_at: string}>}
 * @throws {ValueError} on validation failure.
 */
export async function recordPayment(db, input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  const adapter = pickAdapter(db);

  // ── Validate inputs (no DB round-trip needed) ──
  const invoice_id = Number(input.invoice_id);
  if (!Number.isInteger(invoice_id) || invoice_id <= 0) {
    throw new ValueError(`invoice_id must be a positive integer (got ${String(input.invoice_id)})`);
  }
  const amount_amd = validateAmount(input.amount_amd);
  const method = validateMethod(input.method);
  const reference = validateReference(input.reference);
  const paid_at = validatePaidAt(input.paid_at);

  // ── Load invoice + pre-state checks ──
  const invoice = await adapter.getInvoice(invoice_id);
  if (!invoice) {
    // The DB would also enforce this via the FK on finance.payments.invoice_id,
    // but we surface it as a ValueError before issuing the INSERT — cleaner
    // error path for callers.
    throw new ValueError(`invoice ${invoice_id} not found`);
  }
  if (invoice.status === 'draft') {
    throw new ValueError(`cannot record payment against draft invoice ${invoice_id}`);
  }
  if (invoice.status === 'void') {
    throw new ValueError(`cannot record payment against void invoice ${invoice_id}`);
  }
  // The "already paid" guard is balance-aware: if the invoice is marked paid
  // but balance_amd === 0, refuse. If it's marked paid with a non-zero balance
  // (e.g., an out-of-band refund since), still allow the new payment.
  if (invoice.status === 'paid') {
    const alreadyPaid = await adapter.sumPayments(invoice_id);
    const balance = Number(invoice.total_amd) - alreadyPaid;
    if (balance === 0) {
      throw new ValueError(`invoice ${invoice_id} is already fully paid (balance_amd = 0)`);
    }
  }

  // ── INSERT ──
  const inserted = await adapter.insertPayment({
    invoice_id,
    paid_at,
    amount_amd,
    method,
    reference,
  });

  // ── Auto-transition: re-read cumulative sum, update invoice if covered ──
  const total = Number(invoice.total_amd);
  const paidNow = await adapter.sumPayments(invoice_id);
  if (paidNow >= total && PAYABLE_STATUSES.has(invoice.status)) {
    await adapter.updateInvoiceStatus(invoice_id, 'paid');
  }

  return inserted;
}

/**
 * List all payments for an invoice, ordered by `paid_at` ASC, then `id` ASC
 * (so equal timestamps get a deterministic tie-break).
 *
 * @returns {Promise<Array<{id, invoice_id, paid_at, amount_amd, method, reference}>>}
 */
export async function listPaymentsForInvoice(db, invoice_id) {
  const adapter = pickAdapter(db);
  const id = Number(invoice_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValueError(`invoice_id must be a positive integer (got ${String(invoice_id)})`);
  }
  return adapter.listPayments(id);
}

/**
 * Compute the reconciliation summary for an invoice: total, paid, balance,
 * and current status. `balance_amd` may be negative for overpayments.
 *
 * @returns {Promise<{total_amd: number, paid_amd: number, balance_amd: number, status: string}>}
 */
export async function reconcileInvoice(db, invoice_id) {
  const adapter = pickAdapter(db);
  const id = Number(invoice_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValueError(`invoice_id must be a positive integer (got ${String(invoice_id)})`);
  }
  const invoice = await adapter.getInvoice(id);
  if (!invoice) {
    throw new ValueError(`invoice ${id} not found`);
  }
  const total_amd = Number(invoice.total_amd);
  const paid_amd = await adapter.sumPayments(id);
  return {
    total_amd,
    paid_amd,
    balance_amd: total_amd - paid_amd,
    status: invoice.status,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Re-exports for tests / callers that need to assert on the error class.
// Not part of the "public surface" promised in the JSDoc above but useful at
// integration boundaries (e.g. error name assertions in route handlers).
// ────────────────────────────────────────────────────────────────────────────

export const __internals = Object.freeze({
  ALLOWED_METHODS,
  DEFAULT_METHOD,
  REFERENCE_MAX,
  PAYABLE_STATUSES,
  isValidIsoTimestamp,
});
