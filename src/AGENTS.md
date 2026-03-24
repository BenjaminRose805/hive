<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-24 | Updated: 2026-03-24 -->

# src

## Purpose
TypeScript source modules for the Hive orchestrator. All business logic lives here; `bin/` entry points import from `src/`.

## Top-Level Modules

| File | Description |
|------|-------------|
| `gen-config.ts` | Generates per-worker and manager configuration (Discord access.json, MCP settings, system prompts) for single-bot gateway mode |
| `validate-tools.ts` | Pre-flight validation of MCP tool configurations — checks tool definitions, profiles, and environment variables |
| `register-commands.ts` | Registers Discord slash commands (/hive-status, /hive-assign, etc.) via the REST API |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `gateway/` | Discord gateway logic — protocol parsing, selective routing, thread management, shared types (see `gateway/AGENTS.md`) |
| `mind/` | Hive Mind logic — daemon, file utilities, type definitions (see `mind/AGENTS.md`) |
| `shared/` | Shared type definitions used across gateway and mind modules (see `shared/AGENTS.md`) |
| `scripts/` | Bash scripts invoked by `bin/hive` for launch, status, and integrate subcommands |

## For AI Agents

### Working In This Directory
- All `.ts` files use `bun` as runtime
- Scripts in `scripts/` are bash with `set -euo pipefail`
- Import paths use relative imports within `src/`
- `gen-config.ts`, `validate-tools.ts`, and `register-commands.ts` are invoked via `bin/hive <subcommand>`

<!-- MANUAL: -->
