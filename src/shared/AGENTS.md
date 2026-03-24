<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-24 | Updated: 2026-03-24 -->

# src/shared

## Purpose
Shared TypeScript type definitions used across gateway and mind modules.

## Key Files

| File | Description |
|------|-------------|
| `agent-types.ts` | Agent and role type definitions — agent names, role identifiers, worker configuration shapes |

## For AI Agents

### Working In This Directory
- Types here are imported by both `src/gateway/` and `src/mind/` — avoid adding module-specific logic
- Keep this directory limited to pure type definitions (no runtime logic)

<!-- MANUAL: -->
