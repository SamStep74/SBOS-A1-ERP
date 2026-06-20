// Tests for the l10n-am audit scanner CLI.
//
// The CLI is structured as two pure functions (parseArgs + runAudit) plus
// a small `main()` wrapper that wires them to process.argv / process.exit.
// This means we can test the CLI without spawning a child process — pass
// synthetic argv arrays and a stub scan function.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    const capture = (s) => { stdout += s + '\n'; };
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
    assert.match(stdout, /5/);   // catalogKeyCount
    assert.match(stdout, /12/);  // tCallCount
  });

  test('dirty scan: exitCode 1, output lists issues', () => {
    let stdout = '';
    const capture = (s) => { stdout += s + '\n'; };
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
    const capture = (s) => { stdout += s + '\n'; };
    const fakeScan = () => ({
      issues: [],
      catalogKeyCount: 7,
      tCallCount: 9,
      usedKeyCount: 7,
      unusedKeyCount: 0,
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
  });

  test('--quiet: nothing is written to stdout, but exitCode is still correct', () => {
    let stdout = '';
    const capture = (s) => { stdout += s + '\n'; };
    const cleanScan = () => ({
      issues: [], catalogKeyCount: 1, tCallCount: 1, usedKeyCount: 1, unusedKeyCount: 0,
    });
    const dirtyScan = () => ({
      issues: [{ type: 'catalog-unused-key', key: 'x' }],
      catalogKeyCount: 1, tCallCount: 0, usedKeyCount: 0, unusedKeyCount: 1,
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
    const capture = (s) => { stdout += s + '\n'; };
    let scanCalled = false;
    const fakeScan = () => { scanCalled = true; return { issues: [] }; };
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
    const capture = (s) => { stdout += s + '\n'; };
    let scanCalled = false;
    const fakeScan = () => { scanCalled = true; return { issues: [] }; };
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
  test('node server/l10n-am/audit-cli.js exits 0 and reports no issues', () => {
    const cliPath = join(PROJECT_ROOT, 'server', 'l10n-am', 'audit-cli.js');
    const result = spawnSync('node', [cliPath], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0,
      `audit-cli should exit 0 on a clean repo.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /no issues/i);
  });

  test('node server/l10n-am/audit-cli.js --quiet exits 0 with no output', () => {
    const cliPath = join(PROJECT_ROOT, 'server', 'l10n-am', 'audit-cli.js');
    const result = spawnSync('node', [cliPath, '--quiet'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0,
      `audit-cli --quiet should exit 0 on a clean repo.\nstderr: ${result.stderr}`);
    assert.equal(result.stdout, '',
      `audit-cli --quiet should suppress stdout, got: ${JSON.stringify(result.stdout)}`);
  });

  test('node server/l10n-am/audit-cli.js --format json emits valid JSON', () => {
    const cliPath = join(PROJECT_ROOT, 'server', 'l10n-am', 'audit-cli.js');
    const result = spawnSync('node', [cliPath, '--format', 'json'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0,
      `audit-cli --format json should exit 0 on a clean repo.\nstderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.issues, []);
    assert.ok(parsed.catalogKeyCount > 0);
    assert.ok(parsed.tCallCount > 0);
    assert.equal(parsed.unusedKeyCount, 0);
  });
});

// ---- new flags: --check-rates / --check-eval / --check-sql -----------------
//
// The CLI gets three new independent flags. The default behavior (no new
// flag) is unchanged. With one or more flags, the legacy auditAll is NOT
// called; only the requested check(s) run. `--format json` switches to the
// new {rates, eval, sql, ok} shape when at least one new flag is active.

describe('parseArgs — new flags', () => {
  test('--check-rates is recognised and recorded', () => {
    const a = parseArgs(['--check-rates']);
    assert.equal(a.checkRates, true);
    assert.equal(a.checkEval, false);
    assert.equal(a.checkSql, false);
    assert.deepEqual(a.errors, []);
  });

  test('--check-eval is recognised and recorded', () => {
    const a = parseArgs(['--check-eval']);
    assert.equal(a.checkEval, true);
    assert.equal(a.checkRates, false);
    assert.equal(a.checkSql, false);
  });

  test('--check-sql is recognised and recorded', () => {
    const a = parseArgs(['--check-sql']);
    assert.equal(a.checkSql, true);
    assert.equal(a.checkRates, false);
    assert.equal(a.checkEval, false);
  });

  test('all three check flags can be combined', () => {
    const a = parseArgs(['--check-rates', '--check-eval', '--check-sql']);
    assert.equal(a.checkRates, true);
    assert.equal(a.checkEval, true);
    assert.equal(a.checkSql, true);
  });
});

// runExtraChecks is the async handler for the new flags. We import it via
// a dynamic lookup so the test file still loads when the symbol does not
// yet exist (RED state). When the symbol is missing, we mark every extra
// check test as a "tombstone" that fails with a precise message.
import * as auditCli from './audit-cli.js';
const runExtraChecks = auditCli.runExtraChecks;

describe('runExtraChecks — --check-rates', () => {
  test('clean scratch dir: exitCode 0, no matches', async () => {
    if (typeof runExtraChecks !== 'function') {
      throw new Error('runExtraChecks is not exported by audit-cli.js');
    }
    const dir = mkdtempSync(join(tmpdir(), 'audit-cli-rates-clean-'));
    try {
      let stdout = '';
      const capture = (s) => { stdout += s + '\n'; };
      const out = await runExtraChecks({
        args: parseArgs(['--check-rates']),
        rootDir: dir,
        stdout: capture,
        stderr: capture,
      });
      assert.equal(out.exitCode, 0,
        `clean scratch dir should have exitCode 0; got ${out.exitCode} stdout=${stdout}`);
      assert.ok(Array.isArray(out.rates));
      assert.equal(out.rates.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with a synthetic rate fixture: exitCode 1 and stdout shows the match', async () => {
    if (typeof runExtraChecks !== 'function') {
      throw new Error('runExtraChecks is not exported by audit-cli.js');
    }
    // Build a tiny scratch dir with one .js file containing a rate literal.
    const dir = mkdtempSync(join(tmpdir(), 'audit-cli-rates-'));
    try {
      writeFileSync(
        join(dir, 'fixture.js'),
        "export const STAMP_RATE = 0.05;",
      );
      let stdout = '';
      const capture = (s) => { stdout += s + '\n'; };
      const out = await runExtraChecks({
        args: parseArgs(['--check-rates']),
        rootDir: dir,
        stdout: capture,
        stderr: capture,
      });
      assert.equal(out.exitCode, 1,
        `expected exitCode 1 when a rate is present, got ${out.exitCode}`);
      assert.equal(out.rates.length, 1);
      assert.match(stdout, /fixture\.js/);
      assert.match(stdout, /0\.05/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runExtraChecks — --check-eval', () => {
  test('clean scratch dir: exitCode 0, no matches', async () => {
    if (typeof runExtraChecks !== 'function') {
      throw new Error('runExtraChecks is not exported by audit-cli.js');
    }
    const dir = mkdtempSync(join(tmpdir(), 'audit-cli-eval-clean-'));
    try {
      let stdout = '';
      const capture = (s) => { stdout += s + '\n'; };
      const out = await runExtraChecks({
        args: parseArgs(['--check-eval']),
        rootDir: dir,
        stdout: capture,
        stderr: capture,
      });
      assert.equal(out.exitCode, 0,
        `clean scratch dir should exit 0; got ${out.exitCode} stdout=${stdout}`);
      assert.ok(Array.isArray(out.eval));
      assert.equal(out.eval.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with a synthetic eval fixture: exitCode 1 and stdout shows eval-call', async () => {
    if (typeof runExtraChecks !== 'function') {
      throw new Error('runExtraChecks is not exported by audit-cli.js');
    }
    const dir = mkdtempSync(join(tmpdir(), 'audit-cli-eval-'));
    try {
      writeFileSync(join(dir, 'fixture.js'), "const r = eval('1+1');");
      let stdout = '';
      const capture = (s) => { stdout += s + '\n'; };
      const out = await runExtraChecks({
        args: parseArgs(['--check-eval']),
        rootDir: dir,
        stdout: capture,
        stderr: capture,
      });
      assert.equal(out.exitCode, 1);
      assert.equal(out.eval.length, 1);
      assert.equal(out.eval[0].kind, 'eval-call');
      assert.match(stdout, /fixture\.js/);
      assert.match(stdout, /eval-call/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runExtraChecks — --check-sql', () => {
  test('clean scratch dir: exitCode 0, no matches', async () => {
    if (typeof runExtraChecks !== 'function') {
      throw new Error('runExtraChecks is not exported by audit-cli.js');
    }
    const dir = mkdtempSync(join(tmpdir(), 'audit-cli-sql-clean-'));
    try {
      let stdout = '';
      const capture = (s) => { stdout += s + '\n'; };
      const out = await runExtraChecks({
        args: parseArgs(['--check-sql']),
        rootDir: dir,
        stdout: capture,
        stderr: capture,
      });
      assert.equal(out.exitCode, 0,
        `clean scratch dir should exit 0; got ${out.exitCode} stdout=${stdout}`);
      assert.ok(Array.isArray(out.sql));
      assert.equal(out.sql.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with a synthetic SQL fixture: exitCode 1 and stdout shows select-+', async () => {
    if (typeof runExtraChecks !== 'function') {
      throw new Error('runExtraChecks is not exported by audit-cli.js');
    }
    const dir = mkdtempSync(join(tmpdir(), 'audit-cli-sql-'));
    try {
      writeFileSync(join(dir, 'fixture.js'), "const q = 'SELECT * FROM t WHERE id=' + id;");
      let stdout = '';
      const capture = (s) => { stdout += s + '\n'; };
      const out = await runExtraChecks({
        args: parseArgs(['--check-sql']),
        rootDir: dir,
        stdout: capture,
        stderr: capture,
      });
      assert.equal(out.exitCode, 1);
      assert.equal(out.sql.length, 1);
      assert.equal(out.sql[0].pattern, 'select-+');
      assert.match(stdout, /fixture\.js/);
      assert.match(stdout, /select-\+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runExtraChecks — --format json', () => {
  test('emits {rates, eval, sql, ok} shape when any new flag is active', async () => {
    if (typeof runExtraChecks !== 'function') {
      throw new Error('runExtraChecks is not exported by audit-cli.js');
    }
    const dir = mkdtempSync(join(tmpdir(), 'audit-cli-json-'));
    try {
      writeFileSync(join(dir, 'clean.js'), "const x = 1; // no rates here");
      let stdout = '';
      const capture = (s) => { stdout += s + '\n'; };
      await runExtraChecks({
        args: parseArgs(['--check-rates', '--format', 'json']),
        rootDir: dir,
        stdout: capture,
        stderr: capture,
      });
      const parsed = JSON.parse(stdout.trim());
      assert.ok(Array.isArray(parsed.rates), 'parsed.rates must be an array');
      assert.ok(Array.isArray(parsed.eval), 'parsed.eval must be an array');
      assert.ok(Array.isArray(parsed.sql), 'parsed.sql must be an array');
      assert.equal(typeof parsed.ok, 'boolean');
      assert.equal(parsed.ok,
        parsed.rates.length === 0 && parsed.eval.length === 0 && parsed.sql.length === 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runExtraChecks — --quiet', () => {
  test('suppresses per-match output but preserves exitCode', async () => {
    if (typeof runExtraChecks !== 'function') {
      throw new Error('runExtraChecks is not exported by audit-cli.js');
    }
    const dir = mkdtempSync(join(tmpdir(), 'audit-cli-quiet-'));
    try {
      writeFileSync(join(dir, 'fixture.js'), "const rate = 0.20;");
      let stdout = '';
      const capture = (s) => { stdout += s + '\n'; };
      const out = await runExtraChecks({
        args: parseArgs(['--check-rates', '--quiet']),
        rootDir: dir,
        stdout: capture,
        stderr: capture,
      });
      assert.equal(stdout, '', `--quiet should suppress stdout, got: ${JSON.stringify(stdout)}`);
      assert.equal(out.exitCode, 1, '--quiet must still set exitCode 1 on a hit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
