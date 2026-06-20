import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeVatReturn,
  vatReturnForm,
  STANDARD_VAT_RATE,
  IMPUTED_VAT_RATE,
  VAT_RETURN_FORM_SOURCE,
  VAT_RETURN_FORM_LINE_DEFINITIONS,
  line7_totalTaxableBase,
  line9_zeroRatedSupplies,
  line12_exemptSupplies,
  line13_importsVatBase,
  line16_reverseChargeVat,
  line18_adjustments,
  line21_vatToPay,
  line23_inputVatCreditBase,
} from './vatReturn.js';

test('vat-return: net = output VAT minus recoverable input VAT (payable to SRC)', () => {
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

test('vat-return: input exceeding output yields a carried credit, not a negative payable', () => {
  const r = computeVatReturn({
    sales: [{ netAmount: 100000, vatRate: 20 }], // output 20000
    purchases: [{ netAmount: 500000, vatRate: 20 }], // input 100000
  });
  assert.equal(r.net, -80000);
  assert.equal(r.payable, 0);
  assert.equal(r.creditCarried, 80000);
});

test('vat-return: non-recoverable purchases are excluded from input VAT', () => {
  const r = computeVatReturn({
    sales: [],
    purchases: [
      { netAmount: 100000, vatRate: 20, recoverable: true },
      { netAmount: 100000, vatRate: 20, recoverable: false },
    ],
  });
  assert.equal(r.inputVat, 20000); // only the recoverable one
});

test('vat-return: zero-rated/exempt sales add to base but not to output VAT', () => {
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

test('vat-return: an explicit vatAmount overrides the computed one', () => {
  const r = computeVatReturn({
    sales: [{ netAmount: 100000, vatRate: 20, vatAmount: 0 }],
    purchases: [],
  });
  assert.equal(r.outputVat, 0);
});

test('vat-return: empty period is all zeros; RA standard rate is 20%', () => {
  const r = computeVatReturn({ sales: [], purchases: [] });
  assert.deepEqual(
    { o: r.outputVat, i: r.inputVat, n: r.net, p: r.payable, c: r.creditCarried },
    { o: 0, i: 0, n: 0, p: 0, c: 0 },
  );
  assert.equal(STANDARD_VAT_RATE, 20);
});

test('vat-return-form: maps 20% sales to line 7 and rolls up total credit (line 16)', () => {
  const f = vatReturnForm({ sales: [{ netAmount: 1000000, vatRate: 20 }], purchases: [] });
  assert.deepEqual(f.lines['7'], { base: 1000000, vat: 200000 });
  assert.deepEqual(f.lines['16'], { base: 1000000, vat: 200000 });
});

test('vat-return-form: carries official SRC source metadata and line definitions', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.equal(f.source, VAT_RETURN_FORM_SOURCE);
  assert.equal(f.source.sourceUrl, 'https://www.arlis.am/hy/acts/136996');
  assert.equal(f.source.orderNumber, 'N 298-Ն');
  assert.match(f.source.titleHy, /Ավելացված արժեքի հարկ/);
  assert.equal(f.lineDefinitions, VAT_RETURN_FORM_LINE_DEFINITIONS);
  assert.deepEqual(f.lineDefinitions['7'].fields, ['base', 'vat']);
  assert.equal(f.lineDefinitions['7'].section, 'output');
  assert.match(f.lineDefinitions['18'].labelHy, /ձեռք բերված/);
  assert.deepEqual(f.lineDefinitions['23'].fields, ['payable', 'recoverable']);
});

test('vat-return-form: separates zero-rated (line 12) from exempt (line 13)', () => {
  const f = vatReturnForm({
    sales: [
      { netAmount: 100000, vatRate: 0 }, // zero-rated → line 12
      { netAmount: 50000, vatRate: 0, category: 'exempt' }, // exempt → line 13
    ],
    purchases: [],
  });
  assert.equal(f.lines['12'].base, 100000);
  assert.equal(f.lines['13'].base, 50000);
  assert.equal(f.lines['16'].vat, 0);
  assert.equal(f.lines['16'].base, 150000);
});

test('vat-return-form: 16.67% imputed sales go to line 9', () => {
  const f = vatReturnForm({
    sales: [{ netAmount: 120000, vatRate: IMPUTED_VAT_RATE, vatAmount: 20000 }],
    purchases: [],
  });
  assert.equal(f.lines['9'].base, 120000);
  assert.equal(f.lines['9'].vat, 20000);
});

test('vat-return-form: splits imports (line 17) from domestic (line 18) and totals debit (21)', () => {
  const f = vatReturnForm({
    sales: [],
    purchases: [
      { netAmount: 300000, vatRate: 20, source: 'import' },
      { netAmount: 200000, vatRate: 20, source: 'domestic' },
      { netAmount: 100000, vatRate: 20, recoverable: false }, // excluded
    ],
  });
  assert.deepEqual(f.lines['17'], { base: 300000, vat: 60000 });
  assert.deepEqual(f.lines['18'], { base: 200000, vat: 40000 });
  assert.equal(f.lines['21'].vat, 100000);
});

test('vat-return-form: line 23 nets credit against debit (payable vs recoverable)', () => {
  const payable = vatReturnForm({
    sales: [{ netAmount: 1000000, vatRate: 20 }],
    purchases: [{ netAmount: 400000, vatRate: 20 }],
  });
  assert.deepEqual(payable.lines['23'], { payable: 120000, recoverable: 0 });

  const refund = vatReturnForm({
    sales: [{ netAmount: 100000, vatRate: 20 }],
    purchases: [{ netAmount: 500000, vatRate: 20 }],
  });
  assert.deepEqual(refund.lines['23'], { payable: 0, recoverable: 80000 });
});

// --- decree N 298-Ն line definitions 8/10/11/14/15/19/20/22 --------------------
// The remaining output/input adjustment lines per the official VAT return form.
// Lines 8/11/15/19/20 have multiple sub-cells (decrease/increase); line 14 was
// repealed (27.08.19 N 556-Ն) but is still in the form layout for backward
// compatibility; line 22 is independent (Art. 79 imports).

test('vat-return-form: line 8 (correcting tax invoices, output base) has decrease/increase cells', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['8'], 'line 8 definition must exist');
  assert.equal(f.lineDefinitions['8'].section, 'output');
  assert.deepEqual(f.lineDefinitions['8'].fields, ['baseDecrease', 'baseIncrease']);
  assert.match(f.lineDefinitions['8'].labelHy, /Ճշգրտող/);
  // defaulted to zero when absent — UI/manual entries, not derived from sales
  assert.deepEqual(f.lines['8'], { baseDecrease: 0, baseIncrease: 0 });
});

test('vat-return-form: line 10 (other VAT liability) is output VAT only', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['10'], 'line 10 definition must exist');
  assert.equal(f.lineDefinitions['10'].section, 'output');
  assert.deepEqual(f.lineDefinitions['10'].fields, ['vat']);
  assert.match(f.lineDefinitions['10'].labelHy, /այլ հարկային պարտավորություն/);
  assert.deepEqual(f.lines['10'], { vat: 0 });
});

