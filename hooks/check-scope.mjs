#!/usr/bin/env node
/**
 * check-scope.mjs — Claude Code PreToolUse hook for file scope enforcement.
 * Reads scope from .hive/scope/{HIVE_WORKER_ID}.json
 * Blocks Write/Edit/Bash-writes to out-of-scope files via stdout JSON.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, relative, isAbsolute } from 'path'
import { stdin } from 'process'

// --- Config ---
const AGENT_NAME = process.env.HIVE_WORKER_ID || ''
const HIVE_ROOT = process.env.HIVE_ROOT || ''

// No agent or hive root = no enforcement
if (!AGENT_NAME || !HIVE_ROOT) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

const SCOPE_FILE = resolve(HIVE_ROOT, '.hive', 'scope', `${AGENT_NAME}.json`)

// No scope file = no enforcement (task not yet assigned)
if (!existsSync(SCOPE_FILE)) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// --- Read stdin ---
const chunks = []
for await (const chunk of stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString())

const toolName = input.tool_name || ''
const toolInput = input.tool_input || {}

// --- Extract file path to check ---
let filePath = ''

if (toolName === 'Write' || toolName === 'Edit') {
  filePath = toolInput.file_path || ''
} else if (toolName === 'Bash') {
  const cmd = toolInput.command || ''
  // Detect write patterns and extract target paths
  const redirectMatch = cmd.match(/>{1,2}\s*(\S+)/)
  const sedMatch = cmd.match(/sed\s+-i\s+.*?\s+(\S+)/)
  const mvCpMatch = cmd.match(/(?:mv|cp)\s+\S+\s+(\S+)/)
  const teeMatch = cmd.match(/tee\s+(\S+)/)
  filePath = (redirectMatch?.[1] || sedMatch?.[1] || mvCpMatch?.[1] || teeMatch?.[1] || '')
  if (!filePath) {
    // No write detected in bash command — allow
    console.log(JSON.stringify({}))
    process.exit(0)
  }
} else {
  // Read-only tools — always allow
  console.log(JSON.stringify({}))
  process.exit(0)
}

if (!filePath) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// --- Resolve to relative path from worker CWD (worktree root) ---
const cwd = process.env.cwd || process.cwd()
const relPath = isAbsolute(filePath) ? relative(cwd, filePath) : filePath

// --- Load scope ---
let scope
try {
  scope = JSON.parse(readFileSync(SCOPE_FILE, 'utf-8'))
} catch {
  // Corrupt scope file — fail open
  console.log(JSON.stringify({}))
  process.exit(0)
}

const patterns = [...(scope.allowed || []), ...(scope.shared || [])]

// --- Glob matching ---
// NOTE: Brace expansion ({a,b}) is not supported
function globToRegex(pattern) {
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape regex metacharacters (except * and ?)
    .replace(/\*\*/g, '{{GLOBSTAR}}')        // Placeholder for **
    .replace(/\*/g, '[^/]*')                  // * matches anything except /
    .replace(/\?/g, '[^/]')                   // ? matches single char except /
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')       // ** matches everything including /
  return new RegExp(`^${regex}$`)
}

for (const pattern of patterns) {
  if (globToRegex(pattern).test(relPath)) {
    // In scope — allow
    console.log(JSON.stringify({}))
    process.exit(0)
  }
}

// --- BLOCKED — out of scope ---
const allowedList = (scope.allowed || []).map(p => `  - ${p}`).join('\n')
const reason = [
  `SCOPE VIOLATION: ${relPath} is outside your assigned scope.`,
  ``,
  `Your scope for task "${scope.taskId}":`,
  allowedList,
  ``,
  `Instead, publish a contract request:`,
  `  bun run bin/hive-mind.ts publish --type contract --topic <what-you-need> --agent ${AGENT_NAME} --data '{"request": "describe what you need"}'`,
  ``,
  `The owning agent will receive a CONTRACT_UPDATE notification automatically.`,
].join('\n')

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
}))
process.exit(0)
