<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-24 | Updated: 2026-03-24 -->

# hooks

## Purpose
Claude Code and git hook scripts that enforce scope boundaries during development.

## Key Files

| File | Description |
|------|-------------|
| `check-scope.mjs` | Claude Code hook (PreToolUse) — validates that file edits stay within the assigned worker's scope; blocks out-of-scope writes |
| `pre-commit-scope.sh` | Git pre-commit hook — runs the same scope check before allowing commits; prevents accidental cross-worker file modifications |

## For AI Agents

### Working In This Directory
- `check-scope.mjs` is invoked by Claude Code's hook system on every file write
- `pre-commit-scope.sh` is installed as `.git/hooks/pre-commit` on worker worktrees
- Scope boundaries are defined per-worker in `state/` at launch time
- Do not bypass these hooks — they prevent workers from clobbering each other's work

<!-- MANUAL: -->
