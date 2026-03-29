#!/usr/bin/env node
/**
 * keep-working.mjs — Claude Code Stop hook that prevents agents from going
 * idle when they have active (non-terminal) task contracts.
 *
 * If the agent has an IN_PROGRESS or ACCEPTED task, the hook blocks the stop
 * and injects a continuation message. If all tasks are COMPLETE/FAILED, or
 * there are no tasks, the stop is allowed.
 *
 * Environment:
 *   HIVE_WORKER_ID   — this agent's name
 *   HIVE_MIND_ROOT   — path to .hive/mind (contains tasks/)
 *   HIVE_GATEWAY_SOCKET — used to derive MIND_ROOT if not set directly
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const WORKER_ID = process.env.HIVE_WORKER_ID || ''
const MIND_ROOT = process.env.HIVE_MIND_ROOT
  || (process.env.HIVE_GATEWAY_SOCKET
    ? join(dirname(dirname(process.env.HIVE_GATEWAY_SOCKET)), '.hive', 'mind')
    : '')

// Not a Hive worker — allow stop
if (!WORKER_ID || !MIND_ROOT) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

const TERMINAL_PHASES = new Set(['COMPLETE', 'FAILED'])
const tasksDir = join(MIND_ROOT, 'tasks')

/**
 * Find any non-terminal task assigned to this worker.
 */
function findActiveTask() {
  if (!existsSync(tasksDir)) return null

  const files = readdirSync(tasksDir).filter(f => f.endsWith('.json') && !f.startsWith('.'))

  for (const file of files) {
    try {
      const task = JSON.parse(readFileSync(join(tasksDir, file), 'utf-8'))
      if (task.assignee === WORKER_ID && !TERMINAL_PHASES.has(task.phase)) {
        return task
      }
    } catch {
      // Skip unreadable files
    }
  }
  return null
}

const activeTask = findActiveTask()

if (activeTask) {
  // Block stop — agent has active work
  const reason = [
    `BLOCKED: You have an active task — do not stop.`,
    ``,
    `Task: ${activeTask.id} (${activeTask.title})`,
    `Phase: ${activeTask.phase}`,
    ``,
    `You must either:`,
    `  1. Complete the task (hive__task_complete)`,
    `  2. Fail the task with a reason (hive__task_fail)`,
    ``,
    `Continue working on your task now.`,
  ].join('\n')

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      stopDecision: 'block',
      stopReason: reason,
    },
  }))
} else {
  // No active tasks — allow stop
  console.log(JSON.stringify({}))
}

process.exit(0)
