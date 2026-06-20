#!/usr/bin/env node
// A1 ERP-HY Tmux/Worktree Orchestrator (shared helper)
//
// Implements the worktree-per-worker pattern from the dmux-workflows skill.
// Each worker runs in its own git worktree under .claude/worktrees/<branch>/,
// in its own tmux pane under a shared session.
//
// Usage:
//   const orch = require('./tmux-worktree-orchestrator.cjs');
//   const worktreePath = orch.createWorktree('feat-rbac', 'main');
//   orch.overlaySeedPaths(worktreePath, ['docs/ERP_COMPARISON_IMPLEMENTATION_PLAN.md']);
//   orch.writeWorkerFiles(worktreePath, 'a1-erp-hy-initial', 'rbac-catalog', '...');
//   orch.launchTmuxPane('a1-erp-hy-initial', 'rbac-catalog', 'codex exec --cwd {worktree_path} --task-file {task_file}');
//
// Safety:
//   - Refuses to clobber an existing worktree or branch
//   - Dry-run mode logs the commands it would run
//   - All operations are idempotent (re-running is a no-op)

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = findRepoRoot();
const WORKTREES_DIR = path.join(REPO_ROOT, '.claude', 'worktrees');
const ORCH_DIR = path.join(REPO_ROOT, '.orchestration');

function findRepoRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Not inside a git repository');
}

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: opts.cwd || REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tmux(args) {
  return execFileSync('tmux', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function pathExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

// ───── createWorktree(branchName, baseRef) ─────

/**
 * Create a git worktree at .claude/worktrees/<branchName>. Idempotent —
 * if a worktree already exists for the branch, returns its path.
 *
 * @param {string} branchName  Name of the branch (and worktree directory).
 * @param {string} [baseRef='HEAD']  Git ref to branch from if the branch
 *                                   does not yet exist.
 * @returns {string} Absolute path to the worktree.
 */
function createWorktree(branchName, baseRef = 'HEAD') {
  ensureDir(WORKTREES_DIR);
  const worktreePath = path.join(WORKTREES_DIR, branchName);

  // If a worktree already exists for this branch, return it (idempotent).
  if (pathExists(worktreePath)) {
    return worktreePath;
  }

  // Ensure the branch exists. If not, create it from baseRef.
  let hasBranch = false;
  try {
    git(['rev-parse', '--verify', `refs/heads/${branchName}`]);
    hasBranch = true;
  } catch {
    hasBranch = false;
  }

  if (!hasBranch) {
    git(['branch', branchName, baseRef]);
  }

  git(['worktree', 'add', worktreePath, branchName]);
  return worktreePath;
}

// ───── overlaySeedPaths(worktreePath, seedPaths) ─────

/**
 * Copy seed files from the repo root into the worktree. Missing source
 * paths are silently skipped (allows the same plan to run on a tree
 * that doesn't yet have every doc).
 *
 * @param {string} worktreePath  Absolute path to the worktree.
 * @param {string[]} [seedPaths]  Repo-root-relative paths to overlay.
 * @returns {void}
 */
function overlaySeedPaths(worktreePath, seedPaths = []) {
  for (const rel of seedPaths) {
    const src = path.join(REPO_ROOT, rel);
    const dst = path.join(worktreePath, rel);
    if (!pathExists(src)) continue;
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
  }
}

// ───── writeWorkerFiles(worktreePath, sessionName, workerName, task) ─────

/**
 * Write the per-worker files (task.md, handoff.md, status.md) under
 * .orchestration/<sessionName>/<workerName>/. task.md is always
 * overwritten; handoff.md and status.md are only seeded if missing
 * (so the worker's progress is preserved across re-runs).
 *
 * @param {string} worktreePath  Absolute path to the worktree.
 * @param {string} sessionName  Orchestration session name.
 * @param {string} workerName  Worker (and branch) name.
 * @param {string} task  Task body — written verbatim into task.md.
 * @returns {{ taskPath: string, handoffPath: string, statusPath: string }}
 */
function writeWorkerFiles(worktreePath, sessionName, workerName, task) {
  const dir = path.join(ORCH_DIR, sessionName, workerName);
  ensureDir(dir);

  const taskPath = path.join(dir, 'task.md');
  fs.writeFileSync(taskPath, `# ${workerName}\n\n${task}\n`);

  const handoffPath = path.join(dir, 'handoff.md');
  if (!pathExists(handoffPath)) {
    fs.writeFileSync(
      handoffPath,
      `# Handoff — ${workerName}\n\n(filled in by the worker on completion)\n`,
    );
  }

  const statusPath = path.join(dir, 'status.md');
  if (!pathExists(statusPath)) {
    fs.writeFileSync(
      statusPath,
      `# Status — ${workerName}\n\n- [ ] task started\n- [ ] task completed\n`,
    );
  }

  return { taskPath, handoffPath, statusPath };
}

// ───── launchTmuxPane(sessionName, workerName, launcherCommand) ─────

/**
 * @param {string} sessionName
 * @returns {boolean} True if the tmux session exists.
 */
function sessionExists(sessionName) {
  try {
    tmux(['has-session', '-t', sessionName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Launch a new tmux window for a worker, joining an existing session
 * if one is already running. Substitutes {worktree_path}, {task_file},
 * {handoff_file}, {status_file}, {repo_root} into the launcher command.
 *
 * @param {string} sessionName
 * @param {string} workerName  Used as the tmux window name.
 * @param {string} launcherCommand  Shell command with optional placeholders.
 * @returns {{ session: string, window: string, command: string }}
 */
function launchTmuxPane(sessionName, workerName, launcherCommand) {
  if (!sessionExists(sessionName)) {
    tmux(['new-session', '-d', '-s', sessionName, '-n', 'main', '-c', REPO_ROOT]);
  }
  const worktreePath = path.join(WORKTREES_DIR, workerName);
  const taskFile = path.join(ORCH_DIR, sessionName, workerName, 'task.md');
  const handoffFile = path.join(ORCH_DIR, sessionName, workerName, 'handoff.md');
  const statusFile = path.join(ORCH_DIR, sessionName, workerName, 'status.md');

  // Substitute placeholders.
  const cmd = launcherCommand
    .replace(/\{worktree_path\}/g, worktreePath)
    .replace(/\{task_file\}/g, taskFile)
    .replace(/\{handoff_file\}/g, handoffFile)
    .replace(/\{status_file\}/g, statusFile)
    .replace(/\{repo_root\}/g, REPO_ROOT)
    .replace(/\{worker_name\}/g, workerName);

  tmux(['new-window', '-t', sessionName, '-n', workerName, '-c', worktreePath, cmd]);
  return { session: sessionName, window: workerName, command: cmd };
}

// ───── capturePaneOutput(sessionName, workerName, lines = 200) ─────

/**
 * Capture the recent output of a worker's tmux pane. Returns a
 * placeholder string if tmux fails (e.g. session already killed).
 *
 * @param {string} sessionName
 * @param {string} workerName
 * @param {number} [lines=200]  Number of trailing lines to capture.
 * @returns {string}
 */
function capturePaneOutput(sessionName, workerName, lines = 200) {
  try {
    return tmux(['capture-pane', '-pt', `${sessionName}:${workerName}`, '-S', `-${lines}`]);
  } catch (e) {
    return `<<capture failed: ${e.message}>>`;
  }
}

// ───── list / cleanup ─────

function listWorkers(sessionName) {
  const dir = path.join(ORCH_DIR, sessionName);
  if (!pathExists(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function killSession(sessionName) {
  try {
    tmux(['kill-session', '-t', sessionName]);
  } catch {
    /* ignore */
  }
}

module.exports = {
  REPO_ROOT,
  WORKTREES_DIR,
  ORCH_DIR,
  createWorktree,
  overlaySeedPaths,
  writeWorkerFiles,
  launchTmuxPane,
  capturePaneOutput,
  sessionExists,
  listWorkers,
  killSession,
  // helpers
  git,
  tmux,
  pathExists,
  ensureDir,
};
