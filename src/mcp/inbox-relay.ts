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

const MIND_ROOT = process.env.HIVE_MIND_ROOT ?? "";

const PROCESSED_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Task contract types (imported inline to avoid cross-module issues in MCP)
// ---------------------------------------------------------------------------

const TASK_PHASES = [
  "ASSIGNED", "ACCEPTED", "IN_PROGRESS", "REVIEW", "VERIFY", "COMPLETE", "FAILED",
] as const;

type TaskPhase = (typeof TASK_PHASES)[number];

const TERMINAL_PHASES = new Set<TaskPhase>(["COMPLETE", "FAILED"]);

const PHASE_ORDER: Record<TaskPhase, number> = {
  ASSIGNED: 0, ACCEPTED: 1, IN_PROGRESS: 2, REVIEW: 3, VERIFY: 4, COMPLETE: 5, FAILED: 5,
};

type ProcessItemStatus = "PASS" | "FAIL" | "N/A" | "PENDING";

interface ProcessItem {
  name: string;
  status: ProcessItemStatus;
  detail?: string;
  updated?: string;
}

interface TaskContract {
  id: string;
  title: string;
  description: string;
  assignee: string;
  phase: TaskPhase;
  acceptance: string[];
  process: ProcessItem[];
  files?: string[];
  dependencies?: string[];
  budget?: number;
  stage?: string;
  created: string;
  updated: string;
  history: TaskTransition[];
}

interface TaskTransition {
  from: TaskPhase;
  to: TaskPhase;
  agent: string;
  timestamp: string;
  reason?: string;
}

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
          enum: ["normal", "critical"],
          description:
            "Message priority. normal=default (nudge may be suppressed if recipient is focused), critical=always interrupts regardless of status.",
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
      'Set your worker status. Use "available" when between tasks, "focused" when deep in work (only critical messages nudge), "blocked" when waiting on something.',
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
    name: "hive__team_status",
    description:
      "Get current status (available/focused/blocked) of all team members. Use before creating channels to check availability.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  // -------------------------------------------------------------------------
  // Task lifecycle tools
  // -------------------------------------------------------------------------
  {
    name: "hive__task_create",
    description: "Create a new task contract. Sets phase to ASSIGNED.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Unique task ID (e.g. task-auth-flow)" },
        title: { type: "string", description: "Short task title" },
        description: { type: "string", description: "Full task description" },
        assignee: { type: "string", description: "Agent name assigned to this task" },
        acceptance: { type: "array", items: { type: "string" }, description: "Acceptance criteria" },
        process: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              status: { type: "string", enum: ["PASS", "FAIL", "N/A", "PENDING"] },
            },
          },
          description: "Process checklist items (default all PENDING)",
        },
        files: { type: "array", items: { type: "string" }, description: "Scoped file paths" },
        dependencies: { type: "array", items: { type: "string" }, description: "Dependent task IDs" },
        budget: { type: "number", description: "USD budget for this task" },
        stage: { type: "string", description: "Pipeline stage: IMPLEMENT, REVIEW, VERIFY" },
      },
      required: ["id", "title", "description", "assignee", "acceptance"],
    },
  },
  {
    name: "hive__task_accept",
    description: "Accept a task assignment. Transitions from ASSIGNED to ACCEPTED.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Task ID to accept" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "hive__task_update",
    description: "Update a task's phase. Enforces sequential phase ordering — cannot skip or go backward.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Task ID to update" },
        phase: { type: "string", enum: [...TASK_PHASES], description: "Target phase" },
        reason: { type: "string", description: "Reason for the transition" },
        process_updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              status: { type: "string", enum: ["PASS", "FAIL", "N/A", "PENDING"] },
              detail: { type: "string" },
            },
          },
          description: "Process item updates to apply with this transition",
        },
      },
      required: ["task_id", "phase"],
    },
  },
  {
    name: "hive__task_complete",
    description: "Mark a task as COMPLETE. Validates all process items are PASS or N/A before accepting.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Task ID to complete" },
        summary: { type: "string", description: "Completion summary" },
        process_updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              status: { type: "string", enum: ["PASS", "FAIL", "N/A", "PENDING"] },
              detail: { type: "string" },
            },
          },
          description: "Final process item updates before completion check",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "hive__task_fail",
    description: "Mark a task as FAILED with a reason.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Task ID to fail" },
        reason: { type: "string", description: "Why the task failed" },
      },
      required: ["task_id", "reason"],
    },
  },
  {
    name: "hive__task_question",
    description: "Ask a question about a task. Sends to the task assignee or manager via inbox.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Related task ID" },
        to: { type: "string", description: "Target agent (defaults to task assignee)" },
        question: { type: "string", description: "The question text" },
        options: { type: "array", items: { type: "string" }, description: "Suggested options" },
        default_action: { type: "string", description: "Default if no answer within timeout" },
      },
      required: ["task_id", "question"],
    },
  },
  {
    name: "hive__task_answer",
    description: "Answer a question about a task.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Related task ID" },
        to: { type: "string", description: "Target agent who asked the question" },
        answer: { type: "string", description: "The answer text" },
      },
      required: ["task_id", "to", "answer"],
    },
  },
  {
    name: "hive__task_review",
    description: "Submit a review for a task. Transitions to REVIEW phase if not already there.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Task ID to review" },
        verdict: { type: "string", enum: ["approve", "request-changes", "comment"], description: "Review verdict" },
        comments: { type: "string", description: "Review comments" },
        process_updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              status: { type: "string", enum: ["PASS", "FAIL", "N/A", "PENDING"] },
              detail: { type: "string" },
            },
          },
          description: "Process item updates from the review",
        },
      },
      required: ["task_id", "verdict", "comments"],
    },
  },
  {
    name: "hive__task_get",
    description: "Get the current state of a task contract.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string", description: "Task ID to retrieve" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "hive__task_list",
    description: "List all task contracts, optionally filtered by assignee or phase.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignee: { type: "string", description: "Filter by assignee agent name" },
        phase: { type: "string", description: "Filter by phase" },
      },
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
  priority?: string; // Message priority ("normal", "critical")
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
// Task contract file helpers
// ---------------------------------------------------------------------------

