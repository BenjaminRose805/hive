<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-24 | Updated: 2026-03-24 -->

# tool-profiles

## Purpose
MCP tool allowlists per agent role. Each JSON file maps a role to the set of MCP tool servers that role should have access to. The config generator uses these to build per-worker MCP settings.

## Key Files

| File | Description |
|------|-------------|
| `_base.json` | Base tool set — context7, fetch, github (used by developer, backend-dev, devops, and any unrecognized role) |
| `manager.json` | Manager-specific tools — fetch only |
| `frontend-dev.json` | Frontend tools — adds puppeteer to default set |
| `qa-engineer.json` | QA tools — adds puppeteer to default set |
| `security-reviewer.json` | Security tools — adds web-search to default set |
| `tech-lead.json` | Tech lead tools — adds web-search to default set |

## For AI Agents

### Working In This Directory
- Each JSON file has a `role`, optional `description`, and `tools` array referencing tool names from `config/tools/`
- Tool names must match filenames (without `.json`) in `config/tools/`
- Use `bin/hive validate` to verify tool profiles reference valid tool definitions
- The `--tools-override` flag in `bin/hive launch` can override these at launch time

### Testing Requirements
- Run `bin/hive validate` after any changes
- Verify tool names match entries in `config/tools/`

## Dependencies

### Internal
- Tool names reference definitions in `config/tools/`
- Read by `src/gen-config.ts` during config generation
- Validated by `src/validate-tools.ts` (via `bin/hive validate`)

<!-- MANUAL: -->
