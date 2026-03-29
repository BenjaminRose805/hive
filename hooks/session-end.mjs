#!/usr/bin/env node

/**
 * Session-End Hook — Silent Failure Safety Net
 *
 * Fires when any agent's Claude Code session ends. Writes a FAILED task
 * contract and inbox notification so the manager knows the agent is dead,
 * even if the agent never got a chance to report.
 *
 * Reads from environment:
 *   HIVE_AGENT_NAME      — the agent's name (e.g., "alpha")
 *   HIVE_GATEWAY_SOCKET  — path to the gateway Unix socket
 *   HIVE_MIND_ROOT       — path to .hive/mind/ for task contracts
 *
 * Always fires, with or without an active task.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";

const agentName = process.env.HIVE_AGENT_NAME || process.env.HIVE_WORKER_ID;
const gatewaySocket = process.env.HIVE_GATEWAY_SOCKET;

// Bail silently if not running inside a hive session
if (!agentName || !gatewaySocket) {
  process.exit(0);
}

const inboxRoot = join(dirname(gatewaySocket), "inbox", "messages");

// Derive MIND_ROOT — try env var, fall back to HIVE_ROOT-based path
const mindRoot = process.env.HIVE_MIND_ROOT
  || (process.env.HIVE_ROOT ? join(process.env.HIVE_ROOT, ".hive", "mind") : "");

/**
 * Check if the agent already sent COMPLETE or FAILED in this session
 * by scanning the gateway inbox's processed directory for outbound messages.
 */
function alreadyReported() {
  try {
    const inboxDir = join(inboxRoot, agentName, ".processed");
    if (!existsSync(inboxDir)) return false;
    const files = readdirSync(inboxDir).filter((f) => f.endsWith(".json"));

    for (const file of files.slice(-50)) {
      try {
        const msg = JSON.parse(readFileSync(join(inboxDir, file), "utf-8"));
        const content = msg.content || "";
        if (
          content.startsWith(`COMPLETE | ${agentName}`) ||
          (content.startsWith(`STATUS | ${agentName}`) && content.includes("FAILED"))
        ) {
          return true;
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable — assume not reported
  }
  return false;
}

/**
 * Find the agent's active task by scanning task contracts in the mind.
 */
function findActiveTask() {
  if (!mindRoot) return null;
  const tasksDir = join(mindRoot, "tasks");
  if (!existsSync(tasksDir)) return null;

  try {
    const files = readdirSync(tasksDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    for (const file of files) {
      try {
        const task = JSON.parse(readFileSync(join(tasksDir, file), "utf-8"));
        if (task.assignee === agentName && !["COMPLETE", "FAILED"].includes(task.phase)) {
          return task;
        }
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * Mark task contract as FAILED.
 */
function failTaskContract(task) {
  if (!mindRoot) return;
  const now = new Date().toISOString();
  task.history.push({
    from: task.phase,
    to: "FAILED",
    agent: agentName,
    timestamp: now,
    reason: "Agent session terminated unexpectedly",
  });
  task.phase = "FAILED";
  task.updated = now;

  const tasksDir = join(mindRoot, "tasks");
  const tmpPath = join(tasksDir, `.${task.id}.tmp`);
  const finalPath = join(tasksDir, `${task.id}.json`);
  writeFileSync(tmpPath, JSON.stringify(task, null, 2));
  renameSync(tmpPath, finalPath);
}

/**
 * Write a notification to the manager's inbox.
 */
function notifyManager(message) {
  // Find manager name from agents.json
  let managerName = "monarch";
  try {
    const stateDir = process.env.HIVE_STATE_DIR || join(process.env.HIVE_ROOT || ".", "state");
    const agentsPath = join(stateDir, "agents.json");
    if (existsSync(agentsPath)) {
      const data = JSON.parse(readFileSync(agentsPath, "utf-8"));
      const mgr = data.agents?.find((a) => a.role === "manager");
      if (mgr) managerName = mgr.name;
    }
  } catch {}

  const targetDir = join(inboxRoot, managerName);
  mkdirSync(targetDir, { recursive: true });

  const msgId = randomUUID();
  const filename = `${Date.now()}-session-end-${msgId}.json`;
  const inboxMsg = {
    chatId: "",
    messageId: msgId,
    user: agentName,
    ts: new Date().toISOString(),
    content: message,
    attachments: [],
    source: "direct",
    priority: "critical",
  };

  const tmpPath = join(targetDir, `.${filename}.tmp`);
  const finalPath = join(targetDir, filename);
  writeFileSync(tmpPath, JSON.stringify(inboxMsg, null, 2));
  renameSync(tmpPath, finalPath);
}

/**
 * Layer 2: Mark any non-terminal task contracts assigned to this agent as FAILED.
 * This ensures the task system reflects reality even if the agent died mid-task.
 */
function failOrphanedTasks() {
  const mindRoot = process.env.HIVE_MIND_ROOT
    || (gatewaySocket ? join(dirname(dirname(gatewaySocket)), '.hive', 'mind') : '')
  if (!mindRoot) return

  const tasksDir = join(mindRoot, 'tasks')
  if (!existsSync(tasksDir)) return

  const TERMINAL_PHASES = new Set(['COMPLETE', 'FAILED'])
  const now = new Date().toISOString()

  try {
    const files = readdirSync(tasksDir).filter(f => f.endsWith('.json') && !f.startsWith('.'))
    for (const file of files) {
      try {
        const filePath = join(tasksDir, file)
        const task = JSON.parse(readFileSync(filePath, 'utf-8'))
        if (task.assignee === agentName && !TERMINAL_PHASES.has(task.phase)) {
          const previousPhase = task.phase
          task.history.push({
            from: previousPhase,
            to: 'FAILED',
            agent: agentName,
            timestamp: now,
            reason: 'Session terminated unexpectedly (session-end hook)',
          })
          task.phase = 'FAILED'
          task.updated = now
          writeFileSync(filePath, JSON.stringify(task, null, 2))
          process.stderr.write(
            `[session-end-hook] Marked task ${task.id} as FAILED (was ${previousPhase})\n`
          )
        }
      } catch {
        // Skip unreadable task files
      }
    }
  } catch {
    // Best-effort — don't block session teardown
  }
}

// --- Main ---

async function main() {
  if (alreadyReported()) {
    process.exit(0);
  }

  // Layer 2: Mark orphaned tasks as FAILED in the contract system
  failOrphanedTasks()

  const task = findActiveTask();
  const timestamp = new Date().toISOString();

  // Mark active task contract as FAILED
  if (task) {
    try {
      failTaskContract(task);
    } catch (err) {
      process.stderr.write(
        `[session-end-hook] Failed to update task contract for ${agentName}: ${err.message}\n`
      );
    }
  }

  // Notify manager via inbox
  const taskInfo = task ? ` (task: ${task.id})` : "";
  const message = [
    `STATUS | ${agentName} | ${task?.id ?? "-"} | FAILED`,
    `Time: ${timestamp}`,
    `Notice: Agent session terminated without sending COMPLETE or FAILED.${taskInfo}`,
    `Action: Manager should check if this agent had active work and reassign if needed.`,
  ].join("\n");

  try {
    notifyManager(message);
  } catch (err) {
    process.stderr.write(
      `[session-end-hook] Failed to notify manager about ${agentName}: ${err.message}\n`
    );
  }
}

main().catch(() => process.exit(1));
