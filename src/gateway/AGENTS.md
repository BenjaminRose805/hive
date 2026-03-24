<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-24 | Updated: 2026-03-24 -->

# src/gateway

## Purpose
Discord gateway logic — protocol parsing, selective message routing, per-task thread management, and shared types. Used by `bin/hive-gateway.ts`.

## Key Files

| File | Description |
|------|-------------|
| `protocol-parser.ts` | Parses raw Discord messages into typed protocol messages (TASK_ASSIGN, STATUS, QUESTION, ANSWER, COMPLETE, HEARTBEAT, INTEGRATE, ESCALATE) |
| `selective-router.ts` | Determines which worker sessions should receive a given message based on routing rules |
| `thread-manager.ts` | Creates and tracks per-task Discord threads; maps task IDs to thread IDs |
| `types.ts` | TypeScript types for gateway internals (message envelopes, routing tables, socket protocol) |

## For AI Agents

### Working In This Directory
- `protocol-parser.ts` is the implementation of the spec in `config/prompts/protocol.md` — keep them in sync
- The gateway communicates with worker sessions via Unix domain socket at `/tmp/hive-gateway/gateway.sock`
- Routing decisions are stateless per-message; thread state is persisted in memory and optionally to `state/`

## Dependencies

### Internal
- `src/shared/agent-types.ts` — shared agent/role type definitions
- Used by `bin/hive-gateway.ts`

### External
- `discord.js` — Discord WebSocket client and message types

<!-- MANUAL: -->
