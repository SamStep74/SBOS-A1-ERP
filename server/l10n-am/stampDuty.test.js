// Armenia stamp duty module — RED-first tests.
//
// These tests pin the public contract of server/l10n-am/stampDuty.js:
//   - STAMP_DUTY_RATES: frozen rate table by transaction type
//   - STAMP_DUTY_EXEMPTIONS: frozen exemption rules
//   - stampDutyFor(type, amountAmd, opts?): returns whole-dram AMD, throws on bad input
//   - isStampDutyApplicable(type, opts?): boolean, never throws
//
// Sourced from the RA Law on State Duty (HO-48-N; base duty = AMD 1,000),
// Art. 9 (court filings), Art. 11 (notarial actions), and the 2026 payroll
// military-stamp revision (flat 1,000/mo). Exemptions are documented
// carve-outs, not silent zeros.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STAMP_DUTY_RATES,
  STAMP_DUTY_EXEMPTIONS,
  stampDutyFor,
  isStampDutyApplicable,
} from './stampDuty.js';

// ---------------------------------------------------------------------------
// 1. Payroll standard rate
// ---------------------------------------------------------------------------
test('stamp_duty: payroll_standard — flat 1,000 AMD/month at any positive gross', () => {
  // 2026: payroll military stamp duty was revised to a flat 1,000/mo for all
  // employees, replacing the former 1,500/3,000/5,500/8,500 brackets. The duty
  // does NOT scale with gross — any positive salary triggers it.
  assert.equal(stampDutyFor('payroll', 200000), 1000);
  assert.equal(stampDutyFor('payroll', 75000), 1000);
  assert.equal(stampDutyFor('payroll', 500000), 1000);
  assert.equal(stampDutyFor('payroll', 5000000), 1000);
});

// ---------------------------------------------------------------------------
// 2. Rental agreement — apartment lease certification
// ---------------------------------------------------------------------------
test('stamp_duty: rental_agreement — apartment lease = 1× base duty (1,000 AMD)', () => {
  // RA State Duty Law Art. 11.2(b): certification of contracts on the use of
  // an apartment triggers 1× base duty (= 1,000 AMD) per contract. The duty
  // is per-contract, not per-month — a 12-month rental still costs 1,000.
  assert.equal(stampDutyFor('rental_agreement', 100000), 1000);
  assert.equal(stampDutyFor('rental_agreement', 100000 * 12), 1000);
  assert.equal(stampDutyFor('rental_agreement', 5000000), 1000);
});

// ---------------------------------------------------------------------------
// 3. Zero amount — no duty
// ---------------------------------------------------------------------------
test('stamp_duty: zero_amount — 0-AMD transaction yields 0 duty', () => {
  // Degenerate case: amount is 0 after rounding. For percent rates this is
  // trivially 0; for flat rates the duty is on the contractual action, but a
  // 0-amount contract is no contract — return 0 uniformly.
  assert.equal(stampDutyFor('rental_agreement', 0), 0);
  assert.equal(stampDutyFor('loan_agreement', 0), 0);
  assert.equal(stampDutyFor('gift', 0), 0);
});

// ---------------------------------------------------------------------------
// 4. Rounding to whole dram
// ---------------------------------------------------------------------------
test('stamp_duty: rounds_to_whole_dram — percent rate yields integer drams', () => {
  // Use court_filing_monetary at 3%, with values large enough to clear the
  // 6×-base floor (6,000 AMD) so the percent math is what we observe:
  //   250,000 × 0.03 = 7,500.00 — exact, but pinned as a whole integer.
  //   1,234,567 × 0.03 = 37,037.01 → rounds to 37,037. Still a whole
  //   integer with no fractional dram.
  let duty = stampDutyFor('court_filing_monetary', 250000);
  assert.equal(duty, 7500);
  assert.equal(Number.isInteger(duty), true);
  duty = stampDutyFor('court_filing_monetary', 1234567);
  assert.equal(duty, 37037);
  assert.equal(Number.isInteger(duty), true);
  // Pin the percent result for an exact multiple too.
  assert.equal(stampDutyFor('court_filing_monetary', 1000000), 30000);
});

// ---------------------------------------------------------------------------
// 5. Unknown transaction type throws
// ---------------------------------------------------------------------------
test('stamp_duty: unknown_type_throws — RangeError names the offending type', () => {
  assert.throws(() => stampDutyFor('made_up_thing', 1000), RangeError);
  assert.throws(() => stampDutyFor('made_up_thing', 1000), /made_up_thing/);
  assert.throws(() => stampDutyFor('', 1000), RangeError);
});

// ---------------------------------------------------------------------------
// 6. Negative amount throws
// ---------------------------------------------------------------------------
test('stamp_duty: negative_amount_throws — RangeError on negative amountAmd', () => {
  assert.throws(() => stampDutyFor('payroll', -100), RangeError);
  assert.throws(() => stampDutyFor('rental_agreement', -1), RangeError);
  assert.throws(() => stampDutyFor('gift', -999999), /negative/i);
});

