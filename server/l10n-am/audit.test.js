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
import { auditAll, auditCatalog, auditSource } from './audit.js';
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
  });
});
