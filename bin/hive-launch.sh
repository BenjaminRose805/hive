#!/usr/bin/env bash
# hive-launch.sh — Main entry point for launching a full Hive (1 manager + N workers).
set -euo pipefail

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

HIVE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Defaults
WORKERS=3
BUDGET=5
MANAGER_BUDGET=10
TOKENS_FILE=""
CHANNEL_ID=""
MANAGER_BOT_ID=""
WORKER_BOT_IDS=""
PROJECT_REPO=""
TEARDOWN=false
CLEAN=false

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

usage() {
  cat <<'EOF'
hive-launch.sh — Launch or tear down a full Hive swarm

USAGE
  hive-launch.sh --project-repo /path/to/repo --channel-id <id> [OPTIONS]

OPTIONS
  --project-repo PATH   Git repository to work on (required)
  --channel-id ID       Discord channel ID for communication (required)
  --workers N           Number of workers (default: 3)
  --budget N            USD budget per worker (default: 5)
  --manager-budget N    USD budget for manager (default: 10)
  --tokens-file PATH    File with bot tokens, 1 per line, manager first (required)
  --manager-bot-id ID   Manager's Discord bot user ID (required)
  --worker-bot-ids IDS  Comma-separated worker bot user IDs (required)
  --teardown            Stop all running hive sessions
  --clean               With --teardown: also remove worktrees
  --help                Show this help

EXAMPLES
  # Launch a 3-worker hive
  hive-launch.sh \
    --project-repo ~/my-project \
    --channel-id 1234567890 \
    --manager-bot-id 111111111111 \
    --worker-bot-ids 222222222222,333333333333,444444444444 \
    --tokens-file ./tokens.txt

  # Tear down all running sessions
  hive-launch.sh --teardown

  # Tear down and remove worktrees
  hive-launch.sh --teardown --clean
EOF
}

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------

log()  { echo "[hive] $*"; }
warn() { echo "[hive] WARNING: $*" >&2; }
die()  { echo "[hive] ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)         usage; exit 0 ;;
      --project-repo)    PROJECT_REPO="$2"; shift 2 ;;
      --channel-id)      CHANNEL_ID="$2"; shift 2 ;;
      --workers)         WORKERS="$2"; shift 2 ;;
      --budget)          BUDGET="$2"; shift 2 ;;
      --manager-budget)  MANAGER_BUDGET="$2"; shift 2 ;;
      --tokens-file)     TOKENS_FILE="$2"; shift 2 ;;
      --manager-bot-id)  MANAGER_BOT_ID="$2"; shift 2 ;;
      --worker-bot-ids)  WORKER_BOT_IDS="$2"; shift 2 ;;
      --teardown)        TEARDOWN=true; shift ;;
      --clean)           CLEAN=true; shift ;;
      *)                 die "Unknown argument: $1. Run with --help for usage." ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Teardown
# ---------------------------------------------------------------------------

do_teardown() {
  local pids_file="$HIVE_DIR/state/pids.json"

  if [[ ! -f "$pids_file" ]]; then
    log "No pids.json found — nothing to tear down."
    exit 0
  fi

  log "Reading PIDs from $pids_file ..."

  # Kill watchdog first
  local watchdog_pid
  watchdog_pid="$(jq -r '.watchdog.pid // empty' "$pids_file" 2>/dev/null || true)"
  if [[ -n "$watchdog_pid" ]] && kill -0 "$watchdog_pid" 2>/dev/null; then
    log "Stopping watchdog (PID $watchdog_pid) ..."
    kill "$watchdog_pid" 2>/dev/null || true
  fi

  # Kill manager
  local manager_pid
  manager_pid="$(jq -r '.manager.pid // empty' "$pids_file" 2>/dev/null || true)"
  if [[ -n "$manager_pid" ]] && kill -0 "$manager_pid" 2>/dev/null; then
    log "Stopping manager (PID $manager_pid) ..."
    kill "$manager_pid" 2>/dev/null || true
  fi

  # Kill workers
  local worker_pids
  worker_pids="$(jq -r '.workers[]?.pid // empty' "$pids_file" 2>/dev/null || true)"
  for wpid in $worker_pids; do
    if [[ -n "$wpid" ]] && kill -0 "$wpid" 2>/dev/null; then
      log "Stopping worker (PID $wpid) ..."
      kill "$wpid" 2>/dev/null || true
    fi
  done

  # Brief wait, then SIGKILL survivors
  sleep 2

  for pid in $watchdog_pid $manager_pid $worker_pids; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      warn "Process $pid did not exit gracefully — sending SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done

  # Clean worktrees if requested
  if [[ "$CLEAN" == true ]] && [[ -d "$HIVE_DIR/worktrees" ]]; then
    log "Removing worktrees ..."
    rm -rf "$HIVE_DIR/worktrees"
  fi

  # Clear pids file
  echo '{}' > "$pids_file"

  log "Teardown complete."
  exit 0
}

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

