#!/usr/bin/env bash
# A1 ERP-HY Worker Wrapper
#
# Run inside a tmux pane to execute a single worker task.
# Reads task.md, runs the agent, and writes handoff.md + status.md.
#
# Usage (in the tmux launcherCommand):
#   bash {repo_root}/scripts/orchestrate-codex-worker.sh \
#     {task_file} {handoff_file} {status_file} {worktree_path} {worker_name}
#
# Behavior:
#   - Streams the task into the agent CLI
#   - On exit code 0, marks status.md [x] completed and writes handoff.md
#     with a summary extracted from the agent's final output
#   - On exit code != 0, marks status.md [!] failed and writes handoff.md
#     with the last 50 lines of agent output for triage

set -uo pipefail

TASK_FILE="$1"
HANDOFF_FILE="$2"
STATUS_FILE="$3"
WORKTREE_PATH="$4"
WORKER_NAME="$5"

if [[ -z "${TASK_FILE:-}" || -z "${HANDOFF_FILE:-}" || -z "${STATUS_FILE:-}" || -z "${WORKTREE_PATH:-}" || -z "${WORKER_NAME:-}" ]]; then
  echo "usage: orchestrate-codex-worker.sh <task_file> <handoff_file> <status_file> <worktree_path> <worker_name>"
  exit 2
fi

# Pick the agent CLI in this priority order.
# Default: claude (Claude Code CLI). It works with a ChatGPT or Anthropic auth
# and is the most reliable in mixed-account environments.
# Fallback: codex (OpenAI Codex CLI). Requires an OpenAI API key (NOT a
# ChatGPT subscription). Override with the A1_AGENT env var.
pick_agent() {
  if [[ -n "${A1_AGENT:-}" ]]; then
    echo "$A1_AGENT"
    return
  fi
  if command -v claude >/dev/null 2>&1; then
    echo "claude"
  elif command -v codex >/dev/null 2>&1; then
    echo "codex"
  else
    echo ""
  fi
}

AGENT="$(pick_agent)"
if [[ -z "$AGENT" ]]; then
  echo "ERROR: no agent CLI found (install claude or codex)" >&2
  exit 3
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] worker=$WORKER_NAME agent=$AGENT worktree=$WORKTREE_PATH"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] task: $TASK_FILE"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] handoff target: $HANDOFF_FILE"
echo "──────────────────────────────────────────────────────────"

# Initialize status.md
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  echo "# Status — $WORKER_NAME"
  echo
  echo "- [x] task started at $STARTED_AT"
  echo "- [ ] task completed"
} > "$STATUS_FILE"

# Read the task body (strip the leading "# <name>\n\n")
TASK_BODY="$(awk 'NR>2' "$TASK_FILE")"

