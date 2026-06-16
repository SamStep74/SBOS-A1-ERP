import test from 'node:test';
import assert from 'node:assert/strict';
import { t, LOCALES, DEFAULT_LOCALE, STRINGS, missingMarker } from './i18n.js';

// i18n kernel: a tiny, pure, dependency-free lookup table for user-facing
// strings. Used by parseHvhh, parseAmd, validateHvhh and any future module
// that returns an error to a user. Locale fallback goes: requested locale →
// DEFAULT_LOCALE → sentinel (never throws on a missing key — a translator
// removing a key must not crash the app, only produce an obvious log/UI mark).

test('i18n: t() returns the requested locale string for a known key', () => {
  assert.equal(t('hy', 'hvhh.required'), 'ՀՎՀՀ-ն պարտադիր է');
  assert.equal(t('en', 'hvhh.required'), 'HVHH is required');
  assert.equal(t('ru', 'hvhh.required'), 'ИНН обязателен');
});

test('i18n: t() interpolates {{var}} placeholders with positional or named values', () => {
  assert.equal(t('hy', 'hvhh.length', { length: '8' }), 'ՀՎՀՀ-ն պետք է լինի 8 նիշ');
  assert.equal(t('en', 'hvhh.length', { length: '8' }), 'HVHH must be 8 digits long');
  assert.equal(t('ru', 'hvhh.length', { length: '8' }), 'ИНН должен содержать 8 цифр');
});

test('i18n: t() leaves an unknown placeholder literal (does not throw, does not substitute)', () => {
  // If a template references a var that was not passed, the raw {{var}} token
  // is left in the output. That makes missing data visible in logs/UI without
  // crashing the call site.
  assert.equal(t('en', 'hvhh.length', {}), 'HVHH must be {{length}} digits long');
});

test('i18n: t() returns a sentinel marker (not throws) when the key is missing in every locale', () => {
  // A developer must be able to ship a feature that references a key the
  // translators haven't filled in yet. The marker should be obvious in logs
  // and self-identifying so an operator can grep for missing translations.
  const out = t('en', 'totally.bogus.key');
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('totally.bogus.key'), `sentinel should mention the key: got ${out}`);
  assert.ok(out.includes('missing'), `sentinel should mention "missing": got ${out}`);
  assert.equal(out, missingMarker('totally.bogus.key'));
});

test('i18n: t() with an unknown locale falls back to DEFAULT_LOCALE for known keys', () => {
  assert.equal(t('xx', 'hvhh.required'), STRINGS[DEFAULT_LOCALE]['hvhh.required']);
  // And to the sentinel for unknown keys — never throws.
  assert.equal(typeof t('xx', 'totally.bogus.key'), 'string');
});

test('i18n: missingMarker is a pure function — same input always gives same output', () => {
  assert.equal(missingMarker('a.b.c'), missingMarker('a.b.c'));
  // And it round-trips through t() so callers can compare.
  assert.equal(t('en', 'a.b.c'), missingMarker('a.b.c'));
});

test('i18n: LOCALES is a frozen, non-empty array of lowercase 2-letter codes', () => {
  assert.ok(Array.isArray(LOCALES));
  assert.ok(LOCALES.length >= 1);
  for (const code of LOCALES) {
    assert.match(code, /^[a-z]{2}$/);
  }
  assert.equal(typeof DEFAULT_LOCALE, 'string');
  assert.ok(LOCALES.includes(DEFAULT_LOCALE), 'DEFAULT_LOCALE must be in LOCALES');
  // Object.freeze means we cannot mutate at runtime.
  assert.throws(() => {
    LOCALES.push('zz');
  }, TypeError);
  assert.throws(() => {
    LOCALES[0] = 'zz';
  }, TypeError);
});

test('i18n: STRINGS is frozen at every level (root + each locale table)', () => {
  assert.throws(() => {
    STRINGS.hy = {};
  }, TypeError);
  assert.throws(() => {
    STRINGS.hy['hvhh.required'] = 'tampered';
  }, TypeError);
});

test('i18n: every locale has the same set of keys (no drift between languages)', () => {
  // If a translator added a key to hy but forgot en/ru, calls for that key
  // in en/ru would silently fall back. That hides bugs. Detect drift at
  // test time so the catalog stays in sync.
  const keySets = LOCALES.map((loc) => new Set(Object.keys(STRINGS[loc])));
  const [first, ...rest] = keySets;
  for (const set of rest) {
    const missing = [...first].filter((k) => !set.has(k));
    const extra = [...set].filter((k) => !first.has(k));
    assert.deepEqual(missing, [], `locale missing keys: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `locale has extra keys: ${extra.join(', ')}`);
  }
});