test('vat-return-form: line 11 (correcting invoices issued outside supplier name) is output VAT with decrease/increase', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['11'], 'line 11 definition must exist');
  assert.equal(f.lineDefinitions['11'].section, 'output');
  assert.deepEqual(f.lineDefinitions['11'].fields, ['vatDecrease', 'vatIncrease']);
  assert.match(f.lineDefinitions['11'].labelHy, /Մատակարարի անունից/);
  assert.deepEqual(f.lines['11'], { vatDecrease: 0, vatIncrease: 0 });
});

test('vat-return-form: line 14 (REPEALED 27.08.19 N 556-Ն) is preserved for backward compatibility', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['14'], 'line 14 definition must exist (repealed but in form)');
  assert.equal(f.lineDefinitions['14'].section, 'output');
  assert.deepEqual(f.lineDefinitions['14'].fields, ['base']);
  // The decree text explicitly notes the line lost force — preserved as base-only
  assert.match(f.lineDefinitions['14'].labelHy, /(ուժը կորցրել|REPEALED|556-Ն)/);
  assert.deepEqual(f.lines['14'], { base: 0 });
});

test('vat-return-form: line 15 (VAT credit adjustment) is output VAT with increase/decrease cells', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['15'], 'line 15 definition must exist');
  assert.equal(f.lineDefinitions['15'].section, 'output');
  assert.deepEqual(f.lineDefinitions['15'].fields, ['vatIncrease', 'vatDecrease']);
  assert.match(f.lineDefinitions['15'].labelHy, /(Ավելացում|Պակասեցում|ճշգրտում)/);
  assert.deepEqual(f.lines['15'], { vatIncrease: 0, vatDecrease: 0 });
});

