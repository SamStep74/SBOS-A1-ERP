// SBOS-A1-ERP permission-registry audit tests
//
// auditOrphanPermissions reports two complementary issue classes:
//   - orphan-permission-key:    declared in the catalog but never referenced
//                               by any production source file.
//   - unknown-permission-usage: referenced in production source but not in
//                               the catalog (typo, deleted perm, or phantom).
//
// The scanner is DI-shaped: callers pass a `permissions` map (or accept the
// default export from ./permissions.js), an explicit file list, and an
// injectable `readFile`. Tests below exercise the contract end-to-end with
// inline fixtures — no filesystem, no module side effects.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditOrphanPermissions,
  PERMISSION_REFERENCE_PATTERN,
} from './permissions-audit.js';

// ───────────────────────────────────────────────────────────────────────────
// helper: build a small synthetic source tree from a {path: text} map
// ───────────────────────────────────────────────────────────────────────────
function fixtureTree(files) {
  return {
    files: Object.keys(files),
    readFile: (p) => {
      if (!(p in files)) throw new Error(`fixture missing: ${p}`);
      return files[p];
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// happy path / contract shape
// ───────────────────────────────────────────────────────────────────────────

describe('auditOrphanPermissions — contract', () => {
  test('returns counts even when the catalog and usage match exactly', () => {
    const permissions = {
      'finance.coa.read': { sensitivity: 'low' },
      'security.role.read': { sensitivity: 'low' },
    };
    const tree = fixtureTree({
      '/fake/a.js': "requirePermFastify('finance.coa.read');",
      '/fake/b.js': "requirePermFastify('security.role.read');",
    });
    const result = auditOrphanPermissions({
      permissions,
      files: tree.files,
      readFile: tree.readFile,
    });
    assert.equal(result.issues.length, 0);
    assert.equal(result.catalogKeyCount, 2);
    assert.equal(result.referencedKeyCount, 2);
    assert.equal(result.orphanCount, 0);
    assert.equal(result.unknownUsageCount, 0);
  });

  test('exposes a stable exported regex pattern for downstream scanners', () => {
    // Tests pin the regex shape so refactors that break the call-site
    // detection (e.g. accidentally switching to a non-greedy match) are
    // caught immediately.
    assert.ok(PERMISSION_REFERENCE_PATTERN instanceof RegExp);
    assert.ok(PERMISSION_REFERENCE_PATTERN.flags.includes('g'));
    const sample = "requirePermFastify('finance.coa.read')";
    const matches = [...sample.matchAll(PERMISSION_REFERENCE_PATTERN)].map(
      (m) => m[1],
    );
    assert.deepEqual(matches, ['finance.coa.read']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// orphan-permission-key: defined in catalog, never referenced
// ───────────────────────────────────────────────────────────────────────────

describe('auditOrphanPermissions — orphan-permission-key', () => {
  test('flags a catalog key that no source file references', () => {
    const permissions = {
      'finance.coa.read': { sensitivity: 'low' },
      'finance.coa.delete': { sensitivity: 'critical' },
    };
    const tree = fixtureTree({
      '/fake/route.js': "requirePermFastify('finance.coa.read');",
    });
    const result = auditOrphanPermissions({
      permissions,
      files: tree.files,
      readFile: tree.readFile,
    });
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].type, 'orphan-permission-key');
    assert.equal(result.issues[0].key, 'finance.coa.delete');
    assert.equal(result.orphanCount, 1);
  });

  test('flags every orphan when source uses none of the catalog keys', () => {
    const permissions = {
      'a.b.c': {},
      'x.y.z': {},
      'one.two.three': {},
    };
    const tree = fixtureTree({
      '/fake/empty.js': "// no permission references here",
    });
    const result = auditOrphanPermissions({
      permissions,
      files: tree.files,
      readFile: tree.readFile,
    });
    assert.equal(result.issues.length, 3);
    const keys = result.issues.map((i) => i.key).sort();
    assert.deepEqual(keys, ['a.b.c', 'one.two.three', 'x.y.z']);
  });

  test('counts a key as used even when referenced by multiple call sites', () => {
    const permissions = {
      'shared.perm': {},
      'orphan.perm': {},
    };
    const tree = fixtureTree({
      '/fake/a.js': "requirePermFastify('shared.perm');",
      '/fake/b.js': "requirePermFastify('shared.perm');",
      '/fake/c.js': "requirePermFastify('shared.perm');",
    });
    const result = auditOrphanPermissions({
      permissions,
      files: tree.files,
      readFile: tree.readFile,
    });
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].key, 'orphan.perm');
    assert.equal(result.referencedKeyCount, 1);
  });

  test('skips test files so test fixtures do not "use" an orphan perm', () => {
    const permissions = {
      'production.perm': {},
      'test.only.perm': {},
    };
    const tree = fixtureTree({
      '/fake/route.js': "requirePermFastify('production.perm');",
      '/fake/route.test.js': "requirePermFastify('test.only.perm');",
    });
    const result = auditOrphanPermissions({
      permissions,
      files: tree.files,
      readFile: tree.readFile,
    });
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].type, 'orphan-permission-key');
    assert.equal(result.issues[0].key, 'test.only.perm');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// unknown-permission-usage: referenced, not in catalog
// ───────────────────────────────────────────────────────────────────────────

describe('auditOrphanPermissions — unknown-permission-usage', () => {
  test('flags a permission that is referenced but not declared in the catalog', () => {
    const permissions = {
      'finance.coa.read': {},
    };
    const tree = fixtureTree({
      '/fake/route.js': "requirePermFastify('finance.does.not.exist');",
    });
    const result = auditOrphanPermissions({
      permissions,
      files: tree.files,
      readFile: tree.readFile,
    });
    const unknown = result.issues.find(
      (i) => i.type === 'unknown-permission-usage',
    );
    assert.ok(unknown, 'expected one unknown-permission-usage issue');
    assert.equal(unknown.key, 'finance.does.not.exist');
    assert.equal(unknown.file, '/fake/route.js');
    assert.equal(typeof unknown.line, 'number');
    assert.equal(unknown.line, 1);
    assert.equal(result.unknownUsageCount, 1);
  });

  test('flags every typo on every call site independently', () => {
    const permissions = {
      'finance.coa.read': {},
    };
    const tree = fixtureTree({
      '/fake/route.js':
        "requirePermFastify('finance.coa.read');\n" +
        "requirePermFastify('finance.coa.raed');\n" +
        "requirePermFastify('finance.coa.raed');\n",
    });
    const result = auditOrphanPermissions({
      permissions,
      files: tree.files,
      readFile: tree.readFile,
    });
    const typos = result.issues.filter(
      (i) => i.type === 'unknown-permission-usage',
    );
    assert.equal(typos.length, 2);
    assert.deepEqual(
      typos.map((t) => t.line).sort((a, b) => a - b),
      [2, 3],
    );
  });

  test('returns BOTH orphan and unknown issues in one scan', () => {
    const permissions = {
      'in.catalog': {},
      'orphan.in.catalog': {},
    };
    const tree = fixtureTree({
      '/fake/route.js':
        "requirePermFastify('in.catalog');\n" +
        "requirePermFastify('phantom.unknown');\n",
    });
    const result = auditOrphanPermissions({
      permissions,
      files: tree.files,
      readFile: tree.readFile,
    });
    const types = result.issues.map((i) => i.type).sort();
    assert.deepEqual(types, [
      'orphan-permission-key',
      'unknown-permission-usage',
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// defensive: empty catalog, empty source, multiple call shapes
// ───────────────────────────────────────────────────────────────────────────

describe('auditOrphanPermissions — defensive', () => {
  test('empty catalog + empty source = zero issues', () => {
    const tree = fixtureTree({ '/fake/empty.js': '// nothing' });
    const result = auditOrphanPermissions({
      permissions: {},
      files: tree.files,
      readFile: tree.readFile,
    });
    assert.equal(result.issues.length, 0);
    assert.equal(result.catalogKeyCount, 0);
    assert.equal(result.referencedKeyCount, 0);
  });

  test('empty catalog + source has references = every ref is unknown', () => {
    const tree = fixtureTree({
      '/fake/route.js': "requirePermFastify('a.b.c');",
    });
    const result = auditOrphanPermissions({
      permissions: {},
      files: tree.files,
      readFile: tree.readFile,
    });
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].type, 'unknown-permission-usage');
    assert.equal(result.issues[0].key, 'a.b.c');
  });

  test('catalog with perms + source with no references = every perm is orphan', () => {
    const permissions = {
      'only.orphan.a': {},
      'only.orphan.b': {},
    };
    const tree = fixtureTree({
      '/fake/empty.js': "// no permission references here",
    });
    const result = auditOrphanPermissions({
      permissions,
      files: tree.files,
      readFile: tree.readFile,
    });
    assert.equal(result.issues.length, 2);
    assert.equal(result.unknownUsageCount, 0);
    assert.equal(result.orphanCount, 2);
  });

  test('does not match permission-shaped strings inside comments or string literals (stripJsComments contract)', () => {
    // Mirrors auditUnusedKeys stripJsComments behavior: a permission-shaped
    // string inside a comment must not be counted as a reference.
    const permissions = {
      'finance.coa.read': {},
    };
    const tree = fixtureTree({
      '/fake/route.js':
        "// TODO: wire requirePermFastify('finance.coa.read') later\n" +
        "/*\n" +
        " * Block comment: requirePermFastify('finance.coa.read')\n" +
        " */\n" +
        "requirePermFastify('finance.coa.read');\n",
    });
    const result = auditOrphanPermissions({
      permissions,
      files: tree.files,
      readFile: tree.readFile,
    });
    // The two commented references must be ignored; only the real call site
    // counts. Catalog key is therefore used, so 0 issues.
    assert.equal(result.issues.length, 0);
    assert.equal(result.referencedKeyCount, 1);
  });
});
