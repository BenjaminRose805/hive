<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-24 | Updated: 2026-03-24 -->

# tools

## Purpose
MCP tool server definitions. Each JSON file defines a single MCP tool server that can be included in worker configurations via tool profiles. These follow the Claude Code MCP settings format.

## Key Files

| File | Description |
|------|-------------|
| `context7.json` | Context7 MCP server — library documentation lookup |
| `fetch.json` | HTTP fetch MCP server — web requests and API calls |
| `github.json` | GitHub MCP server — repository operations, PRs, issues |
| `puppeteer.json` | Puppeteer MCP server — browser automation and screenshots |
| `web-search.json` | Web search MCP server — internet search capabilities |

## For AI Agents

### Working In This Directory
- Each JSON file defines: `name`, `description`, `command`, `args`, and optional `requiredEnv` (environment variables needed)
- Tool names (filename without `.json`) are referenced by tool profiles in `config/tool-profiles/`
- Some tools require environment variables (API keys, tokens) — these are documented in `requiredEnv`
- Adding a new tool: create a JSON file here, then add it to relevant tool profiles

### Testing Requirements
- Run `bun run bin/hive-validate-tools.ts` to verify all tool definitions are valid
- Check that `requiredEnv` variables are documented in `config/secrets.env.example`

## Dependencies

### Internal
- Referenced by tool profiles in `config/tool-profiles/`
- Validated by `bin/hive-validate-tools.ts`
- Included in worker MCP settings by `bin/hive-gen-config.ts`

<!-- MANUAL: -->
