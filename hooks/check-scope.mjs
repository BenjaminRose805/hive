#!/usr/bin/env node
/**
 * check-scope.mjs — Claude Code PreToolUse hook for file scope enforcement.
 *
 * Two modes:
 *   1. Module map mode (.hive/modules.json exists): notify owner on cross-module edits, never block.
 *   2. Legacy scope mode (.hive/scope/{agent}.json): block out-of-scope writes (backward compatible).
 *
 * In module map mode, cross-module edits write a scope-notify delta to .hive/mind/pending/
 * for the Mind daemon to process. The daemon notifies the module owner at info priority.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { resolve, relative, isAbsolute, join } from 'path'
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
const HIVE_ROOT = process.env.HIVE_ROOT || ''

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

// --- Try module map mode first ---
const MODULE_MAP_PATH = resolve(HIVE_ROOT, '.hive', 'modules.json')

let moduleMap = null
try {
  moduleMap = JSON.parse(readFileSync(MODULE_MAP_PATH, 'utf-8'))
} catch {
  // No module map — fall through to legacy scope mode
}

if (moduleMap) {
  const result = resolveFileOwnership(matchPath, moduleMap)

  if (result.kind === 'shared') { allow() }
  if (result.kind === 'owned' && result.owner === AGENT_NAME) { allow() }
  if (result.kind === 'owned') {
    writeScopeNotifyDelta(AGENT_NAME, matchPath, toolName, result.owner, result.module)
    allow()
  }
  if (result.kind === 'unassigned') {
    writeScopeNotifyDelta(AGENT_NAME, matchPath, toolName, result.fallback_owner, '_unassigned')
    allow()
  }
  allow()
}

// --- Legacy scope mode: block out-of-scope writes ---
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

// --- Module map helpers ---

function resolveFileOwnership(filePath, config) {
  for (const pattern of (config.shared || [])) {
    if (globToRegex(pattern).test(filePath)) {
      return { kind: 'shared', pattern }
    }
  }
  for (const [moduleName, moduleDef] of Object.entries(config.modules || {})) {
    for (const pattern of (moduleDef.files || [])) {
      if (globToRegex(pattern).test(filePath)) {
        return { kind: 'owned', module: moduleName, owner: moduleDef.owner, pattern }
      }
    }
  }
  return { kind: 'unassigned', fallback_owner: config.unassigned_owner || 'monarch' }
}

function writeScopeNotifyDelta(editor, file, tool, owner, moduleName) {
  const pendingDir = resolve(HIVE_ROOT, '.hive', 'mind', 'pending')
  try { mkdirSync(pendingDir, { recursive: true }) } catch {}

  const delta = {
    agent: editor,
    action: 'scope-notify',
    target_type: 'module',
    target_topic: moduleName,
    content: { file, tool, owner, module: moduleName },
  }

  const filename = `${Date.now()}-${editor}-scope-notify.json`
  const tmpPath = join(pendingDir, `.tmp-${filename}`)
  const finalPath = join(pendingDir, filename)

  try {
    writeFileSync(tmpPath, JSON.stringify(delta, null, 2))
    renameSync(tmpPath, finalPath)
  } catch {}
}
