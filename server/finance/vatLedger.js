// SBOS-A1-ERP multi-period VAT carry-forward ledger.
//
// Wraps server/l10n-am/vatReturn/vatReturn.computeVatReturn with the
// persistence glue that turns the function's `carryForward` into a
// per-period banked credit. The schema (finance.vat_carry_forward) is
// declared in server/finance/migrations/0003_vat_carry_forward.sql.
//
// Public API:
//   getCurrentCarryForward(db)         → { balance_amd, as_of_period }
//   setCurrentCarryForward(db, bal, asOfPeriod)  → upsert
//   clearCurrentCarryForward(db)       → reset the bank to 0
//   computeAndCloseVatPeriod(db, yearMonth, sales, purchases, tenantId=0)
//     → full period close: read prior, call computeVatReturn with
//     it, write the new bank. Returns the same shape as computeVatReturn.
//
// Wave-13: `computeAndCloseVatPeriod` takes an optional `tenantId`
// (default 0) and scopes the prior-read + new-bank upsert to
// that tenant. The standalone helpers stay tenant-agnostic (they're
// internal building blocks); only the high-level close honors the
// scope.
//
// All money in whole drams; roundAmd from server/l10n-am/localization.js
// is applied on the way in and out to defend against accidental floats
// (e.g. if a caller passes a number from a JSON payload that was parsed
// as a float). The schema column is INTEGER (whole drams); the application
// layer is the single source of truth for the no-float discipline.

import { roundAmd } from '../l10n-am/localization.js';
import { computeVatReturn } from '../l10n-am/vatReturn/vatReturn.js';

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

function assertYearMonth(yearMonth) {
  if (typeof yearMonth !== 'string' || !/^\d{4}-\d{2}$/.test(yearMonth)) {
    throw new ValueError('asOfPeriod must be in YYYY-MM format');
  }
}

