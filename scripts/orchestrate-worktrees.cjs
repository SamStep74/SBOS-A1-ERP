#!/usr/bin/env node
// A1 ERP-HY Orchestration Plan Runner
//
// Reads a plan.json and:
//   1. Creates one git worktree per worker under .claude/worktrees/<workerName>/
//   2. Overlays seedPaths into each worktree
//   3. Writes per-worker task.md, handoff.md, status.md under
//      .orchestration/<sessionName>/<workerName>/
//   4. Starts (or joins) a tmux session and creates one pane per worker
//   5. Runs each worker's launcherCommand inside its pane
//
// Usage:
//   node scripts/orchestrate-worktrees.cjs .orchestration/a1-erp-hy-initial.json
//   node scripts/orchestrate-worktrees.cjs <plan.json> --dry-run
//   node scripts/orchestrate-worktrees.cjs <plan.json> --execute
//
// Flags:
//   --dry-run   Print the actions without executing them
//   --execute   Run the actions (default)
//   --no-tmux   Create worktrees + write files but do not launch tmux panes
//
// See: .orchestration/README.md for plan.json schema and examples.

'use strict';

const fs = require('fs');
const path = require('path');
const orch = require('./tmux-worktree-orchestrator.cjs');

/**
 * Parse CLI arguments. Accepts an explicit argv array (defaults to
 * `process.argv.slice(2)`) so tests can drive it without forking.
 *
 * @param {string[]} [argv]
 * @returns {{ dryRun: boolean, noTmux: boolean, planPath: string|undefined }}
 */
function parseArgs(argv = process.argv.slice(2)) {
  const opts = { dryRun: false, noTmux: false };
  const positional = [];
  for (const a of argv) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--execute') opts.dryRun = false;
    else if (a === '--no-tmux') opts.noTmux = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else positional.push(a);
  }
  opts.planPath = positional[0];
  return opts;
}

function printHelp() {
  process.stdout.write(
    `Usage: node scripts/orchestrate-worktrees.cjs <plan.json> [--dry-run] [--execute] [--no-tmux]\n`,
  );
}

function loadPlan(planPath) {
  if (!planPath) {
    throw new Error('plan.json path is required (positional arg)');
  }
  const abs = path.resolve(planPath);
  if (!orch.pathExists(abs)) {
    throw new Error(`plan.json not found: ${abs}`);
  }
  const plan = JSON.parse(fs.readFileSync(abs, 'utf8'));
  validatePlan(plan);
  return { plan, abs };
}

const VALID_REF = /^[A-Za-z0-9._/-]+$/;

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('plan must be a JSON object');
  }
  if (!plan.sessionName || typeof plan.sessionName !== 'string') {
    throw new Error('plan.sessionName is required (string)');
  }
  if (plan.baseRef !== undefined) {
    if (typeof plan.baseRef !== 'string' || !VALID_REF.test(plan.baseRef)) {
      throw new Error(
        `plan.baseRef must be a git ref string (got ${JSON.stringify(plan.baseRef)})`,
      );
    }
  }
  if (!Array.isArray(plan.workers) || plan.workers.length === 0) {
    throw new Error('plan.workers must be a non-empty array');
  }
  const seen = new Set();
  for (const w of plan.workers) {
    if (!w || typeof w !== 'object') {
      throw new Error('each worker must be an object');
    }
    if (!w.name || typeof w.name !== 'string') {
      throw new Error('each worker must have a .name (string)');
    }
    if (seen.has(w.name)) {
      throw new Error(`duplicate worker name: ${w.name}`);
    }
    seen.add(w.name);
    if (typeof w.task !== 'string' || w.task.length === 0) {
      throw new Error(`worker ${w.name}: .task must be a non-empty string`);
    }
  }
}

function executePlan(plan, opts) {
  const baseRef = plan.baseRef || 'HEAD';
  const seedPaths = Array.isArray(plan.seedPaths) ? plan.seedPaths : [];
  const launcherCommand = plan.launcherCommand || 'bash {task_file}';
  const summary = { sessionName: plan.sessionName, workers: [] };

  for (const w of plan.workers) {
    const entry = { name: w.name, worktree: null, files: null, tmux: null };
    if (opts.dryRun) {
      entry.dryRun = true;
      entry.worktree = path.join(orch.WORKTREES_DIR, w.name);
      entry.files = path.join(orch.ORCH_DIR, plan.sessionName, w.name);
      entry.tmux = `tmux new-window -t ${plan.sessionName} -n ${w.name} -c ${entry.worktree} ${launcherCommand}`;
      summary.workers.push(entry);
      continue;
    }

    // 1. Create worktree
    const worktree = orch.createWorktree(w.name, baseRef);
    entry.worktree = worktree;

    // 2. Overlay seed paths
    orch.overlaySeedPaths(worktree, seedPaths);

    // 3. Write worker files (task.md, handoff.md, status.md)
    const files = orch.writeWorkerFiles(worktree, plan.sessionName, w.name, w.task);
    entry.files = files;

    // 4. Launch tmux pane (unless --no-tmux)
    if (!opts.noTmux) {
      const tmux = orch.launchTmuxPane(plan.sessionName, w.name, launcherCommand);
      entry.tmux = tmux;
    }
    summary.workers.push(entry);
  }

  return summary;
}

function main() {
  const opts = parseArgs();
  const { plan } = loadPlan(opts.planPath);
  const summary = executePlan(plan, opts);
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

// Only run the CLI when invoked directly (`node orchestrate-worktrees.cjs`).
// `require()` from tests should just expose the helpers.
if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { validatePlan, parseArgs, loadPlan, executePlan, main, printHelp };
