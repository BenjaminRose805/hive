<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-24 | Updated: 2026-03-24 -->

# bin

## Purpose
CLI entry points for the Hive orchestrator. Three files only — the unified CLI dispatcher and the two long-running processes.

## Key Files

| File | Description |
|------|-------------|
| `hive` | Unified CLI dispatcher — routes subcommands (launch, status, integrate, gen-config, validate, register-commands) to modules in `src/scripts/` or `src/` |
| `hive-gateway.ts` | Standalone Bun process owning the Discord WebSocket connection; multiplexes messages to/from workers via Unix domain socket; handles selective routing, per-task threading, slash commands |
| `hive-mind.ts` | Hive Mind CLI and daemon — publish/read contracts and decisions, manage watches, send inbox messages, save/load agent memory; `daemon` subcommand runs as a long-lived process |

## For AI Agents

### Working In This Directory
- `hive` is a shell script dispatcher; it does not contain business logic
- `hive-gateway.ts` and `hive-mind.ts` use `#!/usr/bin/env bun` shebangs
- All business logic lives in `src/` — edit there, not here
- Run subcommands via `bin/hive <subcommand>` (e.g. `bin/hive launch`, `bin/hive validate`)
- The gateway communicates with workers via a Unix domain socket at `/tmp/hive-gateway/gateway.sock`

### Testing Requirements
- Run `bin/hive validate` to verify tool configurations
- Test gateway changes by launching a hive and observing Discord message routing

## Dependencies

### Internal
- `src/scripts/` — launch.sh, status.sh, integrate.sh (bash scripts invoked by `hive`)
- `src/gen-config.ts`, `src/validate-tools.ts`, `src/register-commands.ts` — TypeScript modules invoked by `hive`
- `src/gateway/` — gateway logic used by hive-gateway.ts
- `src/mind/` — mind logic used by hive-mind.ts

### External
- `discord.js` — Gateway bot client
- `@discordjs/rest` — Slash command registration
- `bun` — Runtime for all TypeScript entry points

<!-- MANUAL: -->
