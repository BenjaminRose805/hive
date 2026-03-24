#!/usr/bin/env bash
# hive-launch.sh — Main entry point for launching a full Hive (1 manager + N workers).
set -euo pipefail

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

HIVE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Defaults
WORKERS=3
AGENTS_ARG=""
ROLES_ARG=""
BUDGET=5
MANAGER_BUDGET=10
TOKENS_FILE=""
CHANNEL_ID=""
MANAGER_BOT_ID=""
WORKER_BOT_IDS=""
PROJECT_REPO=""
TEARDOWN=false
CLEAN=false
SINGLE_BOT=false
USE_TMUX=true
TOKEN=""
BOT_ID=""
GATEWAY_PID=""

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
  --workers N           Number of workers (default: 3, used when --agents is not set)
  --agents NAMES        Comma-separated agent names (e.g. alice,bob,carol)
  --roles NAME:ROLE,…   Comma-separated name:role pairs (e.g. alice:developer,bob:qa-engineer)
  --budget N            USD budget per worker (default: 5)
  --manager-budget N    USD budget for manager (default: 10)
  --tokens-file PATH    File with bot tokens, 1 per line, manager first (required in multi-bot mode)
  --manager-bot-id ID   Manager's Discord bot user ID (required in multi-bot mode)
  --worker-bot-ids IDS  Comma-separated worker bot user IDs (required in multi-bot mode)
  --single-bot          Enable single-bot gateway mode (uses one Discord bot for all sessions)
  --token STRING        Bot token (optional — auto-reads from ~/.claude/channels/discord/.env)
  --bot-id ID           Bot user ID (optional — auto-discovered from gateway)
  --tmux                Launch each session in a tmux window (default)
  --no-tmux             Launch as background processes instead of tmux
  --teardown            Stop all running hive sessions
  --clean               With --teardown: also remove worktrees
  --help                Show this help

