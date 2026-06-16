<!-- Mirrored from A1-ERP-HY @ 50f5f44d632f8a3112ae5579060b768f0028c5da on 2026-06-16 -->
# A1 ERP-HY dmux Workflows

> Parallel agent orchestration for A1-ERP-HY. Adapted from the
> `dmux-workflows` skill — runs without `dmux` itself by using a small
> Node orchestrator script and standard `tmux`.

## Why we built our own

`dmux` is not installed on this machine. The `dmux-workflows` skill
describes the **pattern** (worktree per worker, tmux session, one pane
per worker) and even includes an ECC helper script. We re-implemented
that pattern in two files:

- `scripts/tmux-worktree-orchestrator.js` — the shared helper
- `scripts/orchestrate-worktrees.js` — the CLI runner

The plan format is identical to the ECC plan, so future scripts can
swap to the upstream `dmux` binary if it gets installed.

## Quick start

```bash
# 1. Look at the plan
cat .orchestration/a1-erp-hy-initial.json | jq

# 2. Dry-run
node scripts/orchestrate-worktrees.js \
  .orchestration/a1-erp-hy-initial.json --dry-run

# 3. Execute
node scripts/orchestrate-worktrees.js \
  .orchestration/a1-erp-hy-initial.json

# 4. Watch
tmux attach -t a1-erp-hy-initial
```

## Patterns in use

### Pattern 1: Multi-File Feature

The first wave splits the RBAC foundation into three independent
workers so they can run in parallel:

- `rbac-catalog` (own worktree): audits and tests the catalogs
- `dmux-workflows` (own worktree): builds the orchestration scaffolding
- `docs-and-status` (own worktree): writes RBAC_SYSTEM.md and
  PROJECT_STATUS.md

None of the three touch overlapping files, so they can all be merged
back to `main` with no conflicts.

### Pattern 2: Code-Review Pipeline (planned)

For future waves: spawn three reviewers on the same diff in parallel,
one focused on security, one on performance, one on test coverage.
Each writes its findings to a separate handoff file. The orchestrator
merges the three.

### Pattern 3: Test + Fix Loop (planned)

For post-merge hardening: one pane runs `node --test --watch` on the
RBAC tests; another pane reads the failure output and patches the
implementation. Loop until 45/45.

## Resource budget

The ECC docs say "keep total panes under 5-6" — each pane is a full
agent session. For a typical A1-ERP-HY wave:

- 1 orchestrator pane (the human)
- 2-4 worker panes
- 1-2 reviewer panes

That keeps the total under 6 panes and the API budget bounded.

## Recovery

If a worker pane dies or the tmux session crashes:

```bash
# List all worktrees
git worktree list

# Find the worker's branch
cd .claude/worktrees/<workerName>
git status
git log --oneline -5

# Re-attach the worker to a fresh tmux window
tmux new-window -t a1-erp-hy-initial -n <workerName> -c $(pwd) \
  'codex exec --task-file .orchestration/a1-erp-hy-initial/<workerName>/task.md'
```

## Cleanup

```bash
# After the workers' branches are merged, remove the worktrees:
git worktree remove .claude/worktrees/rbac-catalog
git worktree remove .claude/worktrees/dmux-workflows
git worktree remove .claude/worktrees/docs-and-status

# Kill the tmux session
tmux kill-session -t a1-erp-hy-initial

# Delete the branches
git branch -d rbac-catalog dmux-workflows docs-and-status
```

The `.orchestration/<sessionName>/` directory is kept on disk for
audit; delete it manually if you want a clean slate.


## Provenance

- **Source path:** `/Users/samvelstepanyan/dev/A1-ERP-HY/docs/DMUX_WORKFLOWS.md`
- **Source commit SHA:** `50f5f44d632f8a3112ae5579060b768f0028c5da`
- **Source blob SHA1:** `d850a4967117b10355f00b52bd2d52637763e877`
- **Mirror date:** 2026-06-16
- **Worktree:** `/Users/samvelstepanyan/dev/SBOS-A1-ERP/.claude/worktrees/seed-from-a1-erp-hy`
- **Bytes (mirrored body, pre-provenance):** 3218