function assertNonNegativeInt(n, name) {
  if (!Number.isInteger(n) || n < 0) {
    throw new ValueError(`${name} must be a non-negative integer`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Low-level CRUD (single-row upsert target — only id=1 is ever active)
// ────────────────────────────────────────────────────────────────────────

/**
 * Read the current banked credit. On a fresh DB (no row), returns
 * `{ balance_amd: 0, as_of_period: null }`.
 *
 * Wave-13: tenant-scoped — each tenant has its own bank.
 */
export async function getCurrentCarryForward(db, tenantId = 0) {
  const { rows } = await db.query(
    `SELECT balance_amd, as_of_period
     FROM finance.vat_carry_forward
     WHERE tenant_id = $1 AND id = 1`,
    [tenantId],
  );
  if (!rows || rows.length === 0) {
    return { balance_amd: 0, as_of_period: null };
  }
  return {
    balance_amd: Number(rows[0].balance_amd) || 0,
    as_of_period: rows[0].as_of_period || null,
  };
}

/**
 * Upsert the bank to `balance_amd` (whole drams) tagged with
 * `asOfPeriod` ('YYYY-MM'). Non-negative integers only.
 *
 * Wave-13: accepts an optional `tenantId` (default 0). The
 * composite PK on (tenant_id, id) lets each tenant bank its own
 * credit; the ON CONFLICT clause matches the composite PK.
 */
export async function setCurrentCarryForward(db, balance_amd, asOfPeriod, tenantId = 0) {
  assertYearMonth(asOfPeriod);
  const balance = roundAmd(balance_amd || 0);
  assertNonNegativeInt(balance, 'balance_amd');
  // Idempotent: works on both pg + sqlite (each driver supports
  // ON CONFLICT in 3.24+ / Postgres 9.5+; node:sqlite 22+ ships with
  // 3.45+; production pg is on a recent version).
  await db.query(
    `INSERT INTO finance.vat_carry_forward
       (id, tenant_id, balance_amd, as_of_period, created_at, updated_at)
     VALUES (1, $1, $2, $3, datetime('now'), datetime('now'))
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       balance_amd = EXCLUDED.balance_amd,
       as_of_period = EXCLUDED.as_of_period,
       updated_at = datetime('now')`,
    [tenantId, balance, asOfPeriod],
  );
  return { balance_amd: balance, as_of_period: asOfPeriod };
}

/**
 * Reset the bank to 0. Idempotent: if no row exists, the DELETE is a
 * no-op. Returns the previous state for the audit log.
 *
 * Wave-13: tenant-scoped.
 */
export async function clearCurrentCarryForward(db, tenantId = 0) {
  const prev = await getCurrentCarryForward(db, tenantId);
  await db.query('DELETE FROM finance.vat_carry_forward WHERE tenant_id = $1 AND id = 1', [
    tenantId,
  ]);
  return prev;
}

// ────────────────────────────────────────────────────────────────────────
// High-level: full period close (load prior → compute → save new bank)
// ────────────────────────────────────────────────────────────────────────

/**
 * Close a VAT period end-to-end:
 *   1. Read the current bank (the prior period's carry-forward).
 *   2. Call computeVatReturn with the prior as a parameter so the
 *      line-21 headline is computed with the credit applied.
 *   3. Persist the new bank (the result's `carryForward`).
 *   4. Return the full computeVatReturn result (with the headline
 *      `vatToPay` and the bank `carryForward` reconciled to the row).
 *
 * Wave-13: the prior-read and the new-bank upsert are both scoped
 * to the caller's `tenantId` (default 0). Each tenant gets its
 * own per-period bank. A cross-tenant request sees the default
 * zero-balance prior and writes to the tenant-scoped bank.
 *
 * @param {Db} db
 * @param {string} yearMonth  'YYYY-MM' — the period being closed
 * @param {object} salesInvoice       same shape as computeVatReturn's
 * @param {object} purchasesInvoice   same shape as computeVatReturn's
 * @param {number} [tenantId=0]  caller tenant scope; pre-wave-13
 *   callers omit this and see the bootstrap tenant's bank only.
 * @returns {Promise<ComputeVatReturnResult>}  with `vatToPay` already
 *   reflecting the prior credit, plus the persisted bank as
 *   `carryForward`.
 */
export async function computeAndCloseVatPeriod(
  db,
  yearMonth,
  salesInvoice = {},
  purchasesInvoice = {},
  tenantId = 0,
) {
  assertYearMonth(yearMonth);
  // 1. Read prior — tenant-scoped. We inline the SQL instead of
  //    going through getCurrentCarryForward() because the helper is
  //    intentionally tenant-agnostic (it's an internal building
  //    block used by tests too). The composite (tenant_id, id) PK
  //    makes this an indexed lookup.
  const priorRows =
    (
      await db.query(
        `SELECT balance_amd, as_of_period
       FROM finance.vat_carry_forward
       WHERE tenant_id = $1 AND id = 1`,
        [tenantId],
      )
    ).rows || [];
  const prior =
    priorRows.length === 0
      ? { balance_amd: 0, as_of_period: null }
      : {
          balance_amd: Number(priorRows[0].balance_amd) || 0,
          as_of_period: priorRows[0].as_of_period || null,
        };
  // 2. Compute with the prior credit applied.
  const result = computeVatReturn({
    sales: salesInvoice.sales || salesInvoice || [],
    purchases: purchasesInvoice.purchases || purchasesInvoice || [],
    priorPeriodCarryForward: prior.balance_amd,
  });
  // 3. Persist the new bank — tenant-scoped.
  const balance = roundAmd(result.carryForward || 0);
  assertNonNegativeInt(balance, 'balance_amd');
  await db.query(
    `INSERT INTO finance.vat_carry_forward
       (id, tenant_id, balance_amd, as_of_period, created_at, updated_at)
     VALUES (1, $1, $2, $3, datetime('now'), datetime('now'))
     ON CONFLICT (tenant_id, id) DO UPDATE SET
       balance_amd = EXCLUDED.balance_amd,
       as_of_period = EXCLUDED.as_of_period,
       updated_at = datetime('now')`,
    [tenantId, balance, yearMonth],
  );
  // 4. Decorate the result with the prior period so callers can audit.
  return {
    ...result,
    priorPeriodCarryForward: prior.balance_amd,
    priorAsOfPeriod: prior.as_of_period,
  };
}