EXAMPLES
  # Launch a named 2-agent hive
  hive-launch.sh \
    --project-repo ~/my-project \
    --channel-id 1234567890 \
    --agents alice,bob \
    --roles alice:developer,bob:qa-engineer \
    --single-bot

  # Launch a 3-worker hive (backwards compat)
  hive-launch.sh \
    --project-repo ~/my-project \
    --channel-id 1234567890 \
    --manager-bot-id 111111111111 \
    --worker-bot-ids 222222222222,333333333333,444444444444 \
    --tokens-file ./tokens.txt

  # Single-bot mode (minimal — token auto-read, bot ID auto-discovered)
  hive-launch.sh --single-bot \
    --project-repo ~/my-project \
    --channel-id 1234567890 \
    --workers 3

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
      --agents)          AGENTS_ARG="$2"; shift 2 ;;
      --roles)           ROLES_ARG="$2"; shift 2 ;;
      --budget)          BUDGET="$2"; shift 2 ;;
      --manager-budget)  MANAGER_BUDGET="$2"; shift 2 ;;
      --tokens-file)     TOKENS_FILE="$2"; shift 2 ;;
      --manager-bot-id)  MANAGER_BOT_ID="$2"; shift 2 ;;
      --worker-bot-ids)  WORKER_BOT_IDS="$2"; shift 2 ;;
      --single-bot)      SINGLE_BOT=true; shift ;;
      --token)           TOKEN="$2"; shift 2 ;;
      --bot-id)          BOT_ID="$2"; shift 2 ;;
      --tmux)            USE_TMUX=true; shift ;;
      --no-tmux)         USE_TMUX=false; shift ;;
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
  local agents_file="$HIVE_DIR/state/agents.json"

  if [[ ! -f "$pids_file" ]]; then
    log "No pids.json found — nothing to tear down."
    exit 0
  fi

  log "Reading state from $pids_file ..."

  # Check if this is a tmux-mode hive
  local mode
  mode="$(jq -r '.mode // empty' "$pids_file" 2>/dev/null || true)"

  if [[ "$mode" == "tmux" ]]; then
    # Tmux teardown: kill the session
    local session
    session="$(jq -r '.session // "hive"' "$pids_file" 2>/dev/null || echo "hive")"
    if tmux has-session -t "$session" 2>/dev/null; then
      tmux kill-session -t "$session" 2>/dev/null && log "Killed tmux session '$session'"
    else
      log "Tmux session '$session' is not running."
    fi
  else
    # PID-based teardown (original code)

    # Kill watchdog first
    local watchdog_pid
    watchdog_pid="$(jq -r '.watchdog.pid // empty' "$pids_file" 2>/dev/null || true)"
    if [[ -n "$watchdog_pid" ]] && kill -0 "$watchdog_pid" 2>/dev/null; then
      log "Stopping watchdog (PID $watchdog_pid) ..."
      kill "$watchdog_pid" 2>/dev/null || true
    fi

    # Kill gateway (before workers, so workers can attempt deregistration)
    local gateway_pid
    gateway_pid="$(jq -r '.gateway.pid // empty' "$pids_file" 2>/dev/null || true)"
    if [[ -n "$gateway_pid" ]] && kill -0 "$gateway_pid" 2>/dev/null; then
      log "Stopping gateway (PID $gateway_pid) ..."
      kill "$gateway_pid" 2>/dev/null || true
    fi

    # Kill manager
    local manager_pid
    manager_pid="$(jq -r '.manager.pid // empty' "$pids_file" 2>/dev/null || true)"
    if [[ -n "$manager_pid" ]] && kill -0 "$manager_pid" 2>/dev/null; then
      log "Stopping manager (PID $manager_pid) ..."
      kill "$manager_pid" 2>/dev/null || true
    fi

    # Kill workers (by agent name)
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

    for pid in ${watchdog_pid:-} ${gateway_pid:-} ${manager_pid:-} $worker_pids; do
      if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
        warn "Process $pid did not exit gracefully — sending SIGKILL"
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  fi

  # Update agents.json: set each agent's status to "stopped" and record lastActive
  if [[ -f "$agents_file" ]]; then
    local stopped_ts
    stopped_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    local updated_agents
    updated_agents="$(jq --arg ts "$stopped_ts" \
      '.agents = [.agents[] | .status = "stopped" | .lastActive = $ts]' \
      "$agents_file")" || true
    if [[ -n "$updated_agents" ]]; then
      echo "$updated_agents" > "$agents_file"
      log "Updated agents.json: all agents marked stopped"
    fi
  fi

  # Clean worktrees if requested (but preserve memory dirs)
  if [[ "$CLEAN" == true ]] && [[ -d "$HIVE_DIR/worktrees" ]]; then
    log "Removing worktrees ..."
    rm -rf "$HIVE_DIR/worktrees"
  fi

  # Clean up gateway socket directory
  if [[ -d "/tmp/hive-gateway" ]]; then
    log "Removing gateway socket directory ..."
    rm -rf "/tmp/hive-gateway"
  fi

  # Clean launch scripts (but NOT memory dirs — memory persists)
  rm -f "$HIVE_DIR/state"/.launch-*.sh

  # Clear pids file
  echo '{}' > "$pids_file"

  log "Teardown complete. Agent memory preserved in state/agents/*/memory/"
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

  # Required arguments (common to both modes)
  [[ -n "$PROJECT_REPO" ]] || die "--project-repo is required"
  [[ -n "$CHANNEL_ID" ]]   || die "--channel-id is required"

  if [[ "$SINGLE_BOT" == true ]]; then
    # Auto-read token from Discord channel config if not provided
    if [[ -z "$TOKEN" ]]; then
      local env_file="$HOME/.claude/channels/discord/.env"
      if [[ -f "$env_file" ]]; then
        TOKEN=$(grep -E '^DISCORD_BOT_TOKEN=' "$env_file" | cut -d= -f2)
        if [[ -n "$TOKEN" ]]; then
          echo "  Token: auto-read from $env_file"
        fi
      fi
    fi
    [[ -n "$TOKEN" ]] || die "--token is required in --single-bot mode (or set DISCORD_BOT_TOKEN in ~/.claude/channels/discord/.env)"
    # --bot-id is optional — auto-discovered from gateway after startup
  else
    # Multi-bot mode requirements (existing validation)
    [[ -n "$MANAGER_BOT_ID" ]] || die "--manager-bot-id is required"
    [[ -n "$WORKER_BOT_IDS" ]] || die "--worker-bot-ids is required"
    [[ -n "$TOKENS_FILE" ]]    || die "--tokens-file is required"

    # Tokens file
    [[ -f "$TOKENS_FILE" ]] || die "Tokens file not found: $TOKENS_FILE"

    # Determine worker count for validation
    local worker_count_for_validation
    if [[ -n "$AGENTS_ARG" ]]; then
      worker_count_for_validation="$(echo "$AGENTS_ARG" | tr ',' '\n' | grep -c '.' || true)"
    else
      worker_count_for_validation="$WORKERS"
    fi

    local expected_lines=$(( worker_count_for_validation + 1 ))
    local actual_lines
    actual_lines="$(grep -c '.' "$TOKENS_FILE" || true)"
    if [[ "$actual_lines" -ne "$expected_lines" ]]; then
      die "Tokens file has $actual_lines non-empty lines, expected $expected_lines (1 manager + $worker_count_for_validation workers)"
    fi

    # Validate worker-bot-ids count
    local id_count
    id_count="$(echo "$WORKER_BOT_IDS" | tr ',' '\n' | grep -c '.' || true)"
    if [[ "$id_count" -ne "$worker_count_for_validation" ]]; then
      die "--worker-bot-ids has $id_count IDs but worker count is $worker_count_for_validation. They must match."
    fi
  fi

  # Repo validation
  [[ -d "$PROJECT_REPO" ]] || die "Project repo not found: $PROJECT_REPO"
  git -C "$PROJECT_REPO" rev-parse --git-dir &>/dev/null \
    || die "$PROJECT_REPO is not a git repository"
  git -C "$PROJECT_REPO" rev-parse HEAD &>/dev/null \
    || die "$PROJECT_REPO has no commits"

  # RAM check (warn if < 2GB headroom per worker)
  if command -v free &>/dev/null; then
    local avail_mb
    avail_mb="$(free -m | awk '/^Mem:/ { print $7 }')"
    local worker_count_for_ram
    if [[ -n "$AGENTS_ARG" ]]; then
      worker_count_for_ram="$(echo "$AGENTS_ARG" | tr ',' '\n' | grep -c '.' || true)"
    else
      worker_count_for_ram="$WORKERS"
    fi
    local needed_mb=$(( worker_count_for_ram * 2048 ))
    if [[ -n "$avail_mb" ]] && [[ "$avail_mb" -lt "$needed_mb" ]]; then
      warn "Available RAM (~${avail_mb}MB) may be tight for $worker_count_for_ram workers (recommend ~${needed_mb}MB free)"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Generate configs
