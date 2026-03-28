#!/usr/bin/env node

/**
 * Session-End Hook — Silent Failure Safety Net
 *
 * Fires when any agent's Claude Code session ends. Updates the task contract
 * to FAILED state and writes a failure notification to monarch's inbox.
 * Falls back to posting via Discord gateway as a last resort.
 *
 * Reads from environment:
 *   HIVE_AGENT_NAME  — the agent's name (e.g., "alpha")
 *   HIVE_CHANNEL_ID  — the agent's Discord channel ID
 *   HIVE_GATEWAY_SOCKET — path to the gateway Unix socket
 *
 * Always fires, with or without an active task.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
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
 * Find and update any active task contract for this agent.
 * Task contracts live at .hive/mind/tasks/{id}.json relative to the project root.
 * We derive the project root by searching upward from the gateway socket directory.
 */
function updateTaskContract(timestamp, reason) {
  const socketDir = dirname(gatewaySocket);
  const candidates = [
    join(socketDir, "..", "..", ".hive", "mind", "tasks"),
    join(socketDir, "..", ".hive", "mind", "tasks"),
    join(socketDir, ".hive", "mind", "tasks"),
  ];

  let tasksDir = null;
  for (const candidate of candidates) {
    try {
      readdirSync(candidate);
      tasksDir = candidate;
      break;
    } catch {
      // Not found here
    }
  }

  if (!tasksDir) return null;

  const terminalPhases = new Set(["COMPLETE", "FAILED", "approved", "merged", "failed"]);
  const files = readdirSync(tasksDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const filePath = join(tasksDir, file);
    try {
      const task = JSON.parse(readFileSync(filePath, "utf-8"));
      if (task.assignee !== agentName) continue;
      if (terminalPhases.has(task.phase)) continue;

      // Found an active task — mark it FAILED
      const prevPhase = task.phase;
      task.phase = "FAILED";
      task.updated = timestamp;
      if (!Array.isArray(task.history)) task.history = [];
      task.history.push({
        from: prevPhase,
        to: "FAILED",
        agent: agentName,
        timestamp,
        reason,
      });

      writeFileSync(filePath, JSON.stringify(task, null, 2), "utf-8");
      return { id: task.id, title: task.title };
    } catch {
      // Skip unreadable or malformed files
    }
  }

  return null;
}

/**
 * Write a failure notification to monarch's inbox (file-based).
 * Inbox path: join(dirname(gatewaySocket), "inbox", "messages", "monarch")
 */
function writeInboxMessage(timestamp, content) {
  const inboxDir = join(dirname(gatewaySocket), "inbox", "messages", "monarch");
  try {
    mkdirSync(inboxDir, { recursive: true });
    const messageId = `session-end-${Date.now()}`;
    const msg = {
      chatId: "",
      messageId,
      user: agentName,
      ts: timestamp,
      content,
      attachments: [],
    };
    writeFileSync(join(inboxDir, `${messageId}.json`), JSON.stringify(msg, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Post a message to Discord via the gateway's HTTP /send endpoint
 * over the Unix domain socket. Best-effort fallback only.
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

// --- Main ---

async function main() {
  // If the agent already sent COMPLETE or FAILED, no need to post again
  if (alreadyReported()) {
    process.exit(0);
  }

  const timestamp = new Date().toISOString();
  const reason = "Agent session terminated without sending COMPLETE or FAILED.";

  // 1. Update task contract if one exists for this agent
  const updatedTask = updateTaskContract(timestamp, reason);

  // 2. Build failure message
  const taskNote = updatedTask
    ? `Task: ${updatedTask.id} — "${updatedTask.title}" marked FAILED.`
    : "No active task contract found for this agent.";

  const message = [
    `STATUS | ${agentName} | - | FAILED`,
    `Time: ${timestamp}`,
    `Notice: ${reason}`,
    taskNote,
    `Action: Manager should check if this agent had active work and reassign if needed.`,
  ].join("\n");

  // 3. Write to monarch's inbox (primary notification path)
  const inboxOk = writeInboxMessage(timestamp, message);

  // 4. Last-resort fallback: post to Discord via gateway socket
  if (!inboxOk) {
    try {
      await postToDiscord(message);
    } catch (err) {
      // Last resort: write to stderr so it appears in tmux logs
      process.stderr.write(
        `[session-end-hook] Failed to notify for ${agentName}: ${err.message}\n`
      );
    }
  }
}

main().catch(() => process.exit(1));