test('vat-return-form: line 19 (acquisition correcting tax invoices) is input VAT with decrease/increase', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['19'], 'line 19 definition must exist');
  assert.equal(f.lineDefinitions['19'].section, 'input');
  assert.deepEqual(f.lineDefinitions['19'].fields, ['vatDecrease', 'vatIncrease']);
  assert.match(f.lineDefinitions['19'].labelHy, /Ձեռքբերումներին/);
  assert.deepEqual(f.lines['19'], { vatDecrease: 0, vatIncrease: 0 });
});

test('vat-return-form: line 20 (offset VAT adjustment total) is input VAT with increase/decrease', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['20'], 'line 20 definition must exist');
  assert.equal(f.lineDefinitions['20'].section, 'input');
  assert.deepEqual(f.lineDefinitions['20'].fields, ['vatIncrease', 'vatDecrease']);
  assert.match(f.lineDefinitions['20'].labelHy, /(Հաշվանցման|ընդհանուր գումար)/);
  assert.deepEqual(f.lines['20'], { vatIncrease: 0, vatDecrease: 0 });
});

test('vat-return-form: line 22 (imports per Tax Code art. 79) is input base + VAT, independent of line 21', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['22'], 'line 22 definition must exist');
  assert.equal(f.lineDefinitions['22'].section, 'input');
  assert.deepEqual(f.lineDefinitions['22'].fields, ['base', 'vat']);
  assert.match(f.lineDefinitions['22'].labelHy, /79-րդ հոդված/);
  assert.deepEqual(f.lines['22'], { base: 0, vat: 0 });
});

test('vat-return-form: every line definition carries the same shape (section/labelHy/fields)', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  for (const id of ['8', '10', '11', '14', '15', '19', '20', '22']) {
    const def = f.lineDefinitions[id];
    assert.ok(def, `line ${id} definition missing`);
    assert.ok(
      ['output', 'input'].includes(def.section),
      `line ${id} section must be output or input`,
    );
    assert.equal(typeof def.labelHy, 'string');
    assert.ok(def.labelHy.length > 0, `line ${id} labelHy must be non-empty`);
    assert.ok(Array.isArray([...def.fields]), `line ${id} fields must be an array`);
    assert.ok(def.fields.length > 0, `line ${id} must declare at least one field`);
  }
});

// --- wave-4: per-line helpers (decree N 298-Ն aggregate view) ---------------
// Each line 7/9/12/13/16/18/23 helper takes an invoice and returns the line's
// value. Line 21 takes a VAT decomposition (per-period aggregate) and returns
// the headline "VAT to pay" amount, clamped at 0 (carry-forward TODO wave-5+).
// For every line we assert two paths: a realistic Armenian tax scenario that
// produces a non-zero value, and an input that produces 0.