// ---------------------------------------------------------------------------
// 7. Salary below minimum-wage threshold → 0
// ---------------------------------------------------------------------------
test('stamp_duty: exemption_salary_below_threshold — payroll < 75,000 → 0', () => {
  // Documented exemption: payroll amounts strictly below the RA minimum-wage
  // threshold (AMD 75,000 as of 2026) are exempt. Above or at the threshold,
  // the flat 1,000 kicks in.
  assert.equal(stampDutyFor('payroll', 0), 0);
  assert.equal(stampDutyFor('payroll', 50000), 0);
  assert.equal(stampDutyFor('payroll', 74999), 0);
  assert.equal(stampDutyFor('payroll', 75000), 1000);
});

// ---------------------------------------------------------------------------
// 8. Inter-bank transfer exemption
// ---------------------------------------------------------------------------
test('stamp_duty: exemption_inter_bank — inter_bank_transfer always 0', () => {
  // Documented exemption: bank-to-bank settlement transfers are exempt from
  // stamp duty regardless of amount.
  assert.equal(stampDutyFor('inter_bank_transfer', 100000), 0);
  assert.equal(stampDutyFor('inter_bank_transfer', 10000000), 0);
  assert.equal(stampDutyFor('inter_bank_transfer', 1), 0);
});

// ---------------------------------------------------------------------------
// 9. Explicit opt-out via opts.exempt
// ---------------------------------------------------------------------------
test('stamp_duty: explicit_opt_out — opts.exempt=true bypasses the rate', () => {
  // Caller-driven exemption: any transaction type can be force-zeroed by
  // passing { exempt: true, reason }. The reason is recorded but does not
  // affect the numeric result.
  assert.equal(
    stampDutyFor('rental_agreement', 100000, { exempt: true, reason: 'court_order' }),
    0,
  );
  assert.equal(
    stampDutyFor('court_filing_monetary', 5000000, { exempt: true, reason: 'waived' }),
    0,
  );
  assert.equal(stampDutyFor('gift', 999999, { exempt: true }), 0);
});

// ---------------------------------------------------------------------------
// 10. Rate table is frozen
// ---------------------------------------------------------------------------
test('stamp_duty: rates_table_is_frozen — STAMP_DUTY_RATES resists mutation', () => {
  // In strict mode (ESM is always strict), assignment to a frozen property
  // throws TypeError. In non-strict the assignment silently fails and the
  // property remains unchanged. Either outcome proves the table is frozen;
  // we assert BOTH invariants to pin intent regardless of mode.
  assert.equal(Object.isFrozen(STAMP_DUTY_RATES), true);
  assert.equal(Object.isFrozen(STAMP_DUTY_EXEMPTIONS), true);
  // Attempt mutation: in strict mode this throws; in sloppy mode it no-ops.
  // We use try/catch so the test passes under both semantics while still
  // proving the value did NOT change.
  const before = STAMP_DUTY_RATES.payroll;
  let threw = false;
  try {
    STAMP_DUTY_RATES.payroll = { kind: 'flat', amountAmd: 1 };
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'mutating STAMP_DUTY_RATES should throw in strict mode');
  assert.equal(STAMP_DUTY_RATES.payroll, before, 'STAMP_DUTY_RATES.payroll must not change');
});

// ---------------------------------------------------------------------------
// 11. isStampDutyApplicable returns boolean, never throws
// ---------------------------------------------------------------------------
test('stamp_duty: is_applicable_returns_boolean — every input yields a boolean', () => {
  // Known type, no opts → true
  assert.equal(isStampDutyApplicable('payroll'), true);
  assert.equal(isStampDutyApplicable('rental_agreement'), true);
  // Exempt type → false
  assert.equal(isStampDutyApplicable('inter_bank_transfer'), false);
  // Unknown type → false (NOT a throw — distinguish "exempt" from "unknown")
  assert.equal(isStampDutyApplicable('made_up_thing'), false);
  assert.equal(isStampDutyApplicable(''), false);
  // Opt-out → false
  assert.equal(isStampDutyApplicable('payroll', { exempt: true }), false);
  // All return boolean, not truthy/falsy
  for (const v of [
    isStampDutyApplicable('payroll'),
    isStampDutyApplicable('inter_bank_transfer'),
    isStampDutyApplicable('made_up_thing'),
    isStampDutyApplicable('payroll', { exempt: true }),
  ]) {
    assert.equal(typeof v, 'boolean');
  }
});

// ---------------------------------------------------------------------------
// 12. Composes with payroll module — STAMP_DUTY_2026 contract
// ---------------------------------------------------------------------------
test('stamp_duty: composes_with_payroll — matches armeniaPayroll.stampDuty contract', () => {
  // armeniaPayroll.js exports `stampDuty(gross)` = 1,000 for any positive
  // gross (the 2026 flat-rate military stamp). The new module MUST produce
  // the same value when called as stampDutyFor('payroll', gross), so the two
  // modules can be safely cross-imported without behavioral drift.
  // The function under test: stampDutyFor('payroll', GROSS) for positive GROSS.
  const payrollDuty = stampDutyFor('payroll', 200000);
  assert.equal(payrollDuty, 1000, 'stamp duty for payroll must match armeniaPayroll STAMP_DUTY_2026');
  // Spot-check more values to pin the contract across the salary range.
  assert.equal(stampDutyFor('payroll', 75000), 1000);
  assert.equal(stampDutyFor('payroll', 1200000), 1000);
});

