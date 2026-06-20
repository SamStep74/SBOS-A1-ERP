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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditAll,
  auditCatalog,
  auditSource,
  auditUnusedKeys,
  findHardcodedRates,
  findEvalLike,
  findStringConcatSql,
} from './audit.js';
import { STRINGS, LOCALES } from './i18n.js';

// Helper: make an isolated scratch directory for filesystem-scanner tests.
function makeScratchDir(prefix = 'audit-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

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

// ---- findHardcodedRates ----------------------------------------------------
//
// Walks rootDir for .js files (excluding *.test.js) and reports any numeric
// literal >= 0.01 that sits in a "rate-shaped" context: the line contains
// `rate` / `percent`, or we're inside a `RATES = { ... }` object literal.
// Tests below use isolated tmpdirs so the live l10n-am tree is never scanned.

describe('findHardcodedRates', () => {
  test('empty directory returns []', async () => {
    const dir = makeScratchDir();
    try {
      const out = await findHardcodedRates(dir);
      assert.deepEqual(out, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flags a single rate literal on a rate-shaped line', async () => {
    const dir = makeScratchDir();
    try {
      writeFileSync(
        join(dir, 'vat.js'),
        [
          "export const VAT_RATE = 0.20;",
        ].join('\n'),
      );
      const out = await findHardcodedRates(dir);
      assert.equal(out.length, 1);
      assert.equal(out[0].value, 0.20);
      assert.match(out[0].file, /vat\.js$/);
      assert.equal(out[0].line, 1);
      assert.ok(out[0].column >= 1);
      assert.match(out[0].context, /VAT_RATE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flags literals inside a RATES object (multi-line block)', async () => {
    const dir = makeScratchDir();
    try {
      writeFileSync(
        join(dir, 'rates.js'),
        [
          "const RATES = {",
          "  income: 0.05,",
          "  vat: 0.20,",
          "  pension: 0.10,",
          "};",
        ].join('\n'),
      );
      const out = await findHardcodedRates(dir);
      assert.equal(out.length, 3);
      const values = out.map((r) => r.value).sort();
      assert.deepEqual(values, [0.05, 0.10, 0.20]);
      // Lines are 2, 3, 4 (the opening line { is line 1, } is line 5)
      assert.deepEqual(
        out.map((r) => r.line).sort((a, b) => a - b),
        [2, 3, 4],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('finds rates across multiple files in the tree', async () => {
    const dir = makeScratchDir();
    try {
      writeFileSync(join(dir, 'a.js'), "const rateA = 0.10;");
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'b.js'), "const rateB = 0.15;");
      const out = await findHardcodedRates(dir);
      assert.equal(out.length, 2);
      const files = out.map((r) => r.file).sort();
      assert.equal(files[0].endsWith('a.js'), true);
      assert.equal(files[1].endsWith('b.js'), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('excludes *.test.js so test fixtures do not flag', async () => {
    const dir = makeScratchDir();
    try {
      writeFileSync(join(dir, 'real.js'), "const rate = 0.20;");          // flagged
      writeFileSync(join(dir, 'real.test.js'), "const rate = 0.99;");     // NOT flagged (test)
      const out = await findHardcodedRates(dir);
      assert.equal(out.length, 1);
      assert.match(out[0].file, /real\.js$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not flag literals below 0.01 even on rate-shaped lines', async () => {
    const dir = makeScratchDir();
    try {
      // 0.001 is below the rate threshold; 'count' is not rate-shaped.
      writeFileSync(
        join(dir, 'tiny.js'),
        [
          "const rate = 0.001;",          // 0.001 < 0.01 → ignored (under threshold)
          "const count = 10;",            // 'count' has no rate identifier → ignored
          "const factor = 0.5;",          // no rate identifier → ignored
        ].join('\n'),
      );
      const out = await findHardcodedRates(dir);
      assert.deepEqual(out, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not throw on a binary file or unreadable file', async () => {
    const dir = makeScratchDir();
    try {
      // Write a "binary" .js file (non-UTF8 bytes). The scanner must skip it
      // gracefully — no throw, no spurious match.
      const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x42, 0x0a, 0x00]);
      writeFileSync(join(dir, 'garbage.js'), binary);
      const out = await findHardcodedRates(dir);
      assert.deepEqual(out, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips node_modules and .git directories', async () => {
    const dir = makeScratchDir();
    try {
      mkdirSync(join(dir, 'node_modules'));
      writeFileSync(join(dir, 'node_modules', 'lib.js'), "const rate = 0.5;");
      mkdirSync(join(dir, '.git'));
      writeFileSync(join(dir, '.git', 'hook.js'), "const rate = 0.5;");
      writeFileSync(join(dir, 'real.js'), "const rate = 0.20;");
      const out = await findHardcodedRates(dir);
      assert.equal(out.length, 1);
      assert.match(out[0].file, /real\.js$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- findEvalLike ----------------------------------------------------------
//
// Walks rootDir for .js files and reports `eval(` and `new Function(` call
// sites. Both patterns are code-injection red flags; this is an operator-
// visible warning, not a parser-accurate lint.

describe('findEvalLike', () => {
  test('empty directory returns []', async () => {
    const dir = makeScratchDir();
    try {
      const out = await findEvalLike(dir);
      assert.deepEqual(out, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flags eval() call sites', async () => {
    const dir = makeScratchDir();
    try {
      writeFileSync(
        join(dir, 'danger.js'),
        [
          "function run(src) {",
          "  return eval(src);",
          "}",
        ].join('\n'),
      );
      const out = await findEvalLike(dir);
      assert.equal(out.length, 1);
      assert.equal(out[0].kind, 'eval-call');
      assert.equal(out[0].line, 2);
      assert.match(out[0].file, /danger\.js$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flags new Function() call sites', async () => {
    const dir = makeScratchDir();
    try {
      writeFileSync(
        join(dir, 'ctor.js'),
        "const fn = new Function('a', 'return a + 1');",
      );
      const out = await findEvalLike(dir);
      assert.equal(out.length, 1);
      assert.equal(out[0].kind, 'new-function');
      assert.equal(out[0].line, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flags both kinds across multiple files', async () => {
    const dir = makeScratchDir();
    try {
      writeFileSync(join(dir, 'a.js'), "eval('1+1');");
      writeFileSync(join(dir, 'b.js'), "new Function('return 1')();");
      writeFileSync(join(dir, 'c.js'), "const x = 1; // safe");
      const out = await findEvalLike(dir);
      assert.equal(out.length, 2);
      const kinds = out.map((r) => r.kind).sort();
      assert.deepEqual(kinds, ['eval-call', 'new-function']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not throw on a binary file', async () => {
    const dir = makeScratchDir();
    try {
      const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x42, 0x0a, 0x00]);
      writeFileSync(join(dir, 'garbage.js'), binary);
      const out = await findEvalLike(dir);
      assert.deepEqual(out, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- findStringConcatSql ---------------------------------------------------
//
// Walks rootDir for .js files (excluding *.test.js) and reports lines that
// look like a SQL keyword followed by string-concat (`+`). Single-line match
// — multi-line SQL builders do not concatenate on a single line, so they are
// not flagged (and that is by design).

describe('findStringConcatSql', () => {
  test('empty directory returns []', async () => {
    const dir = makeScratchDir();
    try {
      const out = await findStringConcatSql(dir);
      assert.deepEqual(out, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flags SELECT ... + concat', async () => {
    const dir = makeScratchDir();
    try {
      writeFileSync(
        join(dir, 'q.js'),
        "const q = 'SELECT * FROM users WHERE id = ' + userId;",
      );
      const out = await findStringConcatSql(dir);
      assert.equal(out.length, 1);
      assert.equal(out[0].pattern, 'select-+');
      assert.equal(out[0].line, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flags INSERT/UPDATE/DELETE concat variants', async () => {
    const dir = makeScratchDir();
    try {
      writeFileSync(
        join(dir, 'q.js'),
        [
          "const a = 'INSERT INTO t VALUES (' + id + ')';",
          "const b = 'UPDATE t SET x = ' + v + ' WHERE id = ' + id;",
          "const c = 'DELETE FROM t WHERE id = ' + id;",
        ].join('\n'),
      );
      const out = await findStringConcatSql(dir);
      assert.equal(out.length, 3);
      const patterns = out.map((r) => r.pattern).sort();
      assert.deepEqual(patterns, ['delete-+', 'insert-+', 'update-+']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('flags multiple matches across multiple files', async () => {
    const dir = makeScratchDir();
    try {
      writeFileSync(join(dir, 'a.js'), "const x = 'SELECT 1' + n;");
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'b.js'), "const y = 'UPDATE t SET x = ' + v;");
      const out = await findStringConcatSql(dir);
      assert.equal(out.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('excludes *.test.js (tests use fake SQL strings legitimately)', async () => {
    const dir = makeScratchDir();
    try {
      writeFileSync(join(dir, 'real.js'), "const x = 'SELECT 1' + n;");          // flagged
      writeFileSync(join(dir, 'real.test.js'), "const x = 'SELECT 1' + n;");      // NOT flagged
      const out = await findStringConcatSql(dir);
      assert.equal(out.length, 1);
      assert.match(out[0].file, /real\.js$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not throw on a binary file', async () => {
    const dir = makeScratchDir();
    try {
      const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x42, 0x0a, 0x00]);
      writeFileSync(join(dir, 'garbage.js'), binary);
      const out = await findStringConcatSql(dir);
      assert.deepEqual(out, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
