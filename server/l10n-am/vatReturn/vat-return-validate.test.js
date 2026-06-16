import test from 'node:test';
import assert from 'node:assert/strict';
import { vatReturnForm, validateVatReturnForm } from './vatReturn.js';

// A representative period that produces a PAYABLE position (output VAT > input VAT).
const payablePeriod = {
  sales: [
    { netAmount: 1000000, vatRate: 20 }, // standard → line 7
    { netAmount: 600000, vatRate: 16.67 }, // imputed → line 9
    { netAmount: 200000, vatRate: 0 }, // zero-rated → line 12
    { netAmount: 50000, category: 'exempt' }, // exempt → line 13
  ],
  purchases: [
    { netAmount: 300000, vatRate: 20, source: 'import' }, // line 17
    { netAmount: 400000, vatRate: 20, source: 'domestic' }, // line 18
    { netAmount: 100000, vatRate: 20, recoverable: false }, // excluded
  ],
};

// A period where input VAT exceeds output VAT → RECOVERABLE (carried-forward) position.
const recoverablePeriod = {
  sales: [{ netAmount: 100000, vatRate: 20 }],
  purchases: [{ netAmount: 900000, vatRate: 20, source: 'domestic' }],
};

function codes(result) {
  return result.errors.map((e) => e.code);
}

function clone(form) {
  return JSON.parse(JSON.stringify(form));
}

test('validateVatReturnForm: a freshly computed payable form is internally consistent', () => {
  const form = vatReturnForm(payablePeriod);
  const result = validateVatReturnForm(form);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
});

test('validateVatReturnForm: a freshly computed recoverable form is internally consistent', () => {
  const form = vatReturnForm(recoverablePeriod);
  const result = validateVatReturnForm(form);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  // sanity: it really is a recoverable (credit-carried) position
  assert.ok(form.lines['23'].recoverable > 0);
  assert.equal(form.lines['23'].payable, 0);
});

test('validateVatReturnForm: ok is exactly (errors.length === 0)', () => {
  const good = validateVatReturnForm(vatReturnForm(payablePeriod));
  assert.equal(good.ok, good.errors.length === 0);
  const bad = validateVatReturnForm({});
  assert.equal(bad.ok, false);
  assert.equal(bad.ok, bad.errors.length === 0);
});

test('validateVatReturnForm: every error is {field, code, message}', () => {
  const result = validateVatReturnForm({ lines: {} });
  assert.ok(result.errors.length > 0);
  for (const err of result.errors) {
    assert.equal(typeof err.field, 'string');
    assert.equal(typeof err.code, 'string');
    assert.equal(typeof err.message, 'string');
    assert.ok(err.field.length > 0 && err.code.length > 0 && err.message.length > 0);
  }
});

test('validateVatReturnForm: missing required lines are reported, never throws', () => {
  const result = validateVatReturnForm({ lines: {} });
  assert.equal(result.ok, false);
  const set = new Set(codes(result));
  for (const id of ['7', '9', '12', '13', '16', '17', '18', '21', '23']) {
    assert.ok(
      result.errors.some((e) => e.code === 'FORM_MISSING_LINE' && e.field === `lines.${id}`),
      `expected FORM_MISSING_LINE for line ${id}`,
    );
  }
  assert.ok(set.has('FORM_MISSING_LINE'));
});

test('validateVatReturnForm: a tampered line-16 base total is caught (16 = 7+9+12+13)', () => {
  const form = clone(vatReturnForm(payablePeriod));
  form.lines['16'].base += 1;
  const result = validateVatReturnForm(form);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('FORM_16_BASE_MISMATCH'));
});

test('validateVatReturnForm: a tampered line-16 VAT total is caught (16.vat = 7.vat+9.vat)', () => {
  const form = clone(vatReturnForm(payablePeriod));
  form.lines['16'].vat += 100;
  const result = validateVatReturnForm(form);
  assert.ok(codes(result).includes('FORM_16_VAT_MISMATCH'));
});

test('validateVatReturnForm: a tampered line-21 debit total is caught (21 = 17+18)', () => {
  const form = clone(vatReturnForm(payablePeriod));
  form.lines['21'].vat += 50;
  const result = validateVatReturnForm(form);
  assert.ok(codes(result).includes('FORM_21_VAT_MISMATCH'));
});

test('validateVatReturnForm: a tampered line-23 net is caught (23 = line16.vat − line21.vat)', () => {
  const form = clone(vatReturnForm(payablePeriod));
  form.lines['23'].payable += 1000;
  const result = validateVatReturnForm(form);
  assert.ok(codes(result).includes('FORM_23_NET_MISMATCH'));
});

test('validateVatReturnForm: a non-integer (fractional dram) amount is rejected', () => {
  const form = clone(vatReturnForm(payablePeriod));
  form.lines['7'].vat = 199999.5;
  const result = validateVatReturnForm(form);
  assert.ok(codes(result).includes('FORM_NON_INTEGER_AMOUNT'));
});

test('validateVatReturnForm: a negative amount is rejected', () => {
  const form = clone(vatReturnForm(payablePeriod));
  form.lines['7'].base = -1;
  const result = validateVatReturnForm(form);
  assert.ok(codes(result).includes('FORM_NEGATIVE_AMOUNT'));
});

test('validateVatReturnForm: a non-numeric amount is rejected, not coerced', () => {
  const form = clone(vatReturnForm(payablePeriod));
  form.lines['18'].vat = '80000';
  const result = validateVatReturnForm(form);
  assert.ok(codes(result).includes('FORM_NON_NUMERIC_AMOUNT'));
});