test('line7_totalTaxableBase: sums netAmount across all invoice line items (multi-line invoice)', () => {
  // Realistic mixed invoice: one standard-rate supply, one zero-rated, one exempt.
  const invoice = {
    lines: [
      { netAmount: 1000000, vatRate: 20 },
      { netAmount: 200000, vatRate: 0 }, // zero-rated
      { netAmount: 50000, category: 'exempt' },
    ],
  };
  assert.equal(line7_totalTaxableBase(invoice), 1250000);
});

test('line7_totalTaxableBase: an empty invoice is zero', () => {
  assert.equal(line7_totalTaxableBase({ lines: [] }), 0);
  assert.equal(line7_totalTaxableBase({}), 0); // missing lines key
});

test('line9_zeroRatedSupplies: sum of zero-rated lines (exports, international services, art. 65)', () => {
  // A coffee exporter: domestic sales 1M @ 20% + export sales 500K @ 0%.
  const invoice = {
    lines: [
      { netAmount: 1000000, vatRate: 20 },
      { netAmount: 500000, vatRate: 0 }, // export → line 9
    ],
  };
  assert.equal(line9_zeroRatedSupplies(invoice), 500000);
});

test('line9_zeroRatedSupplies: exempt lines (category "exempt") are NOT zero-rated, even when vatRate=0', () => {
  // Exempt supplies have their own line 12 — must not bleed into line 9.
  const invoice = {
    lines: [
      { netAmount: 100000, vatRate: 0, category: 'exempt' },
      { netAmount: 200000, vatRate: 0 }, // plain zero-rated
    ],
  };
  assert.equal(line9_zeroRatedSupplies(invoice), 200000);
});

test('line12_exemptSupplies: sum of exempt lines (financial, medical, educational, art. 64)', () => {
  // A clinic's invoice: consultation (exempt) + pharmacy sales (standard).
  const invoice = {
    lines: [
      { netAmount: 300000, category: 'exempt' }, // medical service → line 12
      { netAmount: 150000, vatRate: 20 }, // pharmacy sale → not exempt
    ],
  };
  assert.equal(line12_exemptSupplies(invoice), 300000);
});

test('line12_exemptSupplies: a zero-rated line without category "exempt" is not exempt', () => {
  const invoice = {
    lines: [{ netAmount: 100000, vatRate: 0 }],
  };
  assert.equal(line12_exemptSupplies(invoice), 0);
});

test('line13_importsVatBase: sum of import-purchase lines (RA Tax Code art. 71)', () => {
  // An importer's purchase batch: domestic 400K + import 300K.
  const invoice = {
    lines: [
      { netAmount: 400000, vatRate: 20, source: 'domestic' },
      { netAmount: 300000, vatRate: 20, source: 'import' }, // → line 13 base
    ],
  };
  assert.equal(line13_importsVatBase(invoice), 300000);
});

test('line13_importsVatBase: a domestic-only invoice has zero imports base', () => {
  const invoice = {
    lines: [{ netAmount: 500000, vatRate: 20, source: 'domestic' }],
  };
  assert.equal(line13_importsVatBase(invoice), 0);
});

test('line16_reverseChargeVat: 20% reverse-charge on an imported service from a non-VAT-payer (art. 72)', () => {
  // Reverse-charge example: a foreign SaaS purchase (buyer acts as VAT agent).
  // Base 1000000, no vatRate declared → engine uses standard 20%.
  const invoice = {
    lines: [
      { netAmount: 1000000, isReverseCharge: true }, // no vatRate → 20%
    ],
  };
  assert.equal(line16_reverseChargeVat(invoice), 200000);
});

test('line16_reverseChargeVat: lines without isReverseCharge are excluded', () => {
  const invoice = {
    lines: [
      { netAmount: 100000, vatRate: 20 }, // standard sale, not reverse-charge
      { netAmount: 200000, vatRate: 20, isReverseCharge: true },
    ],
  };
  assert.equal(line16_reverseChargeVat(invoice), 40000); // only the second line
});

