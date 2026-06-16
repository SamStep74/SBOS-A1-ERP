import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMD,
  HVHH_LENGTH,
  normalizeHvhh,
  validateHvhh,
  isValidHvhh,
  roundAmd,
  formatAmd,
} from './localization.js';
import { t, missingMarker } from './i18n.js';

// --- ՀՎՀՀ (Armenian taxpayer identification number) ---

test('ՀՎՀՀ: accepts a well-formed 8-digit taxpayer id', () => {
  const r = validateHvhh('00123456');
  assert.equal(r.ok, true);
  assert.equal(r.normalized, '00123456');
  assert.equal(r.error, null);
  assert.equal(isValidHvhh('00123456'), true);
});

test('ՀՎՀՀ: normalizes spaces, dots, and hyphens before validating', () => {
  assert.equal(normalizeHvhh(' 001-234.56 '), '00123456');
  assert.equal(validateHvhh('001 234 56').ok, true);
});

test('ՀՎՀՀ: rejects wrong length', () => {
  assert.equal(validateHvhh('1234567').ok, false); // 7 digits
  assert.equal(validateHvhh('123456789').ok, false); // 9 digits
  assert.equal(HVHH_LENGTH, 8);
});

test('ՀՎՀՀ: rejects non-numeric input', () => {
  const r = validateHvhh('0012345A');
  assert.equal(r.ok, false);
  assert.match(r.error, /թվանշան/); // "digits"
});

test('ՀՎՀՀ: rejects degenerate all-same sequences (never issued)', () => {
  assert.equal(validateHvhh('00000000').ok, false);
  assert.equal(validateHvhh('11111111').ok, false);
});

test('ՀՎՀՀ: blank/null is a required error', () => {
  const r = validateHvhh('');
  assert.equal(r.ok, false);
  assert.match(r.error, /պարտադիր/); // "required"
  assert.equal(isValidHvhh(null), false);
  assert.equal(isValidHvhh(undefined), false);
});

// --- AMD (Armenian dram) money ---

test('AMD: rounds to whole dram (no minor unit)', () => {
  assert.equal(roundAmd(1234.4), 1234);
  assert.equal(roundAmd(1234.5), 1235);
  assert.equal(roundAmd('999.99'), 1000);
  assert.equal(roundAmd(NaN), 0);
  assert.equal(roundAmd(Infinity), 0);
  assert.equal(roundAmd(null), 0);
});

test('AMD: formats with thousands grouping and the ֏ symbol', () => {
  assert.equal(formatAmd(1234567), '1,234,567 ֏');
  assert.equal(formatAmd(1234567, { symbol: false }), '1,234,567');
  assert.equal(formatAmd(1234.6), '1,235 ֏'); // rounds before formatting
  assert.equal(formatAmd(0), '0 ֏');
  assert.equal(formatAmd(-1500), '-1,500 ֏');
});

test('AMD: currency metadata reflects dram with zero subunits', () => {
  assert.equal(AMD.code, 'AMD');
  assert.equal(AMD.symbol, '֏');
  assert.equal(AMD.subunit, 0);
});

// --- i18n wiring: locale override on validateHvhh ---
//
// validateHvhh must route its user-facing errors through t() so callers can
// pick a language. Default stays 'hy' to preserve the 5 Armenian strings every
// existing test and call site depends on.

test('validateHvhh: locale=ru returns the Russian error via t()', () => {
  // Pre-condition: the kernel must have the ru translation. If a translator
  // removes it later, this test fails with a clear missing-marker message
  // instead of silently flipping to Armenian.
  const russian = t('ru', 'hvhh.required');
  assert.notEqual(
    russian,
    missingMarker('hvhh.required'),
    'kernel must have ru translation for hvhh.required',
  );
  assert.equal(validateHvhh('', { locale: 'ru' }).error, russian);
});

test('validateHvhh: locale=en returns the English error via t() for every fail path', () => {
  const englishRequired = t('en', 'hvhh.required');
  const englishNotNumeric = t('en', 'hvhh.notNumeric');
  const englishLength = t('en', 'hvhh.length', { length: '8' });
  const englishDegenerate = t('en', 'hvhh.degenerate');
  const englishCheckDigit = t('en', 'hvhh.checkDigit');
  // Sanity: kernel has the keys (catches translator regressions).
  for (const [name, value] of Object.entries({
    englishRequired,
    englishNotNumeric,
    englishLength,
    englishDegenerate,
    englishCheckDigit,
  })) {
    assert.notEqual(value, missingMarker(name), `kernel must have en translation: ${name}`);
  }
  assert.equal(validateHvhh('', { locale: 'en' }).error, englishRequired);
  assert.equal(validateHvhh('0012345A', { locale: 'en' }).error, englishNotNumeric);
  assert.equal(validateHvhh('1234567', { locale: 'en' }).error, englishLength);
  assert.equal(validateHvhh('00000000', { locale: 'en' }).error, englishDegenerate);
  assert.equal(
    validateHvhh('01234567', { locale: 'en', checkDigitVerifier: () => false }).error,
    englishCheckDigit,
  );
});

test('validateHvhh: default locale is hy (backward compat with Armenian errors)', () => {
  // No locale arg → must keep producing the same Armenian strings the existing
  // call sites and the 5 regex-based tests in this file depend on.
  assert.equal(validateHvhh('').error, t('hy', 'hvhh.required'));
  assert.equal(validateHvhh('0012345A').error, t('hy', 'hvhh.notNumeric'));
  assert.equal(validateHvhh('1234567').error, t('hy', 'hvhh.length', { length: '8' }));
  assert.equal(validateHvhh('00000000').error, t('hy', 'hvhh.degenerate'));
  assert.equal(
    validateHvhh('01234567', { checkDigitVerifier: () => false }).error,
    t('hy', 'hvhh.checkDigit'),
  );
});
