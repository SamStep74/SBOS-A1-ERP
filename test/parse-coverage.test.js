import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllFilesRow } from '../lib/parse-coverage.mjs';

test('parseAllFilesRow: extracts line/branch/func percentages from a coverage table', () => {
  const sample = [
    'ℹ start of coverage report',
    'ℹ ----------------------------------------------------------',
    'ℹ file      | line % | branch % | funcs % | uncovered lines',
    'ℹ ----------------------------------------------------------',
    'ℹ all files |  92.50 |  80.00   |  88.00  |',
    'ℹ ----------------------------------------------------------',
    'ℹ end of coverage report',
  ].join('\n');
  const r = parseAllFilesRow(sample);
  assert.deepEqual(r, { lines: 92.5, branches: 80, funcs: 88 });
});

test('parseAllFilesRow: returns null when the "all files" row is missing', () => {
  const sample = [
    'ℹ start of coverage report',
    'ℹ file      | line % | branch % | funcs % | uncovered lines',
    'ℹ server/l10n-am/... | 100.00 | 100.00 | 100.00 |',
    'ℹ end of coverage report',
  ].join('\n');
  assert.equal(parseAllFilesRow(sample), null);
});

test('parseAllFilesRow: tolerates 100.00 / 0.00 boundary values', () => {
  const sample = 'all files | 100.00 |   0.00 | 100.00 |';
  const r = parseAllFilesRow(sample);
  assert.deepEqual(r, { lines: 100, branches: 0, funcs: 100 });
});

test('parseAllFilesRow: strips ANSI color codes between numbers and pipes', () => {
  // Real TTY-style output mixes the INFO prefix (ℹ ) with SGR escapes
  // (\x1b[32m, \x1b[34m) between columns. The parser must still find
  // the percentages.
  const sample = [
    'ℹ \x1b[32mall files\x1b[34m                           | \x1b[32m 92.21\x1b[34m | \x1b[33m   87.81\x1b[34m | \x1b[33m   86.58\x1b[34m |',
  ].join('\n');
  const r = parseAllFilesRow(sample);
  assert.deepEqual(r, { lines: 92.21, branches: 87.81, funcs: 86.58 });
});
