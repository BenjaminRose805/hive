#!/usr/bin/env node
/**
 * contract-publish.mjs — Claude Code PreToolUse hook for contract publish enforcement.
 *
 * Blocks `git push` if any contracts.ts file has been modified in staged/committed
 * changes but the corresponding contract hasn't been published to Hive Mind.
 *
 * Checks .hive/mind/contracts/ for a matching entry updated after the contract file.
 */

import { readFileSync, existsSync, statSync } from 'fs'
import { resolve, join, basename, dirname } from 'path'
import { stdin } from 'process'

// --- Config ---
const HIVE_ROOT = process.env.HIVE_ROOT || ''
const AGENT_NAME = process.env.HIVE_WORKER_ID || ''

if (!HIVE_ROOT) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// --- Read stdin ---
const chunks = []
for await (const chunk of stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString())

const toolName = input.tool_name || ''
const toolInput = input.tool_input || {}

// Only check Bash commands that are git push
if (toolName !== 'Bash') {
  console.log(JSON.stringify({}))
  process.exit(0)
}

const cmd = toolInput.command || ''

// Detect git push commands
const isPush = /\bgit\s+push\b/.test(cmd)
if (!isPush) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// --- Find modified contracts.ts files ---
// Check git diff between current branch and its merge-base with master
import { execFileSync } from 'child_process'

const cwd = process.env.cwd || process.cwd()

let changedFiles = []
try {
  // Get files changed on this branch vs master
  const mergeBase = execFileSync('git', ['merge-base', 'HEAD', 'master'], { cwd, encoding: 'utf-8' }).trim()
  const diff = execFileSync('git', ['diff', '--name-only', mergeBase, 'HEAD'], { cwd, encoding: 'utf-8' }).trim()
  changedFiles = diff ? diff.split('\n') : []
} catch {
  // If merge-base fails (e.g. no master), check staged + unstaged
  try {
    const diff = execFileSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { cwd, encoding: 'utf-8' }).trim()
    changedFiles = diff ? diff.split('\n') : []
  } catch {
    // No commits to check
    console.log(JSON.stringify({}))
    process.exit(0)
  }
}

// Filter to contracts.ts files only
const changedContracts = changedFiles.filter(f => basename(f) === 'contracts.ts')

if (changedContracts.length === 0) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// --- Check Hive Mind for published contracts ---
// Module dir name -> Mind topic mapping convention:
// src/gateway/contracts.ts -> topic: "gateway-api" or module name
const MIND_ROOT = join(HIVE_ROOT, '.hive', 'mind')

const unpublished = []

for (const contractFile of changedContracts) {
  // Extract module name from path: src/gateway/contracts.ts -> "gateway"
  const parts = contractFile.split('/')
  const moduleIdx = parts.indexOf('src')
  if (moduleIdx === -1 || moduleIdx + 1 >= parts.length) continue

  const moduleName = parts[moduleIdx + 1]
  const topic = `${moduleName}-api`

  // Check if a Mind contract exists for this module
  const mindContractPath = join(MIND_ROOT, 'contracts', `${topic}.json`)

  if (!existsSync(mindContractPath)) {
    unpublished.push({ file: contractFile, topic, reason: 'no Mind contract published' })
    continue
  }

  // Check if Mind contract was updated after the contracts.ts was last modified
  try {
    const mindEntry = JSON.parse(readFileSync(mindContractPath, 'utf-8'))
    const mindUpdated = new Date(mindEntry.updated).getTime()

    // Get the commit timestamp of the contracts.ts change
    const commitTime = execFileSync(
      'git', ['log', '-1', '--format=%aI', '--', contractFile],
      { cwd, encoding: 'utf-8' }
    ).trim()
    const fileUpdated = new Date(commitTime).getTime()

    if (fileUpdated > mindUpdated) {
      unpublished.push({
        file: contractFile,
        topic,
        reason: `contracts.ts modified after last Mind publish (file: ${commitTime}, mind: ${mindEntry.updated})`,
      })
    }
  } catch {
    unpublished.push({ file: contractFile, topic, reason: 'failed to compare timestamps' })
  }
}

if (unpublished.length === 0) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// --- Block the push ---
const details = unpublished.map(u =>
  `  - ${u.file} (topic: ${u.topic}) — ${u.reason}`
).join('\n')

const publishCmds = unpublished.map(u =>
  `  bun run bin/hive-mind.ts publish --type contract --topic ${u.topic} --agent ${AGENT_NAME || '<your-name>'} --data '<contract-json>'`
).join('\n')

const reason = [
  `CONTRACT PUBLISH REQUIRED: Push blocked — contracts.ts changed without Hive Mind publish.`,
  ``,
  `Unpublished contract changes:`,
  details,
  ``,
  `Publish your contracts before pushing:`,
  publishCmds,
  ``,
  `This ensures other agents are notified of API changes.`,
].join('\n')

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
}))
process.exit(0)
