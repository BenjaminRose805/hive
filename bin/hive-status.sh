#!/usr/bin/env bash
# hive-status.sh — Quick status checker for a running Hive swarm.
set -euo pipefail

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

HIVE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
JSON_OUTPUT=false

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
  cat <<'EOF'
hive-status.sh — Check the status of a running Hive swarm

USAGE
  hive-status.sh [OPTIONS]

OPTIONS
  --json    Output status as JSON instead of a formatted table
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
      --json)     JSON_OUTPUT=true; shift ;;
      *)          echo "Unknown argument: $1" >&2; usage; exit 1 ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

check_pid() {
  local pid="$1"
  if [[ -z "$pid" ]] || [[ "$pid" == "null" ]]; then
    echo "n/a"
  elif kill -0 "$pid" 2>/dev/null; then
    echo "alive"
  else
    echo "dead"
  fi
}

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

# Calculate uptime from the earliest started timestamp in pids.json
get_uptime() {
  local pids_file="$1"
  local started
  started="$(jq -r '.manager.started // empty' "$pids_file" 2>/dev/null || true)"
  if [[ -z "$started" ]]; then
    echo "unknown"
    return
  fi
  local started_epoch
  started_epoch="$(date -d "$started" +%s 2>/dev/null || echo "")"
  if [[ -z "$started_epoch" ]]; then
    echo "unknown"
    return
  fi
  local now_epoch
  now_epoch="$(date +%s)"
  local diff=$(( now_epoch - started_epoch ))

  if [[ "$diff" -lt 60 ]]; then
    echo "${diff} seconds"
  elif [[ "$diff" -lt 3600 ]]; then
    echo "$(( diff / 60 )) minutes"
  else
    local hours=$(( diff / 3600 ))
    local mins=$(( (diff % 3600) / 60 ))
    echo "${hours}h ${mins}m"
  fi
}

# ---------------------------------------------------------------------------
# JSON output
# ---------------------------------------------------------------------------

output_json() {
  local pids_file="$1"

  local result
  result="$(jq '.' "$pids_file")"

  # Enrich with live status
  local manager_pid
  manager_pid="$(jq -r '.manager.pid // empty' "$pids_file" 2>/dev/null || true)"
  local manager_status
  manager_status="$(check_pid "$manager_pid")"

  local watchdog_pid
  watchdog_pid="$(jq -r '.watchdog.pid // empty' "$pids_file" 2>/dev/null || true)"
  local watchdog_status
  watchdog_status="$(check_pid "$watchdog_pid")"

  local uptime
  uptime="$(get_uptime "$pids_file")"

  # Build enriched JSON
  local output
  output="$(jq -n \
    --arg manager_status "$manager_status" \
    --arg watchdog_status "$watchdog_status" \
    --arg uptime "$uptime" \
    --argjson raw "$result" \
    '$raw + { manager: ($raw.manager + { status: $manager_status }), watchdog: ($raw.watchdog + { status: $watchdog_status }), uptime: $uptime }')"

  # Add per-worker status
  local worker_count
  worker_count="$(jq '.workers | length' "$pids_file" 2>/dev/null || echo 0)"

  for i in $(seq 0 $(( worker_count - 1 ))); do
    local wpid
    wpid="$(jq -r ".workers[$i].pid // empty" "$pids_file" 2>/dev/null || true)"
    local wstatus
    wstatus="$(check_pid "$wpid")"
    local wid
    wid="$(jq -r ".workers[$i].id" "$pids_file" 2>/dev/null || true)"
    local worktree_dir="$HIVE_DIR/worktrees/worker-$wid"
    local branch
    branch="$(get_branch "$worktree_dir")"
    local commits
    commits="$(get_commits_ahead "$worktree_dir")"

    output="$(echo "$output" | jq \
      --argjson idx "$i" \
      --arg status "$wstatus" \
      --arg branch "$branch" \
      --arg commits "$commits" \
      '.workers[$idx] += { status: $status, branch: $branch, commits: $commits }')"
  done

  echo "$output" | jq '.'
}

# ---------------------------------------------------------------------------
# Table output
# ---------------------------------------------------------------------------

output_table() {
  local pids_file="$1"

  local uptime
  uptime="$(get_uptime "$pids_file")"

  echo ""
  echo "Hive Status"
  printf '\u2550%.0s' {1..51}
  echo ""
  printf " %-10s \u2502 %-6s \u2502 %-6s \u2502 %-16s \u2502 %s\n" \
    "Role" "PID" "Status" "Branch" "Commits"
  printf '\u2500%.0s' {1..12}
  printf '\u253c'
  printf '\u2500%.0s' {1..8}
  printf '\u253c'
  printf '\u2500%.0s' {1..8}
  printf '\u253c'
  printf '\u2500%.0s' {1..18}
  printf '\u253c'
  printf '\u2500%.0s' {1..8}
  echo ""

  # Manager row
  local manager_pid
  manager_pid="$(jq -r '.manager.pid // empty' "$pids_file" 2>/dev/null || true)"
  local manager_status
  manager_status="$(check_pid "$manager_pid")"
  local manager_pid_display="${manager_pid:-n/a}"

  printf " %-10s \u2502 %-6s \u2502 %-6s \u2502 %-16s \u2502 %s\n" \
    "manager" "$manager_pid_display" "$manager_status" "main" "-"

  # Worker rows
  local worker_count
  worker_count="$(jq '.workers | length' "$pids_file" 2>/dev/null || echo 0)"

  for i in $(seq 0 $(( worker_count - 1 ))); do
    local wid
    wid="$(jq -r ".workers[$i].id" "$pids_file" 2>/dev/null || true)"
    local wpid
    wpid="$(jq -r ".workers[$i].pid" "$pids_file" 2>/dev/null || true)"
    local wstatus
    wstatus="$(check_pid "$wpid")"
    local worktree_dir="$HIVE_DIR/worktrees/worker-$wid"
    local branch
    branch="$(get_branch "$worktree_dir")"
    local commits
    commits="$(get_commits_ahead "$worktree_dir")"

    printf " %-10s \u2502 %-6s \u2502 %-6s \u2502 %-16s \u2502 %s\n" \
      "worker-$wid" "$wpid" "$wstatus" "$branch" "$commits"
  done

  printf '\u2550%.0s' {1..51}
  echo ""

  # Watchdog
  local watchdog_pid
  watchdog_pid="$(jq -r '.watchdog.pid // empty' "$pids_file" 2>/dev/null || true)"
  local watchdog_status
  watchdog_status="$(check_pid "$watchdog_pid")"
  echo " Watchdog: PID ${watchdog_pid:-n/a} ($watchdog_status)"
  echo " Uptime: $uptime"
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

  if [[ "$JSON_OUTPUT" == true ]]; then
    output_json "$pids_file"
  else
    output_table "$pids_file"
  fi
}

main "$@"
