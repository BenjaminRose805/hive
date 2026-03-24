#!/usr/bin/env bash
# hive-status.sh — Quick status checker for a running Hive swarm.
set -euo pipefail

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

HIVE_DIR="${HIVE_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
  cat <<'EOF'
hive-status.sh — Check the status of a running Hive swarm

USAGE
  hive-status.sh [OPTIONS]

OPTIONS
  --help    Show this help
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)  usage; exit 0 ;;
      *)          echo "Unknown argument: $1" >&2; usage; exit 1 ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Get commits ahead of main for a worktree branch
get_commits_ahead() {
  local worktree_dir="$1"
  if [[ ! -d "$worktree_dir" ]]; then
    echo "-"
    return
  fi
  local count
  count="$(git -C "$worktree_dir" rev-list --count HEAD --not main 2>/dev/null || echo "?")"
  if [[ "$count" == "?" ]]; then
    echo "-"
  else
    echo "$count ahead"
  fi
}

# Get current branch name for a worktree
get_branch() {
  local worktree_dir="$1"
  if [[ ! -d "$worktree_dir" ]]; then
    echo "-"
    return
  fi
  git -C "$worktree_dir" branch --show-current 2>/dev/null || echo "-"
}

# ---------------------------------------------------------------------------
# Tmux output
# ---------------------------------------------------------------------------

output_tmux() {
  local pids_file="$1"
  local agents_file="$HIVE_DIR/state/agents.json"

  local session
  session="$(jq -r '.session // "hive"' "$pids_file" 2>/dev/null || echo "hive")"
  local started
  started="$(jq -r '.started // empty' "$pids_file" 2>/dev/null || true)"
  local worker_count
  worker_count="$(jq -r '.workers // 0' "$pids_file" 2>/dev/null || echo 0)"

  echo ""
  echo "Hive Status"
  printf '\u2550%.0s' {1..40}
  echo ""
  echo " Session: $session"
  echo " Started: ${started:-unknown}"
  echo " Agents:  $worker_count"
  echo ""

  # Show agent names and roles if agents.json exists
  if [[ -f "$agents_file" ]]; then
    echo " Agents:"
    while IFS= read -r line; do
      echo "   $line"
    done < <(jq -r '.agents[] | "  \(.name) (\(.role)) — \(.status)"' "$agents_file" 2>/dev/null || true)
    echo ""
  fi

  if tmux has-session -t "$session" 2>/dev/null; then
    echo " Session status: RUNNING"
    echo ""
    echo " Windows:"
    tmux list-windows -t "$session" -F "   #I: #{window_name}  [#{window_activity_flag:+active}#{?window_last_flag,last,}]" 2>/dev/null || true
  else
    echo " Session status: NOT RUNNING"
    echo " (Start with: hive-launch.sh ...)"
  fi

  printf '\u2550%.0s' {1..40}
  echo ""
  echo " Attach:   tmux attach -t $session"
  echo " Teardown: hive-launch.sh --teardown"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"

  local pids_file="$HIVE_DIR/state/pids.json"

  if [[ ! -f "$pids_file" ]]; then
    echo "No hive is running (state/pids.json not found)."
    echo "Launch one with: hive-launch.sh --project-repo /path/to/repo --channel-id <id>"
    exit 1
  fi

  # Validate it's valid JSON
  if ! jq '.' "$pids_file" >/dev/null 2>&1; then
    echo "ERROR: state/pids.json is not valid JSON" >&2
    exit 1
  fi

  output_tmux "$pids_file"
}

main "$@"
