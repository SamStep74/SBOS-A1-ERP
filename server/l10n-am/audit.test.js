// Tests for the l10n-am i18n audit scanner.
//
// Two regression nets:
//   1. auditCatalog — every key must exist in every locale (catalog balance).
//   2. auditSource — every t(locale, 'key', ...) call must reference a known key.
//
// Plus negative tests that inject known-bad input to prove the scanner
// actually detects issues (not just that current code happens to be clean).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auditAll, auditCatalog, auditSource, auditUnusedKeys } from './audit.js';
import { STRINGS, LOCALES } from './i18n.js';

describe('auditCatalog', () => {
  test('every key in the real catalog exists in every locale — current repo is balanced', () => {
    const result = auditCatalog({ strings: STRINGS, locales: LOCALES });
    assert.equal(result.issues.length, 0,
      `catalog should be balanced but found: ${JSON.stringify(result.issues, null, 2)}`);
    assert.ok(result.keyCount > 0, 'catalog should have at least one key');
  });

  test('flags a key that is missing in one locale', () => {
    const synthetic = {
      hy: { 'a.b': 'A', 'c.d': 'C' },
      en: { 'a.b': 'A' /* c.d missing */ },
      ru: { 'a.b': 'A', 'c.d': 'C' },
    };
    const result = auditCatalog({ strings: synthetic, locales: ['hy', 'en', 'ru'] });
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].type, 'catalog-missing-locale');
    assert.equal(result.issues[0].key, 'c.d');
    assert.deepEqual(result.issues[0].missingLocales, ['en']);
  });

  test('flags a key missing in multiple locales', () => {
    const synthetic = {
      hy: { 'only.here': 'X' },
      en: { 'only.here': 'X' },
      ru: { /* missing on purpose */ },
    };
    const result = auditCatalog({ strings: synthetic, locales: ['hy', 'en', 'ru'] });
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].key, 'only.here');
    assert.deepEqual(result.issues[0].missingLocales, ['ru']);
  });
});

describe('auditSource', () => {
  test('current l10n-am source has no t() calls referencing missing keys', () => {
    const result = auditSource({ strings: STRINGS, locales: LOCALES });
    assert.equal(result.issues.length, 0,
      `current source should be clean but found: ${JSON.stringify(result.issues, null, 2)}`);
    assert.ok(result.tCallCount > 0, 'current source should have at least one t() call');
  });

  test('flags a t() call whose key is not in any locale catalog', () => {
    const syntheticFiles = {
      '/fake/root/vatReturn/vatReturn.js': [
        "import { t } from '../i18n.js';",
        "const msg = t('en', 'vat.form.missingLine', { id: '7' });",          // OK — exists
        "const oops = t('en', 'totally.fake.key');",                            // BAD
        "const more = t('hy', 'also.fake');",                                   // BAD
      ].join('\n'),
    };
    const result = auditSource({
      strings: STRINGS,
      locales: LOCALES,
      files: Object.keys(syntheticFiles),
      readFile: (p) => syntheticFiles[p],
    });
    const missing = result.issues.filter((i) => i.type === 'source-uses-missing-key');
    assert.equal(missing.length, 2);
    const keys = missing.map((m) => m.key).sort();
    assert.deepEqual(keys, ['also.fake', 'totally.fake.key']);
    // Each issue should carry file + line so a developer can jump to it
    for (const m of missing) {
      assert.ok(m.file.endsWith('vatReturn.js'));
      assert.ok(typeof m.line === 'number' && m.line > 0);
    }
  });

  test('finds t() calls across multiple files in the synthetic tree', () => {
    const syntheticFiles = {
      '/fake/root/a.js': "t('en', 'hvhh.required');",
      '/fake/root/b.js': "t('hy', 'missing.in.catalog');",
      '/fake/root/sub/c.js': "t('ru', 'amd.notFinite');",
    };
    const result = auditSource({
      strings: STRINGS,
      locales: LOCALES,
      files: Object.keys(syntheticFiles),
      readFile: (p) => syntheticFiles[p],
    });
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].key, 'missing.in.catalog');
    assert.equal(result.tCallCount, 3);
  });

  test('skips test files and non-js files', () => {
    const syntheticFiles = {
      '/fake/root/real.js': "t('en', 'real.key');",
      '/fake/root/real.test.js': "t('en', 'should.be.ignored');",
      '/fake/root/README.md': "t('en', 'should.be.ignored');",
    };
    const syntheticCatalog = { en: { 'real.key': 'x', 'should.be.ignored': 'x' } };
    const result = auditSource({
      strings: syntheticCatalog,
      locales: ['en'],
      files: Object.keys(syntheticFiles),
      readFile: (p) => syntheticFiles[p],
    });
    // Only real.js counts — test.js and README.md are exempt
    assert.equal(result.issues.length, 0);
    assert.equal(result.tCallCount, 1);
  });
});

