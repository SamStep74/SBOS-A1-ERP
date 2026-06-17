#!/usr/bin/env node
// scripts/check-coverage.mjs
//
// Coverage threshold gate. Runs the test suite with
// `node --test --experimental-test-coverage`, parses the "all files"
// row from the resulting coverage table, and exits non-zero when
// line/branch/func coverage drops below the configured thresholds.
//
// Thresholds default to 80% lines, 80% funcs, 70% branches (matches
// the iron law in common/testing.md). Override per-axis via env:
//   COVERAGE_THRESHOLD_LINES=85
//   COVERAGE_THRESHOLD_FUNCS=85
//   COVERAGE_THRESHOLD_BRANCHES=75
//
// Exits:
//   0 — coverage at or above threshold
//   1 — below threshold on at least one axis
//   2 — coverage table unparseable (drift in node's output format)
//   nonzero — test suite itself failed

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseAllFilesRow } from '../lib/parse-coverage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const THRESHOLDS = {
  lines: Number.parseInt(process.env.COVERAGE_THRESHOLD_LINES ?? '80', 10),
  branches: Number.parseInt(process.env.COVERAGE_THRESHOLD_BRANCHES ?? '70', 10),
  funcs: Number.parseInt(process.env.COVERAGE_THRESHOLD_FUNCS ?? '80', 10),
};

const args = [
  '--test',
  '--experimental-test-coverage',
  '--test-concurrency=4',
  '--test-timeout=60000',
];

const child = spawn(process.execPath, args, {
  cwd: repoRoot,
  stdio: ['inherit', 'pipe', 'pipe'],
});

// Node's coverage table prints to stdout (the test results and the
// "all files" summary share stdout; only test-level warnings/errors
// go to stderr). Buffer stdout for parsing, forward both streams
// verbatim so the user sees the live test output.
let stdoutBuf = '';
child.stdout.on('data', (b) => {
  const s = b.toString();
  stdoutBuf += s;
  process.stdout.write(b);
});
child.stderr.on('data', (b) => process.stderr.write(b));

child.on('exit', (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }
  const summary = parseAllFilesRow(stdoutBuf);
  if (!summary) {
    console.error('check-coverage: could not find "all files" row in coverage output');
    process.exit(2);
  }
  const failures = [];
  for (const [k, threshold] of Object.entries(THRESHOLDS)) {
    if (summary[k] < threshold) {
      failures.push(`${k} ${summary[k].toFixed(2)}% < ${threshold}%`);
    }
  }
  if (failures.length > 0) {
    console.error(`check-coverage: FAILED — ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(
    `check-coverage: ok (lines=${summary.lines.toFixed(2)}% branches=${summary.branches.toFixed(2)}% funcs=${summary.funcs.toFixed(2)}%)`,
  );
});