validate_prerequisites() {
  # Required CLI tools
  for cmd in claude bun git; do
    if ! command -v "$cmd" &>/dev/null; then
      die "'$cmd' not found on PATH. Please install it first."
    fi
  done

  # Required arguments
  [[ -n "$PROJECT_REPO" ]]   || die "--project-repo is required"
  [[ -n "$CHANNEL_ID" ]]     || die "--channel-id is required"
  [[ -n "$MANAGER_BOT_ID" ]] || die "--manager-bot-id is required"
  [[ -n "$WORKER_BOT_IDS" ]] || die "--worker-bot-ids is required"
  [[ -n "$TOKENS_FILE" ]]    || die "--tokens-file is required"

  # Repo validation
  [[ -d "$PROJECT_REPO" ]] || die "Project repo not found: $PROJECT_REPO"
  git -C "$PROJECT_REPO" rev-parse --git-dir &>/dev/null \
    || die "$PROJECT_REPO is not a git repository"
  git -C "$PROJECT_REPO" rev-parse HEAD &>/dev/null \
    || die "$PROJECT_REPO has no commits"

  # Tokens file
  [[ -f "$TOKENS_FILE" ]] || die "Tokens file not found: $TOKENS_FILE"

  local expected_lines=$(( WORKERS + 1 ))
  local actual_lines
  actual_lines="$(grep -c '.' "$TOKENS_FILE" || true)"
  if [[ "$actual_lines" -ne "$expected_lines" ]]; then
    die "Tokens file has $actual_lines non-empty lines, expected $expected_lines (1 manager + $WORKERS workers)"
  fi

  # Validate worker-bot-ids count
  local id_count
  id_count="$(echo "$WORKER_BOT_IDS" | tr ',' '\n' | grep -c '.' || true)"
  if [[ "$id_count" -ne "$WORKERS" ]]; then
    die "--worker-bot-ids has $id_count IDs but --workers is $WORKERS. They must match."
  fi

  # RAM check (warn if < 2GB headroom per worker)
  if command -v free &>/dev/null; then
    local avail_mb
    avail_mb="$(free -m | awk '/^Mem:/ { print $7 }')"
    local needed_mb=$(( WORKERS * 2048 ))
    if [[ -n "$avail_mb" ]] && [[ "$avail_mb" -lt "$needed_mb" ]]; then
      warn "Available RAM (~${avail_mb}MB) may be tight for $WORKERS workers (recommend ~${needed_mb}MB free)"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Generate configs
# ---------------------------------------------------------------------------

generate_configs() {
  # Skip if configs already exist for the right worker count
  local manager_mcp="$HIVE_DIR/state/manager/mcp-config.json"
  if [[ -f "$manager_mcp" ]]; then
    log "Config files already exist — skipping generation. Delete state/ to regenerate."
    return 0
  fi

  log "Generating configuration files ..."
  bun run "$HIVE_DIR/bin/hive-gen-config.ts" \
    --workers "$WORKERS" \
    --channel-id "$CHANNEL_ID" \
    --manager-bot-id "$MANAGER_BOT_ID" \
    --worker-bot-ids "$WORKER_BOT_IDS" \
    --tokens-file "$TOKENS_FILE" \
    --project-repo "$PROJECT_REPO" \
    --budget "$BUDGET"
}

# ---------------------------------------------------------------------------
# Apply bot filter patch
# ---------------------------------------------------------------------------

apply_patch() {
  local patch_script="$HIVE_DIR/patches/apply-patch.sh"
  if [[ -f "$patch_script" ]]; then
    log "Applying bot filter patch ..."
    bash "$patch_script"
  else
    warn "Patch script not found at $patch_script — skipping"
  fi
}

# ---------------------------------------------------------------------------
# Launch sessions
# ---------------------------------------------------------------------------

launch_hive() {
  local manager_prompt
  manager_prompt="$(cat "$HIVE_DIR/config/manager-system-prompt.md")"

  local worker_count_padded
  worker_count_padded="$(printf '%02d' "$WORKERS")"

  log "Launching manager session ..."
  claude --name "hive-manager" \
    --append-system-prompt "$manager_prompt" \
    --mcp-config "$HIVE_DIR/state/manager/mcp-config.json" \
    --max-budget-usd "$MANAGER_BUDGET" \
    --permission-mode bypassPermissions \
    -p "You are the Hive Manager. Project repo: $PROJECT_REPO. You have $WORKERS workers available (worker-01 through worker-$worker_count_padded). Channel ID: $CHANNEL_ID. Workers are starting up now and will announce themselves as READY on Discord. Begin by reading the project repo to understand what needs to be built, then decompose into tasks and assign to workers as they come online." &
  local manager_pid=$!
  log "  Manager started (PID: $manager_pid)"

  local worker_pids=()
  local started_times=()

  for i in $(seq 1 "$WORKERS"); do
    local worker_id
    worker_id="$(printf '%02d' "$i")"

    local worker_prompt
    worker_prompt="$(sed "s/{NN}/$worker_id/g" "$HIVE_DIR/config/worker-system-prompt.md")"

    local worktree_dir="$HIVE_DIR/worktrees/worker-$worker_id"

    if [[ ! -d "$worktree_dir" ]]; then
      die "Worktree not found: $worktree_dir — run config generation first"
    fi

    (cd "$worktree_dir" && \
    claude --name "hive-worker-$worker_id" \
      --append-system-prompt "$worker_prompt" \
      --mcp-config "$HIVE_DIR/state/workers/worker-$worker_id/mcp-config.json" \
      --strict-mcp-config \
      --max-budget-usd "$BUDGET" \
      --permission-mode bypassPermissions \
      -p "You are Hive Worker $worker_id. Announce yourself as READY on Discord and wait for task assignment from the manager.") &
    worker_pids+=($!)
    started_times+=("$(date -u +%Y-%m-%dT%H:%M:%SZ)")
    log "  Started worker-$worker_id (PID: ${worker_pids[-1]})"

    if [[ "$i" -lt "$WORKERS" ]]; then
      sleep 5
    fi
  done

  # -------------------------------------------------------------------------
  # Write PIDs to state/pids.json
  # -------------------------------------------------------------------------

  local manager_started
  manager_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local pids_json
  pids_json=$(jq -n \
    --arg mpid "$manager_pid" \
    --arg mstarted "$manager_started" \
    '{
      manager: { pid: ($mpid | tonumber), name: "hive-manager", started: $mstarted },
      workers: [],
      watchdog: { pid: null, started: null }
    }')

  for i in $(seq 0 $(( ${#worker_pids[@]} - 1 ))); do
    local wid
    wid="$(printf '%02d' $(( i + 1 )))"
    pids_json=$(echo "$pids_json" | jq \
      --arg wid "$wid" \
      --arg wpid "${worker_pids[$i]}" \
      --arg wstarted "${started_times[$i]}" \
      '.workers += [{ id: $wid, pid: ($wpid | tonumber), name: ("hive-worker-" + $wid), started: $wstarted }]')
  done

  echo "$pids_json" > "$HIVE_DIR/state/pids.json"

  # -------------------------------------------------------------------------
  # Start PID watchdog
  # -------------------------------------------------------------------------

  local manager_token
  manager_token="$(head -1 "$TOKENS_FILE")"

  (
    while true; do
      sleep 30

      # Check workers
      if [[ -f "$HIVE_DIR/state/pids.json" ]]; then
        for entry in $(jq -r '.workers[]? | "\(.id):\(.pid)"' "$HIVE_DIR/state/pids.json" 2>/dev/null); do
          local wid="${entry%%:*}"
          local wpid="${entry##*:}"
          if [[ -n "$wpid" ]] && [[ "$wpid" != "null" ]] && ! kill -0 "$wpid" 2>/dev/null; then
            # Worker died — notify Discord
            curl -s -X POST "https://discord.com/api/v10/channels/$CHANNEL_ID/messages" \
              -H "Authorization: Bot $manager_token" \
              -H "Content-Type: application/json" \
              -d "{\"content\": \"WATCHDOG | worker-$wid process (PID $wpid) has died. Task may need reassignment.\"}" > /dev/null 2>&1 || true
            # Remove from tracking
            jq "del(.workers[] | select(.id == \"$wid\"))" "$HIVE_DIR/state/pids.json" \
              > "$HIVE_DIR/state/pids.json.tmp" 2>/dev/null \
              && mv "$HIVE_DIR/state/pids.json.tmp" "$HIVE_DIR/state/pids.json"
          fi
        done

        # Check manager
        local mpid
        mpid="$(jq -r '.manager.pid // empty' "$HIVE_DIR/state/pids.json" 2>/dev/null || true)"
        if [[ -n "$mpid" ]] && [[ "$mpid" != "null" ]] && ! kill -0 "$mpid" 2>/dev/null; then
          echo "[hive-watchdog] WARNING: Manager process (PID $mpid) has died!"
          jq '.manager.pid = null' "$HIVE_DIR/state/pids.json" \
            > "$HIVE_DIR/state/pids.json.tmp" 2>/dev/null \
            && mv "$HIVE_DIR/state/pids.json.tmp" "$HIVE_DIR/state/pids.json"
        fi
      fi
    done
  ) &
  local watchdog_pid=$!

  # Update pids.json with watchdog PID
  jq --arg wpid "$watchdog_pid" \
    '.watchdog = { pid: ($wpid | tonumber), started: (now | strftime("%Y-%m-%dT%H:%M:%SZ")) }' \
    "$HIVE_DIR/state/pids.json" > "$HIVE_DIR/state/pids.json.tmp" \
    && mv "$HIVE_DIR/state/pids.json.tmp" "$HIVE_DIR/state/pids.json"

  # -------------------------------------------------------------------------
  # Print summary
  # -------------------------------------------------------------------------

  local worker_pid_list
  worker_pid_list="$(printf '%s, ' "${worker_pids[@]}")"
  worker_pid_list="${worker_pid_list%, }"

  echo ""
  echo "=== Hive Launched Successfully ==="
  echo "  Manager:  PID $manager_pid"
  echo "  Workers:  $WORKERS (PIDs: $worker_pid_list)"
  echo "  Watchdog: PID $watchdog_pid"
  echo "  Channel:  $CHANNEL_ID"
  echo "  Budget:   \$${BUDGET}/worker, \$${MANAGER_BUDGET} manager"
  echo ""
  echo "  Status:   hive-status.sh"
  echo "  Teardown: hive-launch.sh --teardown"
  echo "=================================="

  # Wait for all background processes (optional — script can also exit and let them run)
  log "Hive is running. Use 'hive-launch.sh --teardown' to stop."
  wait
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"

  if [[ "$TEARDOWN" == true ]]; then
    do_teardown
  fi

  validate_prerequisites
  generate_configs
  apply_patch
  launch_hive
}

main "$@"
