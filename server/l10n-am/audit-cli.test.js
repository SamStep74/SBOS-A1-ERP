// Tests for the l10n-am audit scanner CLI.
//
// The CLI is structured as two pure functions (parseArgs + runAudit) plus
// a small `main()` wrapper that wires them to process.argv / process.exit.
// This means we can test the CLI without spawning a child process — pass
// synthetic argv arrays and a stub scan function.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, runAudit } from './audit-cli.js';

// Resolve the project root from this test file's location so the live-repo
// regression below spawns audit-cli.js from the same cwd CI would use.
const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe('parseArgs', () => {
  test('empty argv returns defaults', () => {
    const a = parseArgs([]);
    assert.equal(a.root, undefined);
    assert.equal(a.format, 'text');
    assert.equal(a.quiet, false);
    assert.equal(a.help, false);
    assert.deepEqual(a.errors, []);
  });

  test('--root sets the audit root', () => {
    const a = parseArgs(['--root', '/tmp/somewhere']);
    assert.equal(a.root, '/tmp/somewhere');
    assert.deepEqual(a.errors, []);
  });

  test('--format json switches to JSON output', () => {
    const a = parseArgs(['--format', 'json']);
    assert.equal(a.format, 'json');
  });

  test('--format text is the explicit default', () => {
    const a = parseArgs(['--format', 'text']);
    assert.equal(a.format, 'text');
  });

  test('--quiet suppresses output but is otherwise inert', () => {
    const a = parseArgs(['--quiet']);
    assert.equal(a.quiet, true);
  });

  test('--help sets the help flag', () => {
    const a = parseArgs(['--help']);
    assert.equal(a.help, true);
  });

  test('-h is an alias for --help', () => {
    const a = parseArgs(['-h']);
    assert.equal(a.help, true);
  });

  test('an unknown flag is recorded as an error', () => {
    const a = parseArgs(['--frobnicate']);
    assert.equal(a.errors.length, 1);
    assert.match(a.errors[0], /frobnicate/);
  });

  test('multiple flags can be combined in any order', () => {
    const a = parseArgs(['--quiet', '--root', '/x', '--format', 'json']);
    assert.equal(a.quiet, true);
    assert.equal(a.root, '/x');
    assert.equal(a.format, 'json');
  });
});

