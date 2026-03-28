#!/usr/bin/env bun

/**
 * Hive Watchdog — Heartbeat Freshness Monitor
 *
 * Background process that monitors agent heartbeat freshness.
 * If a worker has an active task and no heartbeat for 10 minutes,
 * alerts the manager's Discord channel.
 *
 * Alert-only — does NOT auto-restart agents.
 *
 * Usage:
 *   bun run bin/hive-watchdog.ts --project <name>
 *
 * Environment:
 *   HIVE_GATEWAY_SOCKET — path to gateway Unix socket (default: /tmp/hive-gateway/gateway.sock)
 *   HIVE_STATE_DIR      — path to state directory (default: ./state)
 *   HIVE_DIR            — hive root directory (default: cwd)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// --- Configuration ---

const CHECK_INTERVAL_MS = 60_000; // Check every 60 seconds
const HEARTBEAT_TIMEOUT_MS = 10 * 60_000; // 10 minutes
const ALERT_COOLDOWN_MS = 15 * 60_000; // Don't re-alert for same agent within 15 min
const FETCH_LIMIT = 20; // Messages to fetch per channel check

// --- Argument parsing ---

const args = process.argv.slice(2);
let project = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--project" && args[i + 1]) {
    project = args[i + 1];
    i++;
  }
}

if (!project) {
  console.error("Usage: bun run bin/hive-watchdog.ts --project <name>");
  process.exit(1);
}

// --- Paths ---

const HIVE_DIR = process.env.HIVE_DIR ?? process.cwd();
const STATE_DIR = process.env.HIVE_STATE_DIR ?? join(HIVE_DIR, "state");
const GATEWAY_SOCKET =
  process.env.HIVE_GATEWAY_SOCKET ?? "/tmp/hive-gateway/gateway.sock";

const projectStateDir = join(STATE_DIR, project);
const agentsFile = join(projectStateDir, "agents.json");
const gatewayConfigFile = join(projectStateDir, "gateway", "config.json");
const channelsFile = join(projectStateDir, "gateway", "channels.json");
const watchdogStateFile = join(projectStateDir, "watchdog-state.json");

// --- Types ---

interface AgentEntry {
  name: string;
  role: string;
  status: string;
  channelId?: string;
}

interface WatchdogState {
  lastActivity: Record<string, string>; // agentName → ISO timestamp
  lastAlert: Record<string, string>; // agentName → ISO timestamp
  activeTask: Record<string, string | null>; // agentName → taskId | null
}

// --- Gateway HTTP helpers ---

function gatewayRequest(
  path: string,
  method: string,
  body?: unknown
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use Bun's fetch with unix socket if available, otherwise node http
    const payload = body ? JSON.stringify(body) : undefined;

    const url = `http://localhost${path}`;
    fetch(url, {
      method,
      headers: payload
        ? { "Content-Type": "application/json", "X-Worker-Id": "watchdog" }
        : { "X-Worker-Id": "watchdog" },
      body: payload,
      unix: GATEWAY_SOCKET,
    })
      .then((res) => res.text())
      .then(resolve)
      .catch(reject);
  });
}

async function fetchMessages(
  channelId: string,
  limit: number
): Promise<Array<{ content: string; timestamp: string; author: string }>> {
  try {
    const res = await gatewayRequest("/fetch", "POST", {
      channel: channelId,
      limit,
    });
    const data = JSON.parse(res);
    return data.messages || [];
  } catch {
    return [];
  }
}

async function sendAlert(channelId: string, text: string): Promise<void> {
  try {
    await gatewayRequest("/send", "POST", {
      chat_id: channelId,
      text: text,
    });
  } catch (err) {
    console.error(`[watchdog] Failed to send alert: ${err}`);
  }
}

// --- State management ---

function loadState(): WatchdogState {
  try {
    if (existsSync(watchdogStateFile)) {
      return JSON.parse(readFileSync(watchdogStateFile, "utf-8"));
    }
  } catch {
    // Corrupted state — start fresh
  }
  return { lastActivity: {}, lastAlert: {}, activeTask: {} };
}

function saveState(state: WatchdogState): void {
  try {
    mkdirSync(dirname(watchdogStateFile), { recursive: true });
    writeFileSync(watchdogStateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[watchdog] Failed to save state: ${err}`);
  }
}

// --- Agent discovery ---

function getAgents(): AgentEntry[] {
  try {
    const data = JSON.parse(readFileSync(agentsFile, "utf-8"));
    return data.agents || [];
  } catch {
    return [];
  }
}

function getChannels(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(channelsFile, "utf-8"));
  } catch {
    return {};
  }
}

function getManagerChannelId(): string | null {
  try {
    const config = JSON.parse(readFileSync(gatewayConfigFile, "utf-8"));
    // Find the manager/coordinator agent's channel
    const workers = config.workers || [];
    const manager = workers.find(
      (w: { role: string }) =>
        w.role === "manager" || w.role === "coordinator"
    );
    if (manager?.channelId) return manager.channelId;

    // Fallback: look in channels.json for monarch/manager
    const channels = getChannels();
    return channels["monarch"] || channels["manager"] || null;
  } catch {
    return null;
  }
}

// --- Protocol message parsing ---

const HEARTBEAT_RE = /^HEARTBEAT\s*\|\s*(\S+)/;
const STATUS_RE = /^STATUS\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)/;
const COMPLETE_RE = /^COMPLETE\s*\|\s*(\S+)\s*\|\s*(\S+)/;
const TASK_ASSIGN_RE = /^TASK_ASSIGN\s*\|\s*(\S+)\s*\|\s*(\S+)/;

function parseActivity(
  content: string
): {
  type: string;
  agent: string;
  taskId?: string;
  status?: string;
} | null {
  let match: RegExpExecArray | null;

  match = HEARTBEAT_RE.exec(content);
  if (match) return { type: "heartbeat", agent: match[1] };

  match = STATUS_RE.exec(content);
  if (match)
    return {
      type: "status",
      agent: match[1],
      taskId: match[2],
      status: match[3],
    };

  match = COMPLETE_RE.exec(content);
  if (match)
    return { type: "complete", agent: match[1], taskId: match[2] };

  match = TASK_ASSIGN_RE.exec(content);
  if (match)
    return { type: "task_assign", agent: match[1], taskId: match[2] };

  return null;
}

// --- File-based liveness ---

const LIVENESS_DIR = join(dirname(GATEWAY_SOCKET), "liveness");

function readLivenessTimestamp(agentName: string): number {
  try {
    const filePath = join(LIVENESS_DIR, `${agentName}.ts`);
    if (!existsSync(filePath)) return 0;
    const content = readFileSync(filePath, "utf-8").trim();
    const ts = new Date(content).getTime();
    return Number.isNaN(ts) ? 0 : ts;
  } catch {
    return 0;
  }
}

// --- Main check cycle ---

async function checkAgents(state: WatchdogState): Promise<void> {
  const agents = getAgents().filter((a) => a.status === "running");
  const channels = getChannels();
  const managerChannelId = getManagerChannelId();
  const now = Date.now();

  if (!managerChannelId) {
    console.error("[watchdog] Cannot find manager channel ID — skipping cycle");
    return;
  }

  for (const agent of agents) {
    const channelId = channels[agent.name] || agent.channelId;
    if (!channelId) continue;

    // Layer 3: Check file-based liveness timestamps first (preferred over Discord polling)
    const fileTs = readLivenessTimestamp(agent.name);
    if (fileTs > 0) {
      const lastKnown = state.lastActivity[agent.name]
        ? new Date(state.lastActivity[agent.name]).getTime()
        : 0;
      if (fileTs > lastKnown) {
        state.lastActivity[agent.name] = new Date(fileTs).toISOString();
      }
    }

    // Fallback: Fetch recent messages from this agent's channel
    const messages = await fetchMessages(channelId, FETCH_LIMIT);

    // Process messages for activity signals
    for (const msg of messages) {
      const parsed = parseActivity(msg.content);
      if (!parsed || parsed.agent !== agent.name) continue;

      // Update last activity timestamp
      const msgTime = new Date(msg.timestamp).getTime();
      const lastKnown = state.lastActivity[agent.name]
        ? new Date(state.lastActivity[agent.name]).getTime()
        : 0;

      if (msgTime > lastKnown) {
        state.lastActivity[agent.name] = msg.timestamp;
      }

      // Track task state
      if (parsed.type === "task_assign") {
        state.activeTask[agent.name] = parsed.taskId || null;
      } else if (
        parsed.type === "complete" ||
        (parsed.type === "status" &&
          (parsed.status === "FAILED" || parsed.status === "COMPLETED"))
      ) {
        state.activeTask[agent.name] = null;
      } else if (
        parsed.type === "status" &&
        parsed.status === "ACCEPTED" &&
        parsed.taskId
      ) {
        state.activeTask[agent.name] = parsed.taskId;
      }
    }

    // Check if this agent needs an alert
    const hasActiveTask = !!state.activeTask[agent.name];
    if (!hasActiveTask) continue;

    const lastSeen = state.lastActivity[agent.name]
      ? new Date(state.lastActivity[agent.name]).getTime()
      : 0;
    const timeSinceActivity = now - lastSeen;

    if (timeSinceActivity < HEARTBEAT_TIMEOUT_MS) continue;

    // Check alert cooldown
    const lastAlertTime = state.lastAlert[agent.name]
      ? new Date(state.lastAlert[agent.name]).getTime()
      : 0;
    if (now - lastAlertTime < ALERT_COOLDOWN_MS) continue;

    // Send alert to manager
    const minutesSilent = Math.round(timeSinceActivity / 60_000);
    const taskId = state.activeTask[agent.name];
    const alertMsg = [
      `ALERT | watchdog | -`,
      `${agent.name} has been silent for ${minutesSilent}min with active task ${taskId}`,
      `Action: Check tmux session or reassign task.`,
    ].join("\n");

    console.log(`[watchdog] Alerting: ${agent.name} silent for ${minutesSilent}min on task ${taskId}`);
    await sendAlert(managerChannelId, alertMsg);
    state.lastAlert[agent.name] = new Date().toISOString();
  }
}

// --- Entrypoint ---

async function main(): Promise<void> {
  console.log(`[watchdog] Starting for project: ${project}`);
  console.log(`[watchdog] Gateway socket: ${GATEWAY_SOCKET}`);
  console.log(`[watchdog] Check interval: ${CHECK_INTERVAL_MS / 1000}s`);
  console.log(`[watchdog] Heartbeat timeout: ${HEARTBEAT_TIMEOUT_MS / 60_000}min`);

  // Wait for gateway to be ready
  let gatewayReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await gatewayRequest("/health", "GET");
      const data = JSON.parse(res);
      if (data.botId) {
        gatewayReady = true;
        console.log(`[watchdog] Gateway connected (bot: ${data.connectedAs || data.botId})`);
        break;
      }
    } catch {
      // Gateway not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!gatewayReady) {
    console.error("[watchdog] Gateway did not become ready in 30s — exiting");
    process.exit(1);
  }

  const state = loadState();

  // Main loop
  while (true) {
    try {
      await checkAgents(state);
      saveState(state);
    } catch (err) {
      console.error(`[watchdog] Check cycle error: ${err}`);
    }
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(`[watchdog] Fatal: ${err}`);
  process.exit(1);
});
