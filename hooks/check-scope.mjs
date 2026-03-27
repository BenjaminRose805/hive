#!/usr/bin/env node
/**
 * check-scope.mjs — Claude Code PreToolUse hook for file scope enforcement.
 * Reads scope from .hive/scope/{HIVE_WORKER_ID}.json
 * Blocks Write/Edit/NotebookEdit/Bash-writes to out-of-scope files via stdout JSON.
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

// --- Config ---
const AGENT_NAME = process.env.HIVE_WORKER_ID || ''
const HIVE_ROOT = process.env.HIVE_ROOT || ''

// No agent or hive root = no enforcement
if (!AGENT_NAME || !HIVE_ROOT) {
  allow()
}

const SCOPE_FILE = resolve(HIVE_ROOT, '.hive', 'scope', `${AGENT_NAME}.json`)

// --- Load scope (fail-closed: deny on corrupt/missing file) ---
// Single try/catch eliminates TOCTOU race between existsSync and readFileSync
let scope
try {
  scope = JSON.parse(readFileSync(SCOPE_FILE, 'utf-8'))
} catch (err) {
  // ENOENT = no scope file = task not yet assigned — no enforcement
  if (err.code === 'ENOENT') {
    allow()
  }
  // Corrupt or unreadable scope file — fail closed
  deny(`SCOPE ERROR: Could not read scope file for agent "${AGENT_NAME}". Denying write for safety. Error: ${err.message}`)
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
  // Detect write patterns — covers redirects, in-place edits, file manipulation,
  // and common tools that write to the filesystem
  const writePatterns = [
    />{1,2}\s*(\S+)/,                          // shell redirects: > file, >> file
    /sed\s+-i\s+.*?\s+(\S+)/,                  // sed -i
    /(?:mv|cp)\s+\S+\s+(\S+)/,                 // mv/cp target
    /tee\s+(?:-a\s+)?(\S+)/,                   // tee file, tee -a file
    /dd\s+.*?of=(\S+)/,                         // dd of=target
    /(?:curl|wget)\s+.*?-o\s+(\S+)/,           // curl -o / wget -o
    /(?:curl|wget)\s+.*?--output\s+(\S+)/,     // curl/wget --output
    /install\s+(?:-\S+\s+)*\S+\s+(\S+)/,        // install [flags] source dest
    /rsync\s+(?:-\S+\s+)*\S+\s+(\S+)/,          // rsync [flags] source dest
    /patch\s+(?:-\S+\s+)*(\S+)/,                 // patch [flags] file
    /truncate\s+(?:-\S+\s+\S+\s+)*(?:-\S+\s+)*(\S+)/, // truncate [flags] file
    /python[23]?\s+-c\s+.*?open\s*\(/,         // python -c with file open (no path extraction — block)
    /node\s+-e\s+.*?writeFile/,                 // node -e with writeFile (no path extraction — block)
    /git\s+checkout\s+.*?--\s+(\S+)/,          // git checkout -- file (overwrites)
  ]

  for (const pattern of writePatterns) {
    const match = cmd.match(pattern)
    if (match) {
      // Some patterns (python -c, node -e) detect writes but can't extract a path —
      // for those, block with a generic message
      filePath = match[1] || ''
      if (!filePath) {
        deny(`SCOPE VIOLATION: Bash command appears to write files via scripting. Use Write/Edit tools instead for scope-checked file operations.`)
      }
      break
    }
  }

  if (!filePath) {
    // No write detected in bash command — allow
    allow()
  }
} else {
  // Read-only tools — always allow
  allow()
}

if (!filePath) {
  allow()
}

// --- Normalize path to prevent traversal attacks ---
// Fix #5: use process.cwd() only, not process.env.cwd
const cwd = process.cwd()
const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath)
const relPath = relative(cwd, absPath)

// Reject paths that escape the worktree root via ../
if (relPath.startsWith('..')) {
  deny(`SCOPE VIOLATION: Path "${filePath}" resolves outside the worktree. Traversal blocked.`)
}

// --- Glob matching ---
const patterns = [...(scope.allowed || []), ...(scope.shared || [])]

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

// Match the normalized relative path against scope patterns
for (const pattern of patterns) {
  if (globToRegex(pattern).test(relPath)) {
    allow()
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

deny(reason)