function tasksDir(): string {
  return join(MIND_ROOT, "tasks");
}

function taskPath(id: string): string {
  return join(tasksDir(), `${id}.json`);
}

function readTask(id: string): TaskContract | null {
  const p = taskPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as TaskContract;
  } catch {
    return null;
  }
}

function writeTask(task: TaskContract): void {
  const dir = tasksDir();
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${task.id}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(task, null, 2));
  renameSync(tmpPath, taskPath(task.id));
}

function listTasks(filter?: { assignee?: string; phase?: string }): TaskContract[] {
  const dir = tasksDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  const tasks: TaskContract[] = [];
  for (const file of files) {
    try {
      const task = JSON.parse(readFileSync(join(dir, file), "utf-8")) as TaskContract;
      if (filter?.assignee && task.assignee !== filter.assignee) continue;
      if (filter?.phase && task.phase !== filter.phase) continue;
      tasks.push(task);
    } catch { /* skip corrupt files */ }
  }
  return tasks;
}

function writeDelta(delta: object): void {
  const dir = join(MIND_ROOT, "pending");
  mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const filename = `${Date.now()}-task-${id}.json`;
  const tmpPath = join(dir, `.tmp-${filename}`);
  const finalPath = join(dir, filename);
  writeFileSync(tmpPath, JSON.stringify(delta, null, 2));
  renameSync(tmpPath, finalPath);
}

function applyProcessUpdates(task: TaskContract, updates?: ProcessItem[]): void {
  if (!updates) return;
  const now = new Date().toISOString();
  for (const update of updates) {
    const existing = task.process.find((p) => p.name === update.name);
    if (existing) {
      existing.status = update.status;
      existing.detail = update.detail ?? existing.detail;
      existing.updated = now;
    } else {
      task.process.push({ ...update, updated: now });
    }
  }
}

