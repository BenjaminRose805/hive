#!/usr/bin/env bash
# hive-integrate.sh - Merge completed worker branches into a target branch
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
REPO=""
WORKERS=""
TARGET="main"
TEST_CMD=""
DRY_RUN=false
AUTO_RESOLVE=false

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF'
Usage: hive-integrate.sh --repo PATH --workers LIST [options]

Merges completed worker branches back into a target branch, runs tests,
and handles conflicts.

Required:
  --repo PATH         Path to the git repository
  --workers LIST      Comma-separated worker IDs to integrate (e.g., worker-01,worker-03)

Options:
  --target BRANCH     Target branch to merge into (default: main)
  --test-cmd CMD      Command to run tests after merge (auto-detected if omitted)
  --dry-run           Show merge plan without executing
  --auto-resolve      Auto-resolve trivial conflicts (different files only)
  --help              Show this help and exit

Examples:
  hive-integrate.sh --repo /path/to/repo --workers worker-01,worker-02 --target main
  hive-integrate.sh --repo /path/to/repo --workers worker-01 --dry-run
  hive-integrate.sh --repo /path/to/repo --workers worker-01,worker-02 --auto-resolve --test-cmd "make test"
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)       REPO="$2";       shift 2 ;;
    --workers)    WORKERS="$2";    shift 2 ;;
    --target)     TARGET="$2";     shift 2 ;;
    --test-cmd)   TEST_CMD="$2";   shift 2 ;;
    --dry-run)    DRY_RUN=true;    shift   ;;
    --auto-resolve) AUTO_RESOLVE=true; shift ;;
    --help|-h)    usage; exit 0    ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
die() { echo "ERROR: $*" >&2; exit 1; }

require_arg() {
  [[ -n "${2:-}" ]] || die "--$1 is required"
}

# Auto-detect test command from repo root
detect_test_cmd() {
  local root="$1"
  if [[ -f "$root/package.json" ]]; then
    # Check if there is a "test" script defined
    if command -v node >/dev/null 2>&1 && node -e "
      const p = require('$root/package.json');
      process.exit((p.scripts && p.scripts.test) ? 0 : 1);
    " 2>/dev/null; then
      # Prefer bun if available
      if command -v bun >/dev/null 2>&1; then
        echo "bun test"
      else
        echo "npm test"
      fi
      return
    fi
  fi
  if [[ -f "$root/Makefile" ]] && grep -qE '^test[[:space:]]*:' "$root/Makefile" 2>/dev/null; then
    echo "make test"
    return
  fi
  if [[ -f "$root/pytest.ini" || -f "$root/setup.py" || -f "$root/pyproject.toml" ]]; then
    echo "pytest"
    return
  fi
  echo ""
}

# ---------------------------------------------------------------------------
# Validate required args
# ---------------------------------------------------------------------------
require_arg "repo"    "${REPO:-}"
require_arg "workers" "${WORKERS:-}"

# Resolve absolute path
REPO="$(cd "$REPO" 2>/dev/null && pwd)" || die "Repository path does not exist: $REPO"

# Verify it is a git repo
[[ -d "$REPO/.git" ]] || die "Not a git repository: $REPO"

