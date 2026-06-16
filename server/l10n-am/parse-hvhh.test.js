import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHvhh, isValidHvhh } from './localization.js';
import { t, missingMarker } from './i18n.js';

// parseHvhh is the STRICT boundary parser for ՀՎՀՀ (Armenian taxpayer id).
// Mirrors parseAmd's shape: { ok, hvhh, error }. Unlike normalizeHvhh (which
// silently returns '' for bad input) and isValidHvhh (boolean only), parseHvhh
// fails loud with a localized reason and exposes the normalized 8-digit value
// ready to persist. Use at API/form/import boundaries; keep normalizeHvhh for
// already-validated internal numbers.

const VALID = '01234567';

test('parseHvhh: a clean 8-digit string is accepted and returned normalized', () => {
  assert.deepEqual(parseHvhh(VALID), { ok: true, hvhh: VALID });
});

test('parseHvhh: separators (spaces, dots, hyphens) are stripped', () => {
  assert.deepEqual(parseHvhh('0123 4567'), { ok: true, hvhh: VALID });
  assert.deepEqual(parseHvhh('0123-4567'), { ok: true, hvhh: VALID });
  assert.deepEqual(parseHvhh('0123.4567'), { ok: true, hvhh: VALID });
  assert.deepEqual(parseHvhh('  01234567  '), { ok: true, hvhh: VALID });
});

test('parseHvhh: result is equivalent to isValidHvhh for the same input', () => {
  for (const v of [VALID, '0123-4567', '0123 4567', '0123.4567']) {
    assert.equal(parseHvhh(v).ok, isValidHvhh(v), `mismatch on ${v}`);
  }
});

test('parseHvhh: non-numeric input fails loud (not a silent empty string)', () => {
  const r = parseHvhh('0123abcd');
  assert.equal(r.ok, false);
  assert.equal(r.hvhh, '0123abcd'); // normalized (digit prefix) is still exposed
  assert.equal(typeof r.error, 'string');
  assert.ok(r.error.length > 0);
});

test('parseHvhh: wrong-length input fails with a length message', () => {
  const r = parseHvhh('1234567'); // 7 digits
  assert.equal(r.ok, false);
  assert.equal(r.hvhh, '1234567');
  assert.ok(r.error.length > 0);
  const r2 = parseHvhh('123456789'); // 9 digits
  assert.equal(r2.ok, false);
  assert.equal(r2.hvhh, '123456789');
});

test('parseHvhh: degenerate (all-same-digit) input is rejected', () => {
  const r = parseHvhh('00000000');
  assert.equal(r.ok, false);
  assert.equal(r.hvhh, '00000000');
  assert.ok(r.error.length > 0);
});

test('parseHvhh: empty/blank/missing input is a required-error, not empty', () => {
  for (const v of ['', '   ', null, undefined]) {
    const r = parseHvhh(v);
    assert.equal(r.ok, false, `expected ${JSON.stringify(v)} to fail`);
    // For null/undefined/empty, normalizeHvhh returns ''. The error is the signal.
    assert.equal(r.hvhh, '');
    assert.ok(r.error.length > 0);
  }
});

test('parseHvhh: a checkDigitVerifier that rejects turns ok=false with check-digit message', () => {
  const r = parseHvhh(VALID, { checkDigitVerifier: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.hvhh, VALID); // normalized value still exposed on rejection
  assert.ok(r.error.length > 0);
});

test('parseHvhh: a passing checkDigitVerifier leaves ok=true', () => {
  const r = parseHvhh(VALID, { checkDigitVerifier: () => true });
  assert.equal(r.ok, true);
  assert.equal(r.hvhh, VALID);
});

// --- i18n wiring: locale override propagates through parseHvhh → validateHvhh ---

test('parseHvhh: locale=ru returns the Russian error via t()', () => {
  const russian = t('ru', 'hvhh.required');
  assert.notEqual(
    russian,
    missingMarker('hvhh.required'),
    'kernel must have ru translation for hvhh.required',
  );
  assert.equal(parseHvhh('', { locale: 'ru' }).error, russian);
  assert.equal(parseHvhh('0012345A', { locale: 'ru' }).error, t('ru', 'hvhh.notNumeric'));
  assert.equal(
    parseHvhh('1234567', { locale: 'ru' }).error,
    t('ru', 'hvhh.length', { length: '8' }),
  );
});

test('parseHvhh: default locale stays hy (preserves Armenian errors for existing callers)', () => {
  // No locale arg → Armenian, matching the regex-based tests above.
  assert.equal(parseHvhh('').error, t('hy', 'hvhh.required'));
  assert.equal(parseHvhh('0012345A').error, t('hy', 'hvhh.notNumeric'));
});