function validatePhaseTransition(current: TaskPhase, target: TaskPhase): string | null {
  if (TERMINAL_PHASES.has(current)) {
    return `Task is already in terminal phase ${current} — no further transitions allowed`;
  }
  // FAILED is always reachable from any non-terminal phase
  if (target === "FAILED") return null;
  if (PHASE_ORDER[target] <= PHASE_ORDER[current]) {
    return `Cannot transition from ${current} to ${target} — phase ordering violation (must move forward)`;
  }
  return null;
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
      const rawPriority = (args.priority as string) ?? "normal";
      // Normalize legacy 4-level priorities to 2-level: critical stays critical, everything else is normal
      const priority = rawPriority === "critical" ? "critical" : "normal";
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

      // PRIMARY: Write message to target worker's inbox
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

      const filename = `${Date.now()}-${msgId}.json`;
      const tmpPath = join(targetDir, `.${filename}.tmp`);
      const finalPath = join(targetDir, filename);
      writeFileSync(tmpPath, JSON.stringify(message, null, 2));
      renameSync(tmpPath, finalPath);

      // Nudge target worker — capture delivery feedback
      let nudged = false;
      let recipientStatus = "unknown";
      try {
        const nudgeRes = await gatewayFetch("/nudge", { workerId: to, priority });
        if (nudgeRes && typeof nudgeRes === "object") {
          nudged = (nudgeRes as Record<string, unknown>).nudged === true;
          recipientStatus = ((nudgeRes as Record<string, unknown>).status as string)
            ?? ((nudgeRes as Record<string, unknown>).reason as string)
            ?? (nudged ? "available" : "unknown");
        }
      } catch {
        // Nudge is best-effort — message is already in inbox
      }

      // SECONDARY: Echo to Discord for human visibility (best-effort)
      const echoText = `[${WORKER_ID} → ${to}] ${text}`;
      const echoPayload = taskId
        ? { chat_id: "task", task_id: taskId, text: echoText, sender: WORKER_ID, target_agent: to }
        : { chat_id: "auto", target_agent: to, text: echoText, sender: WORKER_ID };
      await gatewayFetch("/send", echoPayload);

      return JSON.stringify({ sent: true, nudged, recipientStatus, to, messageId: msgId });
    }
    case "hive__set_status": {
      const status = args.status as string;
      if (!["available", "focused", "blocked"].includes(status)) {
        throw new Error("status must be available, focused, or blocked");
      }
      await gatewayFetch("/status", { workerId: WORKER_ID, status });
      return JSON.stringify({ status, workerId: WORKER_ID });
    }
    case "hive__team_status": {
      const result = await gatewayFetch("/team-status");
      if (!result) throw new Error("Gateway unavailable or request failed");
      return JSON.stringify(result);
    }
    // -----------------------------------------------------------------------
    // Task lifecycle handlers
    // -----------------------------------------------------------------------
    case "hive__task_create": {
      if (!MIND_ROOT) throw new Error("HIVE_MIND_ROOT not configured — task tools unavailable");
      const id = args.id as string;
      const title = args.title as string;
      const description = args.description as string;
      const assignee = args.assignee as string;
      const acceptance = args.acceptance as string[];
      if (!id || !title || !description || !assignee || !acceptance?.length) {
        throw new Error("id, title, description, assignee, and acceptance are required");
      }
      if (readTask(id)) throw new Error(`Task ${id} already exists`);

      const now = new Date().toISOString();
      const processItems: ProcessItem[] = (args.process as ProcessItem[] | undefined) ??
        [{ name: "tests", status: "PENDING" }, { name: "lsp_diagnostics", status: "PENDING" }, { name: "code_review", status: "PENDING" }];

      const task: TaskContract = {
        id, title, description, assignee,
        phase: "ASSIGNED",
        acceptance,
        process: processItems,
        files: args.files as string[] | undefined,
        dependencies: args.dependencies as string[] | undefined,
        budget: args.budget as number | undefined,
        stage: args.stage as string | undefined,
        created: now,
        updated: now,
        history: [],
      };

      writeTask(task);

      // Also write a delta for daemon changelog/notifications
      writeDelta({
        action: "task-create",
        agent: WORKER_ID,
        target_type: "task",
        target_topic: id,
        content: task,
      });

      return JSON.stringify({ created: true, id, phase: "ASSIGNED" });
    }
    case "hive__task_accept": {
      if (!MIND_ROOT) throw new Error("HIVE_MIND_ROOT not configured");
      const taskId = args.task_id as string;
      if (!taskId) throw new Error("task_id is required");
      const task = readTask(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);

      const err = validatePhaseTransition(task.phase, "ACCEPTED");
      if (err) throw new Error(err);

      const now = new Date().toISOString();
      task.history.push({ from: task.phase, to: "ACCEPTED", agent: WORKER_ID, timestamp: now });
      task.phase = "ACCEPTED";
      task.updated = now;
      writeTask(task);

      writeDelta({
        action: "task-transition",
        agent: WORKER_ID,
        target_type: "task",
        target_topic: taskId,
        content: { from: task.history.at(-1)!.from, to: "ACCEPTED" },
      });

      return JSON.stringify({ accepted: true, id: taskId, phase: "ACCEPTED" });
    }
    case "hive__task_update": {
      if (!MIND_ROOT) throw new Error("HIVE_MIND_ROOT not configured");
      const taskId = args.task_id as string;
      const targetPhase = args.phase as TaskPhase;
      const reason = args.reason as string | undefined;
      const processUpdates = args.process_updates as ProcessItem[] | undefined;
      if (!taskId) throw new Error("task_id is required");
      if (!targetPhase || !TASK_PHASES.includes(targetPhase)) {
        throw new Error(`phase must be one of: ${TASK_PHASES.join(", ")}`);
      }

      const task = readTask(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);

      // AC4: Enforce phase ordering
      const err = validatePhaseTransition(task.phase, targetPhase);
      if (err) throw new Error(err);

      const now = new Date().toISOString();
      applyProcessUpdates(task, processUpdates);
      task.history.push({ from: task.phase, to: targetPhase, agent: WORKER_ID, timestamp: now, reason });
      task.phase = targetPhase;
      task.updated = now;
      writeTask(task);

      writeDelta({
        action: "task-transition",
        agent: WORKER_ID,
        target_type: "task",
        target_topic: taskId,
        content: { from: task.history.at(-1)!.from, to: targetPhase, reason },
      });

      return JSON.stringify({ updated: true, id: taskId, phase: targetPhase });
    }
    case "hive__task_complete": {
      if (!MIND_ROOT) throw new Error("HIVE_MIND_ROOT not configured");
      const taskId = args.task_id as string;
      const summary = args.summary as string | undefined;
      const processUpdates = args.process_updates as ProcessItem[] | undefined;
      if (!taskId) throw new Error("task_id is required");

      const task = readTask(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);

      const phaseErr = validatePhaseTransition(task.phase, "COMPLETE");
      if (phaseErr) throw new Error(phaseErr);

      // Apply any final process updates before validation
      applyProcessUpdates(task, processUpdates);

      // AC5: Validate all process items are PASS or N/A
      const failing = task.process.filter((p) => p.status !== "PASS" && p.status !== "N/A");
      if (failing.length > 0) {
        const details = failing.map((p) => `${p.name}: ${p.status}`).join(", ");
        throw new Error(
          `Cannot complete task — ${failing.length} process item(s) not passing: ${details}. ` +
          `All items must be PASS or N/A.`
        );
      }

      const now = new Date().toISOString();
      task.history.push({ from: task.phase, to: "COMPLETE", agent: WORKER_ID, timestamp: now, reason: summary });
      task.phase = "COMPLETE";
      task.updated = now;
      writeTask(task);

      writeDelta({
        action: "task-transition",
        agent: WORKER_ID,
        target_type: "task",
        target_topic: taskId,
        content: { from: task.history.at(-1)!.from, to: "COMPLETE", summary },
      });

      return JSON.stringify({ completed: true, id: taskId, phase: "COMPLETE" });
    }
    case "hive__task_fail": {
      if (!MIND_ROOT) throw new Error("HIVE_MIND_ROOT not configured");
      const taskId = args.task_id as string;
      const reason = args.reason as string;
      if (!taskId || !reason) throw new Error("task_id and reason are required");

      const task = readTask(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);

      const phaseErr = validatePhaseTransition(task.phase, "FAILED");
      if (phaseErr) throw new Error(phaseErr);

      const now = new Date().toISOString();
      task.history.push({ from: task.phase, to: "FAILED", agent: WORKER_ID, timestamp: now, reason });
      task.phase = "FAILED";
      task.updated = now;
      writeTask(task);

      writeDelta({
        action: "task-transition",
        agent: WORKER_ID,
        target_type: "task",
        target_topic: taskId,
        content: { from: task.history.at(-1)!.from, to: "FAILED", reason },
      });

      return JSON.stringify({ failed: true, id: taskId, phase: "FAILED", reason });
    }
    case "hive__task_question": {
      if (!MIND_ROOT) throw new Error("HIVE_MIND_ROOT not configured");
      const taskId = args.task_id as string;
      const question = args.question as string;
      const options = args.options as string[] | undefined;
      const defaultAction = args.default_action as string | undefined;
      if (!taskId || !question) throw new Error("task_id and question are required");

      const to = (args.to as string) || "monarch";

      if (!INBOX_ROOT) throw new Error("HIVE_INBOX_ROOT not configured");

      const targetDir = join(INBOX_ROOT, to);
      mkdirSync(targetDir, { recursive: true });

      const msgId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      let content = `QUESTION | ${WORKER_ID} | ${taskId}\n${question}`;
      if (options?.length) content += `\nOptions: ${options.join(", ")}`;
      if (defaultAction) content += `\nDefault: ${defaultAction}`;

      const message: InboxMessage = {
        chatId: "", messageId: msgId, user: WORKER_ID, ts: timestamp,
        content, attachments: [], source: "direct", priority: "normal",
      };

      const filename = `${Date.now()}-${msgId}.json`;
      writeFileSync(join(targetDir, `.${filename}.tmp`), JSON.stringify(message, null, 2));
      renameSync(join(targetDir, `.${filename}.tmp`), join(targetDir, filename));
      await gatewayFetch("/nudge", { workerId: to, priority: "normal" });

      // Echo to Discord
      await gatewayFetch("/send", {
        chat_id: "task", task_id: taskId,
        text: content, sender: WORKER_ID, target_agent: to,
      });

      return JSON.stringify({ sent: true, to, messageId: msgId, type: "question" });
    }
    case "hive__task_answer": {
      if (!MIND_ROOT) throw new Error("HIVE_MIND_ROOT not configured");
      const taskId = args.task_id as string;
      const to = args.to as string;
      const answer = args.answer as string;
      if (!taskId || !to || !answer) throw new Error("task_id, to, and answer are required");

      if (!INBOX_ROOT) throw new Error("HIVE_INBOX_ROOT not configured");

      const targetDir = join(INBOX_ROOT, to);
      mkdirSync(targetDir, { recursive: true });

      const msgId = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const content = `ANSWER | ${WORKER_ID} | ${taskId}\n${answer}`;

      const message: InboxMessage = {
        chatId: "", messageId: msgId, user: WORKER_ID, ts: timestamp,
        content, attachments: [], source: "direct", priority: "normal",
      };

      const filename = `${Date.now()}-${msgId}.json`;
      writeFileSync(join(targetDir, `.${filename}.tmp`), JSON.stringify(message, null, 2));
      renameSync(join(targetDir, `.${filename}.tmp`), join(targetDir, filename));
      await gatewayFetch("/nudge", { workerId: to, priority: "normal" });

      await gatewayFetch("/send", {
        chat_id: "task", task_id: taskId,
        text: content, sender: WORKER_ID, target_agent: to,
      });

      return JSON.stringify({ sent: true, to, messageId: msgId, type: "answer" });
    }
    case "hive__task_review": {
      if (!MIND_ROOT) throw new Error("HIVE_MIND_ROOT not configured");
      const taskId = args.task_id as string;
      const verdict = args.verdict as string;
      const comments = args.comments as string;
      const processUpdates = args.process_updates as ProcessItem[] | undefined;
      if (!taskId || !verdict || !comments) throw new Error("task_id, verdict, and comments are required");

      const task = readTask(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);

      // Guard: task must be at least IN_PROGRESS before review is allowed
      if (PHASE_ORDER[task.phase] < PHASE_ORDER["IN_PROGRESS"]) {
        throw new Error(
          `Cannot review task ${taskId} — task is in ${task.phase} phase (must be at least IN_PROGRESS)`
        );
      }

      // Transition to REVIEW if currently in IN_PROGRESS
      if (task.phase === "IN_PROGRESS") {
        const now = new Date().toISOString();
        task.history.push({ from: task.phase, to: "REVIEW", agent: WORKER_ID, timestamp: now });
        task.phase = "REVIEW";
        task.updated = now;
      }

      applyProcessUpdates(task, processUpdates);

      // If request-changes, transition back to IN_PROGRESS so assignee can fix
      if (verdict === "request-changes") {
        const now = new Date().toISOString();
        task.history.push({ from: task.phase, to: "IN_PROGRESS", agent: WORKER_ID, timestamp: now, reason: `Review: ${comments}` });
        task.phase = "IN_PROGRESS";
        task.updated = now;
      }

      writeTask(task);

      // Notify assignee
      if (INBOX_ROOT && task.assignee !== WORKER_ID) {
        const targetDir = join(INBOX_ROOT, task.assignee);
        mkdirSync(targetDir, { recursive: true });
        const msgId = crypto.randomUUID();
        const content = `ANSWER | ${WORKER_ID} | ${taskId}\nRe: Review — ${taskId}\nVerdict: ${verdict}\n${comments}`;
        const message: InboxMessage = {
          chatId: "", messageId: msgId, user: WORKER_ID, ts: new Date().toISOString(),
          content, attachments: [], source: "direct", priority: "normal",
        };
        const filename = `${Date.now()}-${msgId}.json`;
        writeFileSync(join(targetDir, `.${filename}.tmp`), JSON.stringify(message, null, 2));
        renameSync(join(targetDir, `.${filename}.tmp`), join(targetDir, filename));
        await gatewayFetch("/nudge", { workerId: task.assignee, priority: "normal" });
      }

      writeDelta({
        action: "task-transition",
        agent: WORKER_ID,
        target_type: "task",
        target_topic: taskId,
        content: { verdict, comments, phase: task.phase },
      });

      return JSON.stringify({ reviewed: true, id: taskId, verdict, phase: task.phase });
    }
    case "hive__task_get": {
      if (!MIND_ROOT) throw new Error("HIVE_MIND_ROOT not configured");
      const taskId = args.task_id as string;
      if (!taskId) throw new Error("task_id is required");
      const task = readTask(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      return JSON.stringify(task);
    }
    case "hive__task_list": {
      if (!MIND_ROOT) throw new Error("HIVE_MIND_ROOT not configured");
      const assignee = args.assignee as string | undefined;
      const phase = args.phase as string | undefined;
      const tasks = listTasks({ assignee, phase });
      return JSON.stringify({ tasks, count: tasks.length });
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
