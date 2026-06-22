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

test('validateVatReturnForm: line 18 (domestic acquisitions) is checked against the 20% standard rate', () => {
  // Sanity: a freshly computed form for a normal period is OK.
  const okForm = vatReturnForm(payablePeriod);
  const okResult = validateVatReturnForm(okForm);
  assert.ok(
    !codes(okResult).some((c) => c.startsWith('FORM_18_')),
    `expected no FORM_18_* errors on a fresh form, got ${JSON.stringify(okResult.errors)}`,
  );

  // Surgical tamper: replace line 18 with a single line at exactly half-rate (10%)
  // and absorb the difference in line 17 so that EVERY cross-foot still ties:
  //   - line 21 = 17 + 18           (unchanged because we move 17 down by the same amount)
  //   - line 23 = 16.vat − 21.vat   (unchanged because 21.vat is unchanged)
  // The only thing wrong is that line 18's VAT is at ~10% of base, not 20%.
  // Without the rate-band check, this form passes the validator.
  const form = clone(okForm);
  const realBase18 = form.lines['18'].base;
  const realVat18 = form.lines['18'].vat;
  const realVat17 = form.lines['17'].vat;
  const offRateVat18 = Math.round(realBase18 * 0.1); // 10%, well outside the 20% ±1% band
  const delta = realVat18 - offRateVat18;
  form.lines['18'].vat = offRateVat18;
  form.lines['17'].vat = realVat17 + delta; // absorb so line 21 = 17 + 18 still ties
  // (line 16/21/23 totals unchanged)
  assert.ok(realBase18 > 0);
  assert.ok(offRateVat18 < realVat18); // we actually lowered it
  const result = validateVatReturnForm(form);
  assert.ok(
    codes(result).includes('FORM_18_RATE_MISMATCH'),
    `expected FORM_18_RATE_MISMATCH, got ${JSON.stringify(result.errors)}`,
  );
  // the field pinpoints the offending cell
  const err = result.errors.find((e) => e.code === 'FORM_18_RATE_MISMATCH');
  assert.equal(err.field, 'lines.18.vat');
});

test('validateVatReturnForm: line 18 rate-band tolerates the same per-line rounding drift as line 7', () => {
  // A period that produces line 18 base / VAT consistent with 20% within the
  // rounding band should NOT trigger FORM_18_RATE_MISMATCH.
  const period = {
    sales: [{ netAmount: 100_000, vatRate: 20 }],
    purchases: [
      // 5 domestic purchases of odd net amounts: the per-line VAT rounding can
      // produce a line-18 VAT that differs from base*0.20 by 1-2 dram without
      // being wrong. The validator must absorb this drift, not flag it.
      { netAmount: 33_333, vatRate: 20, source: 'domestic' },
      { netAmount: 17_777, vatRate: 20, source: 'domestic' },
      { netAmount: 9_999, vatRate: 20, source: 'domestic' },
      { netAmount: 12_345, vatRate: 20, source: 'domestic' },
      { netAmount: 6_789, vatRate: 20, source: 'domestic' },
    ],
  };
  const form = vatReturnForm(period);
  const result = validateVatReturnForm(form);
  assert.ok(
    !codes(result).includes('FORM_18_RATE_MISMATCH'),
    `realistic period should not fail the rate band, got ${JSON.stringify(result.errors)}`,
  );
});

test('validateVatReturnForm: line 18 rate-band skips the check when base is 0 (no false positive on a no-domestic-purchase period)', () => {
  const period = {
    sales: [{ netAmount: 100_000, vatRate: 20 }],
    purchases: [], // no domestic acquisitions → line 18 base = 0
  };
  const form = vatReturnForm(period);
  const result = validateVatReturnForm(form);
  assert.ok(
    !codes(result).some((c) => c.startsWith('FORM_18_')),
    `zero-base line 18 must not trigger rate-band error, got ${JSON.stringify(result.errors)}`,
  );
});