describe('runAudit', () => {
  test('clean scan: exitCode 0, human output says no issues', () => {
    let stdout = '';
    const capture = (s) => {
      stdout += s + '\n';
    };
    const fakeScan = () => ({
      issues: [],
      catalogKeyCount: 5,
      tCallCount: 12,
      usedKeyCount: 5,
      unusedKeyCount: 0,
    });
    const out = runAudit({
      args: parseArgs([]),
      scan: fakeScan,
      stdout: capture,
      stderr: capture,
    });
    assert.equal(out.exitCode, 0);
    assert.match(stdout, /no issues/i);
    assert.match(stdout, /5/); // catalogKeyCount
    assert.match(stdout, /12/); // tCallCount
  });

  test('dirty scan: exitCode 1, output lists issues', () => {
    let stdout = '';
    const capture = (s) => {
      stdout += s + '\n';
    };
    const fakeScan = () => ({
      issues: [
        { type: 'catalog-missing-locale', key: 'foo.bar', missingLocales: ['en'] },
        { type: 'catalog-unused-key', key: 'baz.qux' },
      ],
      catalogKeyCount: 3,
      tCallCount: 4,
      usedKeyCount: 2,
      unusedKeyCount: 1,
    });
    const out = runAudit({
      args: parseArgs([]),
      scan: fakeScan,
      stdout: capture,
      stderr: capture,
    });
    assert.equal(out.exitCode, 1);
    assert.match(stdout, /catalog-missing-locale/);
    assert.match(stdout, /foo\.bar/);
    assert.match(stdout, /catalog-unused-key/);
    assert.match(stdout, /baz\.qux/);
  });

  test('--format json: emits the scan result as JSON to stdout', () => {
    let stdout = '';
    const capture = (s) => {
      stdout += s + '\n';
    };
    const fakeScan = () => ({
      issues: [],
      catalogKeyCount: 7,
      tCallCount: 9,
      usedKeyCount: 7,
      unusedKeyCount: 0,
      rbacCatalogKeyCount: 3,
      rbacReferencedKeyCount: 3,
      rbacOrphanCount: 0,
      rbacUnknownUsageCount: 0,
    });
    runAudit({
      args: parseArgs(['--format', 'json']),
      scan: fakeScan,
      stdout: capture,
      stderr: capture,
    });
    // The output should be valid JSON, parseable as the scan result
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.catalogKeyCount, 7);
    assert.equal(parsed.tCallCount, 9);
    assert.deepEqual(parsed.issues, []);
    // Rbac fields are surfaced through the combined report envelope.
    assert.equal(parsed.rbacCatalogKeyCount, 3);
    assert.equal(parsed.rbacReferencedKeyCount, 3);
    assert.equal(parsed.rbacOrphanCount, 0);
    assert.equal(parsed.rbacUnknownUsageCount, 0);
  });

  test('clean rbac scan: text output mentions the rbac permissions audit section', () => {
    // No orphan keys and no unknown usages — the rbac section is rendered
    // with both counts at zero and lists no issues.
    let stdout = '';
    const capture = (s) => {
      stdout += s + '\n';
    };
    const fakeScan = () => ({
      issues: [],
      catalogKeyCount: 1,
      tCallCount: 1,
      usedKeyCount: 1,
      unusedKeyCount: 0,
      rbacCatalogKeyCount: 4,
      rbacReferencedKeyCount: 4,
      rbacOrphanCount: 0,
      rbacUnknownUsageCount: 0,
    });
    const out = runAudit({
      args: parseArgs([]),
      scan: fakeScan,
      stdout: capture,
      stderr: capture,
    });
    assert.equal(out.exitCode, 0);
    assert.match(
      stdout,
      /rbac permissions audit/i,
      'text output should mention the rbac permissions audit section',
    );
    assert.match(stdout, /4/, 'should show the rbac catalog key count');
  });

  test('dirty rbac scan: text output lists orphan-permission-key issues', () => {
    // One orphan catalog key + one unknown usage — exit 1, both surfaced.
    let stdout = '';
    const capture = (s) => {
      stdout += s + '\n';
    };
    const fakeScan = () => ({
      issues: [
        { type: 'orphan-permission-key', key: 'finance.orphan' },
        { type: 'unknown-permission-usage', key: 'typo.perm', file: '/x/routes.js', line: 42 },
      ],
      catalogKeyCount: 0,
      tCallCount: 0,
      usedKeyCount: 0,
      unusedKeyCount: 0,
      rbacCatalogKeyCount: 1,
      rbacReferencedKeyCount: 0,
      rbacOrphanCount: 1,
      rbacUnknownUsageCount: 1,
    });
    const out = runAudit({
      args: parseArgs([]),
      scan: fakeScan,
      stdout: capture,
      stderr: capture,
    });
    assert.equal(out.exitCode, 1);
    assert.match(stdout, /orphan-permission-key/);
    assert.match(stdout, /finance\.orphan/);
    assert.match(stdout, /unknown-permission-usage/);
    assert.match(stdout, /typo\.perm/);
    assert.match(stdout, /\/x\/routes\.js/);
  });

  test('--quiet: nothing is written to stdout, but exitCode is still correct', () => {
    let stdout = '';
    const capture = (s) => {
      stdout += s + '\n';
    };
    const cleanScan = () => ({
      issues: [],
      catalogKeyCount: 1,
      tCallCount: 1,
      usedKeyCount: 1,
      unusedKeyCount: 0,
    });
    const dirtyScan = () => ({
      issues: [{ type: 'catalog-unused-key', key: 'x' }],
      catalogKeyCount: 1,
      tCallCount: 0,
      usedKeyCount: 0,
      unusedKeyCount: 1,
    });
    const clean = runAudit({
      args: parseArgs(['--quiet']),
      scan: cleanScan,
      stdout: capture,
      stderr: capture,
    });
    assert.equal(stdout, '');
    assert.equal(clean.exitCode, 0);
    const dirty = runAudit({
      args: parseArgs(['--quiet']),
      scan: dirtyScan,
      stdout: capture,
      stderr: capture,
    });
    assert.equal(stdout, '');
    assert.equal(dirty.exitCode, 1);
  });

  test('--help: prints usage, does not run the scanner, exits 0', () => {
    let stdout = '';
    const capture = (s) => {
      stdout += s + '\n';
    };
    let scanCalled = false;
    const fakeScan = () => {
      scanCalled = true;
      return { issues: [] };
    };
    const out = runAudit({
      args: parseArgs(['--help']),
      scan: fakeScan,
      stdout: capture,
      stderr: capture,
    });
    assert.equal(scanCalled, false);
    assert.equal(out.exitCode, 0);
    assert.match(stdout, /usage/i);
  });

  test('parse errors: exitCode 1, scanner is not called', () => {
    let stdout = '';
    const capture = (s) => {
      stdout += s + '\n';
    };
    let scanCalled = false;
    const fakeScan = () => {
      scanCalled = true;
      return { issues: [] };
    };
    const out = runAudit({
      args: parseArgs(['--bogus']),
      scan: fakeScan,
      stdout: capture,
      stderr: capture,
    });
    assert.equal(scanCalled, false);
    assert.equal(out.exitCode, 1);
    assert.match(stdout, /bogus/);
  });
});