test('line18_adjustments: net of increase and decrease (prior-period corrections, rounding)', () => {
  // Period adjustments: +5000 from a corrected prior invoice, -2000 rounding.
  const invoice = { adjustments: { increase: 5000, decrease: 2000 } };
  assert.equal(line18_adjustments(invoice), 3000);
});

test('line18_adjustments: invoice without adjustments declared is zero', () => {
  assert.equal(line18_adjustments({}), 0);
  assert.equal(line18_adjustments({ lines: [{ netAmount: 1000, vatRate: 20 }] }), 0);
});

test('line21_vatToPay: aggregate decomposition — output + imports + reverse-charge − input − import-input ± adjustments', () => {
  // Standard payable period:
  //   output 20% sales 200000 (line 14)
  //   import input VAT 60000 (line 20)
  //   domestic input VAT 80000 (line 19)
  //   no reverse-charge, no adjustments, no output-side imports
  const result = line21_vatToPay({
    outputVat: 200000,
    importVat: 0,
    reverseChargeVat: 0,
    inputVat: 80000, // domestic-only
    importInputVat: 60000, // import-only credit
    adjustments: 0,
  });
  // 200000 + 0 + 0 − 80000 − 60000 + 0 = 60000
  assert.equal(result.vatToPay, 60000);
  assert.equal(result.carryForward, 0);
});

test('line21_vatToPay: negative net is banked as carryForward (RA Tax Code art. 68)', () => {
  // Recoverable period: input VAT exceeds output VAT → no refund in Armenia,
  // the balance is banked and reduces the next period's payable.
  const result = line21_vatToPay({
    outputVat: 20000,
    importVat: 0,
    reverseChargeVat: 0,
    inputVat: 50000,
    importInputVat: 50000,
    adjustments: 0,
  });
  // 20000 − 50000 − 50000 = −80000 → vatToPay=0, carryForward=80000
  assert.equal(result.vatToPay, 0);
  assert.equal(result.carryForward, 80000);
});

test('line21_vatToPay: positive adjustments increase the VAT to pay', () => {
  const result = line21_vatToPay({
    outputVat: 100000,
    importVat: 0,
    reverseChargeVat: 0,
    inputVat: 20000,
    importInputVat: 0,
    adjustments: 5000, // prior-period correction in the SRC's favor
  });
  // 100000 + 0 + 0 − 20000 − 0 + 5000 = 85000
  assert.equal(result.vatToPay, 85000);
  assert.equal(result.carryForward, 0);
});

test('line21_vatToPay: an empty decomposition is zero (no carry-forward either)', () => {
  const empty = line21_vatToPay({});
  assert.equal(empty.vatToPay, 0);
  assert.equal(empty.carryForward, 0);
  const missing = line21_vatToPay();
  assert.equal(missing.vatToPay, 0);
  assert.equal(missing.carryForward, 0);
});

test('line21_vatToPay: priorPeriodCarryForward reduces a positive net payable', () => {
  // Current period net = 60000, prior credit = 20000 → vatToPay = 40000, no carry-forward.
  const result = line21_vatToPay(
    {
      outputVat: 200000,
      importVat: 0,
      reverseChargeVat: 0,
      inputVat: 80000,
      importInputVat: 60000,
      adjustments: 0,
    },
    20000, // prior credit
  );
  assert.equal(result.vatToPay, 40000);
  assert.equal(result.carryForward, 0);
});

test('line21_vatToPay: priorPeriodCarryForward fully absorbs a smaller net → no payable, no new carry-forward', () => {
  // Current period net = 10000, prior credit = 50000 → vatToPay = 0,
  // remainder of prior credit (40000) is still banked and shows up as
  // a positive carry-forward for the next period.
  const result = line21_vatToPay(
    {
      outputVat: 90000,
      importVat: 0,
      reverseChargeVat: 0,
      inputVat: 80000,
      importInputVat: 0,
      adjustments: 0,
    },
    50000,
  );
  // net = 10000; total = 10000 + 50000 = 60000 credit > 10000 net
  // → vatToPay = 0, carryForward = 50000 - 10000 = 40000 (leftover prior credit)
  assert.equal(result.vatToPay, 0);
  assert.equal(result.carryForward, 40000);
});

