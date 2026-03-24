<!-- Generated: 2026-03-24 | Updated: 2026-03-24 -->

# Hive

## Purpose
Discord-based multi-session Claude Code orchestrator. A **manager** session decomposes projects into tasks and assigns them to autonomous **worker** sessions via Discord. Each worker has its own 1M context window, full OMC stack, and operates on an isolated git worktree branch. A standalone gateway process multiplexes a single Discord bot connection across all sessions.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | Project manifest — depends on discord.js, @discordjs/rest |
| `CLAUDE.md` | Project conventions and structure for AI agents |
| `README.md` | Setup guide, architecture overview, quick start |
| `bun.lock` | Bun lockfile for reproducible installs |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `bin/` | CLI entry points — hive (unified CLI), hive-gateway.ts, hive-mind.ts (see `bin/AGENTS.md`) |
| `src/` | TypeScript source modules — gateway/, mind/, shared/, scripts/, and top-level gen-config/validate/register (see `src/AGENTS.md`) |
| `hooks/` | Claude Code scope-check and git pre-commit hook scripts (see `hooks/AGENTS.md`) |
| `config/` | System prompts, protocol spec, profiles, tool definitions (see `config/AGENTS.md`) |
| `docs/` | Design documents and planning notes (see `docs/AGENTS.md`) |
| `.hive/` | Runtime state for the Hive Mind shared knowledge system (see `.hive/AGENTS.md`) |
| `state/` | Per-worker Discord configs, PIDs, thread mappings (gitignored) |
| `worktrees/` | Git worktrees for worker sessions (gitignored) |

## For AI Agents

### Working In This Directory
- Workers communicate **only** via Discord — no direct filesystem coupling between sessions
- Each worker needs a unique Discord bot token (or use single-bot gateway mode)
- The message protocol in `config/protocol.md` is the contract between manager and workers
- Entry points are in `bin/`; TypeScript source modules are in `src/` — run with `bun run src/<module>.ts` or via `bin/hive <subcommand>`
- `state/` and `worktrees/` are gitignored runtime directories

### Testing Requirements
- No test suite currently — validate by launching a hive and checking Discord message flow
- Use `bin/hive validate` to pre-flight check MCP tool configurations
- Use `bin/hive status` to verify process and branch health

### Architecture Overview
```
Human ←→ Manager Session (Claude Code + OMC)
               │
            Discord (gateway multiplexes bot connection)
               │
    ┌──────────┼──────────┐
    │          │          │
 Worker A   Worker B   Worker C
 (worktree) (worktree) (worktree)
```

### Key Concepts
- **Gateway**: Single Bun process owning the Discord WebSocket; routes messages via protocol parsing
- **Selective Routing**: Workers only see messages addressed to them (TASK_ASSIGN, ANSWER, @mentions)
- **Per-Task Threads**: Each TASK_ASSIGN creates a Discord thread isolating that task's communication
- **Hive Mind**: Shared knowledge layer (contracts, decisions, inbox) under `.hive/mind/`
- **Protocol**: 8 message types (TASK_ASSIGN, STATUS, QUESTION, ANSWER, COMPLETE, HEARTBEAT, INTEGRATE, ESCALATE)

## Dependencies

### External
- `discord.js` ^14.14.0 — Discord gateway and API client
- `@discordjs/rest` ^2.3.0 — REST API for slash command registration
- `discord-api-types` ^0.37.83 — Discord API type definitions
- `bun` — TypeScript runtime
- `claude` CLI v2.1+ — Claude Code sessions
- `git` — Worktree management

<!-- MANUAL: -->
