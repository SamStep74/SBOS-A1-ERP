#!/usr/bin/env bash
# A1 portfolio health check.
#
# Verifies four portfolio invariants against live GitHub state:
#   1. Repo count + visibility split   (10 / 6 public / 4 private)
#   2. LICENSE present in every repo
#   3. 22-file cross-account sweep     (SamStep74 refs in program.md = 0)
#   4. Dependabot + SECURITY.md        coverage across the portfolio
#
# Exits non-zero on any invariant failure. Designed to run:
#   - Locally:        ./scripts/health.sh
#   - CI weekly:      see .github/workflows/health.yml
#   - Pre-commit:     hook before pushing large sweeps
#
# Required: gh CLI authenticated as `Armosphera` OR a token in $GITHUB_TOKEN /
# $GH_TOKEN / `gh auth token --user Armosphera`. Curl + jq + bash 3.2+.

set -euo pipefail

# -------- auth --------
if [ -z "${TOKEN:-}" ]; then
  if command -v gh >/dev/null 2>&1; then
    TOKEN=$(gh auth token --user Armosphera 2>/dev/null || gh auth token 2>/dev/null || true)
  fi
fi
if [ -z "${TOKEN:-}" ]; then
  if [ -n "${GITHUB_TOKEN:-}" ]; then TOKEN="$GITHUB_TOKEN"; fi
fi
if [ -z "${TOKEN:-}" ]; then
  echo "ERROR: no GitHub token. Run 'gh auth switch --user Armosphera' or set \$GITHUB_TOKEN." >&2
  exit 2
fi
AUTH="Authorization: token $TOKEN"
ORG="Armosphera"
API="https://api.github.com"