describe('audit-cli.js — live l10n-am regression (child process)', () => {
  // Spawn the actual `node server/l10n-am/audit-cli.js` entry point against
  // the project's real source tree. This is the same command the GitHub
  // Actions CI step will run, so any drift between the synthetic-scan
  // tests above and the real CLI behavior is caught here.
  //
  // The live repo's i18n side is balanced and clean (every key in every
  // locale, every t() resolves, every key used). The rbac side has real
  // orphan keys (the audit correctly surfaces them) and is expected to
  // exit 1 — the rbac wire-in is doing its job. These tests verify the
  // wire-in surfaces correctly to both text and JSON output without
  // asserting the live catalog is clean (synthetic tests do that).

  test('node server/l10n-am/audit-cli.js exits 1 because rbac orphans are real drift', () => {
    const cliPath = join(PROJECT_ROOT, 'server', 'l10n-am', 'audit-cli.js');
    const result = spawnSync('node', [cliPath], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    // Exit 1 is the correct behavior: the rbac sub-scanner is wired in
    // and the live catalog has real orphan keys. The wire-in doing its
    // job is what we want to lock in here, not pinning the repo clean.
    assert.equal(
      result.status,
      1,
      `audit-cli should exit 1 when rbac orphans are present.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    // The text output should still render the l10n-am audit header.
    assert.match(result.stdout, /l10n-am audit/);
    // And the rbac section should be present and populated.
    assert.match(result.stdout, /rbac permissions audit/i);
    assert.match(
      result.stdout,
      /orphan keys:\s*[1-9]/,
      'live-repo text output should show a positive orphan count, proving the wire-in fires against the real tree',
    );
  });

  test('node server/l10n-am/audit-cli.js --quiet exits 1 with no output', () => {
    const cliPath = join(PROJECT_ROOT, 'server', 'l10n-am', 'audit-cli.js');
    const result = spawnSync('node', [cliPath, '--quiet'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(
      result.status,
      1,
      `audit-cli --quiet should exit 1 when rbac orphans are present.\nstderr: ${result.stderr}`,
    );
    assert.equal(
      result.stdout,
      '',
      `audit-cli --quiet should suppress stdout, got: ${JSON.stringify(result.stdout)}`,
    );
  });

  test('node server/l10n-am/audit-cli.js --format json emits valid JSON with rbac fields', () => {
    const cliPath = join(PROJECT_ROOT, 'server', 'l10n-am', 'audit-cli.js');
    const result = spawnSync('node', [cliPath, '--format', 'json'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(
      result.status,
      1,
      `audit-cli --format json should exit 1 when rbac orphans are present.\nstderr: ${result.stderr}`,
    );
    const parsed = JSON.parse(result.stdout);
    // i18n side is clean at HEAD: zero non-rbac issues and zero unused keys.
    const nonRbac = parsed.issues.filter(
      (i) => i.type !== 'orphan-permission-key' && i.type !== 'unknown-permission-usage',
    );
    assert.deepEqual(
      nonRbac,
      [],
      `live i18n should have no non-rbac issues but found: ${JSON.stringify(nonRbac, null, 2)}`,
    );
    assert.ok(parsed.catalogKeyCount > 0);
    assert.ok(parsed.tCallCount > 0);
    assert.equal(parsed.unusedKeyCount, 0);
    // Rbac fields are present on the live-repo JSON output (the wire-in
    // contract) with a positive orphan count proving the sub-scanner ran
    // against the real tree.
    assert.equal(typeof parsed.rbacCatalogKeyCount, 'number');
    assert.equal(typeof parsed.rbacReferencedKeyCount, 'number');
    assert.ok(
      parsed.rbacOrphanCount > 0,
      'live rbac catalog should report at least one orphan — proves wire-in fires against the real tree',
    );
    // Unknown usages are a separate concern and may or may not exist; we
    // just verify the field is shaped correctly.
    assert.equal(typeof parsed.rbacUnknownUsageCount, 'number');
  });

  test('node server/l10n-am/audit-cli.js text output renders the rbac section', () => {
    const cliPath = join(PROJECT_ROOT, 'server', 'l10n-am', 'audit-cli.js');
    const result = spawnSync('node', [cliPath], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(
      result.status,
      1,
      `audit-cli should exit 1 when rbac orphans are present.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.match(
      result.stdout,
      /rbac permissions audit/i,
      'live-repo text output should include the rbac permissions audit section',
    );
    assert.match(
      result.stdout,
      /orphan keys:\s*[1-9]/,
      'live-repo text output should show a positive orphan count',
    );
  });
});
