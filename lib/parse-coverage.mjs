// Coverage table parser for `node --test --experimental-test-coverage`.
//
// The runner emits a table on stderr like:
//   ℹ start of coverage report
//   ℹ ----------------------------------------------------------
//   ℹ file      | line % | branch % | funcs % | uncovered lines
//   ℹ ----------------------------------------------------------
//   ℹ all files |  92.50 |  80.00   |  88.00  |
//   ℹ ----------------------------------------------------------
//   ℹ end of coverage report
//
// `parseAllFilesRow` returns the "all files" row as numbers, or null if
// the row is missing (e.g. coverage disabled or output format drift).

/**
 * @param {string} text  raw coverage output (typically the captured stderr)
 * @returns {{ lines: number, branches: number, funcs: number } | null}
 */
export function parseAllFilesRow(text) {
  // Node colors the coverage table on TTYs (ℹ  + ANSI SGR sequences
  // between numbers and pipes). Strip ANSI before matching so the
  // percentage/pipe geometry is plain.
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  // The "all files" row is prefixed by node's INFO char ("ℹ ") on
  // newer node versions; older versions emit it bare. Match anything
  // before "all files" on the same line, then the three percentages.
  const m = clean.match(/^[^\n]*?all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/m);
  if (!m) return null;
  return {
    lines: Number.parseFloat(m[1]),
    branches: Number.parseFloat(m[2]),
    funcs: Number.parseFloat(m[3]),
  };
}
