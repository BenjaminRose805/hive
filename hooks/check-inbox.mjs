#!/usr/bin/env node
/**
 * check-inbox.mjs — Claude Code PostToolUse hook that checks for unread
 * messages in the agent's inbox directory after every tool call.
 * If unread messages exist, injects a nudge context so the agent knows
 * to check their inbox.
 */

import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const WORKER_ID = process.env.HIVE_WORKER_ID || ''
const GATEWAY_DIR = process.env.HIVE_GATEWAY_SOCKET
  ? join(process.env.HIVE_GATEWAY_SOCKET, '..')
  : '/tmp/hive-gateway'

// Not a Hive worker — skip
if (!WORKER_ID) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// Layer 3: Touch liveness timestamp on every tool call so the watchdog
// can detect agent activity without polling Discord for heartbeats.
const livenessDir = join(GATEWAY_DIR, 'liveness')
try {
  mkdirSync(livenessDir, { recursive: true })
  writeFileSync(join(livenessDir, `${WORKER_ID}.ts`), new Date().toISOString())
} catch {
  // Best-effort — don't block tool execution on liveness errors
}

const inboxDir = join(GATEWAY_DIR, 'inbox', 'messages', WORKER_ID)

let hasUnread = false
try {
  if (existsSync(inboxDir)) {
    const files = readdirSync(inboxDir).filter(
      f => f.endsWith('.json') && !f.startsWith('.')
    )
    hasUnread = files.length > 0
  }
} catch {
  // Best-effort — don't block tool execution on inbox errors
}

if (hasUnread) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: '[hive] New message — check inbox',
    },
  }))
} else {
  console.log(JSON.stringify({}))
}
process.exit(0)
