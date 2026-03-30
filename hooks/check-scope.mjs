#!/usr/bin/env node
/**
 * check-scope.mjs — Claude Code PreToolUse hook for file scope enforcement.
 *
 * Uses legacy scope mode (.hive/scope/{agent}.json) to block out-of-scope writes.
 */

import { readFileSync } from 'fs'
import { resolve, relative, isAbsolute } from 'path'
import { stdin } from 'process'

// --- Helpers ---
function allow() {
  console.log(JSON.stringify({}))
  process.exit(0)
}

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

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

// --- Config ---
const AGENT_NAME = process.env.HIVE_WORKER_ID || ''
let HIVE_ROOT = process.env.HIVE_ROOT || ''

// Per-story worktree: override HIVE_ROOT from active-worktree state file
if (AGENT_NAME) {
  try {
    const stateFile = resolve(HIVE_ROOT || process.cwd(), '.hive', 'active-worktree', `${AGENT_NAME}.json`)
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'))
    if (state.worktreePath) {
      HIVE_ROOT = state.worktreePath
    }
  } catch { /* State file may not exist yet — fall back to env var */ }
}

// No agent or hive root = no enforcement
if (!AGENT_NAME || !HIVE_ROOT) {
  allow()
}

// --- Read stdin ---
const chunks = []
for await (const chunk of stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString())

const toolName = input.tool_name || ''
const toolInput = input.tool_input || {}

// --- Extract file path to check ---
let filePath = ''

if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
  filePath = toolInput.file_path || ''
} else if (toolName === 'Bash') {
  const cmd = toolInput.command || ''
  const writePatterns = [
    />{1,2}\s*(\S+)/,
    /sed\s+-i\s+.*?\s+(\S+)/,
    /(?:mv|cp)\s+\S+\s+(\S+)/,
    /tee\s+(?:-a\s+)?(\S+)/,
    /dd\s+.*?of=(\S+)/,
    /(?:curl|wget)\s+.*?-o\s+(\S+)/,
    /(?:curl|wget)\s+.*?--output\s+(\S+)/,
    /install\s+(?:-\S+\s+)*\S+\s+(\S+)/,
    /rsync\s+(?:-\S+\s+)*\S+\s+(\S+)/,
    /patch\s+(?:-\S+\s+)*(\S+)/,
    /truncate\s+(?:-\S+\s+\S+\s+)*(?:-\S+\s+)*(\S+)/,
    /python[23]?\s+-c\s+.*?open\s*\(/,
    /node\s+-e\s+.*?writeFile/,
    /git\s+checkout\s+.*?--\s+(\S+)/,
  ]

  for (const pattern of writePatterns) {
    const match = cmd.match(pattern)
    if (match) {
      filePath = match[1] || ''
      if (!filePath) { break }
      break
    }
  }

  if (!filePath) { allow() }
} else {
  allow()
}

if (!filePath) { allow() }

// --- Normalize path to prevent traversal attacks ---
const cwd = process.cwd()
const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath)
const relPath = relative(cwd, absPath)

// Reject paths that escape both the worktree AND the hive root
const relFromHiveRoot = relative(HIVE_ROOT, absPath)
if (relPath.startsWith('..') && relFromHiveRoot.startsWith('..')) {
  deny(`SCOPE VIOLATION: Path "${filePath}" resolves outside the worktree. Traversal blocked.`)
}

// Use HIVE_ROOT-relative path for matching when file is within the hive root
const matchPath = relFromHiveRoot.startsWith('..') ? relPath : relFromHiveRoot

// --- Scope mode: block out-of-scope writes ---
const SCOPE_FILE = resolve(HIVE_ROOT, '.hive', 'scope', `${AGENT_NAME}.json`)

let scope
try {
  scope = JSON.parse(readFileSync(SCOPE_FILE, 'utf-8'))
} catch (err) {
  if (err.code === 'ENOENT') { allow() }
  deny(`SCOPE ERROR: Could not read scope file for agent "${AGENT_NAME}". Denying write for safety. Error: ${err.message}`)
}

// Strip backticks and trailing annotations from scope patterns
const patterns = [...(scope.allowed || []), ...(scope.shared || [])].map(p => p.replace(/^`|`.*$/g, '').trim()).filter(Boolean)

for (const pattern of patterns) {
  if (globToRegex(pattern).test(matchPath)) { allow() }
}

const allowedList = (scope.allowed || []).map(p => `  - ${p}`).join('\n')
const reason = [
  `SCOPE VIOLATION: ${matchPath} is outside your assigned scope.`,
  '',
  `Your scope for task "${scope.taskId}":`,
  allowedList,
  '',
  'Instead, publish a contract request:',
  `  bun run bin/hive-mind.ts publish --type contract --topic <what-you-need> --agent ${AGENT_NAME} --data '{"request": "describe what you need"}'`,
  '',
  'The owning agent will receive a CONTRACT_UPDATE notification automatically.',
].join('\n')

deny(reason)
