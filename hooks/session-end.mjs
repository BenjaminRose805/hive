#!/usr/bin/env node

/**
 * Session-End Hook — Silent Failure Safety Net
 *
 * Fires when any agent's Claude Code session ends. Posts a failure notice
 * to Discord via the gateway socket so the manager knows the agent is dead,
 * even if the agent never got a chance to report.
 *
 * Reads from environment:
 *   HIVE_AGENT_NAME  — the agent's name (e.g., "alpha")
 *   HIVE_CHANNEL_ID  — the agent's Discord channel ID
 *   HIVE_GATEWAY_SOCKET — path to the gateway Unix socket
 *
 * Always fires, with or without an active task.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { request } from "http";

const agentName = process.env.HIVE_AGENT_NAME;
const channelId = process.env.HIVE_CHANNEL_ID;
const gatewaySocket = process.env.HIVE_GATEWAY_SOCKET;

// Bail silently if not running inside a hive session
if (!agentName || !channelId || !gatewaySocket) {
  process.exit(0);
}

/**
 * Check if the agent already sent COMPLETE or FAILED in this session
 * by scanning the gateway inbox's processed directory for outbound messages.
 * This is a best-effort check — if we can't determine, we post anyway (safe default).
 */
function alreadyReported() {
  try {
    const inboxDir = join(dirname(gatewaySocket), "inbox", "messages", agentName, ".processed");
    const files = readdirSync(inboxDir).filter((f) => f.endsWith(".json"));

    // Check recent processed messages for COMPLETE or FAILED from this agent
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
 * Post a message to Discord via the gateway's HTTP /send endpoint
 * over the Unix domain socket.
 */
function postToDiscord(text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: channelId,
      text: text,
    });

    const req = request(
      {
        socketPath: gatewaySocket,
        path: "/send",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "X-Worker-Id": agentName,
        },
        timeout: 5000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Gateway request timed out"));
    });
    req.write(payload);
    req.end();
  });
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
  // If the agent already sent COMPLETE or FAILED, no need to post again
  if (alreadyReported()) {
    process.exit(0);
  }

  // Layer 2: Mark orphaned tasks as FAILED in the contract system
  failOrphanedTasks()

  const timestamp = new Date().toISOString();
  const message = [
    `STATUS | ${agentName} | - | FAILED`,
    `Time: ${timestamp}`,
    `Notice: Agent session terminated without sending COMPLETE or FAILED.`,
    `Action: Manager should check if this agent had active work and reassign if needed.`,
  ].join("\n");

  try {
    await postToDiscord(message);
  } catch (err) {
    // Last resort: write to stderr so it appears in tmux logs
    process.stderr.write(
      `[session-end-hook] Failed to post session-end notice for ${agentName}: ${err.message}\n`
    );
  }
}

main().catch(() => process.exit(1));
