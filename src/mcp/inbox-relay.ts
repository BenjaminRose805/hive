#!/usr/bin/env bun

/**
 * src/mcp/inbox-relay.ts
 *
 * MCP server that provides inbox reading for Hive workers.
 * Workers call hive__check_inbox to retrieve pending messages
 * written by the gateway's file-based inbox system.
 *
 * Env vars:
 *   HIVE_INBOX_DIR — path to this worker's inbox directory (required)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const INBOX_DIR = process.env.HIVE_INBOX_DIR;
if (!INBOX_DIR) {
  process.stderr.write("inbox-relay: HIVE_INBOX_DIR is required\n");
  process.exit(1);
}

const INBOX_ROOT = process.env.HIVE_INBOX_ROOT ?? "";
const WORKER_ID = process.env.HIVE_WORKER_ID ?? "worker";
const GATEWAY_SOCKET = process.env.HIVE_GATEWAY_SOCKET ?? "";

const PROCESSED_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "hive__check_inbox",
    description:
      "Read all pending messages from your Hive inbox. Returns an array of message objects and moves them to processed. Call this when you see a [hive] nudge notification.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "hive__send",
    description:
      "Send a message directly to another worker. Writes to their inbox and nudges them. The message is also echoed to Discord for human visibility.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: { type: "string", description: 'Target worker name (e.g. "alice", "bob").' },
        text: { type: "string", description: "Message text to send (max 10KB)." },
        priority: {
          type: "string",
          enum: ["info", "alert", "response", "critical"],
          description:
            "Message priority. info=FYI (default), alert=problem affecting them, response=answering their question, critical=must interrupt.",
        },
        task_id: {
          type: "string",
          description:
            "Optional task ID. When provided, the Discord echo goes to the task channel instead of the target agent channel.",
        },
      },
      required: ["to", "text"],
    },
  },
  {
    name: "hive__set_status",
    description:
      'Set your worker status. Use "available" when between tasks, "focused" when deep in work (suppresses non-critical nudges), "blocked" when waiting on something.',
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["available", "focused", "blocked"],
          description: "Your current status.",
        },
      },
      required: ["status"],
    },
  },
  {
    name: "hive__create_channel",
    description:
      "Create a conversation channel for multi-party discussion. You become active (inbox delivery). Other participants start as observing (they read Discord history and can promote themselves to active). Returns participant statuses.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: { type: "string", description: "Channel topic/purpose (used in channel name)" },
        participants: {
          type: "array",
          items: { type: "string" },
          description: "Worker names to include (they start as observing)",
        },
        message: { type: "string", description: "Optional initial message to post in the channel" },
      },
      required: ["topic", "participants"],
    },
  },
  {
    name: "hive__add_to_channel",
    description:
      "Add an agent to an existing conversation channel as an observer. They get a notification with the channel ID and can promote to active when ready. Returns their current status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: {
          type: "string",
          description: "Discord channel ID of the conversation channel",
        },
        agent: { type: "string", description: "Worker name to add" },
      },
      required: ["channel_id", "agent"],
    },
  },
  {
    name: "hive__set_channel_tier",
    description:
      'Change your participation tier in a conversation channel. "active" = receive every message in your inbox (real-time collaboration). "observing" = no inbox delivery, read Discord history on your own schedule.',
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: {
          type: "string",
          description: "Discord channel ID of the conversation channel",
        },
        tier: { type: "string", enum: ["active", "observing"], description: "Participation tier" },
      },
      required: ["channel_id", "tier"],
    },
  },
  {
    name: "hive__leave_channel",
    description:
      "Leave a conversation channel entirely. You will no longer receive messages or be listed as a participant.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel_id: { type: "string", description: "Discord channel ID to leave" },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "hive__my_channels",
    description:
      "List conversation channels you are a member of, with your tier (active/observing). Useful after context compaction to recover channel IDs.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "hive__team_status",
    description:
      "Get current status (available/focused/blocked) of all team members. Use before creating channels to check availability.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Inbox reading with consume-on-read (move to .processed/)
// ---------------------------------------------------------------------------

interface InboxMessage {
  chatId: string;
  messageId: string;
  user: string;
  ts: string;
  content: string;
  attachments: Array<{ name: string; contentType: string; size: number; url: string }>;
  source?: string; // "direct" for worker-to-worker, "mind" for daemon notifications, absent for Discord
  mindType?: string; // Mind notification type (e.g. "mind-update", "watch-resolved", "nudge")
  priority?: string; // Message priority ("info", "alert", "response", "critical")
  topic?: string; // Mind topic reference
  taskChannelId?: string; // Task channel ID (present on TASK_ASSIGN messages)
}

async function gatewayFetch(path: string, body?: object): Promise<any> {
  if (!GATEWAY_SOCKET) return null;
  try {
    const isGet = body === undefined;
    const res = await fetch(`http://localhost${path}`, {
      method: isGet ? "GET" : "POST",
      ...(isGet
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      unix: GATEWAY_SOCKET,
      signal: AbortSignal.timeout(5000),
    } as any);
    // Best-effort: don't throw on non-2xx (e.g. Discord echo may fail if channel not resolved)
    if (res.ok) return await res.json();
    return null;
  } catch {
    return null; // Gateway unavailable — not an error for send operations
  }
}

function cleanProcessed(): void {
  const processedDir = join(INBOX_DIR!, ".processed");
  if (!existsSync(processedDir)) return;

  try {
    const now = Date.now();
    for (const file of readdirSync(processedDir)) {
      const filePath = join(processedDir, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > PROCESSED_TTL_MS) {
          unlinkSync(filePath);
        }
      } catch {}
    }
  } catch {}
}

function readInbox(): InboxMessage[] {
  // Clean up old processed files first
  cleanProcessed();

  if (!existsSync(INBOX_DIR!)) return [];

  const files = readdirSync(INBOX_DIR!)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort(); // timestamp prefix ensures chronological order

  if (files.length === 0) return [];

  const processedDir = join(INBOX_DIR!, ".processed");
  mkdirSync(processedDir, { recursive: true });

  const messages: InboxMessage[] = [];

  for (const file of files) {
    const filePath = join(INBOX_DIR!, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const msg = JSON.parse(raw) as InboxMessage;
      messages.push(msg);

      // Move to .processed/ instead of deleting (crash-safe per Architect review)
      const processedPath = join(processedDir, file);
      try {
        renameSync(filePath, processedPath);
      } catch {
        // If rename fails (cross-device), fall back to delete
        try {
          unlinkSync(filePath);
        } catch {}
      }
    } catch {
      // File vanished between readdir and read (race condition) — skip gracefully
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "hive__check_inbox": {
      const messages = readInbox();
      if (messages.length === 0) {
        return JSON.stringify({ messages: [], count: 0 });
      }
      return JSON.stringify({ messages, count: messages.length });
    }
    case "hive__send": {
      const to = args.to as string;
      const text = args.text as string;
      const priority = (args.priority as string) ?? "info";
      const taskId = args.task_id as string | undefined;
      if (!to) throw new Error("to is required");
      if (!text) throw new Error("text is required");

      // Validate worker name format (prevent path traversal)
      if (!/^[a-zA-Z0-9-]{1,32}$/.test(to)) {
        throw new Error("Invalid worker name. Must be alphanumeric + hyphens, 1-32 chars.");
      }

      // Size limit: 10KB
      if (text.length > 10240) {
        throw new Error("Message too large. Maximum 10KB.");
      }

      if (!INBOX_ROOT) {
        throw new Error("HIVE_INBOX_ROOT not configured — cannot send to other workers");
      }

      // Write message to target worker's inbox
      const targetDir = join(INBOX_ROOT, to);
      mkdirSync(targetDir, { recursive: true });

      const msgId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const message: InboxMessage = {
        chatId: "",
        messageId: msgId,
        user: WORKER_ID,
        ts: timestamp,
        content: text,
        attachments: [],
        source: "direct",
        priority,
      };

      // Echo to Discord for human visibility (best-effort)
      // Do this BEFORE direct inbox write so we can check skip_direct_inbox
      const echoText = `[${WORKER_ID} → ${to}] ${text}`;
      const echoPayload = taskId
        ? { chat_id: "task", task_id: taskId, text: echoText, sender: WORKER_ID, target_agent: to }
        : { chat_id: "auto", target_agent: to, text: echoText, sender: WORKER_ID };
      const echoResult = await gatewayFetch("/send", echoPayload);

      // If target is an active conversation channel member, Pass 3 will deliver via routeInbound.
      // Skip the direct inbox write to prevent duplicate delivery.
      if (!echoResult?.skip_direct_inbox) {
        const filename = `${Date.now()}-${msgId}.json`;
        const tmpPath = join(targetDir, `.${filename}.tmp`);
        const finalPath = join(targetDir, filename);
        writeFileSync(tmpPath, JSON.stringify(message, null, 2));
        renameSync(tmpPath, finalPath);

        // Nudge target worker (best-effort)
        await gatewayFetch("/nudge", { workerId: to, priority });
      }

      return JSON.stringify({ sent: true, to, messageId: msgId });
    }
    case "hive__set_status": {
      const status = args.status as string;
      if (!["available", "focused", "blocked"].includes(status)) {
        throw new Error("status must be available, focused, or blocked");
      }
      await gatewayFetch("/status", { workerId: WORKER_ID, status });
      return JSON.stringify({ status, workerId: WORKER_ID });
    }
    case "hive__create_channel": {
      const topic = args.topic as string;
      // MCP clients may stringify array arguments — parse defensively
      let participants: string[] | undefined;
      if (Array.isArray(args.participants)) {
        participants = args.participants as string[];
      } else if (typeof args.participants === "string") {
        try {
          participants = JSON.parse(args.participants);
        } catch {}
      }
      const message = args.message as string | undefined;
      if (!topic) throw new Error("topic is required");
      if (!Array.isArray(participants) || participants.length === 0)
        throw new Error("participants is required (non-empty array)");

      const result = await gatewayFetch("/create-channel", {
        topic,
        participants,
        ...(message ? { message } : {}),
        creator: WORKER_ID,
      });
      if (!result) throw new Error("Gateway unavailable or request failed");
      return JSON.stringify(result);
    }
    case "hive__add_to_channel": {
      const channelId = args.channel_id as string;
      const agent = args.agent as string;
      if (!channelId) throw new Error("channel_id is required");
      if (!agent) throw new Error("agent is required");

      const result = await gatewayFetch("/add-to-channel", {
        channel_id: channelId,
        agent,
        added_by: WORKER_ID,
      });
      if (!result) throw new Error("Gateway unavailable or request failed");
      return JSON.stringify(result);
    }
    case "hive__set_channel_tier": {
      const channelId = args.channel_id as string;
      const tier = args.tier as string;
      if (!channelId) throw new Error("channel_id is required");
      if (!tier || !["active", "observing"].includes(tier))
        throw new Error("tier must be active or observing");

      const result = await gatewayFetch("/set-channel-tier", {
        channel_id: channelId,
        agent: WORKER_ID,
        tier,
      });
      if (!result) throw new Error("Gateway unavailable or request failed");
      return JSON.stringify(result);
    }
    case "hive__leave_channel": {
      const channelId = args.channel_id as string;
      if (!channelId) throw new Error("channel_id is required");

      const result = await gatewayFetch("/leave-channel", {
        channel_id: channelId,
        agent: WORKER_ID,
      });
      if (!result) throw new Error("Gateway unavailable or request failed");
      return JSON.stringify(result);
    }
    case "hive__my_channels": {
      const result = await gatewayFetch(`/my-channels?worker=${WORKER_ID}`);
      if (!result) throw new Error("Gateway unavailable or request failed");
      return JSON.stringify(result);
    }
    case "hive__team_status": {
      const result = await gatewayFetch("/team-status");
      if (!result) throw new Error("Gateway unavailable or request failed");
      return JSON.stringify(result);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "hive-inbox-relay", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args ?? {});
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`inbox-relay: MCP server started (inbox=${INBOX_DIR})\n`);
}

main().catch((err) => {
  process.stderr.write(`inbox-relay: fatal: ${err}\n`);
  process.exit(1);
});