test('validateVatReturnForm: line 17 (imports) is checked against the 20% standard rate', () => {
  // Sanity: a freshly computed form for a normal period is OK.
  const okForm = vatReturnForm(payablePeriod);
  const okResult = validateVatReturnForm(okForm);
  assert.ok(
    !codes(okResult).some((c) => c.startsWith('FORM_17_')),
    `expected no FORM_17_* errors on a fresh form, got ${JSON.stringify(okResult.errors)}`,
  );

  // Surgical tamper: replace line 17 with a single line at exactly half-rate (10%)
  // and absorb the difference in line 18 so that EVERY cross-foot still ties:
  //   - line 21 = 17 + 18           (unchanged because we move 18 down by the same amount)
  //   - line 23 = 16.vat − 21.vat   (unchanged because 21.vat is unchanged)
  // The only thing wrong is that line 17's VAT is at ~10% of base, not 20%.
  // Without the rate-band check, this form passes the validator.
  const form = clone(okForm);
  const realBase17 = form.lines['17'].base;
  const realVat17 = form.lines['17'].vat;
  const realVat18 = form.lines['18'].vat;
  const offRateVat17 = Math.round(realBase17 * 0.1); // 10%, well outside the 20% ±1% band
  const delta = realVat17 - offRateVat17;
  form.lines['17'].vat = offRateVat17;
  form.lines['18'].vat = realVat18 + delta; // absorb so line 21 = 17 + 18 still ties
  // (line 16/21/23 totals unchanged)
  assert.ok(realBase17 > 0);
  assert.ok(offRateVat17 < realVat17); // we actually lowered it
  const result = validateVatReturnForm(form);
  assert.ok(
    codes(result).includes('FORM_17_RATE_MISMATCH'),
    `expected FORM_17_RATE_MISMATCH, got ${JSON.stringify(result.errors)}`,
  );
  // the field pinpoints the offending cell
  const err = result.errors.find((e) => e.code === 'FORM_17_RATE_MISMATCH');
  assert.equal(err.field, 'lines.17.vat');
});

test('validateVatReturnForm: line 17 rate-band tolerates the same per-line rounding drift as line 7', () => {
  // A period that produces line 17 base / VAT consistent with 20% within the
  // rounding band should NOT trigger FORM_17_RATE_MISMATCH.
  const period = {
    sales: [{ netAmount: 100_000, vatRate: 20 }],
    purchases: [
      // 5 import purchases of odd net amounts: the per-line VAT rounding can
      // produce a line-17 VAT that differs from base*0.20 by 1-2 dram without
      // being wrong. The validator must absorb this drift, not flag it.
      { netAmount: 33_333, vatRate: 20, source: 'import' },
      { netAmount: 17_777, vatRate: 20, source: 'import' },
      { netAmount: 9_999, vatRate: 20, source: 'import' },
      { netAmount: 12_345, vatRate: 20, source: 'import' },
      { netAmount: 6_789, vatRate: 20, source: 'import' },
    ],
  };
  const form = vatReturnForm(period);
  const result = validateVatReturnForm(form);
  assert.ok(
    !codes(result).includes('FORM_17_RATE_MISMATCH'),
    `realistic import-heavy period should not fail the rate band, got ${JSON.stringify(result.errors)}`,
  );
});

test('validateVatReturnForm: line 17 rate-band skips the check when base is 0 (no false positive on a no-import period)', () => {
  const period = {
    sales: [{ netAmount: 100_000, vatRate: 20 }],
    purchases: [], // no imports → line 17 base = 0
  };
  const form = vatReturnForm(period);
  const result = validateVatReturnForm(form);
  assert.ok(
    !codes(result).some((c) => c.startsWith('FORM_17_')),
    `zero-base line 17 must not trigger rate-band error, got ${JSON.stringify(result.errors)}`,
  );
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
