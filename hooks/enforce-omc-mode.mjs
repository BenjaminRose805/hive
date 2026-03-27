#!/usr/bin/env node
/**
 * enforce-omc-mode.mjs — Claude Code PreToolUse hook for OMC mode enforcement.
 *
 * Reads the task mode from .hive/state/workers/{agent}/task-mode.json and checks
 * whether an OMC orchestration mode (ralph, ultrawork, autopilot, team) is active
 * in .omc/state/. Enforcement levels:
 *
 *   - "required": BLOCK writes if no OMC mode is active.
 *   - "recommended": WARN after 3 writes, ALERT after 6 writes (never blocks).
 *   - "optional" or missing file: allow silently.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, join } from 'path'
import { stdin } from 'process'

// --- Helpers ---
function allow(additionalContext) {
  if (additionalContext) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext,
      },
    }))
  } else {
    console.log(JSON.stringify({}))
  }
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

// --- Read stdin ---
const chunks = []
for await (const chunk of stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString())

const toolName = input.tool_name || ''

// Only enforce on write tools
if (toolName !== 'Write' && toolName !== 'Edit') {
  allow()
}

// --- Read task mode ---
const TASK_MODE_PATH = resolve(HIVE_ROOT, '.hive', 'state', 'workers', AGENT_NAME, 'task-mode.json')

let taskMode
try {
  taskMode = JSON.parse(readFileSync(TASK_MODE_PATH, 'utf-8'))
} catch {
  // No task-mode file = optional, allow silently
  allow()
}

const mode = (taskMode.mode || 'optional').toLowerCase()

// Optional mode — always allow
if (mode === 'optional') {
  allow()
}

// --- Check for active OMC mode ---
const cwd = process.cwd()
const OMC_STATE_DIR = resolve(cwd, '.omc', 'state')
const OMC_MODES = ['ralph', 'ultrawork', 'autopilot', 'team']

function isOmcActive() {
  for (const modeName of OMC_MODES) {
    const stateFile = join(OMC_STATE_DIR, `${modeName}-state.json`)
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'))
      if (state.active === true) return true
    } catch {
      // File doesn't exist or isn't valid — skip
    }
  }
  return false
}

const omcActive = isOmcActive()

// If OMC is active, allow regardless of mode
if (omcActive) {
  allow()
}

// --- Required mode: block ---
if (mode === 'required') {
  const recommendedMode = taskMode.recommended || 'ralph'
  deny([
    `OMC ENFORCEMENT: Task mode is "required" but no OMC orchestration mode is active.`,
    ``,
    `Activate an OMC mode before making writes:`,
    `  Recommended: /${recommendedMode}`,
    `  Alternatives: /ralph, /ultrawork, /autopilot, /team`,
    ``,
    `This task requires structured orchestration for quality and traceability.`,
  ].join('\n'))
}

// --- Recommended mode: warn/alert based on write count ---
if (mode === 'recommended') {
  const COUNTER_PATH = resolve(HIVE_ROOT, '.hive', 'state', 'workers', AGENT_NAME, 'omc-write-count.json')

  let count = 0
  try {
    const data = JSON.parse(readFileSync(COUNTER_PATH, 'utf-8'))
    count = data.count || 0
  } catch {
    // No counter file yet
  }

  // Increment
  count++

  // Persist counter
  try {
    const dir = resolve(HIVE_ROOT, '.hive', 'state', 'workers', AGENT_NAME)
    mkdirSync(dir, { recursive: true })
    writeFileSync(COUNTER_PATH, JSON.stringify({ count, lastWrite: new Date().toISOString() }))
  } catch {
    // Non-fatal — counter persistence failed
  }

  const recommendedMode = taskMode.recommended || 'ralph'

  if (count >= 6) {
    allow([
      `⚠️ OMC ALERT: ${count} writes without OMC orchestration (task mode: recommended).`,
      `You SHOULD activate an OMC mode now. Recommended: /${recommendedMode}`,
      `OMC modes provide structured verification and prevent drift on complex tasks.`,
    ].join('\n'))
  } else if (count >= 3) {
    allow([
      `OMC NOTICE: ${count} writes without OMC orchestration (task mode: recommended).`,
      `Consider activating /${recommendedMode} for better task structure.`,
    ].join('\n'))
  } else {
    allow()
  }
}

// Fallback — should not reach here
allow()