# Split workers into array
IFS=',' read -ra WORKER_LIST <<< "$WORKERS"
[[ ${#WORKER_LIST[@]} -gt 0 ]] || die "No workers specified"

# ---------------------------------------------------------------------------
# DRY-RUN mode
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" = true ]]; then
  echo "═══════════════════════════════════"
  echo "  Hive Integration Dry-Run Plan"
  echo "═══════════════════════════════════"
  echo "  Repository : $REPO"
  echo "  Target     : $TARGET"
  echo "  Workers    : ${WORKER_LIST[*]}"
  echo "═══════════════════════════════════"
  echo ""

  cd "$REPO"

  # Verify target branch exists
  git rev-parse --verify "refs/heads/$TARGET" >/dev/null 2>&1 \
    || die "Target branch '$TARGET' does not exist"

  for WORKER in "${WORKER_LIST[@]}"; do
    WORKER="$(echo "$WORKER" | xargs)"  # trim whitespace
    BRANCH="hive/$WORKER"

    echo "── $BRANCH ──────────────────────────"

    if ! git rev-parse --verify "refs/heads/$BRANCH" >/dev/null 2>&1; then
      echo "  [SKIP] Branch '$BRANCH' does not exist"
      echo ""
      continue
    fi

    COMMIT_COUNT=$(git log --oneline "$TARGET..$BRANCH" | wc -l | xargs)
    echo "  Commits ahead of $TARGET: $COMMIT_COUNT"
    echo ""

    if [[ "$COMMIT_COUNT" -gt 0 ]]; then
      echo "  Commits:"
      git log --oneline "$TARGET..$BRANCH" | sed 's/^/    /'
      echo ""
      echo "  Files changed:"
      git diff --stat "$TARGET...$BRANCH" | sed 's/^/    /'
    else
      echo "  (no commits ahead of $TARGET)"
    fi
    echo ""
  done

  echo "Dry-run complete. No changes made."
  exit 0
fi

# ---------------------------------------------------------------------------
# Normal mode
# ---------------------------------------------------------------------------

cd "$REPO"

# Verify target branch exists
git rev-parse --verify "refs/heads/$TARGET" >/dev/null 2>&1 \
  || die "Target branch '$TARGET' does not exist"

# Verify each worker branch exists
for WORKER in "${WORKER_LIST[@]}"; do
  WORKER="$(echo "$WORKER" | xargs)"
  BRANCH="hive/$WORKER"
  git rev-parse --verify "refs/heads/$BRANCH" >/dev/null 2>&1 \
    || die "Worker branch '$BRANCH' does not exist"
done

# Verify working directory is clean
if ! git diff --quiet || ! git diff --cached --quiet; then
  die "Working directory has uncommitted changes. Commit or stash them before integrating."
fi

# Record pre-merge SHA for rollback instructions
PRE_MERGE_SHA="$(git rev-parse HEAD)"

# Checkout target branch
echo "Checking out '$TARGET'..."
git checkout "$TARGET"

MERGED_COUNT=0
MERGED_WORKERS=()

for WORKER in "${WORKER_LIST[@]}"; do
  WORKER="$(echo "$WORKER" | xargs)"
  BRANCH="hive/$WORKER"
  echo ""
  echo "Merging $BRANCH..."

  if [[ "$AUTO_RESOLVE" = true ]]; then
    if ! git merge --no-ff "$BRANCH" -m "hive: integrate $WORKER" 2>&1; then
      CONFLICTING="$(git diff --name-only --diff-filter=U 2>/dev/null || true)"
      if [[ -z "$CONFLICTING" ]]; then
        die "Merge failed for $WORKER with no conflicting files detected. Manual resolution required."
      fi
      echo "  Auto-resolving conflicts in:"
      echo "$CONFLICTING" | sed 's/^/    - /'
      # Accept 'theirs' for each conflicting file
      # shellcheck disable=SC2086
      if git checkout --theirs $CONFLICTING 2>/dev/null \
          && git add $CONFLICTING \
          && git commit --no-edit -m "hive: integrate $WORKER (auto-resolved conflicts)" 2>/dev/null; then
        echo "  Auto-resolve succeeded"
      else
        echo ""
        echo "ERROR: Cannot auto-resolve conflicts in:"
        echo "$CONFLICTING" | sed 's/^/  - /'
        echo ""
        echo "To rollback all merges so far:"
        echo "  git reset --hard $PRE_MERGE_SHA"
        exit 1
      fi
    fi
  else
    if ! git merge --no-ff "$BRANCH" -m "hive: integrate $WORKER" 2>&1; then
      CONFLICTING="$(git diff --name-only --diff-filter=U 2>/dev/null || true)"
      echo ""
      echo "ERROR: Merge conflict integrating $WORKER"
      echo "Conflicting files:"
      echo "$CONFLICTING" | sed 's/^/  - /'
      echo ""
      echo "To resolve manually:"
      echo "  1. Fix conflicts in the files above"
      echo "  2. git add <resolved-files>"
      echo "  3. git commit"
      echo ""
      echo "To rollback all merges:"
      echo "  git reset --hard $PRE_MERGE_SHA"
      exit 1
    fi
  fi

  echo "  ✓ Merged $BRANCH"
  MERGED_COUNT=$((MERGED_COUNT + 1))
  MERGED_WORKERS+=("$WORKER")
done

# ---------------------------------------------------------------------------
# Test detection and execution
# ---------------------------------------------------------------------------
TEST_RESULT="skipped"
TEST_DETAIL="(no test command found)"

if [[ -z "$TEST_CMD" ]]; then
  TEST_CMD="$(detect_test_cmd "$REPO")"
fi

if [[ -n "$TEST_CMD" ]]; then
  echo ""
  echo "Running tests: $TEST_CMD"
  TEST_OUTPUT_FILE="$(mktemp)"
  if eval "$TEST_CMD" 2>&1 | tee "$TEST_OUTPUT_FILE"; then
    TEST_RESULT="passed"
    # Try to parse a summary line for display
    SUMMARY_LINE="$(grep -Ei '[0-9]+ (passing|passed|tests? passed|ok)' "$TEST_OUTPUT_FILE" | tail -1 || true)"
    TEST_DETAIL="${SUMMARY_LINE:-}"
    echo "  ✓ All tests passed"
  else
    TEST_RESULT="FAILED"
    TEST_DETAIL=""
    echo ""
    echo "✗ Tests failed!"
    echo "To rollback: git reset --hard $PRE_MERGE_SHA"
    rm -f "$TEST_OUTPUT_FILE"
    exit 1
  fi
  rm -f "$TEST_OUTPUT_FILE"
else
  echo ""
  echo "WARNING: No test command found — skipping tests."
  echo "  Pass --test-cmd to specify one, or add package.json/Makefile/pytest.ini."
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
POST_MERGE_SHA="$(git rev-parse HEAD)"

echo ""
echo "═══════════════════════════════════"
echo "  Integration Complete"
echo "═══════════════════════════════════"
echo "  Workers merged : $(IFS=', '; echo "${MERGED_WORKERS[*]}")"
echo "  Target branch  : $TARGET"
echo "  Merge commits  : $MERGED_COUNT"
if [[ "$TEST_RESULT" = "skipped" ]]; then
  echo "  Tests          : skipped"
elif [[ -n "$TEST_DETAIL" ]]; then
  echo "  Tests          : $TEST_RESULT ($TEST_DETAIL)"
else
  echo "  Tests          : $TEST_RESULT"
fi
echo "  Pre-merge SHA  : ${PRE_MERGE_SHA:0:7}"
echo "  Post-merge SHA : ${POST_MERGE_SHA:0:7}"
echo "═══════════════════════════════════"
