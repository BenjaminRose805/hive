# Hive — Discord Multi-Session Claude Code Orchestrator

## Project Structure
- `bin/` — Launcher, config generator, status, and integration scripts
- `config/` — System prompts, protocol definition, example configs
- `patches/` — Bot filter patch for Discord MCP server.ts
- `state/` — Runtime state (gitignored). Per-worker Discord configs, PIDs
- `worktrees/` — Git worktrees for worker sessions (gitignored)

## Key Conventions
- Workers communicate ONLY via Discord (no filesystem coupling)
- Each worker needs a unique Discord bot token
- Workers operate in their own git worktree on branch `hive/worker-NN`
- The message protocol in `config/protocol.md` is the contract between manager and workers
- All scripts are bash or bun/TypeScript

## Running
See README.md for setup and usage instructions.
