#!/usr/bin/env bash
# pre-commit-scope.sh — Safety net for scope enforcement
set -euo pipefail

AGENT_NAME="${HIVE_WORKER_ID:-}"
if [[ -z "$AGENT_NAME" ]]; then exit 0; fi

HIVE_ROOT="${HIVE_ROOT:-}"
if [[ -z "$HIVE_ROOT" ]]; then exit 0; fi

# Override HIVE_ROOT from active-worktree state file if available
STATE_FILE="${HIVE_ROOT:-.}/.hive/active-worktree/${AGENT_NAME}.json"
if [[ -f "$STATE_FILE" ]]; then
  WORKTREE_PATH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf-8')).worktreePath||'')" 2>/dev/null)
  if [[ -n "$WORKTREE_PATH" ]]; then
    HIVE_ROOT="$WORKTREE_PATH"
  fi
fi

SCOPE_FILE="$HIVE_ROOT/.hive/scope/${AGENT_NAME}.json"
if [[ ! -f "$SCOPE_FILE" ]]; then exit 0; fi

# Use node for reliable glob matching
node -e "
const { readFileSync } = require('fs');
const scope = JSON.parse(readFileSync('$SCOPE_FILE', 'utf-8'));
const patterns = [...(scope.allowed || []), ...(scope.shared || [])];
const files = process.argv.slice(1);

function globToRegex(p) {
  let r = p.replace(/[.+^\${}()|[\\]\\\\]/g, '\\\\' + '\$&')
           .replace(/\*\*/g, '{{G}}').replace(/\*/g, '[^/]*')
           .replace(/\?/g, '[^/]').replace(/\{\{G\}\}/g, '.*');
  return new RegExp('^' + r + '\$');
}

const violations = files.filter(f =>
  !patterns.some(p => globToRegex(p).test(f))
);
if (violations.length > 0) {
  console.error('SCOPE VIOLATION — these files are outside your assigned scope:');
  violations.forEach(v => console.error('  - ' + v));
  console.error('Publish a contract request instead.');
  process.exit(1);
}
" $(git diff --cached --name-only)