// ---- live-repo regression net ---------------------------------------------
//
// This describe block is the durable wire-into-`npm test` piece: every time
// the test suite runs (locally, in CI, in a pre-commit hook), it asserts
// that the REAL l10n-am catalog is balanced AND every REAL t() call site
// references a real key. If a future contributor adds a new i18n key to
// one locale only, or hardcodes a string instead of routing through t(),
// this test fails the build with a precise pointer.

describe('auditAll — live l10n-am regression', () => {
  test('real catalog + real source tree has zero issues at HEAD', () => {
    const result = auditAll({ strings: STRINGS, locales: LOCALES });
    assert.equal(result.issues.length, 0,
      `live repo should be clean but found: ${JSON.stringify(result.issues, null, 2)}`);
    assert.ok(result.catalogKeyCount > 0, 'live catalog should have keys');
    assert.ok(result.tCallCount > 0, 'live source should have t() calls');
    // Reverse direction: every catalog key is used at least once.
    assert.equal(result.unusedKeyCount, 0,
      `live repo should have no unused keys but found: ${result.unusedKeyCount}`);
  });
});

// ---- auditUnusedKeys (reverse direction) ----------------------------------
//
// Detects keys defined in the catalog that no t() call site ever references.
// These are "dead" keys: translation effort was spent, but no consumer is
// using them. Either the consumer was removed, or the key was added in
// anticipation of a feature that never landed.

describe('auditUnusedKeys', () => {
  test('flags a catalog key that no source file references', () => {
    const syntheticStrings = {
      hy: { 'used.key': 'A', 'unused.one': 'B' },
      en: { 'used.key': 'A', 'unused.one': 'B' },
      ru: { 'used.key': 'A', 'unused.one': 'B' },
    };
    const syntheticFiles = {
      '/fake/root/only-uses-one.js': "t('en', 'used.key');",
    };
    const result = auditUnusedKeys({
      strings: syntheticStrings,
      locales: ['hy', 'en', 'ru'],
      files: Object.keys(syntheticFiles),
      readFile: (p) => syntheticFiles[p],
    });
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].type, 'catalog-unused-key');
    assert.equal(result.issues[0].key, 'unused.one');
    assert.equal(result.usedKeyCount, 1);
    assert.equal(result.catalogKeyCount, 2);
  });

  test('flags every unused key when source uses none of them', () => {
    const syntheticStrings = {
      en: { 'a': 'A', 'b': 'B', 'c': 'C' },
    };
    const syntheticFiles = {
      '/fake/root/empty.js': "// no t() calls in here",
    };
    const result = auditUnusedKeys({
      strings: syntheticStrings,
      locales: ['en'],
      files: Object.keys(syntheticFiles),
      readFile: (p) => syntheticFiles[p],
    });
    assert.equal(result.issues.length, 3);
    const keys = result.issues.map((i) => i.key).sort();
    assert.deepEqual(keys, ['a', 'b', 'c']);
  });

  test('zero issues when every catalog key is used at least once', () => {
    const syntheticStrings = {
      en: { 'x': 'X', 'y': 'Y' },
    };
    const syntheticFiles = {
      '/fake/root/a.js': "t('en', 'x');",
      '/fake/root/b.js': "t('en', 'y');",
    };
    const result = auditUnusedKeys({
      strings: syntheticStrings,
      locales: ['en'],
      files: Object.keys(syntheticFiles),
      readFile: (p) => syntheticFiles[p],
    });
    assert.equal(result.issues.length, 0);
    assert.equal(result.usedKeyCount, 2);
    assert.equal(result.unusedKeyCount, 0);
  });

  test('counts a key as used even when referenced by multiple call sites', () => {
    // Three call sites to 'shared', one to 'lonely'. lonely is the only unused.
    const syntheticStrings = {
      en: { 'shared': 'S', 'lonely': 'L' },
    };
    const syntheticFiles = {
      '/fake/root/a.js': "t('en', 'shared'); t('en', 'shared');",
      '/fake/root/b.js': "t('en', 'shared');",
    };
    const result = auditUnusedKeys({
      strings: syntheticStrings,
      locales: ['en'],
      files: Object.keys(syntheticFiles),
      readFile: (p) => syntheticFiles[p],
    });
    // 3 t() calls total but only 1 distinct key referenced; lonely unused
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].key, 'lonely');
    assert.equal(result.usedKeyCount, 1);
  });

  test('skips test files so test-fixture keys do not look "used"', () => {
    // A test.js references a key that is NOT in the production source.
    // The function audits production source, so the key is unused.
    const syntheticStrings = {
      en: { 'only.in.test': 'X' },
    };
    const syntheticFiles = {
      '/fake/root/real.js': "// no t() calls",
      '/fake/root/real.test.js': "t('en', 'only.in.test');",
    };
    const result = auditUnusedKeys({
      strings: syntheticStrings,
      locales: ['en'],
      files: Object.keys(syntheticFiles),
      readFile: (p) => syntheticFiles[p],
    });
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].key, 'only.in.test');
  });
});
