<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-24 | Updated: 2026-03-24 -->

# src/mind

## Purpose
Hive Mind logic — the daemon that merges pending deltas into canonical knowledge files, filesystem utilities, and shared type definitions. Used by `bin/hive-mind.ts`.

## Key Files

| File | Description |
|------|-------------|
| `daemon.ts` | Long-running daemon that merges pending deltas into canonical mind files, manages reader/watch registries, sends inbox notifications, takes periodic git snapshots. Invoked via `bin/hive-mind.ts daemon`. |
| `fs-utils.ts` | Atomic file I/O helpers — write-rename pattern, directory scanning, delta file management |
| `mind-types.ts` | TypeScript type definitions for all Hive Mind stored structures (contracts, decisions, inbox entries, watch entries, delta files) |

## For AI Agents

### Working In This Directory
- `daemon.ts` is the single writer for `.hive/mind/contracts/`, `decisions/`, `readers/`, `watches/`, `changelog/`
- `mind-types.ts` is the authoritative schema — update it when adding new mind data structures
- Use atomic write-rename pattern (from `fs-utils.ts`) for all file mutations

## Dependencies

### Internal
- `src/shared/agent-types.ts` — shared agent/role types
- Used by `bin/hive-mind.ts`

<!-- MANUAL: -->
