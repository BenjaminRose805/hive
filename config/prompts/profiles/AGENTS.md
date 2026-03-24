<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-24 | Updated: 2026-03-24 -->

# profiles

## Purpose
Role-specific behavior profiles for Hive agents. Each profile is a markdown file that gets appended to the base worker system prompt during config generation, giving agents role-appropriate guidance and expertise.

## Key Files

| File | Description |
|------|-------------|
| `_base.md` | Base profile shared by all agents — team collaboration directives, Hive Mind usage, OMC tools availability |
| `developer.md` | General-purpose developer — full-stack implementation, code quality, testing |
| `backend-dev.md` | Backend specialist — API design, database, server-side logic |
| `frontend-dev.md` | Frontend specialist — UI/UX, components, styling, accessibility |
| `devops.md` | DevOps/infrastructure — CI/CD, deployment, containerization |
| `qa-engineer.md` | QA specialist — test strategy, coverage, bug hunting |
| `security-reviewer.md` | Security specialist — vulnerability assessment, auth, OWASP compliance |
| `tech-lead.md` | Technical lead — architecture decisions, code review, cross-cutting concerns |

## For AI Agents

### Working In This Directory
- `_base.md` is always included for every agent; role profiles are additive
- Profiles use `{NAME}` placeholder which is substituted at config generation time
- Each profile should define: role identity, key responsibilities, working style, what to prioritize
- Keep profiles concise — they consume context window tokens in every worker session
- Roles are assigned via `--roles name:role` flag in `bin/hive launch`

### Testing Requirements
- After editing, regenerate configs with `bin/hive gen-config` and inspect the output system prompt
- Verify `{NAME}` placeholders are present where agent name should appear

## Dependencies

### Internal
- Read and concatenated by `src/gen-config.ts` during config generation
- `_base.md` references `bin/hive-mind.ts` CLI commands

<!-- MANUAL: -->
