#!/usr/bin/env bash
# hive-launch.sh — Main entry point for launching a full Hive (1 manager + N workers).
set -euo pipefail

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

HIVE_DIR="${HIVE_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
# Defaults
WORKERS=3
AGENTS_ARG=""
ROLES_ARG=""
BUDGET=5
MANAGER_BUDGET=10
CHANNEL_ID=""
PROJECT_REPO=""
TEARDOWN=false
CLEAN=false
TOKEN=""
BOT_ID=""
TOOLS_OVERRIDE=""

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
  --token STRING        Bot token (optional — auto-reads from ~/.claude/channels/discord/.env)
  --bot-id ID           Bot user ID (optional — auto-discovered from gateway)
  --teardown            Stop all running hive sessions
  --clean               With --teardown: also remove worktrees
  --tools SPEC          Per-agent tool overrides with merge semantics:
                          alice:+puppeteer     Add tool to role defaults
                          alice:-github        Remove tool from role defaults
                          alice:=ctx7+fetch    Replace role tools entirely
                          alice:tool           Bare name = add (same as +)
                          Multiple: alice:+puppeteer,bob:-github
  --help                Show this help

EXAMPLES
  # Launch a named 2-agent hive
  hive-launch.sh \
    --project-repo ~/my-project \
    --channel-id 1234567890 \
    --agents alice,bob \
    --roles alice:developer,bob:qa-engineer

  # Launch a 3-worker hive (minimal — token auto-read, bot ID auto-discovered)
  hive-launch.sh \
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
      --token)           TOKEN="$2"; shift 2 ;;
      --bot-id)          BOT_ID="$2"; shift 2 ;;
      --teardown)        TEARDOWN=true; shift ;;
      --clean)           CLEAN=true; shift ;;
      --tools)           TOOLS_OVERRIDE="$2"; shift 2 ;;
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

  # Tmux teardown: kill the session
  local session
  session="$(jq -r '.session // "hive"' "$pids_file" 2>/dev/null || echo "hive")"
  if tmux has-session -t "$session" 2>/dev/null; then
    tmux kill-session -t "$session" 2>/dev/null && log "Killed tmux session '$session'"
  else
    log "Tmux session '$session' is not running."
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

  # Stop Hive Mind daemon (after workers, so they can flush final deltas)
  if [[ -f "$HIVE_DIR/.hive/mind/daemon.pid" ]]; then
    local mind_pid
    mind_pid="$(jq -r '.pid // empty' "$HIVE_DIR/.hive/mind/daemon.pid" 2>/dev/null || true)"
    if [[ -n "$mind_pid" ]] && kill -0 "$mind_pid" 2>/dev/null; then
      log "Stopping Hive Mind daemon (PID $mind_pid) ..."
      kill "$mind_pid" 2>/dev/null || true
      # Wait up to 10s for graceful shutdown (daemon drains pending queue)
      local mind_wait=0
      while [ $mind_wait -lt 10 ] && kill -0 "$mind_pid" 2>/dev/null; do
        sleep 1
        mind_wait=$((mind_wait + 1))
      done
      if kill -0 "$mind_pid" 2>/dev/null; then
        warn "Mind daemon did not exit gracefully — sending SIGKILL"
        kill -9 "$mind_pid" 2>/dev/null || true
      fi
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

  # Optionally clean ephemeral mind state (but NEVER contracts/decisions/agents/changelog)
  if [[ "$CLEAN" == true ]] && [[ -d "$HIVE_DIR/.hive/mind" ]]; then
    log "Cleaning ephemeral mind state (preserving durable knowledge) ..."
    rm -rf "$HIVE_DIR/.hive/mind/pending" "$HIVE_DIR/.hive/mind/inbox" "$HIVE_DIR/.hive/mind/watches" "$HIVE_DIR/.hive/mind/readers"
  fi

  # Clean launch scripts (but NOT memory dirs — memory persists)
  rm -f "$HIVE_DIR/state"/.launch-*.sh

  # Clear pids file
  echo '{}' > "$pids_file"

  log "Teardown complete. Hive Mind knowledge preserved in .hive/mind/"
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
  [[ -n "$TOKEN" ]] || die "--token is required (or set DISCORD_BOT_TOKEN in ~/.claude/channels/discord/.env)"
  # --bot-id is optional — auto-discovered from gateway after startup

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

  local gen_args=(
    --channel-id "$CHANNEL_ID"
    --project-repo "$PROJECT_REPO"
    --budget "$BUDGET"
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
  if [[ -n "$TOOLS_OVERRIDE" ]]; then
    gen_args+=(--tools "$TOOLS_OVERRIDE")
  fi
  bun run "$HIVE_DIR/src/gen-config.ts" "${gen_args[@]}"
}

