const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AMD,
  HVHH_LENGTH,
  normalizeHvhh,
  validateHvhh,
  isValidHvhh,
  roundAmd,
  formatAmd,
} = require("./localization.cjs");

// --- ՀՎՀՀ (Armenian taxpayer identification number) ---

test("ՀՎՀՀ: accepts a well-formed 8-digit taxpayer id", () => {
  const r = validateHvhh("00123456");
  assert.equal(r.ok, true);
  assert.equal(r.normalized, "00123456");
  assert.equal(r.error, null);
  assert.equal(isValidHvhh("00123456"), true);
});

test("ՀՎՀՀ: normalizes spaces, dots, and hyphens before validating", () => {
  assert.equal(normalizeHvhh(" 001-234.56 "), "00123456");
  assert.equal(validateHvhh("001 234 56").ok, true);
});

test("ՀՎՀՀ: rejects wrong length", () => {
  assert.equal(validateHvhh("1234567").ok, false); // 7 digits
  assert.equal(validateHvhh("123456789").ok, false); // 9 digits
  assert.equal(HVHH_LENGTH, 8);
});

test("ՀՎՀՀ: rejects non-numeric input", () => {
  const r = validateHvhh("0012345A");
  assert.equal(r.ok, false);
  assert.match(r.error, /թվանշան/); // "digits"
});

test("ՀՎՀՀ: rejects degenerate all-same sequences (never issued)", () => {
  assert.equal(validateHvhh("00000000").ok, false);
  assert.equal(validateHvhh("11111111").ok, false);
});

test("ՀՎՀՀ: blank/null is a required error", () => {
  const r = validateHvhh("");
  assert.equal(r.ok, false);
  assert.match(r.error, /պարտադիր/); // "required"
  assert.equal(isValidHvhh(null), false);
  assert.equal(isValidHvhh(undefined), false);
});

// --- AMD (Armenian dram) money ---

test("AMD: rounds to whole dram (no minor unit)", () => {
  assert.equal(roundAmd(1234.4), 1234);
  assert.equal(roundAmd(1234.5), 1235);
  assert.equal(roundAmd("999.99"), 1000);
  assert.equal(roundAmd(NaN), 0);
  assert.equal(roundAmd(Infinity), 0);
  assert.equal(roundAmd(null), 0);
});

test("AMD: formats with thousands grouping and the ֏ symbol", () => {
  assert.equal(formatAmd(1234567), "1,234,567 ֏");
  assert.equal(formatAmd(1234567, { symbol: false }), "1,234,567");
  assert.equal(formatAmd(1234.6), "1,235 ֏"); // rounds before formatting
  assert.equal(formatAmd(0), "0 ֏");
  assert.equal(formatAmd(-1500), "-1,500 ֏");
});

test("AMD: currency metadata reflects dram with zero subunits", () => {
  assert.equal(AMD.code, "AMD");
  assert.equal(AMD.symbol, "֏");
  assert.equal(AMD.subunit, 0);
});
