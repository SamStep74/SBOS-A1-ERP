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

// --- i18n wiring --------------------------------------------------------
// Error messages are user-facing (the {message} field lands in finance UIs
// and RA-SRC error reports). All of them must route through the t() kernel
// so a caller can request Armenian (the native form language per decree
// N 298-Ն) or Russian. The default-locale is 'en' to preserve the strings
// the test corpus was written against — switching to 'hy' / 'ru' must
// flip every emitted message to the requested locale without losing
// {{id}} / {{field}} / {{actual}} / {{expected}} placeholders.
test('validateVatReturnForm: i18n — default locale is English (backward compatible)', () => {
  const result = validateVatReturnForm({ lines: {} });
  const missing = result.errors.find((e) => e.code === 'FORM_MISSING_LINE');
  assert.ok(missing);
  assert.ok(
    missing.message.includes('missing required line'),
    `expected English template, got: ${missing.message}`,
  );
  assert.ok(
    missing.message.includes("'7'") || missing.message.includes(' 7 '),
    `expected {{id}} interpolation, got: ${missing.message}`,
  );
});

test('validateVatReturnForm: i18n — { locale: "hy" } produces Armenian messages', () => {
  const result = validateVatReturnForm({ lines: {} }, { locale: 'hy' });
  const missing = result.errors.find((e) => e.code === 'FORM_MISSING_LINE');
  assert.ok(missing);
  // Armenian must contain an Armenian-script char (U+0530–U+058F) and must NOT be the
  // English template. We don't pin the exact wording — translation drift is fine —
  // we just assert the routing happened.
  assert.ok(
    /[Ա-Ֆա-ֆև]/.test(missing.message),
    `expected Armenian script in message, got: ${missing.message}`,
  );
  assert.ok(
    !missing.message.includes('missing required line'),
    `expected Armenian (not English) message, got: ${missing.message}`,
  );
});

test('validateVatReturnForm: i18n — { locale: "ru" } produces Russian messages', () => {
  const result = validateVatReturnForm({ lines: {} }, { locale: 'ru' });
  const missing = result.errors.find((e) => e.code === 'FORM_MISSING_LINE');
  assert.ok(missing);
  // Russian must use Cyrillic (U+0400–U+04FF).
  assert.ok(
    /[Ѐ-ӿ]/.test(missing.message),
    `expected Cyrillic script in message, got: ${missing.message}`,
  );
  assert.ok(
    !missing.message.includes('missing required line'),
    `expected Russian (not English) message, got: ${missing.message}`,
  );
});

test('validateVatReturnForm: i18n — mismatch error interpolates {{actual}} and {{expected}}', () => {
  const form = clone(vatReturnForm(payablePeriod));
  form.lines['16'].base += 1; // triggers FORM_16_BASE_MISMATCH
  const result = validateVatReturnForm(form, { locale: 'hy' });
  const mismatch = result.errors.find((e) => e.code === 'FORM_16_BASE_MISMATCH');
  assert.ok(mismatch);
  // Armenian template must show the actual and expected figures, NOT the literal
  // {{actual}} / {{expected}} placeholders — those are kernel-internal, not user-facing.
  assert.ok(
    !mismatch.message.includes('{{'),
    `expected placeholders to be interpolated, got: ${mismatch.message}`,
  );
  // And the numbers must be present in the localized message.
  const actual = form.lines['16'].base; // tampered value
  const expected = actual - 1; // sum of 7+9+12+13 bases
  assert.ok(
    mismatch.message.includes(String(actual)),
    `expected actual=${actual} in message: ${mismatch.message}`,
  );
  assert.ok(
    mismatch.message.includes(String(expected)),
    `expected expected=${expected} in message: ${mismatch.message}`,
  );
});

test('validateVatReturnForm: i18n — every emitted error message is non-empty in every locale', () => {
  const form = clone(vatReturnForm(payablePeriod));
  form.lines['18'].vat = '80000'; // triggers FORM_NON_NUMERIC_AMOUNT
  form.lines['18'].base = -1; // triggers FORM_NEGATIVE_AMOUNT
  form.lines['16'].base += 1; // triggers FORM_16_BASE_MISMATCH
  for (const locale of ['en', 'hy', 'ru']) {
    const result = validateVatReturnForm(form, { locale });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0, `expected errors in locale=${locale}`);
    for (const err of result.errors) {
      assert.ok(
        err.message && err.message.length > 0,
        `empty message in locale=${locale} for code=${err.code}`,
      );
      assert.ok(
        !err.message.includes('[[missing:'),
        `untranslated key in locale=${locale} for code=${err.code}: ${err.message}`,
      );
    }
  }
});