# ---------------------------------------------------------------------------

generate_configs() {
  # Skip if configs already exist
  local manager_mcp="$HIVE_DIR/state/manager/mcp-config.json"
  if [[ -f "$manager_mcp" ]]; then
    log "Config files already exist — skipping generation. Delete state/ to regenerate."
    return 0
  fi

  log "Generating configuration files ..."

  if [[ "$SINGLE_BOT" == true ]]; then
    local gen_args=(
      --channel-id "$CHANNEL_ID"
      --project-repo "$PROJECT_REPO"
      --budget "$BUDGET"
      --single-bot
      --token "$TOKEN"
    )
    # Pass --agents if provided, otherwise fall back to --workers N
    if [[ -n "$AGENTS_ARG" ]]; then
      gen_args+=(--agents "$AGENTS_ARG")
      if [[ -n "$ROLES_ARG" ]]; then
        gen_args+=(--roles "$ROLES_ARG")
      fi
    else
      gen_args+=(--workers "$WORKERS")
    fi
    if [[ -n "$BOT_ID" ]]; then
      gen_args+=(--bot-id "$BOT_ID")
    fi
    bun run "$HIVE_DIR/bin/hive-gen-config.ts" "${gen_args[@]}"
  else
    local gen_args=(
      --channel-id "$CHANNEL_ID"
      --manager-bot-id "$MANAGER_BOT_ID"
      --worker-bot-ids "$WORKER_BOT_IDS"
      --tokens-file "$TOKENS_FILE"
      --project-repo "$PROJECT_REPO"
      --budget "$BUDGET"
    )
    if [[ -n "$AGENTS_ARG" ]]; then
      gen_args+=(--agents "$AGENTS_ARG")
      if [[ -n "$ROLES_ARG" ]]; then
        gen_args+=(--roles "$ROLES_ARG")
      fi
    else
      gen_args+=(--workers "$WORKERS")
    fi
    bun run "$HIVE_DIR/bin/hive-gen-config.ts" "${gen_args[@]}"
  fi
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
# Gateway lifecycle (single-bot mode only)
# ---------------------------------------------------------------------------

launch_gateway_tmux() {
  echo "Starting gateway in tmux window..."
  local launch_script="$HIVE_DIR/state/.launch-gateway.sh"
  cat > "$launch_script" << LAUNCH_EOF
#!/usr/bin/env bash
DISCORD_BOT_TOKEN="$TOKEN" bun run "$HIVE_DIR/bin/hive-gateway.ts" 2>&1
LAUNCH_EOF
  chmod +x "$launch_script"
  tmux new-session -d -s hive -n gateway "$launch_script"

  # Wait for health endpoint (up to 30s)
  local attempts=0
  while [ $attempts -lt 30 ]; do
    if curl -s --unix-socket /tmp/hive-gateway/gateway.sock http://localhost/health > /dev/null 2>&1; then
      local health_json
      health_json=$(curl -s --unix-socket /tmp/hive-gateway/gateway.sock http://localhost/health)
      local bot_tag
      bot_tag=$(echo "$health_json" | grep -o '"connectedAs":"[^"]*"' | cut -d'"' -f4)
      echo "  Gateway started in tmux window 'gateway', connected as $bot_tag"
      if [[ -z "$BOT_ID" ]]; then
        BOT_ID=$(echo "$health_json" | grep -o '"botId":"[^"]*"' | cut -d'"' -f4)
        if [[ -n "$BOT_ID" ]]; then
          echo "  Bot ID: auto-discovered as $BOT_ID"
        fi
      fi
      return 0
    fi
    sleep 1
    attempts=$((attempts + 1))

    # Check if the window still exists
    if ! tmux list-windows -t hive 2>/dev/null | grep -q gateway; then
      echo "ERROR: Gateway tmux window died during startup"
      return 1
    fi
  done

  echo "ERROR: Gateway health check timed out after 30s"
  return 1
}

launch_gateway() {
  echo "Starting gateway..."
  DISCORD_BOT_TOKEN="$TOKEN" bun run "$HIVE_DIR/bin/hive-gateway.ts" &
  local gateway_pid=$!

  # Wait for health endpoint (up to 30s)
  local attempts=0
  while [ $attempts -lt 30 ]; do
    # Try to reach health endpoint via Unix socket
    if curl -s --unix-socket /tmp/hive-gateway/gateway.sock http://localhost/health > /dev/null 2>&1; then
      local health_json
      health_json=$(curl -s --unix-socket /tmp/hive-gateway/gateway.sock http://localhost/health)
      local bot_tag
      bot_tag=$(echo "$health_json" | grep -o '"connectedAs":"[^"]*"' | cut -d'"' -f4)
      echo "  Gateway started (PID: $gateway_pid), connected as $bot_tag"
      if [[ -z "$BOT_ID" ]]; then
        BOT_ID=$(echo "$health_json" | grep -o '"botId":"[^"]*"' | cut -d'"' -f4)
        if [[ -n "$BOT_ID" ]]; then
          echo "  Bot ID: auto-discovered as $BOT_ID"
        fi
      fi
      GATEWAY_PID=$gateway_pid
      return 0
    fi
    sleep 1
    attempts=$((attempts + 1))

    # Check if process died
    if ! kill -0 $gateway_pid 2>/dev/null; then
      echo "ERROR: Gateway process died during startup"
      return 1
    fi
  done

  echo "ERROR: Gateway health check timed out after 30s"
  kill $gateway_pid 2>/dev/null
  return 1
}

# ---------------------------------------------------------------------------
# Compose system prompt for a named agent
# ---------------------------------------------------------------------------

compose_agent_system_prompt() {
  local agent_name="$1"
  local agent_role="$2"

  # a) Base worker prompt with {NAME} and {ROLE} substituted
  local base_prompt
  base_prompt="$(sed "s/{NAME}/$agent_name/g; s/{ROLE}/$agent_role/g" "$HIVE_DIR/config/worker-system-prompt.md")"

  # b) Base profile (always included)
  local base_profile
  base_profile="$(sed "s/{NAME}/$agent_name/g; s/{ROLE}/$agent_role/g" "$HIVE_DIR/config/profiles/_base.md")"

  # c) Role profile: use if it exists, fall back to _base.md with a warning
  local role_profile=""
  local role_profile_path="$HIVE_DIR/config/profiles/${agent_role}.md"
  if [[ -f "$role_profile_path" ]]; then
    role_profile="$(sed "s/{NAME}/$agent_name/g; s/{ROLE}/$agent_role/g" "$role_profile_path")"
  else
    warn "No profile found for role '${agent_role}' (looked for config/profiles/${agent_role}.md) — using _base.md only"
  fi

  # d) Memory prompt section (with {NAME} substituted)
  local memory_section
  memory_section="$(sed "s/{NAME}/$agent_name/g" "$HIVE_DIR/config/memory-prompt-section.md")"

  # e) Memory restoration block for this agent
  local memory_block
  memory_block="$(bun run "$HIVE_DIR/bin/hive-memory.ts" load --agent "$agent_name" 2>/dev/null || echo "## Agent Memory (${agent_name})\nNo prior memory. This is your first session.")"

  # Concatenate all sections
  printf '%s\n\n%s' "$base_prompt" "$base_profile"
  if [[ -n "$role_profile" ]]; then
    printf '\n\n%s' "$role_profile"
  fi
  printf '\n\n%s\n\n%s' "$memory_section" "$memory_block"
}

# ---------------------------------------------------------------------------
# Launch sessions
# ---------------------------------------------------------------------------

launch_hive() {
  if [[ "$USE_TMUX" == true ]]; then
    # Check tmux is available
    command -v tmux >/dev/null 2>&1 || die "tmux is required for --tmux mode. Install with: sudo apt install tmux"
    # Kill any existing hive session
    tmux kill-session -t hive 2>/dev/null || true
  fi

  # In single-bot mode, start the gateway first
  if [[ "$SINGLE_BOT" == true ]]; then
    if [[ "$USE_TMUX" == true ]]; then
      launch_gateway_tmux || die "Gateway failed to start. Aborting."
    else
      launch_gateway || die "Gateway failed to start. Aborting."
    fi
  fi

  # Read agent list from agents.json
  local agents_file="$HIVE_DIR/state/agents.json"
  [[ -f "$agents_file" ]] || die "state/agents.json not found — run config generation first"

  # Build team list for manager init prompt
  local team_list
  team_list="$(jq -r '.agents[] | "\(.name) (\(.role))"' "$agents_file" | paste -sd', ')"

  local manager_prompt
  manager_prompt="$(cat "$HIVE_DIR/config/manager-system-prompt.md")"

  log "Launching manager session ..."

  if [[ "$USE_TMUX" == true ]]; then
    local manager_init="You are the Hive coordinator for project repo: $PROJECT_REPO. Your team: $team_list. Channel ID: $CHANNEL_ID. You do NOT start work autonomously — wait for the user to tell you what to build. Read state/agents.json to learn each agent's name and role. Agents will announce themselves as READY on Discord. When instructed, decompose the project into tasks and assign them to agents by name."

    local launch_script="$HIVE_DIR/state/.launch-manager.sh"
    cat > "$launch_script" << LAUNCH_EOF
#!/usr/bin/env bash
claude --name "hive-manager" \
  --append-system-prompt "\$(cat "$HIVE_DIR/config/manager-system-prompt.md")" \
  --mcp-config "$HIVE_DIR/state/manager/mcp-config.json" \
  --max-cost-usd $MANAGER_BUDGET \
  --permission-mode bypassPermissions
LAUNCH_EOF
    chmod +x "$launch_script"

    if [[ "$SINGLE_BOT" == true ]]; then
      # Gateway already created the session; add manager as a new window
      tmux new-window -t hive -n manager "$launch_script"
    else
      tmux new-session -d -s hive -n manager "$launch_script"
    fi

    sleep 5
    if tmux capture-pane -t hive:manager -p 2>/dev/null | grep -qi "trust"; then
      tmux send-keys -t hive:manager "y" Enter
      sleep 3
    fi
    sleep 3
    tmux send-keys -t hive:manager "$manager_init" Enter
    log "  Manager started in tmux window 'manager'"
  else
    (echo "You are the Hive coordinator for project repo: $PROJECT_REPO. Your team: $team_list. Channel ID: $CHANNEL_ID. You do NOT start work autonomously — wait for the user to tell you what to build. Read state/agents.json to learn each agent's name and role. Agents will announce themselves as READY on Discord. When instructed, decompose the project into tasks and assign them to agents by name."; sleep infinity) | \
    claude --name "hive-manager" \
      --append-system-prompt "$manager_prompt" \
      --mcp-config "$HIVE_DIR/state/manager/mcp-config.json" \
      --max-cost-usd "$MANAGER_BUDGET" \
      --permission-mode bypassPermissions &
    local manager_pid=$!
    log "  Manager started (PID: $manager_pid)"
  fi

  local worker_pids=()
  local started_times=()
  local agent_names=()

  # Iterate over agents from agents.json
  while IFS= read -r agent_name; do
    agent_names+=("$agent_name")
    local agent_role
    agent_role="$(jq -r ".agents[] | select(.name == \"$agent_name\") | .role // \"developer\"" "$agents_file")"

    local worktree_dir="$HIVE_DIR/worktrees/$agent_name"

    if [[ ! -d "$worktree_dir" ]]; then
      die "Worktree not found: $worktree_dir — run config generation first"
    fi

    if [[ "$USE_TMUX" == true ]]; then
      local worker_init="You are $agent_name ($agent_role) on a Hive team with a coordinator (mention 'manager') and other agents. Your Discord channel ID is $CHANNEL_ID — always use this numeric ID with Discord tools. You can message any team member by mentioning their name. Announce yourself as READY on Discord and wait for task assignment."

      local worker_launch_script="$HIVE_DIR/state/.launch-worker-${agent_name}.sh"
      # compose_agent_system_prompt writes to stdout; capture it into the launch script
      local composed_prompt
      composed_prompt="$(compose_agent_system_prompt "$agent_name" "$agent_role")"

      # Write a launch script that uses the pre-composed prompt (stored as heredoc)
      {
        echo '#!/usr/bin/env bash'
        echo "cd \"$worktree_dir\""
        echo 'claude --name "hive-'"$agent_name"'" \'
        echo '  --append-system-prompt "$(cat <<'"'"'__PROMPT_EOF__'"'"'"'
        echo "$composed_prompt"
        echo '__PROMPT_EOF__'
        echo ')" \'
        echo "  --mcp-config \"$HIVE_DIR/state/workers/$agent_name/mcp-config.json\" \\"
        echo '  --strict-mcp-config \'
        echo "  --max-cost-usd $BUDGET \\"
        echo '  --permission-mode bypassPermissions'
      } > "$worker_launch_script"
      chmod +x "$worker_launch_script"

      tmux new-window -t hive -n "$agent_name" "$worker_launch_script"
      # Wait for Claude to initialize, handle trust prompt if it appears, then send initial prompt
      sleep 5
      if tmux capture-pane -t "hive:$agent_name" -p 2>/dev/null | grep -qi "trust"; then
        tmux send-keys -t "hive:$agent_name" "y" Enter
        sleep 3
      fi
      sleep 3
      tmux send-keys -t "hive:$agent_name" "$worker_init" Enter
      started_times+=("$(date -u +%Y-%m-%dT%H:%M:%SZ)")
      log "  Started $agent_name ($agent_role) in tmux window '$agent_name'"
    else
      local worker_init="You are $agent_name ($agent_role) on a Hive team with a coordinator (mention 'manager') and other agents. Your Discord channel ID is $CHANNEL_ID — always use this numeric ID with Discord tools. You can message any team member by mentioning their name. Announce yourself as READY on Discord and wait for task assignment."

      local composed_prompt
      composed_prompt="$(compose_agent_system_prompt "$agent_name" "$agent_role")"

      (cd "$worktree_dir" && \
      (echo "$worker_init"; sleep infinity) | \
      claude --name "hive-$agent_name" \
        --append-system-prompt "$composed_prompt" \
        --mcp-config "$HIVE_DIR/state/workers/$agent_name/mcp-config.json" \
        --strict-mcp-config \
        --max-cost-usd "$BUDGET" \
        --permission-mode bypassPermissions) &
      worker_pids+=($!)
      started_times+=("$(date -u +%Y-%m-%dT%H:%M:%SZ)")
      log "  Started $agent_name ($agent_role) (PID: ${worker_pids[-1]})"
    fi

    # Stagger agent launches slightly
    local agent_count_total
    agent_count_total="$(jq '.agents | length' "$agents_file")"
    if [[ "${#agent_names[@]}" -lt "$agent_count_total" ]]; then
      sleep 5
    fi
  done < <(jq -r '.agents[].name' "$agents_file")

  local total_agents="${#agent_names[@]}"

  # -------------------------------------------------------------------------
  # Write state to state/pids.json
  # -------------------------------------------------------------------------

  if [[ "$USE_TMUX" == true ]]; then
    local started_ts
    started_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    jq -n \
      --arg started "$started_ts" \
      --argjson workers "$total_agents" \
      '{ mode: "tmux", session: "hive", started: $started, workers: $workers }' \
      > "$HIVE_DIR/state/pids.json"
  else
    local manager_started
    manager_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    local pids_json
    if [[ "$SINGLE_BOT" == true ]] && [[ -n "$GATEWAY_PID" ]]; then
      local gateway_started
      gateway_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      pids_json=$(jq -n \
        --arg gpid "$GATEWAY_PID" \
        --arg gstarted "$gateway_started" \
        --arg mpid "$manager_pid" \
        --arg mstarted "$manager_started" \
        '{
          gateway: { pid: ($gpid | tonumber), started: $gstarted },
          manager: { pid: ($mpid | tonumber), name: "hive-manager", started: $mstarted },
          workers: [],
          watchdog: { pid: null, started: null }
        }')
    else
      pids_json=$(jq -n \
        --arg mpid "$manager_pid" \
        --arg mstarted "$manager_started" \
        '{
          manager: { pid: ($mpid | tonumber), name: "hive-manager", started: $mstarted },
          workers: [],
          watchdog: { pid: null, started: null }
        }')
    fi

    for i in $(seq 0 $(( ${#worker_pids[@]} - 1 ))); do
      local agent_name="${agent_names[$i]}"
      local agent_role
      agent_role="$(jq -r ".agents[] | select(.name == \"$agent_name\") | .role // \"developer\"" "$agents_file")"
      pids_json=$(echo "$pids_json" | jq \
        --arg name "$agent_name" \
        --arg role "$agent_role" \
        --arg wpid "${worker_pids[$i]}" \
        --arg wstarted "${started_times[$i]}" \
        '.workers += [{ name: $name, role: $role, pid: ($wpid | tonumber), started: $wstarted }]')
    done

    echo "$pids_json" > "$HIVE_DIR/state/pids.json"

    # -------------------------------------------------------------------------
    # Start PID watchdog
    # -------------------------------------------------------------------------

    # Determine the notification token based on mode
    local notify_token
    if [[ "$SINGLE_BOT" == true ]]; then
      notify_token="$TOKEN"
    else
      notify_token="$(head -1 "$TOKENS_FILE")"
    fi

    (
      while true; do
        sleep 30

        # Check workers
        if [[ -f "$HIVE_DIR/state/pids.json" ]]; then
          for entry in $(jq -r '.workers[]? | "\(.name):\(.pid)"' "$HIVE_DIR/state/pids.json" 2>/dev/null); do
            local wname="${entry%%:*}"
            local wpid="${entry##*:}"
            if [[ -n "$wpid" ]] && [[ "$wpid" != "null" ]] && ! kill -0 "$wpid" 2>/dev/null; then
              # Worker died — notify Discord
              curl -s -X POST "https://discord.com/api/v10/channels/$CHANNEL_ID/messages" \
                -H "Authorization: Bot $notify_token" \
                -H "Content-Type: application/json" \
                -d "{\"content\": \"WATCHDOG | $wname process (PID $wpid) has died. Task may need reassignment.\"}" > /dev/null 2>&1 || true
              # Remove from tracking
              jq "del(.workers[] | select(.name == \"$wname\"))" "$HIVE_DIR/state/pids.json" \
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

          # Check gateway (single-bot mode only) — auto-restart on death
          if [[ "$SINGLE_BOT" == true ]]; then
            local cur_gpid
            cur_gpid="$(jq -r '.gateway.pid // empty' "$HIVE_DIR/state/pids.json" 2>/dev/null || true)"
            if [[ -n "$cur_gpid" ]] && [[ "$cur_gpid" != "null" ]] && ! kill -0 "$cur_gpid" 2>/dev/null; then
              echo "[hive-watchdog] WARNING: Gateway process (PID $cur_gpid) has died — restarting..."
              DISCORD_BOT_TOKEN="$TOKEN" bun run "$HIVE_DIR/bin/hive-gateway.ts" &
              local new_gpid=$!
              jq --arg gpid "$new_gpid" \
                '.gateway.pid = ($gpid | tonumber)' "$HIVE_DIR/state/pids.json" \
                > "$HIVE_DIR/state/pids.json.tmp" 2>/dev/null \
                && mv "$HIVE_DIR/state/pids.json.tmp" "$HIVE_DIR/state/pids.json"
              echo "[hive-watchdog] Gateway restarted (PID $new_gpid)"
            fi
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
  fi

  # -------------------------------------------------------------------------
  # Print summary
  # -------------------------------------------------------------------------

  echo ""
  echo "=== Hive Launched Successfully ==="

  if [[ "$USE_TMUX" == true ]]; then
    echo "  Mode:     tmux session 'hive'"
    if [[ "$SINGLE_BOT" == true ]]; then
      echo "  Gateway:  tmux window 'gateway' (window 0)"
    fi
    echo "  Manager:  tmux window 'manager'"
    for aname in "${agent_names[@]}"; do
      local arole
      arole="$(jq -r ".agents[] | select(.name == \"$aname\") | .role // \"developer\"" "$agents_file")"
      echo "  Agent:    tmux window '$aname' ($arole)"
    done
  else
    if [[ "$SINGLE_BOT" == true ]]; then
      echo "  Gateway:  PID $GATEWAY_PID"
    fi
    local worker_pid_list
    worker_pid_list="$(printf '%s, ' "${worker_pids[@]}")"
    worker_pid_list="${worker_pid_list%, }"
    echo "  Manager:  PID $manager_pid"
    echo "  Agents:   $total_agents (PIDs: $worker_pid_list)"
    echo "  Watchdog: PID $watchdog_pid"
  fi

  echo "  Channel:  $CHANNEL_ID"
  echo "  Budget:   \$${BUDGET}/agent, \$${MANAGER_BUDGET} manager"
  echo ""
  echo "  Status:   hive-status.sh"
  echo "  Teardown: hive-launch.sh --teardown"
  echo "=================================="

  if [[ "$USE_TMUX" == true ]]; then
    log ""
    log "Hive launched in tmux session 'hive'"
    log "  Ctrl-B 0 -> gateway (single-bot mode only)"
    log "  Ctrl-B 1 -> manager (or 0 if no gateway)"
    log "  Ctrl-B 2+ -> agents"
    log "  Ctrl-B d -> detach (sessions keep running)"
    log ""
    tmux attach -t hive
  else
    # Wait for all background processes (optional — script can also exit and let them run)
    log "Hive is running. Use 'hive-launch.sh --teardown' to stop."
    wait
  fi
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

  # Apply bot filter patch only in multi-bot mode
  if [[ "$SINGLE_BOT" == false ]]; then
    apply_patch
  fi

  launch_hive
}

main "$@"
