const test = require("node:test");
const assert = require("node:assert/strict");
const {
  INCOME_TAX_RATE,
  incomeTax,
  pension,
  stampDuty,
  healthInsurance,
  computePayroll,
} = require("./armeniaPayroll.cjs");

test("payroll: personal income tax is a flat 20%", () => {
  assert.equal(INCOME_TAX_RATE, 20);
  assert.equal(incomeTax(300000), 60000);
  assert.equal(incomeTax(1000000), 200000);
});

test("payroll: funded pension is tiered (5% / 10%−25k) with an 87,500 cap", () => {
  assert.equal(pension(300000), 15000); // 5%
  assert.equal(pension(500000), 25000); // 5% at the low ceiling
  assert.equal(pension(800000), 55000); // 10%*G − 25,000
  assert.equal(pension(1000000), 75000); // 10%*G − 25,000
  assert.equal(pension(1125000), 87500); // at the cap threshold
  assert.equal(pension(2000000), 87500); // capped
});

test("payroll: pension is continuous across the 500k tier boundary", () => {
  assert.equal(pension(500000), 25000); // low side
  assert.equal(pension(500001), 25000); // high side ≈ 25,000
});

test("payroll: stamp duty is a flat 1,000/mo (2026 revision), zero for no salary", () => {
  // 2026: the military stamp duty was revised to a flat 1,000/mo for all employees,
  // replacing the former 1,500/3,000/5,500/8,500 tiers. No upper bracket exists.
  assert.equal(stampDuty(300000), 1000);
  assert.equal(stampDuty(1000000), 1000);
  assert.equal(stampDuty(1000001), 1000);
  assert.equal(stampDuty(5000000), 1000);
  assert.equal(stampDuty(0), 0);
});

test("payroll: health insurance follows the Dec-2025 200001/500001 salary bands", () => {
  assert.equal(healthInsurance(200000), 0);
  assert.equal(healthInsurance(200001), 4800);
  assert.equal(healthInsurance(500000), 4800);
  assert.equal(healthInsurance(500001), 10800);
  assert.equal(healthInsurance(0), 0);
});

test("payroll: computePayroll nets gross minus income tax, pension, stamp duty, health insurance", () => {
  const p = computePayroll(800000);
  assert.equal(p.gross, 800000);
  assert.equal(p.incomeTax, 160000);
  assert.equal(p.pension, 55000);
  assert.equal(p.stampDuty, 1000);
  assert.equal(p.healthInsurance, 10800);
  assert.equal(p.totalWithholdings, 226800);
  assert.equal(p.net, 573200);
});

test("payroll: a high earner hits the pension cap; stamp duty stays flat 1,000 (2026)", () => {
  const p = computePayroll(1200000);
  assert.equal(p.incomeTax, 240000);
  assert.equal(p.pension, 87500);
  assert.equal(p.stampDuty, 1000);
  assert.equal(p.healthInsurance, 10800);
  assert.equal(p.totalWithholdings, 339300);
  assert.equal(p.net, 860700);
});

test("payroll: zero gross is all zeros (no phantom stamp duty)", () => {
  const p = computePayroll(0);
  assert.equal(p.gross, 0);
  assert.equal(p.totalWithholdings, 0);
  assert.equal(p.net, 0);
});
