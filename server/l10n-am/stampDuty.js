// Armenian stamp duty module — RA localization kernel.
//
// Computes stamp duty (դրոշմանիշային վճար / պետական տուրք) for the common
// transaction types an Armenian SME encounters. Two distinct duty regimes
// collapse into one rate table:
//
//   1. The military stamp duty (դրոշմանիշային վճար) — a flat monthly 1,000 AMD
//      withheld from every employee's payroll (2026 revision; replaced the
//      former 1,500/3,000/5,500/8,500 brackets). Exposed as the `payroll`
//      rate. This matches the constant in armeniaPayroll.js (STAMP_DUTY_2026).
//
//   2. The state duty (պետական տուրք) — fees for court filings, notarial
//      acts, civil-status acts, etc. Sourced from the RA Law on State Duty
//      (HO-48-N, 27 Dec 1997, with amendments through HO-412-N of 24 Oct
//      2024). The base duty is AMD 1,000 (Art. 8); rates in the table below
//      are expressed as either a flat dram amount OR a percentage of the
//      transaction value, with explicit floor/cap where the law sets one.
//
// Pure functions, no I/O, immutable rate and exemption tables. Whole-dram
// rounding via the localization kernel so callers never have to think about
// fractional drams. Throws RangeError on unknown transaction types and on
// negative or non-numeric amounts; never throws from isStampDutyApplicable
// so callers can use it as a guard without try/catch.

import { roundAmd } from './localization.js';

// Base duty per Art. 8 of HO-48-N. Used as the multiplier for notarial
// rates (e.g. "5× base duty" = 5 × BASE_DUTY_AMD).
const BASE_DUTY_AMD = 1000;

// RA minimum-wage threshold (AMD). Payroll strictly below this is exempt
// from the military stamp duty per documented exemption rule (the law
// applies the military stamp to employed persons earning at least the
// minimum wage; below that, no obligation).
const MINIMUM_WAGE_AMD = 75000;

// ---------------------------------------------------------------------------
// Rate table — frozen, deep-frozen so individual rate entries can't be
// mutated by callers either. Add new transaction types here without code
// changes; stampDutyFor picks them up automatically.
// ---------------------------------------------------------------------------

// Flat-rate helpers (DRY — these never change, so extract once).
const FLAT_1X = Object.freeze({ kind: 'flat', amountAmd: 1 * BASE_DUTY_AMD });
const FLAT_2X = Object.freeze({ kind: 'flat', amountAmd: 2 * BASE_DUTY_AMD });
const FLAT_5X = Object.freeze({ kind: 'flat', amountAmd: 5 * BASE_DUTY_AMD });

// Court filing for a monetary claim (Art. 9.1.a): 3% of claim value, floored
// at 6× base duty, capped at 25,000× base duty. For a non-monetary claim
// (Art. 9.1.b) the duty is a flat 20× base — that's a separate subtype and
// lives under court_filing_non_monetary below.
const COURT_FILING_MONETARY = Object.freeze({
  kind: 'percent',
  ratePercent: 3,
  minAmd: 6 * BASE_DUTY_AMD,
  maxAmd: 25000 * BASE_DUTY_AMD,
});

const COURT_FILING_NON_MONETARY = Object.freeze({
  kind: 'flat',
  amountAmd: 20 * BASE_DUTY_AMD,
});

// Rate table — every key here is a public transaction type. Adding a new
// type requires only adding an entry; stampDutyFor looks it up dynamically.
export const STAMP_DUTY_RATES = Object.freeze({
  // Military stamp duty (2026 flat revision; matches armeniaPayroll.js).
  payroll: FLAT_1X,
  // Notarial actions (Art. 11):
  //   11.2(b) apartment lease certification = 1× base
  //   11.5   mortgage of immovable = 1× base
  //   11.8   other contracts (catch-all notarial certification) = 2× base
  //   11.10(a) succession certificate to first-priority heirs = 2× base
  //   11.10(c) gift contract to non-heirs = 5× base
  rental_agreement: FLAT_1X,
  loan_agreement: FLAT_1X,
  notarized_document: FLAT_2X,
  inheritance: FLAT_2X,
  gift: FLAT_5X,
  // Court actions (Art. 9):
  court_filing_monetary: COURT_FILING_MONETARY,
  court_filing_non_monetary: COURT_FILING_NON_MONETARY,
});

// ---------------------------------------------------------------------------
// Exemption table — frozen. Each entry has:
//   - `predicate(amountAmd, opts)` → boolean, true when the exemption applies.
//   - `alwaysExempt` → true for static exemptions that apply regardless of
//     amount (so isStampDutyApplicable can short-circuit them without an
//     amount context). Absent/false for amount-conditional exemptions.
//   - `reason` → human-readable string for audit trails.
//
// Predicates are pure; opts may carry caller context (e.g. { employeeId }
// for future extension) but are currently unused.
// ---------------------------------------------------------------------------

const ALWAYS_EXEMPT = Object.freeze({
  predicate: () => true,
  alwaysExempt: true,
  reason: 'Inter-bank settlement transfers are exempt from state duty',
});

const PAYROLL_BELOW_MIN_WAGE = Object.freeze({
  predicate: (amountAmd) => roundAmd(amountAmd) < MINIMUM_WAGE_AMD,
  // No alwaysExempt — the duty applies above the threshold, so the TYPE
  // is stamp-duty-attracting (isApplicable → true); only specific small
  // amounts are exempt. This matches the law's per-employee obligation.
  reason: `Payroll amounts strictly below the minimum-wage threshold (AMD ${MINIMUM_WAGE_AMD.toLocaleString('en-US')}) are exempt from military stamp duty`,
});

