# Hive — Discord Multi-Session Claude Code Orchestrator

## Project Structure
- `bin/` — CLI entry points (hive, hive-gateway.ts, hive-mind.ts)
- `src/scripts/` — TypeScript modules (launch.ts, status.ts, integrate.ts)
- `src/shared/` — Shared utilities (paths, subprocess, validation, project-config, agent-types)
- `src/gateway/` — Gateway routing and protocol parsing
- `src/mind/` — Hive Mind daemon and types
- `hooks/` — Claude Code and git hook scripts
- `config/prompts/` — System prompts, protocol, role profiles
- `config/tools/` — MCP tool definitions (JSON)
- `config/tool-profiles/` — Role-to-tool mappings (JSON)
- `state/` — Runtime state (gitignored)
- `worktrees/` — Git worktrees for worker sessions (gitignored)

## Key Conventions
- Everything is TypeScript/Bun — no bash or Python scripts
- Workers communicate ONLY via Discord (no filesystem coupling)
- All sessions share a single Discord bot token via the gateway
- Workers run in Docker containers (`--network=none`, bind-mounted worktrees)
- Workers operate in their own git worktree on branch `hive/worker-NN`
- The message protocol in `config/protocol.md` is the contract between manager and workers
- Multi-instance: set `HIVE_SESSION` and `HIVE_GATEWAY_SOCKET` env vars for isolation

## Running
```bash
alias hive="$HOME/hive/bin/hive"

hive init                  # create ~/.config/hive/config.json
hive edit                  # configure projects
hive up myapp              # launch from config
hive down myapp            # teardown
hive status                # check running hives
hive attach myapp          # reattach tmux
```
