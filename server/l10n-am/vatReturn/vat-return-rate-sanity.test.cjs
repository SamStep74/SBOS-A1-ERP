const test = require("node:test");
const assert = require("node:assert/strict");
const { vatReturnForm, validateVatReturnForm } = require("./vatReturn.cjs");

function codes(result) {
  return result.errors.map((e) => e.code);
}

// A consistent form: every cross-foot total ties out exactly. Used as a base for the
// "ties out but the line VAT is implausible for its rate" isolation tests — these
// must trip ONLY the new rate-sanity check, not the existing cross-foot checks.
function tiedForm({ l7 = { base: 0, vat: 0 }, l9 = { base: 0, vat: 0 } } = {}) {
  const creditBase = l7.base + l9.base;
  const creditVat = l7.vat + l9.vat;
  return {
    lines: {
      "7": { ...l7 },
      "9": { ...l9 },
      "12": { base: 0 },
      "13": { base: 0 },
      "16": { base: creditBase, vat: creditVat },
      "17": { base: 0, vat: 0 },
      "18": { base: 0, vat: 0 },
      "21": { vat: 0 },
      "23": { payable: Math.max(0, creditVat), recoverable: Math.max(0, -creditVat) },
    },
  };
}

test("rate-sanity: a real computed form passes (no rate-mismatch false positive)", () => {
  const form = vatReturnForm({
    sales: [
      { netAmount: 1000000, vatRate: 20 },
      { netAmount: 600000, vatRate: 16.67 },
    ],
    purchases: [{ netAmount: 400000, vatRate: 20, source: "domestic" }],
  });
  const result = validateVatReturnForm(form);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("rate-sanity: per-line rounding drift across many small lines does NOT false-positive", () => {
  // 7 lines of 333 AMD @20%: per-line VAT = 7*round(66.6)=7*67=469; round(2331*0.2)=466.
  // The 3-dram drift must stay within the sanity band.
  const sales = Array.from({ length: 7 }, () => ({ netAmount: 333, vatRate: 20 }));
  const form = vatReturnForm({ sales, purchases: [] });
  const result = validateVatReturnForm(form);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(!codes(result).includes("FORM_7_RATE_MISMATCH"));
});

test("rate-sanity: line 7 VAT implausibly low for a 20% base is caught (even when totals tie)", () => {
  const form = tiedForm({ l7: { base: 1000000, vat: 5 } }); // 20% of 1,000,000 is ~200,000, not 5
  const result = validateVatReturnForm(form);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("FORM_7_RATE_MISMATCH"));
  // it should NOT also be flagged for cross-foot, proving the new check is what fired
  assert.ok(!codes(result).includes("FORM_16_BASE_MISMATCH"));
  assert.ok(!codes(result).includes("FORM_16_VAT_MISMATCH"));
});

test("rate-sanity: line 9 VAT implausibly high for a 16.67% base is caught", () => {
  const form = tiedForm({ l9: { base: 600000, vat: 999999 } }); // ~16.67% of 600,000 is ~100,020
  const result = validateVatReturnForm(form);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("FORM_9_RATE_MISMATCH"));
});

test("rate-sanity: VAT charged on a zero base is caught", () => {
  const form = tiedForm({ l7: { base: 0, vat: 5000 } });
  const result = validateVatReturnForm(form);
  assert.ok(codes(result).includes("FORM_7_RATE_MISMATCH"));
});

test("rate-sanity: a correctly-rated single line passes", () => {
  const form = tiedForm({ l7: { base: 1000000, vat: 200000 } }); // exactly 20%
  const result = validateVatReturnForm(form);
  assert.ok(!codes(result).includes("FORM_7_RATE_MISMATCH"));
});
