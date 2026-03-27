#!/usr/bin/env node
/**
 * contract-export.mjs — Claude Code PreToolUse hook for contract file enforcement.
 *
 * Flags when a Write/Edit adds exported type/interface declarations to files
 * that are NOT contracts.ts. Encourages the convention that all public API
 * surface is re-exported through contracts.ts barrel files.
 *
 * Enforcement: advisory (warns but does not block).
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, basename, dirname, relative, isAbsolute } from 'path'
import { stdin } from 'process'

// --- Config ---
const HIVE_ROOT = process.env.HIVE_ROOT || ''
if (!HIVE_ROOT) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// Module directories that should have contracts.ts
const MODULE_DIRS = ['src/gateway', 'src/mind', 'src/shared']

// --- Read stdin ---
const chunks = []
for await (const chunk of stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString())

const toolName = input.tool_name || ''
const toolInput = input.tool_input || ''

// Only check Write and Edit operations
if (toolName !== 'Write' && toolName !== 'Edit') {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// --- Extract file path ---
let filePath = ''
if (toolName === 'Write') {
  filePath = toolInput.file_path || ''
} else if (toolName === 'Edit') {
  filePath = toolInput.file_path || ''
}

if (!filePath) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// Resolve to relative path from HIVE_ROOT
const cwd = process.env.cwd || process.cwd()
const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath)

// Find the project root (could be main repo or worktree)
// Normalize to get relative path from any worktree
let relPath = ''
if (absPath.includes('/worktrees/')) {
  // In a worktree: extract path after worktrees/<name>/
  const match = absPath.match(/\/worktrees\/[^/]+\/(.+)/)
  relPath = match ? match[1] : relative(HIVE_ROOT, absPath)
} else {
  relPath = relative(HIVE_ROOT, absPath)
}

// Skip if not a .ts file in a module directory
if (!relPath.endsWith('.ts')) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// Skip contracts.ts files themselves — those are the correct place
if (basename(relPath) === 'contracts.ts') {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// Skip test files
if (relPath.includes('.test.') || relPath.includes('.spec.')) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// Check if this file is in a module directory that has a contracts.ts
const relDir = dirname(relPath)
const isInContractModule = MODULE_DIRS.some(d => relDir === d || relDir.startsWith(d + '/'))
if (!isInContractModule) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// Check if the module directory has a contracts.ts
const moduleDir = MODULE_DIRS.find(d => relDir === d || relDir.startsWith(d + '/'))
const contractsPath = resolve(absPath, '..', 'contracts.ts')
// Also check in the module root if we're in a subdirectory
const moduleContractsPath = moduleDir ? resolve(cwd, moduleDir, 'contracts.ts') : null

const hasContracts = existsSync(contractsPath) ||
  (moduleContractsPath && existsSync(moduleContractsPath))

if (!hasContracts) {
  // No contracts.ts yet — nothing to enforce
  console.log(JSON.stringify({}))
  process.exit(0)
}

// --- Check content for new exported types/interfaces ---
let contentToCheck = ''

if (toolName === 'Write') {
  contentToCheck = toolInput.content || ''
} else if (toolName === 'Edit') {
  contentToCheck = toolInput.new_string || ''
}

// Match exported type/interface declarations
const exportPatterns = [
  /export\s+(?:interface|type)\s+\w+/,
  /export\s+enum\s+\w+/,
]

const hasExportedTypes = exportPatterns.some(p => p.test(contentToCheck))

if (!hasExportedTypes) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// --- Hard deny for type/interface/enum exports ---
// Extract the type/interface names for a helpful message
const typeNames = []
const typeMatches = contentToCheck.matchAll(/export\s+(?:interface|type|enum)\s+(\w+)/g)
for (const m of typeMatches) {
  typeNames.push(m[1])
}

const reason = [
  `CONTRACT VIOLATION: ${relPath} exports type(s): ${typeNames.join(', ')}`,
  ``,
  `Convention: exported types/interfaces/enums MUST live in ${moduleDir}/contracts.ts.`,
  `Value exports (functions, constants) may live in any file.`,
  ``,
  `Move these type declarations to ${moduleDir}/contracts.ts, or define them there`,
  `and import from contracts.ts where needed.`,
].join('\n')

// Hard deny — type exports outside contracts.ts are blocked
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
}))
process.exit(0)