test('line21_vatToPay: priorPeriodCarryForward + negative net → new carry-forward = prior + |net|', () => {
  // Both periods are recoverable: the banked credit grows.
  const result = line21_vatToPay(
    {
      outputVat: 20000,
      importVat: 0,
      reverseChargeVat: 0,
      inputVat: 50000,
      importInputVat: 0,
      adjustments: 0,
    },
    10000, // prior credit
  );
  // net = -30000; total = -30000 - 10000 = -40000
  // → vatToPay = 0, carryForward = 40000 (prior 10000 + |net| 30000)
  assert.equal(result.vatToPay, 0);
  assert.equal(result.carryForward, 40000);
});

test('line21_vatToPay: priorPeriodCarryForward of 0 is a no-op (back-compat)', () => {
  // Explicit zero must match the no-second-arg behavior.
  const a = line21_vatToPay({ outputVat: 50000, inputVat: 10000 });
  const b = line21_vatToPay({ outputVat: 50000, inputVat: 10000 }, 0);
  assert.deepEqual(a, b);
  assert.equal(a.vatToPay, 40000);
  assert.equal(a.carryForward, 0);
});

test('line23_inputVatCreditBase: sum of recoverable purchase bases (art. 66 input VAT credit)', () => {
  // Mixed purchase batch: 2 recoverable + 1 non-recoverable.
  const invoice = {
    lines: [
      { netAmount: 400000, vatRate: 20, source: 'domestic', recoverable: true },
      { netAmount: 300000, vatRate: 20, source: 'import', recoverable: true },
      { netAmount: 100000, vatRate: 20, recoverable: false }, // excluded
    ],
  };
  assert.equal(line23_inputVatCreditBase(invoice), 700000);
});

test('line23_inputVatCreditBase: a fully non-recoverable purchase batch is zero', () => {
  const invoice = {
    lines: [
      { netAmount: 500000, vatRate: 20, recoverable: false },
      { netAmount: 200000, vatRate: 20, recoverable: false },
    ],
  };
  assert.equal(line23_inputVatCreditBase(invoice), 0);
});

// --- wave-4: computeVatReturn wires the per-line helpers into the return ---

test('computeVatReturn: wave-4 return shape includes the 8 new line aggregates', () => {
  const r = computeVatReturn({
    sales: [
      { netAmount: 1000000, vatRate: 20 },
      { netAmount: 200000, vatRate: 0 }, // zero-rated
      { netAmount: 50000, category: 'exempt' },
    ],
    purchases: [
      { netAmount: 300000, vatRate: 20, source: 'import' },
      { netAmount: 400000, vatRate: 20, source: 'domestic' },
      { netAmount: 100000, vatRate: 20, recoverable: false },
    ],
  });
  // Backward-compatible fields (existing tests).
  assert.equal(r.outputVat, 200000);
  assert.equal(r.inputVat, 140000); // total recoverable
  assert.equal(r.net, 60000);
  assert.equal(r.payable, 60000);
  // Wave-4 new fields.
  assert.equal(r.totalTaxableBase, 1000000 + 200000 + 50000 + 300000 + 400000 + 100000); // = 2050000
  assert.equal(r.zeroRatedSupplies, 200000);
  assert.equal(r.exemptSupplies, 50000);
  assert.equal(r.importsVatBase, 300000);
  assert.equal(r.reverseChargeVat, 0);
  assert.equal(r.adjustments, 0);
  assert.equal(r.vatToPay, 60000); // matches payable when no reverse-charge / adjustments / output-side imports
  assert.equal(r.inputVatCreditBase, 300000 + 400000); // 700000 (recoverable only)
  // Decomposition (split of inputVat for line-21 audit trail).
  assert.equal(r.domesticInputVat, 80000);
  assert.equal(r.importInputVat, 60000);
});
