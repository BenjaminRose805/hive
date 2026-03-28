#!/usr/bin/env node
/**
 * intercept-ask-user.mjs — Claude Code PreToolUse hook that blocks AskUserQuestion
 * when running as a Hive worker. Agents should use Discord for all communication,
 * not the interactive AskUserQuestion tool.
 */

const AGENT_NAME = process.env.HIVE_WORKER_ID || ''

// No agent = not a Hive worker session — allow AskUserQuestion
if (!AGENT_NAME) {
  console.log(JSON.stringify({}))
  process.exit(0)
}

// Block AskUserQuestion and redirect to task contract tools
const reason = [
  `BLOCKED: AskUserQuestion is disabled for Hive workers.`,
  ``,
  `You are agent "${AGENT_NAME}" running in a Hive session.`,
  `Use task contract tools to communicate instead:`,
  `  - hive__task_question to ask a blocking question about your task`,
  `  - hive__send to message a teammate directly`,
  `  - discord__reply to post in your agent channel (if available)`,
].join('\n')

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
}))
process.exit(0)
