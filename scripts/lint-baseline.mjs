#!/usr/bin/env node
// Lint baseline — capture pre-existing lint errors and gate NEW violations.
//
// Why: when a multi-worker integration merges branches that were each
// clean in isolation, the merged tree often surfaces lint warnings from
// workers that haven't yet swept their code (unused imports, console.log
// in boot scripts, etc.). A strict `npm run lint` on the merged tree
// fails red, even though no single PR introduced the failures. The
// baseline mechanism captures the CURRENT set of lint findings into
// `.lint-baseline.json` and lets `lint:check-new` fail only on
// violations NOT already in the baseline.
//
// Usage:
//   node scripts/lint-baseline.mjs create    # write .lint-baseline.json
//   node scripts/lint-baseline.mjs check     # fail only on NEW violations
//   node scripts/lint-baseline.mjs check --dry-run
//                                            # report what would fail, exit 0
//   node scripts/lint-baseline.mjs show      # print the baseline summary
//
// The baseline is a JSON array of {filePath, message: {ruleId, line, column, message}}
// records — one per (file, lint message) tuple. A "new violation" is one
// where (filePath, ruleId, line, column) is not in the baseline. We do
// NOT compare message text — lint messages include byte offsets and can
// drift across edits without indicating a real regression.
//
// This script exits 0 in `--dry-run` mode so the smoke tests under
// `test/ci-scripts.test.mjs` can pin "the script can start and report"
// without coupling to the current lint state of the tree.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineFile = path.join(repoRoot, '.lint-baseline.json');

const subcommand = process.argv[2] ?? 'check';
const isDryRun = process.argv.includes('--dry-run');

function runEslintJson() {
  // We use the local eslint binary so the same config and version are
  // used as in `npm run lint`. `--format json` is the canonical machine-
  // readable form; `--no-error-on-unmatched-pattern` so missing
  // test/ignore globs don't fail the JSON parse path.
  const eslintBin = path.join(repoRoot, 'node_modules/eslint/bin/eslint.js');
  const result = spawnSync(
    process.execPath,
    [eslintBin, '.', '--format', 'json', '--no-error-on-unmatched-pattern'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  // eslint exits 0 on clean, 1 on lint errors, 2 on config errors.
  // We want JSON for both exit 0 and exit 1; only exit 2 is fatal here.
  if (result.status === 2) {
    console.error(`eslint config error:\n${result.stderr || result.stdout}`);
    process.exit(2);
  }
  if (!result.stdout.trim()) return [];
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    console.error(`failed to parse eslint JSON output: ${err.message}`);
    process.exit(2);
  }
}

function normalize(results) {
  // Flatten the per-file results into a list of stable tuples. We
  // intentionally drop the message text and only keep the location +
  // rule id so the baseline survives message-text reflows.
  const flat = [];
  for (const fileResult of results) {
    for (const msg of fileResult.messages ?? []) {
      flat.push({
        filePath: fileResult.filePath,
        ruleId: msg.ruleId ?? '<no-rule>',
        line: msg.line ?? 0,
        column: msg.column ?? 0,
        // severity is 1 (warn) or 2 (error). We baseline both so a
        // future `--max-warnings 0` policy change is a one-line update,
        // not a baseline re-capture.
        severity: msg.severity ?? 1,
      });
    }
  }
  // Sort for deterministic baseline files (matters for diff readability
  // when the baseline is updated).
  flat.sort((a, b) =>
    a.filePath.localeCompare(b.filePath) ||
    a.line - b.line ||
    a.column - b.column ||
    String(a.ruleId).localeCompare(String(b.ruleId)),
  );
  return flat;
}

function loadBaseline() {
  if (!existsSync(baselineFile)) return null;
  try {
    return JSON.parse(readFileSync(baselineFile, 'utf8'));
  } catch (err) {
    console.error(`failed to parse ${baselineFile}: ${err.message}`);
    process.exit(2);
  }
}

function tupleKey(t) {
  return `${t.filePath}::${t.ruleId}::${t.line}::${t.column}`;
}

function diffNew(baseline, current) {
  const baselineKeys = new Set(baseline.map(tupleKey));
  return current.filter((t) => !baselineKeys.has(tupleKey(t)));
}

function summarize(label, records) {
  console.log(`${label}=${records.length}`);
  if (records.length === 0) return;
  // Group by ruleId for the summary so the developer can see at a
  // glance which rules are firing. We cap the per-group listing at 5
  // to keep the output grep-friendly.
  const byRule = new Map();
  for (const t of records) {
    if (!byRule.has(t.ruleId)) byRule.set(t.ruleId, []);
    byRule.get(t.ruleId).push(t);
  }
  const groups = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [ruleId, items] of groups.slice(0, 10)) {
    console.log(`  ${ruleId}: ${items.length}`);
    for (const t of items.slice(0, 5)) {
      console.log(`    ${path.relative(repoRoot, t.filePath)}:${t.line}:${t.column}`);
    }
  }
}

if (subcommand === 'create') {
  const results = runEslintJson();
  const normalized = normalize(results);
  writeFileSync(baselineFile, JSON.stringify(normalized, null, 2) + '\n');
  console.log(`baseline_file=${path.relative(repoRoot, baselineFile)}`);
  summarize('baseline_records', normalized);
  process.exit(0);
}

if (subcommand === 'show') {
  const baseline = loadBaseline();
  if (baseline === null) {
    console.log(`no baseline file at ${path.relative(repoRoot, baselineFile)}`);
    process.exit(0);
  }
  summarize('baseline_records', baseline);
  process.exit(0);
}

if (subcommand === 'check') {
  const baseline = loadBaseline();
  if (baseline === null) {
    console.error(`no baseline file at ${path.relative(repoRoot, baselineFile)};`);
    console.error('run `node scripts/lint-baseline.mjs create` first (or use the `lint:baseline` npm script).');
    process.exit(2);
  }
  const current = normalize(runEslintJson());
  const newOnes = diffNew(baseline, current);
  const resolvedOnes = diffNew(current, baseline);
  console.log(`baseline_records=${baseline.length}`);
  console.log(`current_records=${current.length}`);
  summarize('new_violations', newOnes);
  if (resolvedOnes.length > 0) {
    console.log(`resolved_violations=${resolvedOnes.length}`);
    console.log('(consider running `npm run lint:baseline` to refresh the baseline)');
  }
  if (isDryRun) {
    console.log('dry_run=1');
    process.exit(0);
  }
  if (newOnes.length > 0) {
    const first = newOnes[0];
    console.error(
      `new_lint_violation=${path.relative(repoRoot, first.filePath)}:${first.line}:${first.column} (${first.ruleId})`,
    );
    process.exit(1);
  }
  process.exit(0);
}

console.error(`unknown subcommand: ${subcommand}`);
console.error('usage: node scripts/lint-baseline.mjs {create|check|show} [--dry-run]');
process.exit(2);
