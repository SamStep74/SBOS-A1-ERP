// Armenian payroll rules engine — RA localization kernel.
//
// Computes an employee's gross → net pay under current (2026) RA rules. All four
// components are employee withholdings off the SAME gross (read independently):
//   1. Personal income tax (եկամտային հարկ): flat 20% (phased reduction complete 2023).
//   2. Mandatory funded pension (կուտակային վճար): tiered with a cap.
//   3. Stamp duty / military payment (դրոշմանիշային վճար): flat 1,000/mo (2026 revision).
//   4. Universal health-insurance premium (առողջության ապահովագրավճար): Dec-2025 law.
// Sourced from official arlis.am laws and SRC guidance; whole dram via the kernel.
//
// Pure functions, no I/O.

import { roundAmd } from './localization.js';
import { stampDutyFor } from './stampDuty.js';

const INCOME_TAX_RATE = 20; // flat %, since 1 Jan 2023

// Pension tiers (min wage 75,000 → threshold 15× = 1,125,000; cap 87,500).
const PENSION_LOW_CEIL = 500000;
const PENSION_CAP_THRESHOLD = 1125000;
const PENSION_CAP = 87500;

// Health insurance (2026): full monthly premium is 10,800. The 200,001–500,000 band
// nets to 4,800 after the ~6,000 state reimbursement granted to NON-social-package
// employees (education/culture/social-protection state staff get NO reimbursement →
// their net is higher; that edge is not modeled here). The full premium applies above
// 500,000. The ≤200,000 obligation begins in 2027. Sources: profin.am; arlis.am ՀՕ-459-Ն.
const HEALTH_INSURANCE_MIN_GROSS = 200001;
const HEALTH_INSURANCE_LOW_CEIL = 500000;
const HEALTH_INSURANCE_LOW = 4800;
const HEALTH_INSURANCE_FULL = 10800;

function incomeTax(gross) {
  const g = roundAmd(gross);
  return g <= 0 ? 0 : roundAmd((g * INCOME_TAX_RATE) / 100);
}

function pension(gross) {
  const g = roundAmd(gross);
  if (g <= 0) return 0;
  if (g <= PENSION_LOW_CEIL) return roundAmd(g * 0.05);
  if (g <= PENSION_CAP_THRESHOLD) return roundAmd(g * 0.1 - 25000);
  return PENSION_CAP;
}

// Military stamp duty (2026 flat revision) is now sourced from the canonical
// stampDutyFor('payroll', gross) — which also applies the documented
// exemption for payroll strictly below the AMD 75,000 minimum-wage threshold.
// This is a behavior CHANGE vs. the pre-refactor local constant: amounts in
// 1..74,999 AMD now return 0 (per the law) instead of 1,000. The cross-module
// contract test in stampDuty.test.js ("composes_with_payroll") pins the
// delegation so a future drift between the two modules fails loud.
function stampDuty(gross) {
  return stampDutyFor('payroll', gross);
}

function healthInsurance(gross) {
  const g = roundAmd(gross);
  if (g < HEALTH_INSURANCE_MIN_GROSS) return 0;
  return g <= HEALTH_INSURANCE_LOW_CEIL ? HEALTH_INSURANCE_LOW : HEALTH_INSURANCE_FULL;
}

function computePayroll(grossInput) {
  const gross = roundAmd(grossInput);
  const tax = incomeTax(gross);
  const pen = pension(gross);
  const stamp = stampDuty(gross);
  const health = healthInsurance(gross);
  const totalWithholdings = tax + pen + stamp + health;
  return {
    gross,
    incomeTax: tax,
    pension: pen,
    stampDuty: stamp,
    healthInsurance: health,
    totalWithholdings,
    net: gross - totalWithholdings,
  };
}

export {
  INCOME_TAX_RATE,
  PENSION_CAP,
  incomeTax,
  pension,
  stampDuty,
  healthInsurance,
  computePayroll,
};