# Compose the prompt for the agent
PROMPT="$(cat <<EOF
You are a worker on the A1 ERP-HY project. Your worker name is \`$WORKER_NAME\`.

Working directory (your git worktree): $WORKTREE_PATH

## Your task

$TASK_BODY

## When you are done

1. Make all code changes inside $WORKTREE_PATH.
2. Run the relevant tests and confirm they pass.
3. Commit with a clear conventional message (e.g. \`feat(rbac): ...\`).
4. Write a complete handoff to: $HANDOFF_FILE
   The handoff should include:
   - One-paragraph summary of what you did
   - Bullet list of files added/modified
   - Test command(s) and their results
   - Any open questions or known gaps
5. After writing the handoff, exit. The wrapper will mark the status file.
EOF
)"

# Run the agent, streaming output to a temp file so we can summarize on exit
LOG="$(mktemp -t a1erp-${WORKER_NAME}.XXXXXX.log)"
trap 'rm -f "$LOG"' EXIT

cd "$WORKTREE_PATH" || exit 4

case "$AGENT" in
  codex)
    # codex exec --cd <DIR> [PROMPT] — prompt is a positional arg, not --task.
    # Pass -c service_tier=fast to avoid the user's config.toml `service_tier=priority`
    # which current codex versions reject with "unknown variant `priority`".
    # NOTE: codex with a ChatGPT subscription rejects every model with
    # "not supported when using Codex with a ChatGPT account". Use claude
    # unless you have an OpenAI API key.
    codex exec --cd "$WORKTREE_PATH" -c service_tier=fast "$PROMPT" 2>&1 | tee "$LOG"
    RC=${PIPESTATUS[0]}
    ;;
  claude)
    # Claude Code CLI: --print makes it non-interactive. Claude 2.1.x
    # requires the prompt via stdin (passing it as a positional arg
    # errors with "Input must be provided either through stdin or as a
    # prompt argument when using --print"). We pass --add-dir so the
    # agent can read the worktree, and we do NOT pass
    # --dangerously-skip-permissions — the worker needs git write access
    # but we want the CLI's normal safety prompts to fire.
    printf '%s\n' "$PROMPT" | claude --print --add-dir "$WORKTREE_PATH" 2>&1 | tee "$LOG"
    RC=${PIPESTATUS[0]}
    ;;
  *)
    echo "ERROR: unknown agent $AGENT" >&2
    RC=5
    ;;
esac

# Update status + handoff based on exit
if [[ $RC -eq 0 ]]; then
  # Silent-success guard: the agent returned 0 but may have produced no
  # real work. Two canaries:
  #   1. The handoff file is still the seed placeholder (the worker
  #      never wrote a real handoff).
  #   2. The worktree branch has 0 new commits ahead of origin/main
  #      (the worker did not commit).
  # If either canary fires, treat the run as failed.
  HANDOFF_SEED="# Handoff — $WORKER_NAME"
  HANDOFF_STILL_SEED=0
  if [[ -f "$HANDOFF_FILE" ]] && head -n 1 "$HANDOFF_FILE" | grep -qF "Handoff — $WORKER_NAME (FAILED)"; then
    : # already replaced by a previous failed run; not a silent success
  elif head -n 1 "$HANDOFF_FILE" | grep -qF "$HANDOFF_SEED" && grep -qF "filled in by the worker on completion" "$HANDOFF_FILE"; then
    HANDOFF_STILL_SEED=1
  fi
  WORKTREE_COMMITS=0
  if command -v git >/dev/null 2>&1 && [[ -d "$WORKTREE_PATH/.git" || -f "$WORKTREE_PATH/.git" ]]; then
    # Compare against the wave's base ref (default: origin/main), NOT the
    # branch's upstream tracking ref. If we compared against @{u}, a worker
    # that committed AND pushed would have its commit on the upstream too,
    # so @{u}..HEAD would be 0 — a false-negative silent-success trip.
    WAVE_BASE="${A1_WAVE_BASE:-origin/main}"
    # Try wave base first; fall back to main if origin/main doesn't exist
    # (e.g. a fresh worktree with no fetch yet).
    if ! git -C "$WORKTREE_PATH" rev-parse --verify "$WAVE_BASE" >/dev/null 2>&1; then
      WAVE_BASE="main"
    fi
    WORKTREE_COMMITS="$(git -C "$WORKTREE_PATH" rev-list --count "$WAVE_BASE..HEAD" 2>/dev/null || echo 0)"
  fi

  if [[ $HANDOFF_STILL_SEED -eq 1 || $WORKTREE_COMMITS -eq 0 ]]; then
    # Silent success — flip the status to FAILED and write a triage handoff.
    {
      echo "# Status — $WORKER_NAME"
      echo
      echo "- [x] task started at $STARTED_AT"
      echo "- [!] task FAILED (silent success — agent exited 0 but produced no work) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } > "$STATUS_FILE"
    {
      echo "# Handoff — $WORKER_NAME (FAILED — silent success)"
      echo
      echo "Agent exited with code 0, but the silent-success canary fired:"
      echo
      if [[ $HANDOFF_STILL_SEED -eq 1 ]]; then
        echo "- handoff file is still the seed placeholder (no real handoff written)"
      fi
      if [[ $WORKTREE_COMMITS -eq 0 ]]; then
        echo "- worktree branch has 0 new commits ahead of $BASE (no commit landed)"
      fi
      echo
      echo "## Last 80 lines of agent output"
      echo
      echo '```'
      tail -n 80 "$LOG" 2>/dev/null || echo "(log not available)"
      echo '```'
    } > "$HANDOFF_FILE"
    echo
    echo "──────────────────────────────────────────────────────────"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] worker=$WORKER_NAME: SILENT SUCCESS → FAILED"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] (handoff_seed=$HANDOFF_STILL_SEED, worktree_commits=$WORKTREE_COMMITS)"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] pane will stay open for triage. Press Enter to close."
    read -r _
    exit 1
  fi

  # Real success: agent returned 0, wrote a handoff, committed work.
  STARTED_TS="$STARTED_AT"
  {
    echo "# Status — $WORKER_NAME"
    echo
    echo "- [x] task started at $STARTED_TS"
    echo "- [x] task completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$STATUS_FILE"
  echo
  echo "──────────────────────────────────────────────────────────"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] worker=$WORKER_NAME: SUCCESS (commits=$WORKTREE_COMMITS)"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] pane will stay open. Press Enter to close."
  read -r _
  exit 0
else
  {
    echo "# Status — $WORKER_NAME"
    echo
    echo "- [x] task started"
    echo "- [!] task FAILED at $(date -u +%Y-%m-%dT%H:%M:%SZ) (exit=$RC)"
  } > "$STATUS_FILE"
  # Write a triage handoff with the tail of the agent log
  {
    echo "# Handoff — $WORKER_NAME (FAILED)"
    echo
    echo "Worker exited with code $RC."
    echo
    echo "## Last 80 lines of agent output"
    echo
    echo '```'
    tail -n 80 "$LOG" 2>/dev/null || echo "(log not available)"
    echo '```'
  } > "$HANDOFF_FILE"
  echo
  echo "──────────────────────────────────────────────────────────"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] worker=$WORKER_NAME: FAILED (exit=$RC)"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] pane will stay open for triage. Press Enter to close."
  read -r _
  exit "$RC"
fi