export const STAMP_DUTY_EXEMPTIONS = Object.freeze({
  inter_bank_transfer: ALWAYS_EXEMPT,
  payroll: PAYROLL_BELOW_MIN_WAGE,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Validate and normalize the transaction type. Throws RangeError on bad
// input (non-string, empty). The unknown-type check happens in stampDutyFor
// AFTER the exemption lookup, so an exempt type that's also unknown is
// still treated as exempt (callers can ask "is inter_bank_transfer
// applicable?" without us erroring on a missing rate).
function normalizeType(transactionType) {
  if (typeof transactionType !== 'string' || transactionType === '') {
    throw new RangeError(
      `stampDutyFor: transactionType must be a non-empty string, received ${typeof transactionType === 'string' ? 'empty string' : typeof transactionType}`,
    );
  }
  return transactionType;
}

// Validate and round the amount. Throws RangeError on negative or non-numeric
// input — silently coercing would let "abc" or NaN through and produce
// nonsense duty values.
function normalizeAmount(amountAmd) {
  if (typeof amountAmd !== 'number' || !Number.isFinite(amountAmd)) {
    throw new RangeError(
      `stampDutyFor: amountAmd must be a finite number, received ${amountAmd === null ? 'null' : typeof amountAmd}`,
    );
  }
  const rounded = roundAmd(amountAmd);
  if (rounded < 0) {
    throw new RangeError(`stampDutyFor: amountAmd must be non-negative, received ${rounded}`);
  }
  return rounded;
}

// Compute the duty from a rate entry and a normalized amount.
function computeDuty(rate, amountAmd) {
  // Degenerate case: a 0-amount transaction is no transaction — 0 duty.
  // This holds uniformly for both flat and percent rate kinds and matches
  // the payroll module's "gross 0 → 0 stamp duty" behavior.
  if (amountAmd <= 0) return 0;

  if (rate.kind === 'flat') {
    return rate.amountAmd;
  }
  if (rate.kind === 'percent') {
    const raw = (amountAmd * rate.ratePercent) / 100;
    const floored = rate.minAmd != null ? Math.max(raw, rate.minAmd) : raw;
    const capped = rate.maxAmd != null ? Math.min(floored, rate.maxAmd) : floored;
    return roundAmd(capped);
  }
  // Unknown rate.kind — defensive throw so a buggy rate entry fails LOUD
  // rather than silently producing 0.
  throw new RangeError(`stampDutyFor: unknown rate kind '${rate.kind}'`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the stamp duty for a given transaction.
 *
 * @param {string} transactionType - One of the keys in STAMP_DUTY_RATES, or a
 *   key in STAMP_DUTY_EXEMPTIONS (in which case duty is 0 if the exemption
 *   predicate applies).
 * @param {number} amountAmd - The transaction value in drams. Negative or
 *   non-numeric input throws RangeError. Zero yields 0 duty.
 * @param {object} [opts] - Optional context.
 *   - opts.exempt: when true, force 0 duty regardless of rate (caller
 *     asserts a documented exemption with `opts.reason`).
 *   - opts.reason: free-text reason for the explicit exemption.
 * @returns {number} Whole-dram stamp duty.
 * @throws {RangeError} on unknown transaction type, non-string type, or
 *   negative/non-numeric amount.
 */
export function stampDutyFor(transactionType, amountAmd, opts = {}) {
  const type = normalizeType(transactionType);
  const amount = normalizeAmount(amountAmd);

  // Caller-driven opt-out beats everything (documented exemption).
  if (opts && opts.exempt === true) return 0;

  // Exemption rules next: if the type has an exemption and its predicate
  // matches, the duty is 0. Note: an exempt type may also have a rate; the
  // exemption wins because the law explicitly carves it out.
  const exemption = STAMP_DUTY_EXEMPTIONS[type];
  if (exemption && exemption.predicate(amount, opts)) return 0;

  // Rate lookup — unknown type here is a caller bug (vs. isApplicable which
  // returns false rather than throwing).
  const rate = STAMP_DUTY_RATES[type];
  if (!rate) {
    throw new RangeError(
      `stampDutyFor: unknown transactionType '${type}' — register it in STAMP_DUTY_RATES or STAMP_DUTY_EXEMPTIONS first`,
    );
  }

  return computeDuty(rate, amount);
}

/**
 * Predicate: does this transaction type attract stamp duty at all?
 *
 * Returns true when the type is a known, non-exempt transaction; false
 * for unknown types, always-exempt types, or types force-exempted via opts.
 *
 * Amount-conditional exemptions (e.g. payroll below minimum wage) DO NOT
 * make a type "not applicable" — the type is applicable; only specific
 * small amounts are exempt. Callers needing the precise per-amount answer
 * should call stampDutyFor with the amount.
 *
 * NEVER THROWS. Use this as a guard (e.g. "should I add a stamp-duty line
 * to this invoice?") without try/catch. Unknown types return false so a
 * typo never silently produces a zero-rated invoice.
 *
 * @param {string} transactionType
 * @param {object} [opts] - opts.exempt: when true, returns false.
 * @returns {boolean}
 */
export function isStampDutyApplicable(transactionType, opts = {}) {
  // Defensive: non-string or empty type → not applicable (not a throw).
  if (typeof transactionType !== 'string' || transactionType === '') return false;

  // Force-exempted by caller → not applicable.
  if (opts && opts.exempt === true) return false;

  // Always-exempt type (static rule) → not applicable. This is the safe
  // answer without an amount context: the type NEVER attracts duty.
  const exemption = STAMP_DUTY_EXEMPTIONS[transactionType];
  if (exemption && exemption.alwaysExempt === true) return false;

  // Known rate (regardless of any amount-conditional exemption) →
  // applicable. Unknown type → not applicable (not a throw).
  return Object.prototype.hasOwnProperty.call(STAMP_DUTY_RATES, transactionType);
}
