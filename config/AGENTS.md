<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-24 | Updated: 2026-03-24 -->

# config

## Purpose
Configuration files that define Hive behavior: system prompts for manager and worker sessions, the inter-session message protocol, agent role profiles, MCP tool definitions, and tool-to-role mappings.

## Key Files

| File | Description |
|------|-------------|
| `protocol.md` | Full message protocol specification — 8 message types, header/body format, routing rules, threading, heartbeat protocol, task lifecycle, error recovery |
| `manager-system-prompt.md` | System prompt for the manager session — startup sequence, decomposition strategy, monitoring, integration coordination |
| `worker-system-prompt.md` | System prompt template for worker sessions — `{NAME}` and `{ROLE}` placeholders replaced at config generation time |
| `mind-prompt-section.md` | Prompt section injected into worker prompts describing the Hive Mind shared knowledge system |
| `secrets.env.example` | Template for environment variables (bot tokens, channel IDs) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `prompts/` | All markdown prompt files — manager/worker system prompts, protocol spec, mind prompt section, and role profiles (see `prompts/AGENTS.md` and `prompts/profiles/AGENTS.md`) |
| `tool-profiles/` | MCP tool allowlists per role (see `tool-profiles/AGENTS.md`) |
| `tools/` | MCP tool server definitions (see `tools/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- `prompts/worker-system-prompt.md` uses `{NAME}` and `{ROLE}` placeholders — these are substituted by `src/gen-config.ts` at launch time
- `prompts/protocol.md` is the authoritative contract — any protocol changes must update this file first
- Profile files in `prompts/profiles/` are concatenated onto the base worker prompt by the config generator
- Tool definitions in `tools/` are JSON files describing MCP server configurations

### Testing Requirements
- After editing prompts, regenerate configs with `bin/hive gen-config` and verify output
- Protocol changes require updating both the spec and any parsing logic in `src/gateway/protocol-parser.ts`

### Common Patterns
- Markdown files use section headers for structured prompt composition
- JSON configs follow Claude Code MCP settings format (`command`, `args`, `env`)

## Dependencies

### Internal
- Referenced by `src/gen-config.ts` during config generation
- `src/gateway/protocol-parser.ts` implements parsing for `prompts/protocol.md` message types

<!-- MANUAL: -->