# -------- output helpers --------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BOLD=""; RESET=""
fi
ok()   { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
warn() { printf "  %s!%s %s\n" "$YELLOW" "$RESET" "$1"; }
fail() { printf "  %s✗%s %s\n" "$RED" "$RESET" "$1"; }

REPOS=(
  A1-AI-Core
  A1-Localization-AM
  A1-Localization-RU
  A1-Suite-Local-ANT
  A1-Suite-Local-MAX
  A1-Platform-MAX
  A1-AI-ERP-SBOS-MSTUDIO-sovereign
  A1-Validator
  SBOS-A1-ERP
  A1-SMB-HH-HY-MAX
  A1-SMB-CRM-HY-MAX
  A1-SMB-CRM-HY-MAX-web
  A1-portfolio
  a1-cross-link-sweep
  autoresearch-sboss
)

EXPECTED_TOTAL=15
EXPECTED_PUBLIC=8
EXPECTED_PRIVATE=7

errors=0
warnings=0

# -------- 1. Repo count + visibility split --------
printf "\n%s[1] Repo count + visibility split%s\n" "$BOLD" "$RESET"
meta=$(curl -s -H "$AUTH" "$API/user/repos?per_page=100&affiliation=owner")
total=$(echo "$meta" | jq '[.[] | select(.fork==false and .archived==false)] | length')
public=$(echo "$meta" | jq '[.[] | select(.fork==false and .archived==false and .private==false)] | length')
private=$(echo "$meta" | jq '[.[] | select(.fork==false and .archived==false and .private==true)] | length')

printf "  total=%s public=%s private=%s (expected total=%s public=%s private=%s)\n" \
  "$total" "$public" "$private" "$EXPECTED_TOTAL" "$EXPECTED_PUBLIC" "$EXPECTED_PRIVATE"
if [ "$total" -eq "$EXPECTED_TOTAL" ] && [ "$public" -eq "$EXPECTED_PUBLIC" ] && [ "$private" -eq "$EXPECTED_PRIVATE" ]; then
  ok "repo count matches expected"
else
  fail "repo count drift (expected $EXPECTED_TOTAL/$EXPECTED_PUBLIC/$EXPECTED_PRIVATE, got $total/$public/$private)"
  errors=$((errors + 1))
fi

# -------- 2. LICENSE in every repo --------
printf "\n%s[2] LICENSE present in every repo%s\n" "$BOLD" "$RESET"
lic_missing=0
for r in "${REPOS[@]}"; do
  s=$(curl -s -H "$AUTH" "$API/repos/$ORG/$r/contents/LICENSE" | jq -r '.name // "MISSING"')
  if [ "$s" = "LICENSE" ]; then
    ok "$r"
  else
    fail "$r: $s"
    lic_missing=$((lic_missing + 1))
  fi
done
if [ "$lic_missing" -eq 0 ]; then
  ok "LICENSE present in all ${#REPOS[@]} repos"
else
  fail "$lic_missing repos missing LICENSE"
  errors=$((errors + 1))
fi

# -------- 3. 22-file cross-account sweep (via a1-clx) --------
printf "\n%s[3] 22-file cross-account sweep (program.md SamStep74 refs)%s\n" "$BOLD" "$RESET"

# The cross-link-sweep harness lives in Armosphera/a1-cross-link-sweep as a
# standalone CLI. Cache it under /tmp/a1-clx-$CLX_VERSION to avoid re-cloning
# on every run; refresh if the cache is missing or stale.
CLX_VERSION="${CLX_VERSION:-main}"
CLX_CACHE="/tmp/a1-clx-${CLX_VERSION}"
if [ ! -d "$CLX_CACHE" ]; then
  rm -rf /tmp/a1-clx-*  # clean up older versions
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$CLX_VERSION" \
      "https://github.com/Armosphera/a1-cross-link-sweep.git" "$CLX_CACHE" \
      >/dev/null 2>&1 || { fail "could not clone a1-cross-link-sweep @ $CLX_VERSION"; errors=$((errors + 1)); }
  else
    fail "git not available — cannot fetch a1-clx"
    errors=$((errors + 1))
  fi
fi

# Negative-test hook: HEALTH_FAKE_DIRTY=1 short-circuits before invoking a1-clx.
if [ "${HEALTH_FAKE_DIRTY:-0}" = "1" ]; then
  fail "(simulated drift via HEALTH_FAKE_DIRTY=1)"
  drift=1
  errors=$((errors + 1))
else
  # Run a1-clx eval — exits 0 if all 22 files are clean.
  a1clx_out=$("$CLX_CACHE/a1-clx" eval 2>&1) || a1clx_rc=$?
  a1clx_rc=${a1clx_rc:-0}
  # Surface the score line.
  score_line=$(echo "$a1clx_out" | grep -E "^score:" | head -1 || true)
  [ -n "$score_line" ] && printf "  %s\n" "$score_line"
  if [ "$a1clx_rc" -eq 0 ]; then
    ok "sweep clean: 22/22 program.md files point to Armosphera mirror"
  else
    fail "sweep drift detected (a1-clx eval exit=$a1clx_rc)"
    warn "run 'a1-clx sweep' to commit drift back to canonical refs"
    drift=1
    errors=$((errors + 1))
  fi
fi

# -------- 4. Dependabot + SECURITY.md coverage --------
printf "\n%s[4] Dependabot + SECURITY.md coverage%s\n" "$BOLD" "$RESET"
cov_missing=0
for r in "${REPOS[@]}"; do
  dep=$(curl -s -H "$AUTH" "$API/repos/$ORG/$r/contents/.github/dependabot.yml" | jq -r '.name // "MISSING"')
  sec=$(curl -s -H "$AUTH" "$API/repos/$ORG/$r/contents/.github/SECURITY.md"   | jq -r '.name // "MISSING"')
  if [ "$dep" = "dependabot.yml" ] && [ "$sec" = "SECURITY.md" ]; then
    ok "$r"
  else
    fail "$r: dep=$dep sec=$sec"
    cov_missing=$((cov_missing + 1))
  fi
done
if [ "$cov_missing" -eq 0 ]; then
  ok "Dependabot + SECURITY.md present in all ${#REPOS[@]} repos"
else
  fail "$cov_missing repos missing dependabot/SECURITY"
  errors=$((errors + 1))
fi

# -------- summary --------
printf "\n%s=== Summary ===%s\n" "$BOLD" "$RESET"
if [ "$errors" -eq 0 ]; then
  printf "%sOK%s — all 4 portfolio invariants hold\n" "$GREEN" "$RESET"
  exit 0
else
  printf "%sFAIL%s — %s error(s), %s warning(s)\n" "$RED" "$RESET" "$errors" "$warnings"
  exit 1
fi
