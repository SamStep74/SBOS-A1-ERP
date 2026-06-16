# A1 ERP-HY Orchestration

This directory contains orchestration plans for parallel agent work using
the dmux-style worktree pattern. Each plan is a `plan.json` that
describes a session, a base git ref, a launcher command, and a list of
worker tasks.

## Layout

```
.orchestration/
├── README.md                       ← this file
├── a1-erp-hy-initial.json          ← first wave (RBAC + dmux + docs)
├── a1-erp-hy-rbac-foundation.json  ← second wave (planned)
└── <sessionName>/                  ← created at runtime
    └── <workerName>/
        ├── task.md                 ← input to the worker
        ├── handoff.md              ← output from the worker
        └── status.md               ← checklist
```

When a plan is executed, the runner:

1. Creates one git worktree per worker under `.claude/worktrees/<workerName>/`.
2. Overlays `seedPaths` from the plan into each worktree.
3. Writes per-worker `task.md`, `handoff.md`, and `status.md` under
   `.orchestration/<sessionName>/<workerName>/`.
4. Starts (or joins) a tmux session named `<sessionName>` and creates
   one window per worker. The worker's `launcherCommand` runs inside.

## Running a plan

```bash
# Dry-run (prints what would happen, does nothing destructive)
node scripts/orchestrate-worktrees.js .orchestration/a1-erp-hy-initial.json --dry-run

# Execute (creates worktrees, writes files, launches tmux)
node scripts/orchestrate-worktrees.js .orchestration/a1-erp-hy-initial.json

# Skip tmux (useful for CI / non-interactive environments)
node scripts/orchestrate-worktrees.js .orchestration/a1-erp-hy-initial.json --no-tmux
```

After execution, attach to the tmux session to watch the workers:

```bash
tmux attach -t a1-erp-hy-initial
# Navigate panes:      Ctrl+B then arrow keys
# Detach:             Ctrl+B then d
```

## plan.json schema

```json
{
  "sessionName": "string (required)",
  "description": "string (free text)",
  "baseRef": "git ref to branch from (default: HEAD)",
  "launcherCommand": "shell command with placeholders",
  "seedPaths": ["relative/paths", "to/copy/into/each/worktree"],
  "workers": [
    {
      "name": "string (required, used as branch + tmux window name)",
      "task": "string (multi-line, becomes task.md)"
    }
  ]
}
```

### Placeholders in `launcherCommand`

| Placeholder | Expanded to |
|---|---|
| `{worktree_path}` | Path to the worker's git worktree |
| `{task_file}` | Path to `.orchestration/<session>/<worker>/task.md` |
| `{handoff_file}` | Path to `.orchestration/<session>/<worker>/handoff.md` |
| `{status_file}` | Path to `.orchestration/<session>/<worker>/status.md` |
| `{repo_root}` | Path to the repository root |

### Worker responsibilities

Each worker (human or AI agent) is expected to:

1. Read `task.md` for the full brief.
2. Make code changes in its worktree (the only place it can write).
3. Commit with a clear conventional message (e.g. `feat(rbac): ...`).
4. Write a `handoff.md` describing what was added, what was modified,
   test results, and any open questions.
5. Tick off the items in `status.md`.

The orchestrator (this run) does not merge branches. That is a separate
manual step after the workers finish.

## Why dmux-style?

- **Isolation.** Each worker has its own branch and worktree; no merge
  conflicts during the work.
- **Reproducibility.** A `plan.json` is a checked-in artifact that can
  be re-run, audited, and re-shared.
- **Tool-agnostic.** The same pattern works with Claude Code, Codex,
  OpenCode, Cline, Gemini, Qwen, or a human typing into a terminal.
- **Tunable cost.** Drop a worker to a smaller model, or remove it
  entirely, by editing the plan.