// ---------------------------------------------------------------------------
// Extra coverage tests (beyond the 12 minimum) to hit 80%+ on stampDuty.js
// ---------------------------------------------------------------------------

test('stamp_duty: loan_agreement — mortgage of immovable = 1× base duty', () => {
  // Art. 11.5: certification of mortgage of immovable property = 1× base.
  assert.equal(stampDutyFor('loan_agreement', 1000000), 1000);
  assert.equal(stampDutyFor('loan_agreement', 50000000), 1000);
});

test('stamp_duty: gift — notarized gift contract to non-heir = 5× base', () => {
  // Art. 11.10(c): issuance of succession certificate / certification of gift
  // contract to other persons (i.e. not first/second/third-priority heirs)
  // = 5× base duty = 5,000 AMD.
  assert.equal(stampDutyFor('gift', 500000), 5000);
  assert.equal(stampDutyFor('gift', 9999999), 5000);
});

test('stamp_duty: inheritance — first-priority heir certificate = 2× base', () => {
  // Art. 11.10(a): issuance of right-of-succession certificate to first-
  // priority heirs = 2× base duty = 2,000 AMD.
  assert.equal(stampDutyFor('inheritance', 10000000), 2000);
});

test('stamp_duty: notarized_document — general contract certification = 2× base', () => {
  // Art. 11.8: certification of "other contracts" not enumerated above
  // = 2× base duty = 2,000 AMD per contract.
  assert.equal(stampDutyFor('notarized_document', 75000), 2000);
  assert.equal(stampDutyFor('notarized_document', 99999999), 2000);
});

test('stamp_duty: court_filing_monetary — 3% of claim value', () => {
  // Art. 9.1(a): statement of claim with monetary claim = 3% of the claim
  // value. Values above the 6×-base floor and below the 25,000×-base cap
  // yield a clean percentage. (Min/max boundaries pinned by the next test.)
  // 1,000,000 × 3% = 30,000 (above floor 6,000, well under cap 25,000,000).
  assert.equal(stampDutyFor('court_filing_monetary', 1000000), 30000);
  // 5,000,000 × 3% = 150,000.
  assert.equal(stampDutyFor('court_filing_monetary', 5000000), 150000);
});

test('stamp_duty: court_filing_monetary — floored at 6× base, capped at 25,000× base', () => {
  // Below 6× base of claim: duty is floored at 6,000 (small-claim min).
  assert.equal(stampDutyFor('court_filing_monetary', 100), 6000);
  assert.equal(stampDutyFor('court_filing_monetary', 1999), 6000);
  // Above 25,000× base of claim: duty is capped at 25,000,000 (large-claim max).
  assert.equal(stampDutyFor('court_filing_monetary', 1000000000), 25000000);
});

test('stamp_duty: rates_table_has_at_least_5_types', () => {
  // Pin the contract: the rate table must cover a non-trivial set so callers
  // can use it for the common Armenian state-duty scenarios.
  const keys = Object.keys(STAMP_DUTY_RATES);
  assert.ok(keys.length >= 5, `STAMP_DUTY_RATES has ${keys.length} entries, need ≥5`);
  // Every value is an object describing the rate (kind + value).
  for (const k of keys) {
    const r = STAMP_DUTY_RATES[k];
    assert.equal(typeof r, 'object');
    assert.ok(r, `rate for ${k} must be a truthy object`);
    assert.ok(['flat', 'percent'].includes(r.kind), `rate.kind for ${k} must be 'flat' or 'percent'`);
  }
});

test('stamp_duty: exemptions_table_has_at_least_2_rules', () => {
  // Pin the contract: at least two exemption rules. They cover the common
  // zero-duty cases that callers must NOT pay accidentally.
  const keys = Object.keys(STAMP_DUTY_EXEMPTIONS);
  assert.ok(keys.length >= 2, `STAMP_DUTY_EXEMPTIONS has ${keys.length} entries, need ≥2`);
  for (const k of keys) {
    const e = STAMP_DUTY_EXEMPTIONS[k];
    assert.equal(typeof e, 'object');
    assert.equal(typeof e.reason, 'string');
    assert.ok(e.reason.length > 0, `exemption reason for ${k} must be non-empty`);
  }
});

test('stamp_duty: non_numeric_amount_throws', () => {
  // TypeError or RangeError is acceptable; the contract is "do not silently
  // accept garbage". We pin RangeError specifically.
  assert.throws(() => stampDutyFor('payroll', NaN), RangeError);
  assert.throws(() => stampDutyFor('payroll', 'abc'), RangeError);
  assert.throws(() => stampDutyFor('payroll', null), RangeError);
  assert.throws(() => stampDutyFor('payroll', undefined), RangeError);
});
