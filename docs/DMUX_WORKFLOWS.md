# DMUX_WORKFLOWS

> **Orchestration guide for SBOS-A1-ERP.** The dmux-workflows pattern as
> wired into this repository: tmux + node helper that fans workers out into
> per-branch worktrees, seeds shared context, and launches a parallel wave.

## Table of contents

1. [What is dmux, and what is SBOS-A1-ERP's flavor of it](#1-what-is-dmux-and-what-is-sbos-a1-erps-flavor-of-it)
2. [plan.json schema with a real example](#2-planjson-schema-with-a-real-example)
3. [Placeholders table](#3-placeholders-table)
4. [seedPaths contract and why we seed the orchestrator itself](#4-seedpaths-contract-and-why-we-seed-the-orchestrator-itself)
5. [How to run](#5-how-to-run)
6. [Worker protocol](#6-worker-protocol)
7. [A1-ERP-HY ↔ SBOS-A1-ERP worker convention](#7-a1-erp-hy--sbos-a1-erp-worker-convention)
8. [Troubleshooting](#8-troubleshooting)
9. [Example wave 0 invocation](#9-example-wave-0-invocation)

---

## 1. What is dmux, and what is SBOS-A1-ERP's flavor of it

`dmux` is a community pattern (popularized by `@alatrench/dmux`) for running
multiple AI coding agents in parallel inside one repo: each agent gets its
own git worktree, its own tmux pane, and its own task file. The orchestrator
fans a `plan.json` out into N independent workspaces so workers don't
collide on a shared working copy.

SBOS-A1-ERP does **not** depend on the standalone `dmux` npm binary.
Instead, we ship a small in-repo helper pair:

- `scripts/tmux-worktree-orchestrator.js` — creates one worktree per
  worker, overlays `seedPaths`, writes `task.md` / `handoff.md` /
  `status.md`, and launches a tmux window per worker.
- `scripts/orchestrate-worktrees.js` — CLI wrapper that reads a `plan.json`,
  validates it, and calls the helper. Supports `--dry-run`, `--execute`,
  and `--no-tmux`.

**Why not the standalone binary?** Three reasons: (1) repo-locality — the
runner lives in the repo it orchestrates, so `git grep` and PR review both
work; (2) no external install — anyone with Node 20 and tmux can run a wave
on a clean clone; (3) auditable surface — the whole orchestrator is ~250
lines of plain Node + `execFileSync` calls, testable under the same 80%
coverage floor as the rest of the project.

The `dmux` *pattern* (worktree-per-worker, plan.json, pane-per-worker) is
exactly what we ship; only the implementation is in-house. The skill that
inspired the pattern lives at `~/.claude/skills/dmux-workflows/` and is
read-only — not a runtime dependency.

---

## 2. plan.json schema with a real example

A plan is a single JSON object. The runner validates it before any side
effects (`scripts/orchestrate-worktrees.js` → `validatePlan`).

```jsonc
{
  "sessionName": "string (required)",
  "description": "string (free text)",
  "baseRef": "git ref to branch from (default: HEAD)",
  "launcherCommand": "shell command with placeholders (default: 'bash {task_file}')",
  "seedPaths": ["relative/paths", "to/copy/into/each/worktree"],
  "workers": [
    { "name": "string (required)", "task": "string (multi-line task body)" }
  ]
}
```

Validation rules:

- `sessionName` is required.
- `workers` must be a non-empty array; each `name` is required and unique
  within the plan; each `task` is required and non-empty.
- `baseRef`, if present, must match `^[A-Za-z0-9._/-]+$` (rejects shell
  metacharacters).

### Real SBOS-A1-ERP example (wave 0)

The live wave 0 plan lives at
[`.orchestration/sbos-a1-erp-bootstrap.json`](../../.orchestration/sbos-a1-erp-bootstrap.json).
The four workers are `repo-foundation` (package.json, tsconfig, eslint,
prettier, CI, sanity test), `seed-from-a1-erp-hy` (mirror canonical docs
with provenance), `rbac-port` (port `server/rbac/*` with brand-strip +
hardening), and `dmux-docs` (this guide plus `PROJECT_STATUS.md` and
`AGENT_BRIEF.md`).

Excerpt:

```json
{
  "sessionName": "sbos-a1-erp-bootstrap",
  "baseRef": "main",
  "launcherCommand": "bash -lc 'echo \"[worker] {task_file} ready in {worktree_path}\"; ...'",
  "seedPaths": [
    "scripts/orchestrate-worktrees.js",
    "scripts/tmux-worktree-orchestrator.js",
    "scripts/orchestrate-codex-worker.sh",
    ".orchestration/README.md",
    ".orchestration/sbos-a1-erp-bootstrap.json",
    "README.md", "AGENTS.md", "package.json", ".gitignore", ".nvmrc"
  ],
  "workers": [
    { "name": "repo-foundation",    "task": "..." },
    { "name": "seed-from-a1-erp-hy","task": "..." },
    { "name": "rbac-port",          "task": "..." },
    { "name": "dmux-docs",          "task": "..." }
  ]
}
```

---

## 3. Placeholders table

`launcherCommand` may reference the following placeholders. They are
substituted by `launchTmuxPane` before the command is run in the tmux
window.

| Placeholder | Expanded to |
|---|---|
| `{worktree_path}` | Absolute path to the worker's git worktree |
| `{task_file}` | Path to `.orchestration/<session>/<worker>/task.md` |
| `{handoff_file}` | Path to `.orchestration/<session>/<worker>/handoff.md` |
| `{status_file}` | Path to `.orchestration/<session>/<worker>/status.md` |
| `{repo_root}` | Path to the repository root |
| `{worker_name}` | The worker's `name` field |

Substitution is plain regex `/g` replacement, so escape `$` and backslashes
in your shell command as needed (the default plan wraps the launcher in
`bash -lc '...'` to keep quoting simple).

---

## 4. seedPaths contract and why we seed the orchestrator itself

`seedPaths` is a list of repo-root-relative paths. Before any worker
starts, the runner copies each one from the repo root into the worker's
worktree. Missing source paths are silently skipped, which makes a plan
re-runnable against an in-progress tree (idempotency: re-running the same
plan after a partial completion should be safe).

**Wave 0 deliberately seeds the orchestrator itself** — the
`scripts/orchestrate-*.js` and `scripts/orchestrate-codex-worker.sh` files,
the plan JSON, and `package.json` are all in the seed list. Why?

- The runner executes from the **repo root** but writes into the
  **worktree**. Without the seed overlay, a worker that wants to spin up
  a sub-wave (or re-run a partial plan from inside its worktree) would be
  missing the helper scripts.
- The plan JSON is the canonical brief for the wave. A worker that needs
  to re-read its sibling workers' task briefs (e.g. to coordinate
  interface boundaries) can grep the seeded copy rather than reaching
  back into `.orchestration/` at the repo root.
- `package.json` and `.nvmrc` give the worker a reproducible Node
  toolchain even if a sibling commit has not yet been merged.

Treat the list as the "minimum environment a worker needs to do useful
work." If your worker needs the `scripts/` directory, the README, the plan
JSON itself, or the test config, add them to `seedPaths`.

---

## 5. How to run

The runner lives in `scripts/orchestrate-worktrees.js` and reads a plan
JSON from the first positional argument.

```bash
# Validate + show what would happen. No worktrees, no tmux, no files written.
node scripts/orchestrate-worktrees.js \
  .orchestration/sbos-a1-erp-bootstrap.json --dry-run

# Execute (default). Creates worktrees, writes task/handoff/status, launches tmux.
node scripts/orchestrate-worktrees.js \
  .orchestration/sbos-a1-erp-bootstrap.json

# Execute without launching tmux (CI / non-interactive).
node scripts/orchestrate-worktrees.js \
  .orchestration/sbos-a1-erp-bootstrap.json --no-tmux
```

Flags:

| Flag | Effect |
|---|---|
| `--dry-run` | Print the action plan as JSON; do nothing. |
| `--execute` | Run the plan (default; explicit form). |
| `--no-tmux` | Create worktrees + write files, but do not launch tmux. |
| `-h`, `--help` | Print usage. |

After execution, attach to the session:

```bash
tmux attach -t sbos-a1-erp-bootstrap
# Ctrl+B then arrow keys to switch panes
# Ctrl+B then d         to detach (workers keep running)
```

The runner is idempotent: re-running it against the same plan reuses
existing worktrees, refreshes `task.md` (the input is allowed to drift),
and preserves `handoff.md` / `status.md` (the worker's output is not
clobbered).

---

## 6. Worker protocol

Each worker (human or AI agent) is expected to:

1. **Read `task.md`.** It is written verbatim from the plan's `worker.task`
   field. Treat it as the source of truth for scope and acceptance
   criteria.
2. **Work only inside the worktree.** `git status` will show the worker
   branch; do not edit files in the repo root, sibling worktrees, or
   `.orchestration/<session>/<other-worker>/`.
3. **Commit with a clear conventional message.** The convention is
   enforced by the rest of the project (see
   `~/.claude/rules/common/git-workflow.md`). Examples:
   `feat(rbac): port rbac subsystem from a1-erp-hy`,
   `docs: dmux-workflows and project-status guides`.
4. **Write `handoff.md`.** Document what was added, what was modified,
   test results, and any open questions. Use the wave's plan path to
   anchor it.
5. **Tick `status.md`.** Convert `- [ ]` to `- [x]` for each completed
   checklist item.

The orchestrator does **not** merge branches. Merging is a separate manual
step after the workers finish — wave 0 should produce four open PRs (or
four branches ready to fast-forward into `main` after review).

---

## 7. A1-ERP-HY ↔ SBOS-A1-ERP worker convention

A1-ERP-HY (`~/dev/A1-ERP-HY`) is the private R&D repo. SBOS-A1-ERP (this
repo) is the public open-core. Code flows **A1-ERP-HY → SBOS-A1-ERP**
after de-privatization.

Workers in SBOS-A1-ERP MUST treat A1-ERP-HY as **read-only reference**.
Concretely:

- **Do not write to A1-ERP-HY.** If you need to change behavior, port the
  change here and note the upstream delta in the handoff.
- **Strip brand and internal identifiers** before committing. The grep
  `git grep -nE 'armosphera|hayhashvapah|samvel|a1-erp-hy' <dir>/` must
  return zero matches in any ported tree.
- **Cite provenance.** Every mirrored doc gets a
  `<!-- Mirrored from A1-ERP-HY @ <sha> on <date> -->` header and a
  `## Provenance` footer with the source path, source commit SHA, and
  mirror date.
- **Prefer porting over inventing.** If A1-ERP-HY already has a
  battle-tested module, port it (with the strip above) instead of
  designing a new one. This is the rule from
  `~/.claude/rules/common/development-workflow.md` step 0 ("Research &
  Reuse").
- **Keep the public face domain-agnostic first.** RBAC has no Armenia
  specifics, so it ports cleanly. i18n and Armenia tax port after RBAC
  lands.

The wave 0 `rbac-port` worker is the canonical example: 8 source files +
45 tests from A1-ERP-HY → 55 tests in SBOS-A1-ERP, plus 4 hardening
acceptance grep commands that must return empty.

---

## 8. Troubleshooting

### "pane not responding"

The tmux session exists but the worker pane is silent or stuck.

1. Attach: `tmux attach -t <sessionName>`. Find the worker's window
   (`Ctrl+B then w` shows the window list).
2. Capture recent output without attaching:
   `tmux capture-pane -pt <session>:<worker> -S -200`.
3. If the launcher command exited (e.g. it ran `sleep 86400` and the host
   rebooted), re-run the plan with `--no-tmux` first to refresh the worker
   files, then `--execute` to relaunch the panes.

### Merge conflicts when merging worker branches

Wave 0 is designed so that each worker's seed list is disjoint enough to
avoid most conflicts. The known overlap is `package.json` / `tsconfig.json`
/ `eslint.config.js` (touched by `repo-foundation`) vs. nothing (RBAC,
docs, seeds). If a future wave has overlap: (1) merge the broadest worker
first (usually foundation / infra); (2) merge domain workers in dependency
order — RBAC → i18n → tax → CRM → finance; (3) for content conflicts in
`package.json`, prefer the higher-version dependency and re-run
`npm install` after each merge.

### High token usage

Workers that read `~/dev/A1-ERP-HY` and the whole of `docs/` burn tokens
fast. Mitigations:

- **Use `git grep` with anchored regexes** rather than reading whole
  files to look for symbols.
- **Read only the section you need** (`Read` with `offset` and `limit`).
- **Mirror a slice, not the whole file** when seeding docs (see
  `seed-from-a1-erp-hy` task: only the first 400 lines of the A1-ERP-HY
  `HANDOFF.md`).
- **Drop a worker to a smaller model** by editing its `launcherCommand`
  in the plan; the orchestrator does not care which model runs inside
  the pane.

### "tmux: command not found"

`tmux-worktree-orchestrator.js` shells out to `tmux` via `execFileSync`.
On macOS: `brew install tmux`. On Debian/Ubuntu:
`sudo apt-get install -y tmux`. For CI / non-interactive runs, use
`--no-tmux` to skip the tmux dependency entirely (worktrees and per-worker
files are still created).

### "fatal: not a git repository"

The runner resolves `REPO_ROOT` by walking up from `process.cwd()` looking
for `.git`. Run it from inside the repo (or any subdirectory) — not from
`/tmp`.

---

## 9. Example wave 0 invocation

Wave 0 is the first parallel wave for SBOS-A1-ERP. The plan is already
checked in at `.orchestration/sbos-a1-erp-bootstrap.json`.

```bash
# Step 1: dry-run, confirm 4 workers, confirm seed list, confirm tmux command.
node scripts/orchestrate-worktrees.js \
  .orchestration/sbos-a1-erp-bootstrap.json --dry-run | jq .

# Step 2: execute. Worktrees appear under .claude/worktrees/,
# per-worker files under .orchestration/sbos-a1-erp-bootstrap/<worker>/,
# a tmux session named "sbos-a1-erp-bootstrap" comes up with one window
# per worker.
node scripts/orchestrate-worktrees.js \
  .orchestration/sbos-a1-erp-bootstrap.json

# Step 3: attach and watch. Workers echo their task/handoff/status paths
# on startup (see launcherCommand).
tmux attach -t sbos-a1-erp-bootstrap

# Step 4: detach when you're done babysitting. Workers keep running.
# Ctrl+B then d

# Step 5: peek at a worker's last 200 lines of output without attaching.
tmux capture-pane -pt sbos-a1-erp-bootstrap:rbac-port -S -200

# Step 6: when a worker writes its handoff.md and ticks status.md, review
# the branch (e.g. via `gh pr create` from the worker's worktree) and
# merge into main. The runner does not merge for you.
```

After wave 0 lands, the next wave is typically a 3-worker plan: port
`server/i18n/`, port `server/tax/armenia/`, and add the first integration
test that runs the RBAC guards against a real request. The plan filename
convention is `<scope>-<ordinal>.json`; see
`.orchestration/sbos-a1-erp-bootstrap.json` for the existing shape.
