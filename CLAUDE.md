# Hive — Discord Multi-Session Claude Code Orchestrator

## Project Structure
- `bin/` — CLI entry points (hive, hive-gateway.ts, hive-mind.ts)
- `src/` — TypeScript source modules (gateway/, mind/, shared/, scripts/)
- `hooks/` — Claude Code and git hook scripts
- `config/prompts/` — System prompts, protocol, role profiles
- `config/tools/` — MCP tool definitions (JSON)
- `config/tool-profiles/` — Role-to-tool mappings (JSON)
- `state/` — Runtime state (gitignored)
- `worktrees/` — Git worktrees for worker sessions (gitignored)

## Key Conventions
- Workers communicate ONLY via Discord (no filesystem coupling)
- All sessions share a single Discord bot token via the gateway
- Workers operate in their own git worktree on branch `hive/worker-NN`
- The message protocol in `config/protocol.md` is the contract between manager and workers
- All scripts are bash or bun/TypeScript

## Running
See README.md for setup and usage instructions.