# ---------------------------------------------------------------------------
# Gateway lifecycle
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

# ---------------------------------------------------------------------------
# Compose system prompt for a named agent
# ---------------------------------------------------------------------------

compose_agent_system_prompt() {
  local agent_name="$1"
  local agent_role="$2"

  # a) Base worker prompt with {NAME} and {ROLE} substituted
  local base_prompt
  base_prompt="$(sed "s/{NAME}/$agent_name/g; s/{ROLE}/$agent_role/g" "$HIVE_DIR/config/prompts/worker-system-prompt.md")"

  # b) Base profile (always included)
  local base_profile
  base_profile="$(sed "s/{NAME}/$agent_name/g; s/{ROLE}/$agent_role/g" "$HIVE_DIR/config/prompts/profiles/_base.md")"

  # c) Role profile: use if it exists, fall back to _base.md with a warning
  local role_profile=""
  local role_profile_path="$HIVE_DIR/config/prompts/profiles/${agent_role}.md"
  if [[ -f "$role_profile_path" ]]; then
    role_profile="$(sed "s/{NAME}/$agent_name/g; s/{ROLE}/$agent_role/g" "$role_profile_path")"
  else
    warn "No profile found for role '${agent_role}' (looked for config/prompts/profiles/${agent_role}.md) — using _base.md only"
  fi

  # d) Mind prompt section (with {NAME} substituted)
  local memory_section
  memory_section="$(sed "s/{NAME}/$agent_name/g" "$HIVE_DIR/config/prompts/mind-prompt-section.md")"

  # e) Mind restoration block for this agent
  local memory_block
  memory_block="$(bun run "$HIVE_DIR/bin/hive-mind.ts" load --agent "$agent_name" 2>/dev/null || echo "")"

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
  # Check tmux is available
  command -v tmux >/dev/null 2>&1 || die "tmux is required. Install with: sudo apt install tmux"
  # Kill any existing hive session
  tmux kill-session -t hive 2>/dev/null || true

  # Start the gateway first
  launch_gateway_tmux || die "Gateway failed to start. Aborting."

  # Start Hive Mind daemon
  log "Starting Hive Mind daemon ..."
  mkdir -p "$HIVE_DIR/.hive/mind"/{contracts,decisions,agents,pending/.failed,readers/contracts,readers/decisions,inbox/manager,watches,changelog}
  local mind_launch_script="$HIVE_DIR/state/.launch-mind.sh"
  cat > "$mind_launch_script" << MIND_EOF
#!/usr/bin/env bash
bun run "$HIVE_DIR/bin/hive-mind.ts" daemon 2>&1
MIND_EOF
  chmod +x "$mind_launch_script"
  tmux new-window -t hive -n mind "$mind_launch_script"
  log "  Mind daemon started in tmux window 'mind'"
  # Wait for daemon.pid to appear (max 5s)
  local mind_attempts=0
  while [ $mind_attempts -lt 5 ]; do
    if [[ -f "$HIVE_DIR/.hive/mind/daemon.pid" ]]; then
      log "  Mind daemon is ready"
      break
    fi
    sleep 1
    mind_attempts=$((mind_attempts + 1))
  done

  # Read agent list from agents.json
  local agents_file="$HIVE_DIR/state/agents.json"
  [[ -f "$agents_file" ]] || die "state/agents.json not found — run config generation first"

  # Build team list for manager init prompt
  local team_list
  team_list="$(jq -r '.agents[] | "\(.name) (\(.role))"' "$agents_file" | paste -sd', ')"

  local manager_prompt
  manager_prompt="$(cat "$HIVE_DIR/config/prompts/manager-system-prompt.md")"

  log "Launching manager session ..."

  local manager_init="You are the Hive coordinator for project repo: $PROJECT_REPO. Your team: $team_list. Channel ID: $CHANNEL_ID. You do NOT start work autonomously — wait for the user to tell you what to build. Read state/agents.json to learn each agent's name and role. Agents will announce themselves as READY on Discord. When instructed, decompose the project into tasks and assign them to agents by name."

  local launch_script="$HIVE_DIR/state/.launch-manager.sh"
  cat > "$launch_script" << LAUNCH_EOF
#!/usr/bin/env bash
claude --name "hive-manager" \
  --append-system-prompt "\$(cat "$HIVE_DIR/config/prompts/manager-system-prompt.md")" \
  --mcp-config "$HIVE_DIR/state/manager/mcp-config.json" \
  --max-cost-usd $MANAGER_BUDGET \
  --permission-mode bypassPermissions
LAUNCH_EOF
  chmod +x "$launch_script"

  # Gateway already created the session; add manager as a new window
  tmux new-window -t hive -n manager "$launch_script"

  sleep 5
  if tmux capture-pane -t hive:manager -p 2>/dev/null | grep -qi "trust"; then
    tmux send-keys -t hive:manager "y" Enter
    sleep 3
  fi
  sleep 3
  tmux send-keys -t hive:manager "$manager_init" Enter
  log "  Manager started in tmux window 'manager'"

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

    # Install scope enforcement pre-commit hook
    cp "$HIVE_DIR/hooks/pre-commit-scope.sh" "$worktree_dir/.git/hooks/pre-commit"
    chmod +x "$worktree_dir/.git/hooks/pre-commit"

    local worker_init="You are $agent_name ($agent_role) on a Hive team with a coordinator (mention 'manager') and other agents. Your Discord channel ID is $CHANNEL_ID — always use this numeric ID with Discord tools. You can message any team member by mentioning their name. Announce yourself as READY on Discord and wait for task assignment."

    local worker_launch_script="$HIVE_DIR/state/.launch-worker-${agent_name}.sh"
    # compose_agent_system_prompt writes to stdout; capture it into the launch script
    local composed_prompt
    composed_prompt="$(compose_agent_system_prompt "$agent_name" "$agent_role")"

    # Write a launch script that uses the pre-composed prompt (stored as heredoc)
    {
      echo '#!/usr/bin/env bash'
      echo "cd \"$worktree_dir\""
      echo "export HIVE_WORKER_ID=\"$agent_name\""
      echo "export HIVE_ROOT=\"$HIVE_DIR\""
      echo 'claude --name "hive-'"$agent_name"'" \'
      echo '  --append-system-prompt "$(cat <<'"'"'__PROMPT_EOF__'"'"'"'
      echo "$composed_prompt"
      echo '__PROMPT_EOF__'
      echo ')" \'
      echo "  --mcp-config \"$HIVE_DIR/state/workers/$agent_name/mcp-config.json\" \\"
      echo '  --strict-mcp-config \'
      echo "  --settings \"$HIVE_DIR/state/workers/$agent_name/settings.json\" \\"
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

  local started_ts
  started_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jq -n \
    --arg started "$started_ts" \
    --argjson workers "$total_agents" \
    '{ mode: "tmux", session: "hive", started: $started, workers: $workers }' \
    > "$HIVE_DIR/state/pids.json"

  # -------------------------------------------------------------------------
  # Print summary
  # -------------------------------------------------------------------------

  echo ""
  echo "=== Hive Launched Successfully ==="

  echo "  Mode:     tmux session 'hive'"
  echo "  Gateway:  tmux window 'gateway' (window 0)"
  echo "  Manager:  tmux window 'manager'"
  for aname in "${agent_names[@]}"; do
    local arole
    arole="$(jq -r ".agents[] | select(.name == \"$aname\") | .role // \"developer\"" "$agents_file")"
    echo "  Agent:    tmux window '$aname' ($arole)"
  done

  echo "  Channel:  $CHANNEL_ID"
  echo "  Budget:   \$${BUDGET}/agent, \$${MANAGER_BUDGET} manager"
  echo ""
  echo "  Status:   hive-status.sh"
  echo "  Teardown: hive-launch.sh --teardown"
  echo "=================================="

  log ""
  log "Hive launched in tmux session 'hive'"
  log "  Ctrl-B 0 -> gateway"
  log "  Ctrl-B 1 -> manager"
  log "  Ctrl-B 2+ -> agents"
  log "  Ctrl-B d -> detach (sessions keep running)"
  log ""
  tmux attach -t hive
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

  launch_hive
}

main "$@"
