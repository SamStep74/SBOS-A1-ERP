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
