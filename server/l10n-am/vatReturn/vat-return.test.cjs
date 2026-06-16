const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeVatReturn,
  vatReturnForm,
  STANDARD_VAT_RATE,
  IMPUTED_VAT_RATE,
  VAT_RETURN_FORM_SOURCE,
  VAT_RETURN_FORM_LINE_DEFINITIONS,
} = require("./vatReturn.cjs");

test("vat-return: net = output VAT minus recoverable input VAT (payable to SRC)", () => {
  const r = computeVatReturn({
    sales: [{ netAmount: 1000000, vatRate: 20 }],
    purchases: [{ netAmount: 400000, vatRate: 20 }],
  });
  assert.equal(r.outputVat, 200000);
  assert.equal(r.inputVat, 80000);
  assert.equal(r.net, 120000);
  assert.equal(r.payable, 120000);
  assert.equal(r.creditCarried, 0);
  assert.equal(r.taxableSales, 1000000);
});

test("vat-return: input exceeding output yields a carried credit, not a negative payable", () => {
  const r = computeVatReturn({
    sales: [{ netAmount: 100000, vatRate: 20 }], // output 20000
    purchases: [{ netAmount: 500000, vatRate: 20 }], // input 100000
  });
  assert.equal(r.net, -80000);
  assert.equal(r.payable, 0);
  assert.equal(r.creditCarried, 80000);
});

test("vat-return: non-recoverable purchases are excluded from input VAT", () => {
  const r = computeVatReturn({
    sales: [],
    purchases: [
      { netAmount: 100000, vatRate: 20, recoverable: true },
      { netAmount: 100000, vatRate: 20, recoverable: false },
    ],
  });
  assert.equal(r.inputVat, 20000); // only the recoverable one
});

test("vat-return: zero-rated/exempt sales add to base but not to output VAT", () => {
  const r = computeVatReturn({
    sales: [
      { netAmount: 100000, vatRate: 20 }, // 20000
      { netAmount: 50000, vatRate: 0 }, // exempt/zero-rated
    ],
    purchases: [],
  });
  assert.equal(r.outputVat, 20000);
  assert.equal(r.taxableSales, 150000);
});

test("vat-return: an explicit vatAmount overrides the computed one", () => {
  const r = computeVatReturn({
    sales: [{ netAmount: 100000, vatRate: 20, vatAmount: 0 }],
    purchases: [],
  });
  assert.equal(r.outputVat, 0);
});

test("vat-return: empty period is all zeros; RA standard rate is 20%", () => {
  const r = computeVatReturn({ sales: [], purchases: [] });
  assert.deepEqual(
    { o: r.outputVat, i: r.inputVat, n: r.net, p: r.payable, c: r.creditCarried },
    { o: 0, i: 0, n: 0, p: 0, c: 0 },
  );
  assert.equal(STANDARD_VAT_RATE, 20);
});

test("vat-return-form: maps 20% sales to line 7 and rolls up total credit (line 16)", () => {
  const f = vatReturnForm({ sales: [{ netAmount: 1000000, vatRate: 20 }], purchases: [] });
  assert.deepEqual(f.lines["7"], { base: 1000000, vat: 200000 });
  assert.deepEqual(f.lines["16"], { base: 1000000, vat: 200000 });
});

test("vat-return-form: carries official SRC source metadata and line definitions", () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.equal(f.source, VAT_RETURN_FORM_SOURCE);
  assert.equal(f.source.sourceUrl, "https://www.arlis.am/hy/acts/136996");
  assert.equal(f.source.orderNumber, "N 298-Ն");
  assert.match(f.source.titleHy, /Ավելացված արժեքի հարկ/);
  assert.equal(f.lineDefinitions, VAT_RETURN_FORM_LINE_DEFINITIONS);
  assert.deepEqual(f.lineDefinitions["7"].fields, ["base", "vat"]);
  assert.equal(f.lineDefinitions["7"].section, "output");
  assert.match(f.lineDefinitions["18"].labelHy, /ձեռք բերված/);
  assert.deepEqual(f.lineDefinitions["23"].fields, ["payable", "recoverable"]);
});

test("vat-return-form: separates zero-rated (line 12) from exempt (line 13)", () => {
  const f = vatReturnForm({
    sales: [
      { netAmount: 100000, vatRate: 0 }, // zero-rated → line 12
      { netAmount: 50000, vatRate: 0, category: "exempt" }, // exempt → line 13
    ],
    purchases: [],
  });
  assert.equal(f.lines["12"].base, 100000);
  assert.equal(f.lines["13"].base, 50000);
  assert.equal(f.lines["16"].vat, 0);
  assert.equal(f.lines["16"].base, 150000);
});

test("vat-return-form: 16.67% imputed sales go to line 9", () => {
  const f = vatReturnForm({
    sales: [{ netAmount: 120000, vatRate: IMPUTED_VAT_RATE, vatAmount: 20000 }],
    purchases: [],
  });
  assert.equal(f.lines["9"].base, 120000);
  assert.equal(f.lines["9"].vat, 20000);
});

test("vat-return-form: splits imports (line 17) from domestic (line 18) and totals debit (21)", () => {
  const f = vatReturnForm({
    sales: [],
    purchases: [
      { netAmount: 300000, vatRate: 20, source: "import" },
      { netAmount: 200000, vatRate: 20, source: "domestic" },
      { netAmount: 100000, vatRate: 20, recoverable: false }, // excluded
    ],
  });
  assert.deepEqual(f.lines["17"], { base: 300000, vat: 60000 });
  assert.deepEqual(f.lines["18"], { base: 200000, vat: 40000 });
  assert.equal(f.lines["21"].vat, 100000);
});

test("vat-return-form: line 23 nets credit against debit (payable vs recoverable)", () => {
  const payable = vatReturnForm({
    sales: [{ netAmount: 1000000, vatRate: 20 }],
    purchases: [{ netAmount: 400000, vatRate: 20 }],
  });
  assert.deepEqual(payable.lines["23"], { payable: 120000, recoverable: 0 });

  const refund = vatReturnForm({
    sales: [{ netAmount: 100000, vatRate: 20 }],
    purchases: [{ netAmount: 500000, vatRate: 20 }],
  });
  assert.deepEqual(refund.lines["23"], { payable: 0, recoverable: 80000 });
});
