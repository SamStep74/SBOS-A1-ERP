import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeVatReturn,
  vatReturnForm,
  STANDARD_VAT_RATE,
  IMPUTED_VAT_RATE,
  VAT_RETURN_FORM_SOURCE,
  VAT_RETURN_FORM_LINE_DEFINITIONS,
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
    assert.ok(['output', 'input'].includes(def.section), `line ${id} section must be output or input`);
    assert.equal(typeof def.labelHy, 'string');
    assert.ok(def.labelHy.length > 0, `line ${id} labelHy must be non-empty`);
    assert.ok(Array.isArray([...def.fields]), `line ${id} fields must be an array`);
    assert.ok(def.fields.length > 0, `line ${id} must declare at least one field`);
  }
});
