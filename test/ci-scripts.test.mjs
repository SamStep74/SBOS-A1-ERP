// Smoke tests for the CI scripts added in the ci-hardening wave.
//
// The point of these tests is NOT to validate the lint rules, the
// boundary check, or the typecheck wrapper in detail (each of those
// has its own dedicated test surface and is exercised by the script
// itself in CI). The point is to catch the meta-failure mode: "a
// script in the canonical `npm run check` chain was silently broken
// (typo in package.json, missing file, broken shebang) and the chain
// still returned 0 in a way that nobody noticed."
//
// Each test runs the script in dry-run mode (where one exists) or
// with a no-op input, asserts exit code 0, and verifies the
// single-line TAP-friendly summary the script is expected to print.
// Keeping the assertions narrow means a real regression (e.g. a new
// forbidden brand identifier) still bubbles up to `npm run check`
// first; this file only catches "the script can't even start."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function runScript(args, { env = {}, cwd = repoRoot } = {}) {
  return spawnSync('node', args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function runNpmScript(scriptName, extraArgs = []) {
  return spawnSync('npm', ['run', scriptName, '--silent', ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 180_000,
  });
}

test('smoke: boundary check exits 0 and prints the TAP summary', () => {
  // `node scripts/check-open-core-boundary-contract.mjs` is the
  // canonical boundary check. The contract is "report-only" by
  // design — the script never modifies files — so this invocation
  // is itself the dry-run path.
  const result = runScript(['scripts/check-open-core-boundary-contract.mjs']);
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.match(result.stdout, /failing_checks=0/);
});

test('smoke: typecheck stub exits 0 with a one-line skip on a JS-only repo', () => {
  // The repo is currently JS-only; the wrapper prints a skip line and
  // exits 0. If a `.ts` file ever lands, the wrapper shells out to
  // `tsc --noEmit` and this smoke test will start to exercise the
  // real typecheck path.
  const result = runScript(['scripts/typecheck-if-typescript.mjs']);
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  assert.match(result.stdout, /No TypeScript source files found; skipping tsc\./);
});

test('smoke: eslint . --fix-dry-run exits 0 (the dry-run mode of `npm run lint:fix`)', () => {
  // ESLint 9's `--fix-dry-run` runs the auto-fix pipeline without
  // writing any changes — this is the canonical "lint:fix" dry-run
  // mode. A green exit proves the lint config is loadable AND no
  // auto-fixable rule is currently in violation; a yellow exit means
  // there's a fixable issue, and a red exit means a real lint error.
  const eslintBin = resolve(repoRoot, 'node_modules/eslint/bin/eslint.js');
  const result = runScript([eslintBin, '.', '--fix-dry-run']);
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
});

test('smoke: `npm run check` exits 0 in a clean repo (the canonical CI chain)', () => {
  // This is the all-in-one chain the workflow's `All-in-one check`
  // step invokes. Asserting it here means: if any of lint /
  // typecheck / test / boundary-check is broken in a way that would
  // have been invisible to a per-step view, the smoke test catches
  // it before the workflow even has a chance to run.
  const result = runNpmScript('check');
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  // The boundary check prints the summary line last; its presence in
  // the captured stdout proves the chain reached the final step.
  assert.match(result.stdout, /failing_checks=0/);
});

test('smoke: `npm run boundary-check` script is wired in package.json', () => {
  // Regression guard for the case where someone deletes the
  // `boundary-check` script from package.json but the workflow
  // still calls it. The chain test above would also fail, but
  // this test gives a clearer failure message.
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['boundary-check'],
    'node scripts/check-open-core-boundary-contract.mjs',
    'package.json `boundary-check` script must delegate to the boundary check script verbatim',
  );
  assert.match(
    pkg.scripts['check'] ?? '',
    /lint.*typecheck.*test.*boundary-check/,
    'package.json `check` script must chain lint, typecheck, test, and boundary-check',
  );
  assert.equal(pkg.scripts['lint:fix'], 'eslint . --fix');
});
