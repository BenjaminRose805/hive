#!/usr/bin/env bun

/**
 * hive-gateway.ts
 *
 * Standalone Bun process that owns a single Discord gateway connection and
 * multiplexes messages to/from registered worker processes over local HTTP
 * via a Unix domain socket.
 *
 * Workers register themselves at startup, declaring which channel they care
 * about and whether they require @-mentions. Inbound Discord messages are
 * routed to matching workers; outbound tool calls (send, react, edit, fetch,
 * download) are proxied through the gateway's single bot connection.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  type Message,
  Partials,
} from "discord.js";
import { extractAgentsList, parseBody, parseHeader } from "../src/gateway/protocol-parser.ts";
import { shouldDeliver, findSpokesperson, type WorkerInfo } from "../src/gateway/selective-router.ts";
import { MessageType } from "../src/gateway/types.ts";
import type { DeltaFile } from "../src/mind/mind-types.ts";
import { type AgentsJson, NO_WORKTREE_ROLES } from "../src/shared/agent-types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  process.stderr.write("hive-gateway: DISCORD_BOT_TOKEN is required\n");
  process.exit(1);
}

const SOCKET_PATH = process.env.HIVE_GATEWAY_SOCKET ?? "/tmp/hive-gateway/gateway.sock";
const GATEWAY_DIR = dirname(SOCKET_PATH);
const INBOX_DIR = join(GATEWAY_DIR, "inbox");
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_CHUNK = 2000;

// HIVE_ROOT is the project root (directory containing bin/, state/, worktrees/)
const HIVE_ROOT = import.meta.dir ? join(import.meta.dir, "..") : process.cwd();
const STATE_DIR = process.env.HIVE_STATE_DIR ?? join(HIVE_ROOT, "state");
const AGENTS_JSON = join(STATE_DIR, "agents.json");

const ADMIN_USER_IDS = new Set((process.env.HIVE_ADMIN_IDS ?? "").split(",").filter(Boolean));

// ---------------------------------------------------------------------------
// Per-worker async mutex — prevents concurrent tmux operations per worker
// ---------------------------------------------------------------------------

const workerLocks = new Map<string, Promise<void>>();

function withWorkerLock<T>(workerId: string, fn: () => Promise<T>): Promise<T> {
  const prev = workerLocks.get(workerId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  workerLocks.set(
    workerId,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

// ---------------------------------------------------------------------------
// Inbox — file-based message delivery
// ---------------------------------------------------------------------------

interface InboxMessage {
  chatId: string;
  messageId: string;
  user: string;
  ts: string;
  content: string;
  attachments: Array<{ name: string; contentType: string; size: number; url: string }>;
  taskChannelId?: string;
}

function writeToInbox(workerId: string, message: InboxMessage): void {
  const workerInbox = join(INBOX_DIR, "messages", workerId);
  mkdirSync(workerInbox, { recursive: true });
  const filename = `${Date.now()}-${message.messageId}.json`;
  const tmpPath = join(workerInbox, `.${filename}.tmp`);
  const finalPath = join(workerInbox, filename);
  writeFileSync(tmpPath, JSON.stringify(message, null, 2));
  renameSync(tmpPath, finalPath);
}

function checkAdmin(interaction: ChatInputCommandInteraction): boolean {
  if (ADMIN_USER_IDS.size === 0) return true;
  return ADMIN_USER_IDS.has(interaction.user.id);
}

let channelsReady = false;
let workerChannelMap: Map<string, string> = new Map();
// ---------------------------------------------------------------------------
// Conversation channel membership model (two-tier: active/observing)
// ---------------------------------------------------------------------------

interface ConversationChannel {
  name: string;
  active: Set<string>; // inbox delivery — real-time participants
  observing: Set<string>; // no inbox — read Discord on demand
  taskId?: string; // links to task if created via TASK_ASSIGN
  createdAt: string;
  createdBy: string;
}

const conversationChannels = new Map<string, ConversationChannel>(); // channelId → metadata

function getChannelIdForTask(taskId: string): string | undefined {
  for (const [channelId, convo] of conversationChannels) {
    if (convo.taskId === taskId) return channelId;
  }
  return undefined;
}

function _isChannelMember(channelId: string, workerId: string): boolean {
  const convo = conversationChannels.get(channelId);
  if (!convo) return false;
  return convo.active.has(workerId) || convo.observing.has(workerId);
}

function persistConversationChannels(): void {
  try {
    const dir = join(STATE_DIR, "gateway");
    mkdirSync(dir, { recursive: true });
    const serialized: Record<string, any> = {};
    for (const [channelId, convo] of conversationChannels) {
      serialized[channelId] = {
        name: convo.name,
        active: [...convo.active],
        observing: [...convo.observing],
        taskId: convo.taskId,
        createdAt: convo.createdAt,
        createdBy: convo.createdBy,
      };
    }
    const filePath = join(dir, "conversation-channels.json");
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(serialized, null, 2));
    renameSync(tmpPath, filePath);
  } catch {}
}

const GATEWAY_CONFIG_PATH = join(STATE_DIR, "gateway", "config.json");
const GATEWAY_CONFIG_DATA = (() => {
  try {
    if (existsSync(GATEWAY_CONFIG_PATH)) {
      return JSON.parse(readFileSync(GATEWAY_CONFIG_PATH, "utf8"));
    }
  } catch {}
  return null;
})();
const DASHBOARD_CHANNEL_ID =
  GATEWAY_CONFIG_DATA?.dashboardChannelId ?? GATEWAY_CONFIG_DATA?.channelId ?? "";

// ---------------------------------------------------------------------------
// Agent process tracking
// ---------------------------------------------------------------------------

interface AgentProcess {
  process: unknown; // tmux window metadata
  pid: number; // not used for tmux-managed agents
  startedAt: Date;
}

const agentProcesses = new Map<string, AgentProcess>();

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ---------------------------------------------------------------------------
// Recent sent IDs — central set for reply-to-bot detection
// ---------------------------------------------------------------------------

const recentSentIds = new Set<string>();
const recentSentChannels = new Map<string, string>(); // messageId → channelId
const RECENT_SENT_CAP = 200;

function noteSent(id: string, channelId?: string): void {
  recentSentIds.add(id);
  if (channelId) recentSentChannels.set(id, channelId);
  if (recentSentIds.size > RECENT_SENT_CAP) {
    const first = recentSentIds.values().next().value;
    if (first) {
      recentSentIds.delete(first);
      recentSentChannels.delete(first);
    }
  }
}

const selfSendNonces = new Map<string, string>(); // nonce → senderWorkerId

function registerSelfSend(nonce: string, senderId: string): void {
  selfSendNonces.set(nonce, senderId);
  setTimeout(() => selfSendNonces.delete(nonce), 30_000);
}

// ---------------------------------------------------------------------------
// Nudge helpers — status-aware suppression + per-worker debouncing
// ---------------------------------------------------------------------------

function shouldNudge(worker: WorkerEntry, priority: string = "info"): boolean {
  if ((worker.status === "focused" || worker.status === "blocked") && priority !== "critical") {
    return false;
  }
  return true;
}

const lastNudgeTime = new Map<string, number>(); // workerId → timestamp
const NUDGE_COOLDOWN_MS = 15_000; // 15 seconds

function shouldDebounceNudge(workerId: string): boolean {
  const last = lastNudgeTime.get(workerId) ?? 0;
  if (Date.now() - last < NUDGE_COOLDOWN_MS) return true;
  lastNudgeTime.set(workerId, Date.now());
  return false;
}

// ---------------------------------------------------------------------------
// Text chunking — split on paragraph boundaries, same algorithm as server.ts
// ---------------------------------------------------------------------------

function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    // Prefer last double-newline (paragraph), then single newline, then space.
    // Fall back to hard cut.
    const para = rest.lastIndexOf("\n\n", limit);
    const line = rest.lastIndexOf("\n", limit);
    const space = rest.lastIndexOf(" ", limit);
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

// ---------------------------------------------------------------------------
// Worker Registry
// ---------------------------------------------------------------------------

interface WorkerEntry {
  workerId: string;
  endpoint: string;
  mentionPatterns: string[];
  channelId: string;
  requireMention: boolean;
  role: string;
  domain?: string;
  failCount: number;
  status: "available" | "focused" | "blocked";
  statusSince: string;
}

const workers = new Map<string, WorkerEntry>();

// Auto-populate workers from gateway config (no more self-registration needed —
// inbound delivery uses tmux send-keys, not worker sockets)
try {
  if (existsSync(GATEWAY_CONFIG_PATH)) {
    const gwConfig = JSON.parse(readFileSync(GATEWAY_CONFIG_PATH, "utf8"));
    for (const w of gwConfig.workers ?? []) {
      workers.set(w.workerId, {
        workerId: w.workerId,
        endpoint: w.socketPath ?? "",
        mentionPatterns: w.mentionPatterns ?? [],
        channelId: w.channelId ?? "",
        requireMention: w.requireMention ?? true,
        role: w.role ?? "engineer",
        domain: w.domain,
        failCount: 0,
        status: "available" as const,
        statusSince: new Date().toISOString(),
      });
    }
    process.stderr.write(`hive-gateway: auto-registered ${workers.size} worker(s) from config\n`);
  }
} catch (err) {
  process.stderr.write(`hive-gateway: failed to load gateway config: ${err}\n`);
}

// ---------------------------------------------------------------------------
// Channel helper
// ---------------------------------------------------------------------------

async function fetchTextChannel(id: string) {
  const ch = await client.channels.fetch(id);
  if (!ch?.isTextBased()) {
    throw new Error(`channel ${id} not found or not text-based`);
  }
  return ch;
}

// ---------------------------------------------------------------------------
// Inbound message routing
// ---------------------------------------------------------------------------

async function isMentioned(
  msg: Message,
  mentionPatterns: string[],
  effectiveChannelId?: string,
): Promise<boolean> {
  // Direct @mention
  if (client.user && msg.mentions.has(client.user)) return true;

  // Reply to one of our recent messages = implicit mention (scoped to matching channel)
  const refId = msg.reference?.messageId;
  if (refId && recentSentIds.has(refId)) {
    const sentChannel = recentSentChannels.get(refId);
    if (!effectiveChannelId || !sentChannel || sentChannel === effectiveChannelId) return true;
  }

  // Word-boundary matching (case-insensitive) — prevents "message" matching "sage"
  for (const pat of mentionPatterns) {
    const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(msg.content)) return true;
  }

  return false;
}

client.on("messageCreate", (msg) => {
  if (msg.author.bot && msg.author.id !== client.user?.id) return; // ignore other bots

  let excludeSender: string | undefined;
  if (msg.author.id === client.user?.id) {
    const nonce = (msg as any).nonce as string | undefined;
    if (nonce && selfSendNonces.has(nonce)) {
      excludeSender = selfSendNonces.get(nonce)!;
      selfSendNonces.delete(nonce);
    } else {
      return; // unknown self-message, drop to prevent loops
    }
  }

  routeInbound(msg, excludeSender).catch((e) =>
    process.stderr.write(`hive-gateway: routeInbound error: ${e}\n`),
  );
});

async function routeInbound(msg: Message, excludeSender?: string): Promise<void> {
  const effectiveChannelId = msg.channel.isThread()
    ? (msg.channel.parentId ?? msg.channelId)
    : msg.channelId;

  const parsed = parseHeader(msg.content);
  const bodyAgents = parsed ? extractAgentsList(msg.content) : undefined;
  const targets: WorkerEntry[] = [];
  const targeted = new Set<string>();

  // Pass 0: Spokesperson routing — human messages go to oracle first
  const isHumanMsg = !msg.author.bot;
  if (isHumanMsg) {
    const workerInfos = [...workers.values()].map((w) => ({
      workerId: w.workerId,
      channelId: w.channelId,
      role: w.role,
    }));
    const spokesperson = findSpokesperson(workerInfos);
    if (spokesperson) {
      const worker = workers.get(spokesperson.workerId);
      if (worker && !(excludeSender && worker.workerId === excludeSender)) {
        targets.push(worker);
        targeted.add(worker.workerId);
      }
    }
  }

  // Pass 1: Channel owner + coordinator role
  for (const worker of workers.values()) {
    if (excludeSender && worker.workerId === excludeSender) continue;

    if (worker.role === "manager") {
      // Human messages route through spokesperson, not directly to manager
      if (isHumanMsg) continue;
      const workerInfo: WorkerInfo = {
        workerId: worker.workerId,
        channelId: worker.channelId,
        role: worker.role,
      };
      const decision = shouldDeliver(parsed, workerInfo, msg.content, bodyAgents);
      if (decision.deliver) {
        targets.push(worker);
        targeted.add(worker.workerId);
      }
      continue;
    }

    if (worker.channelId === effectiveChannelId) {
      // Channel owner — deliver without mention check
      targets.push(worker);
      targeted.add(worker.workerId);
    }
  }

  // Pass 2: Cross-channel mentions (for workers not yet targeted)
  for (const worker of workers.values()) {
    if (targeted.has(worker.workerId)) continue;
    if (excludeSender && worker.workerId === excludeSender) continue;
    if (worker.role === "manager") continue;

    const mentioned = await isMentioned(msg, worker.mentionPatterns, effectiveChannelId);
    if (mentioned) {
      // Human messages only reach non-spokesperson agents via their own channel (Pass 1)
      // or conversation/task channels (Pass 3) — not via cross-channel @mentions
      const isTaskOrConvoChannel = conversationChannels.has(effectiveChannelId);
      if (isHumanMsg && worker.role !== "product" && !isTaskOrConvoChannel) {
        continue;
      }
      const workerInfo: WorkerInfo = { workerId: worker.workerId, channelId: worker.channelId };
      const decision = shouldDeliver(parsed, workerInfo, msg.content, bodyAgents);
      if (decision.deliver) {
        targets.push(worker);
        targeted.add(worker.workerId);
      }
    }
  }

  // Pass 3: Active conversation channel members
  const convo = conversationChannels.get(effectiveChannelId);
  if (convo) {
    // Skip manager-only protocol messages — don't fan out to conversation participants
    const managerOnlyTypes = new Set(["HEARTBEAT", "STATUS", "COMPLETE", "QUESTION"]);
    const skipProtocol = parsed && managerOnlyTypes.has(parsed.type);

    if (!skipProtocol) {
      for (const participantId of convo.active) {
        if (targeted.has(participantId)) continue;
        if (excludeSender && participantId === excludeSender) continue;
        const worker = workers.get(participantId);
        if (worker) {
          targets.push(worker);
          targeted.add(participantId);
        } else {
          // Stale participant — auto-prune
          convo.active.delete(participantId);
          persistConversationChannels();
        }
      }
    }
  }

  if (targets.length === 0) return;

  // Build attachment metadata
  const attachments = [...msg.attachments.values()].map((att) => ({
    name: att.name ?? att.id,
    contentType: att.contentType ?? "unknown",
    size: att.size,
    url: att.url,
  }));
  const attCount = attachments.length;
  const content = msg.content || (attCount > 0 ? "(attachment)" : "");

  // Human messages (non-bot Discord users) always nudge — they should never be
  // silently queued behind a "focused" status gate.
  const isHumanMessage = !msg.author.bot;

  // Write message to inbox and nudge each target worker via tmux
  const deliveries = targets.map(async (worker) => {
    // Use conversation channel ID for active members, agent's own channel for Pass 1/2
    const isActiveMember =
      convo?.active.has(worker.workerId) && effectiveChannelId !== worker.channelId;
    const chatId = isActiveMember ? effectiveChannelId : worker.channelId;

    const inboxMsg: InboxMessage = {
      chatId,
      messageId: msg.id,
      user: msg.author.username,
      ts: msg.createdAt.toISOString(),
      content,
      attachments,
      // Inject task channel ID for TASK_ASSIGN messages
      ...(parsed?.type === MessageType.TASK_ASSIGN &&
      parsed.taskId &&
      getChannelIdForTask(parsed.taskId)
        ? { taskChannelId: getChannelIdForTask(parsed.taskId)! }
        : {}),
    };
    writeToInbox(worker.workerId, inboxMsg);

    // Use shouldNudge + debounce instead of direct nudgeViaTmux
    // Human messages and manager role bypass status-based suppression (always nudge)
    const alwaysNudge = isHumanMessage || worker.role === "manager";
    if ((alwaysNudge || shouldNudge(worker)) && !shouldDebounceNudge(worker.workerId)) {
      const ok = await nudgeViaTmux(worker.workerId);
      if (ok) {
        process.stderr.write(
          `hive-gateway: delivered message to ${worker.workerId} inbox + nudge\n`,
        );
      } else {
        process.stderr.write(
          `hive-gateway: wrote to ${worker.workerId} inbox (nudge failed — message still in inbox)\n`,
        );
      }
    } else {
      process.stderr.write(`hive-gateway: wrote to ${worker.workerId} inbox (nudge suppressed)\n`);
    }
  });

  await Promise.allSettled(deliveries);
}

// ---------------------------------------------------------------------------
// tmux injection helper
// ---------------------------------------------------------------------------

// DEPRECATED — no longer used for injection, kept for potential logging
function _buildChannelXml(
  content: string,
  chatId: string,
  messageId: string,
  user: string,
  ts: string,
): string {
  const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<channel source="discord" chat_id="${chatId}" message_id="${messageId}" user="${user}" ts="${ts}">${escaped}</channel>`;
}

const NUDGE_TEXT = "[hive] New message — check inbox";

async function nudgeViaTmux(workerId: string): Promise<boolean> {
  return withWorkerLock(workerId, async () => {
    const SESSION_NAME = process.env.HIVE_SESSION ?? "hive";
    const target = `${SESSION_NAME}:${workerId}`;
    const bufName = `hive-${workerId}`;
    const tmpFile = join(GATEWAY_DIR, `.nudge-${workerId}-${Date.now()}.tmp`);

    try {
      writeFileSync(tmpFile, NUDGE_TEXT);

      // Load into named tmux buffer (binary-safe)
      const load = Bun.spawn(["tmux", "load-buffer", "-b", bufName, tmpFile], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const loadExit = await Promise.race([load.exited, Bun.sleep(5000).then(() => -1)]);
      if (loadExit !== 0) {
        try {
          load.kill();
        } catch {}
        process.stderr.write(`hive-gateway: tmux load-buffer failed for ${workerId}\n`);
        return false;
      }

      // Paste buffer into target pane (verbatim)
      const paste = Bun.spawn(["tmux", "paste-buffer", "-b", bufName, "-t", target], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const pasteExit = await Promise.race([paste.exited, Bun.sleep(5000).then(() => -1)]);
      if (pasteExit !== 0) {
        try {
          paste.kill();
        } catch {}
        process.stderr.write(`hive-gateway: tmux paste-buffer failed for ${workerId}\n`);
        return false;
      }

      // Send Enter to submit the nudge
      const enter = Bun.spawn(["tmux", "send-keys", "-t", target, "Enter"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const enterExit = await Promise.race([enter.exited, Bun.sleep(5000).then(() => -1)]);
      if (enterExit !== 0) {
        try {
          enter.kill();
        } catch {}
        process.stderr.write(`hive-gateway: tmux send-keys Enter failed for ${workerId}\n`);
        return false;
      }

      // Clean up named buffer
      Bun.spawn(["tmux", "delete-buffer", "-b", bufName], { stdout: "pipe", stderr: "pipe" });

      return true;
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {}
    }
  });
}

async function ensureWorkerChannels(): Promise<Map<string, string>> {
  const dashboardCh = await client.channels.fetch(DASHBOARD_CHANNEL_ID);
  if (!dashboardCh || !("guild" in dashboardCh))
    throw new Error("dashboard channel not in a guild");
  const guild = (dashboardCh as any).guild;

  // Check if channels.json from a previous run has valid channel IDs
  const channelsJsonPath = join(STATE_DIR, "gateway", "channels.json");
  if (existsSync(channelsJsonPath)) {
    try {
      const stored: Record<string, string> = JSON.parse(readFileSync(channelsJsonPath, "utf8"));
      const channelMap = new Map<string, string>();
      let allValid = true;

      for (const worker of workers.values()) {
        const storedId = stored[worker.workerId];
        if (!storedId) {
          allValid = false;
          break;
        }
        try {
          const ch = await client.channels.fetch(storedId);
          if (ch) {
            channelMap.set(worker.workerId, storedId);
            worker.channelId = storedId;
          } else {
            allValid = false;
            break;
          }
        } catch {
          allValid = false;
          break;
        }
      }

      if (allValid && channelMap.size === workers.size) {
        process.stderr.write(
          `hive-gateway: reusing ${channelMap.size} channels from previous run\n`,
        );
        return channelMap;
      }
    } catch {}
  }

  const SESSION_NAME = process.env.HIVE_SESSION ?? "hive";
  const categoryName = `Hive: ${SESSION_NAME.replace("hive-", "")}`;

  // Find or create category
  const allChannels = await guild.channels.fetch();
  let category = allChannels.find(
    (c: any) => c?.type === ChannelType.GuildCategory && c.name === categoryName,
  );
  if (!category) {
    category = await guild.channels.create({
      name: categoryName,
      type: ChannelType.GuildCategory,
    });
  }

  // Create per-worker channels
  const channelMap = new Map<string, string>();
  for (const worker of workers.values()) {
    let ch = allChannels.find(
      (c: any) =>
        c?.type === ChannelType.GuildText &&
        c.name === worker.workerId &&
        c.parentId === category.id,
    );
    if (!ch) {
      ch = await guild.channels.create({
        name: worker.workerId,
        type: ChannelType.GuildText,
        parent: category.id,
      });
      await Bun.sleep(200); // rate limit courtesy
    }
    channelMap.set(worker.workerId, ch.id);
    worker.channelId = ch.id;
  }

  // Persist category ID in gateway config for teardown
  try {
    const gwConfigPath = join(STATE_DIR, "gateway", "config.json");
    if (existsSync(gwConfigPath)) {
      const config = JSON.parse(readFileSync(gwConfigPath, "utf8"));
      config.categoryId = category.id;
      config.guildId = guild.id;
      writeFileSync(gwConfigPath, JSON.stringify(config, null, 2));
    }
  } catch {}

  return channelMap;
}

// ---------------------------------------------------------------------------
// Task channel helpers
// ---------------------------------------------------------------------------

async function createTaskChannel(
  taskId: string,
  description?: string,
  assignedAgent?: string,
): Promise<string> {
  // If already exists, reuse
  const existing = getChannelIdForTask(taskId);
  if (existing) return existing;

  // Derive slug from description
  const slug = (description ?? "unnamed")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const channelName = `task-${taskId}-${slug}`.slice(0, 100);

  // Get guild and category from dashboard channel
  const dashboardCh = await client.channels.fetch(DASHBOARD_CHANNEL_ID);
  if (!dashboardCh || !("guild" in dashboardCh))
    throw new Error("Cannot find guild for task channel");
  const guild = (dashboardCh as any).guild;
  const categoryId = GATEWAY_CONFIG_DATA?.categoryId;

  const ch = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    ...(categoryId ? { parent: categoryId } : {}),
  });

  // Register as a conversation channel with assigned agent as active
  conversationChannels.set(ch.id, {
    name: channelName,
    active: new Set(assignedAgent ? [assignedAgent] : []),
    observing: new Set(),
    taskId,
    createdAt: new Date().toISOString(),
    createdBy: "gateway",
  });
  persistConversationChannels();
  return ch.id;
}

// ---------------------------------------------------------------------------
// Slash command handlers
// ---------------------------------------------------------------------------

function readAgentsJson(): AgentsJson | null {
  try {
    if (!existsSync(AGENTS_JSON)) return null;
    return JSON.parse(readFileSync(AGENTS_JSON, "utf8")) as AgentsJson;
  } catch {
    return null;
  }
}

function writeAgentsJson(data: AgentsJson): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(AGENTS_JSON, JSON.stringify(data, null, 2));
}

async function handleSlashStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const workerList = [...workers.values()];
  const embed = new EmbedBuilder()
    .setTitle("Hive Gateway Status")
    .setColor(0x5865f2)
    .addFields(
      { name: "Bot", value: client.user?.tag ?? "unknown", inline: true },
      { name: "Registered Workers", value: String(workerList.length), inline: true },
      { name: "Spawned Agents", value: String(agentProcesses.size), inline: true },
    )
    .setTimestamp();

  if (workerList.length > 0) {
    const workerSummary = workerList
      .map((w) => `• \`${w.workerId}\` — channel \`${w.channelId}\``)
      .join("\n");
    embed.addFields({ name: "Workers", value: workerSummary.slice(0, 1024) });
  }

  if (agentProcesses.size > 0) {
    const agentSummary = [...agentProcesses.entries()]
      .map(([name, ap]) => `• \`${name}\` — PID ${ap.pid}, started ${ap.startedAt.toISOString()}`)
      .join("\n");
    embed.addFields({ name: "Running Agents", value: agentSummary.slice(0, 1024) });
  }

  await interaction.reply({ embeds: [embed], ephemeral: false });
}

async function handleSlashAgents(interaction: ChatInputCommandInteraction): Promise<void> {
  const data = readAgentsJson();
  if (!data || data.agents.length === 0) {
    await interaction.reply({
      content: "No agents registered in `state/agents.json`.",
      ephemeral: true,
    });
    return;
  }

  const embed = new EmbedBuilder().setTitle("Hive Agents").setColor(0x57f287).setTimestamp();

  if (data.mode) embed.addFields({ name: "Mode", value: data.mode, inline: true });

  const agentLines = data.agents.map((a) => {
    const running = agentProcesses.has(a.name) ? " [running]" : "";
    const roleLabel = a.domain ? `${a.role}:${a.domain}` : (a.role ?? "unknown");
    const role = ` (${roleLabel})`;
    const status = a.status ?? "unknown";
    return `• \`${a.name}\`${role} — ${status}${running}`;
  });

  embed.addFields({
    name: `Agents (${data.agents.length})`,
    value: agentLines.join("\n").slice(0, 1024),
  });

  await interaction.reply({ embeds: [embed] });
}

async function handleSlashBroadcast(interaction: ChatInputCommandInteraction): Promise<void> {
  const message = interaction.options.getString("message", true);

  if (workers.size === 0) {
    await interaction.reply({ content: "No registered workers to broadcast to.", ephemeral: true });
    return;
  }

  await interaction.deferReply();

  const results: string[] = [];
  for (const worker of workers.values()) {
    const inboxMsg: InboxMessage = {
      chatId: worker.channelId || interaction.channelId,
      messageId: interaction.id,
      user: interaction.user.username,
      ts: new Date().toISOString(),
      content: message,
      attachments: [],
    };
    writeToInbox(worker.workerId, inboxMsg);
    const ok = await nudgeViaTmux(worker.workerId);
    results.push(`\`${worker.workerId}\`: ${ok ? "delivered" : "inbox only (nudge failed)"}`);
  }

  await interaction.editReply({
    content: `Broadcast sent to ${workers.size} worker(s):\n${results.join("\n")}`,
  });
}

async function handleSlashAsk(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString("agent", true);
  const message = interaction.options.getString("message", true);

  const worker = workers.get(agentName);
  if (!worker) {
    await interaction.reply({
      content: `Agent \`${agentName}\` is not registered. Use \`/agents\` to see registered agents.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const inboxMsg: InboxMessage = {
    chatId: worker.channelId || interaction.channelId,
    messageId: interaction.id,
    user: interaction.user.username,
    ts: new Date().toISOString(),
    content: message,
    attachments: [],
  };
  writeToInbox(agentName, inboxMsg);
  const ok = await nudgeViaTmux(agentName);

  if (ok) {
    await interaction.editReply({ content: `Message delivered to \`${agentName}\`.` });
  } else {
    await interaction.editReply({
      content: `Failed to deliver to \`${agentName}\`. Check gateway logs for details.`,
    });
  }
}

async function handleSlashMemory(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString("agent", true);

  await interaction.deferReply();

  try {
    const proc = Bun.spawn(
      ["bun", "run", join(HIVE_ROOT, "bin", "hive-mind.ts"), "view", "--agent", agentName],
      { cwd: HIVE_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    const errout = await new Response(proc.stderr).text();
    const combined = (output + errout).trim() || "(no memory output)";
    // Discord message limit is 2000 chars; truncate if needed
    const truncated =
      combined.length > 1900 ? `${combined.slice(0, 1900)}\n…(truncated)` : combined;
    await interaction.editReply({
      content: `**Memory for \`${agentName}\`:**\n\`\`\`\n${truncated}\n\`\`\``,
    });
  } catch (_err) {
    await interaction.editReply({
      content: `Failed to read memory for \`${agentName}\`. Check gateway logs for details.`,
    });
  }
}

async function handleSlashAssign(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString("agent", true);
  const task = interaction.options.getString("task", true);

  const worker = workers.get(agentName);
  if (!worker) {
    await interaction.reply({
      content: `Agent \`${agentName}\` is not registered. Use \`/agents\` to see registered agents.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  // Format as TASK_ASSIGN protocol message (pipe-delimited per config/protocol.md)
  const taskId = `task-${Date.now().toString(36)}`;
  const files = interaction.options.getString("files") ?? "";
  const taskMessage = [
    `TASK_ASSIGN | ${agentName} | ${taskId}`,
    `Branch: hive/${agentName}`,
    `Files: ${files}`,
    `Description: ${task}`,
    `Dependencies: none`,
  ].join("\n");

  // Use worker's dedicated channel
  const workerData = workers.get(agentName);
  const chatId = workerData?.channelId || interaction.channelId;

  // Create task channel for this assignment
  let taskChannelId: string | undefined;
  try {
    taskChannelId = await createTaskChannel(taskId, task, agentName);
    // Post in task channel too
    const taskCh = await client.channels.fetch(taskChannelId);
    if (taskCh && "send" in taskCh) await (taskCh as any).send(taskMessage.slice(0, 1800));
  } catch (err) {
    process.stderr.write(`hive-gateway: task channel creation in /assign failed: ${err}\n`);
  }

  const assignMsg: InboxMessage = {
    chatId,
    messageId: interaction.id,
    user: interaction.user.username,
    ts: new Date().toISOString(),
    content: taskMessage,
    attachments: [],
    ...(taskChannelId ? { taskChannelId } : {}),
  };
  writeToInbox(agentName, assignMsg);
  const ok = await nudgeViaTmux(agentName);

  if (ok) {
    await interaction.editReply({ content: `Task assigned to \`${agentName}\`:\n> ${task}` });
  } else {
    await interaction.editReply({
      content: `Failed to assign task to \`${agentName}\`. Check gateway logs for details.`,
    });
  }
}

async function handleSlashSpinUp(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString("name", true);
  const role = interaction.options.getString("role") ?? "engineer";
  const domain = interaction.options.getString("domain") ?? undefined;

  if (!checkAdmin(interaction)) {
    await interaction.reply({ content: "Not authorized.", ephemeral: true });
    return;
  }

  // Validate agent name and role format (security: prevent path traversal)
  if (!/^[a-zA-Z0-9-]{1,32}$/.test(agentName)) {
    await interaction.reply({
      content: "Invalid agent name. Must be alphanumeric + hyphens, 1-32 chars.",
      ephemeral: true,
    });
    return;
  }
  if (!/^[a-zA-Z0-9-]{1,32}$/.test(role)) {
    await interaction.reply({
      content: "Invalid role name. Must be alphanumeric + hyphens, 1-32 chars.",
      ephemeral: true,
    });
    return;
  }

  // Defer immediately — startup takes time
  await interaction.deferReply();

  try {
    // Check if already running
    if (agentProcesses.has(agentName)) {
      await interaction.editReply({ content: `Agent \`${agentName}\` is already running.` });
      return;
    }

    // Read agents.json to find agent config
    const agentsData = readAgentsJson();
    const agentEntry = agentsData?.agents.find((a) => a.name === agentName);

    const isNoWorktreeRole = NO_WORKTREE_ROLES.has(role);

    // No-worktree roles work from the project repo directly; worktree roles get their own directory
    let workDir: string;
    if (isNoWorktreeRole) {
      // Use the project repo from agents.json or fall back to HIVE_ROOT
      const agentsData2 = readAgentsJson();
      const _projectRepo =
        agentsData2?.agents.find((a) => a.branch)?.branch?.replace(/^hive\//, "") ?? "";
      workDir = HIVE_ROOT;
    } else {
      workDir = join(HIVE_ROOT, "worktrees", agentName);
      mkdirSync(workDir, { recursive: true });
    }

    // Compose system prompt from worker-system-prompt.md + roles/domains + memory
    const domainLabel = domain ? ` specializing in ${domain}` : "";
    const workerPromptPath = join(HIVE_ROOT, "config", "prompts", "worker-system-prompt.md");
    const sub = (text: string) =>
      text
        .replace(/\{NAME\}/g, agentName)
        .replace(/\{ROLE\}/g, role + domainLabel)
        .replace(/\{DOMAIN\}/g, domain ?? "");
    let systemPrompt = existsSync(workerPromptPath)
      ? sub(readFileSync(workerPromptPath, "utf8"))
      : `You are a Hive agent named ${agentName} with role: ${role + domainLabel}.\n`;

    // Worktree-specific sections (branch discipline, scope enforcement, completion protocol)
    if (!isNoWorktreeRole) {
      const worktreeSectionsPath = join(HIVE_ROOT, "config", "prompts", "worktree-sections.md");
      if (existsSync(worktreeSectionsPath)) {
        systemPrompt += `\n\n${sub(readFileSync(worktreeSectionsPath, "utf8"))}`;
      }
    }

    // Append base profile (always) + role prompt (if exists) + domain prompt (if exists)
    const basePath = join(HIVE_ROOT, "config", "prompts", "profiles", "_base.md");
    const rolePath = join(HIVE_ROOT, "config", "prompts", "roles", `${role}.md`);
    if (existsSync(basePath)) {
      systemPrompt += `\n\n${sub(readFileSync(basePath, "utf8"))}`;
    }
    if (existsSync(rolePath)) {
      systemPrompt += `\n\n${readFileSync(rolePath, "utf8")}`;
    }
    if (domain) {
      const domainPath = join(HIVE_ROOT, "config", "prompts", "domains", `${domain}.md`);
      if (existsSync(domainPath)) {
        systemPrompt += `\n\n${readFileSync(domainPath, "utf8")}`;
      }
    }

    // Append mind prompt section
    const mindPromptPath = join(HIVE_ROOT, "config", "prompts", "mind-prompt-section.md");
    if (existsSync(mindPromptPath)) {
      systemPrompt += `\n\n${readFileSync(mindPromptPath, "utf8").replace(/\{NAME\}/g, agentName)}`;
    }
    // Append live mind state (context, inbox summary, watches)
    try {
      const mindLoad = Bun.spawnSync([
        "bun",
        "run",
        join(HIVE_ROOT, "bin/hive-mind.ts"),
        "load",
        "--agent",
        agentName,
      ]);
      if (mindLoad.exitCode === 0 && mindLoad.stdout.toString().trim()) {
        systemPrompt += `\n\n${mindLoad.stdout.toString()}`;
      }
    } catch {
      /* mind not available yet, continue without */
    }

    // Write system prompt to a temp file for the agent
    const promptFile = join(STATE_DIR, `.prompt-${agentName}.md`);
    writeFileSync(promptFile, systemPrompt);

    // Build MCP config path (reuse existing worker config if present)
    const mcpConfigPath = join(STATE_DIR, "workers", agentName, "mcp-config.json");
    const settingsPath = join(STATE_DIR, "workers", agentName, "settings.json");

    // Write a bash launch script for this agent
    const stateDir = STATE_DIR;
    mkdirSync(stateDir, { recursive: true });
    const scriptPath = join(stateDir, `.launch-gateway-${agentName}.sh`);
    const mcpConfigArg = existsSync(mcpConfigPath) ? `--mcp-config "${mcpConfigPath}"` : "";
    const settingsArg = existsSync(settingsPath) ? `--settings "${settingsPath}"` : "";
    const scriptContent = `${[
      `#!/usr/bin/env bash`,
      `export HIVE_WORKER_ID='${agentName}'`,
      `export HIVE_ROOT='${workDir}'`,
      `cd '${workDir}'`,
      `claude --name "hive-${agentName}" \\`,
      `  --append-system-prompt "$(cat '${promptFile}')" \\`,
      ...(mcpConfigArg ? [`  ${mcpConfigArg} \\`] : []),
      ...(settingsArg ? [`  ${settingsArg} \\`] : []),
      `  --permission-mode bypassPermissions`,
    ].join("\n")}\n`;
    writeFileSync(scriptPath, scriptContent);
    chmodSync(scriptPath, 0o700);

    // Launch agent in a tmux window
    const SESSION_NAME = process.env.HIVE_SESSION ?? "hive";
    Bun.spawnSync(["tmux", "new-window", "-t", SESSION_NAME, "-n", agentName, scriptPath], {
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for claude to start, then handle interactive setup prompts
    await Bun.sleep(5000);
    for (let i = 0; i < 5; i++) {
      const capture = Bun.spawnSync(
        ["tmux", "capture-pane", "-p", "-t", `${SESSION_NAME}:${agentName}`],
        { stdout: "pipe", stderr: "pipe" },
      );
      const paneText = capture.stdout.toString().toLowerCase();
      if (paneText.includes("text style") || paneText.includes("dark mode")) {
        Bun.spawnSync(["tmux", "send-keys", "-t", `${SESSION_NAME}:${agentName}`, "", "Enter"]);
      } else if (paneText.includes("select login method") || paneText.includes("claude account")) {
        Bun.spawnSync(["tmux", "send-keys", "-t", `${SESSION_NAME}:${agentName}`, "", "Enter"]);
      } else if (
        paneText.includes("trust") ||
        paneText.includes("syntax highlighting") ||
        paneText.includes("get started")
      ) {
        Bun.spawnSync(["tmux", "send-keys", "-t", `${SESSION_NAME}:${agentName}`, "", "Enter"]);
      } else if (paneText.includes("❯") || paneText.includes(">")) {
        break;
      }
      await Bun.sleep(3000);
    }

    // Send init prompt to the agent
    const channelId = workerChannelMap.get(agentName) ?? "";
    const identityLabel = domain ? `${role}:${domain}` : role;
    const initPrompt = `You are ${agentName} (${identityLabel}) on a Hive team with a coordinator (mention 'manager') and other agents. Your Discord channel ID is ${channelId} — always use this numeric ID with Discord tools. You can message any team member by mentioning their name. Announce yourself as READY on Discord and wait for task assignment.`;
    Bun.spawnSync(
      ["tmux", "send-keys", "-t", `${SESSION_NAME}:${agentName}`, initPrompt, "Enter"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    agentProcesses.set(agentName, {
      process: null,
      pid: 0,
      startedAt: new Date(),
    });

    // Create channel for the new agent in the hive category
    try {
      const dashboardCh = await client.channels.fetch(DASHBOARD_CHANNEL_ID);
      if (dashboardCh && "guild" in dashboardCh) {
        const guild = (dashboardCh as any).guild;
        const SESSION_NAME = process.env.HIVE_SESSION ?? "hive";
        const categoryName = `Hive: ${SESSION_NAME.replace("hive-", "")}`;
        const allChs = await guild.channels.fetch();
        const category = allChs.find(
          (c: any) => c?.type === ChannelType.GuildCategory && c.name === categoryName,
        );
        if (category) {
          let ch = allChs.find(
            (c: any) =>
              c?.type === ChannelType.GuildText &&
              c.name === agentName &&
              c.parentId === category.id,
          );
          if (!ch) {
            ch = await guild.channels.create({
              name: agentName,
              type: ChannelType.GuildText,
              parent: category.id,
            });
          }
          const worker = workers.get(agentName);
          if (worker) worker.channelId = ch.id;
          workerChannelMap.set(agentName, ch.id);
          writeFileSync(
            join(STATE_DIR, "gateway", "channels.json"),
            JSON.stringify(Object.fromEntries(workerChannelMap), null, 2),
          );
        }
      }
    } catch (err) {
      process.stderr.write(`hive-gateway: channel creation for ${agentName} failed: ${err}\n`);
    }

    // Update agents.json status
    if (agentsData) {
      if (agentEntry) {
        agentEntry.status = "running";
        if (domain) agentEntry.domain = domain;
      } else {
        agentsData.agents.push({
          name: agentName,
          role,
          domain,
          status: "running",
          created: new Date().toISOString(),
        });
      }
      writeAgentsJson(agentsData);
    } else {
      writeAgentsJson({
        agents: [
          { name: agentName, role, domain, status: "running", created: new Date().toISOString() },
        ],
        created: new Date().toISOString(),
        mode: "single-bot",
      });
    }

    const embed = new EmbedBuilder()
      .setTitle("Agent Spawned")
      .setColor(0x57f287)
      .addFields(
        { name: "Name", value: agentName, inline: true },
        { name: "Role", value: domain ? `${role}:${domain}` : role, inline: true },
        { name: isNoWorktreeRole ? "Working Dir" : "Worktree", value: workDir },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (_err) {
    await interaction.editReply({
      content: `Failed to spin up \`${agentName}\`. Check gateway logs for details.`,
    });
  }
}

async function handleSlashTearDown(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString("name", true);

  if (!checkAdmin(interaction)) {
    await interaction.reply({ content: "Not authorized.", ephemeral: true });
    return;
  }

  const tracked = agentProcesses.get(agentName);
  if (!tracked) {
    await interaction.reply({
      content: `Agent \`${agentName}\` is not currently running (no tracked process).`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    // Kill the tmux window for this agent
    const SESSION_NAME = process.env.HIVE_SESSION ?? "hive";
    Bun.spawnSync(["tmux", "kill-window", "-t", `${SESSION_NAME}:${agentName}`], {
      stdout: "pipe",
      stderr: "pipe",
    });

    agentProcesses.delete(agentName);

    // Deregister from workers map if present
    workers.delete(agentName);

    // Remove agent from all conversation channels (prevent ghost participants)
    for (const convo of conversationChannels.values()) {
      convo.active.delete(agentName);
      convo.observing.delete(agentName);
    }
    persistConversationChannels();

    // Update agents.json
    const data = readAgentsJson();
    if (data) {
      const entry = data.agents.find((a) => a.name === agentName);
      if (entry) entry.status = "stopped";
      writeAgentsJson(data);
    }

    await interaction.editReply({ content: `Agent \`${agentName}\` agent stopped.` });
  } catch (_err) {
    await interaction.editReply({
      content: `Failed to tear down \`${agentName}\`. Check gateway logs for details.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Interaction handler (slash commands)
// ---------------------------------------------------------------------------

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case "status":
        await handleSlashStatus(interaction);
        break;
      case "agents":
        await handleSlashAgents(interaction);
        break;
      case "broadcast":
        await handleSlashBroadcast(interaction);
        break;
      case "ask":
        await handleSlashAsk(interaction);
        break;
      case "memory":
        await handleSlashMemory(interaction);
        break;
      case "assign":
        await handleSlashAssign(interaction);
        break;
      case "spin-up":
        await handleSlashSpinUp(interaction);
        break;
      case "tear-down":
        await handleSlashTearDown(interaction);
        break;
      default:
        if (interaction.isRepliable()) {
          await interaction.reply({
            content: `Unknown command: \`/${interaction.commandName}\``,
            ephemeral: true,
          });
        }
    }
  } catch (err) {
    process.stderr.write(`hive-gateway: interaction handler error: ${err}\n`);
    try {
      if (interaction.isRepliable()) {
        process.stderr.write(`hive-gateway: interaction error: ${err}\n`);
        const msg = "An internal error occurred. Check gateway logs for details.";
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: msg });
        } else {
          await interaction.reply({ content: msg, ephemeral: true });
        }
      }
    } catch {}
  }
});

// ---------------------------------------------------------------------------
// HTTP request helpers
// ---------------------------------------------------------------------------

async function readJson(req: Request): Promise<Record<string, unknown>> {
  return (await req.json()) as Record<string, unknown>;
}

function jsonOk(data: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    headers: { "Content-Type": "application/json" },
  });
}

function jsonErr(error: string, status = 500): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** Auto-register a Hive Mind watch on behalf of a worker when TASK_ASSIGN has Dependencies */
function autoRegisterWatch(agent: string, topic: string): void {
  const delta: DeltaFile = {
    agent,
    action: "register-watch",
    target_type: "contract",
    target_topic: topic,
    watch: {
      topic,
      type: "contract",
      status: "waiting",
      since: new Date().toISOString(),
      default_action: `proceed with last known version of ${topic}`,
    },
  };
  const filename = `${Date.now()}-${agent}-auto-watch-${topic}.json`;
  const pendingDir = join(HIVE_ROOT, ".hive", "mind", "pending");
  const tmpPath = join(pendingDir, `.tmp-${crypto.randomUUID()}.json`);
  const finalPath = join(pendingDir, filename);
  try {
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(delta, null, 2));
    renameSync(tmpPath, finalPath);
    process.stderr.write(`hive-gateway: auto-watch registered for ${agent} on topic ${topic}\n`);
  } catch (err) {
    process.stderr.write(`hive-gateway: auto-watch failed for ${agent}/${topic}: ${err}\n`);
  }
}

async function handleRegister(req: Request): Promise<Response> {
  const body = await readJson(req);
  const workerId = body.workerId as string;
  if (!workerId) return jsonErr("workerId required", 400);

  // Validate workerId format (security: finding #4 — prevent impersonation)
  if (!/^[a-zA-Z0-9-]{1,32}$/.test(workerId)) {
    return jsonErr("invalid workerId format", 400);
  }

  const entry = {
    workerId,
    endpoint: (body.endpoint as string) ?? "",
    mentionPatterns: (body.mentionPatterns as string[]) ?? [],
    channelId: (body.channelId as string) ?? "",
    requireMention: (body.requireMention as boolean) ?? true,
    role: (body.role as string) ?? "engineer",
    domain: (body.domain as string) ?? undefined,
    failCount: 0,
    status: "available" as const,
    statusSince: new Date().toISOString(),
  };

  workers.set(workerId, entry);

  process.stderr.write(
    `hive-gateway: registered worker ${workerId} -> channel ${body.channelId}\n`,
  );
  return jsonOk();
}

async function handleDeregister(req: Request): Promise<Response> {
  const body = await readJson(req);
  const workerId = body.workerId as string;
  if (!workerId) return jsonErr("workerId required", 400);
  workers.delete(workerId);
  process.stderr.write(`hive-gateway: deregistered worker ${workerId}\n`);
  return jsonOk();
}

function writeScopeFile(agent: string, taskId: string, allowed: string[]): void {
  const scope = {
    agent,
    taskId,
    allowed,
    shared: ["package.json", "tsconfig.json", "*.lock", ".hive/**", ".omc/**", "node_modules/**"],
    createdAt: new Date().toISOString(),
  };
  const scopeDir = join(HIVE_ROOT, ".hive", "scope");
  mkdirSync(scopeDir, { recursive: true });
  const tmpPath = join(scopeDir, `.tmp-${crypto.randomUUID()}.json`);
  const finalPath = join(scopeDir, `${agent}.json`);
  writeFileSync(tmpPath, JSON.stringify(scope, null, 2));
  renameSync(tmpPath, finalPath);
  process.stderr.write(
    `hive-gateway: scope file written for ${agent} (${allowed.length} patterns)\n`,
  );
}

async function handleSend(req: Request): Promise<Response> {
  const body = await readJson(req);
  let chatId = body.chat_id as string;
  const text = body.text as string;
  const replyTo = body.reply_to as string | undefined;
  const files = (body.files as string[] | undefined) ?? [];
  const sender = body.sender as string | undefined;

  const parsed = parseHeader(text);

  // Auto-register watches for dependencies listed in TASK_ASSIGN
  if (parsed?.type === MessageType.TASK_ASSIGN && parsed.target) {
    const body = parseBody(text);
    const deps = body.dependencies;
    if (deps && deps !== "none") {
      const topics = deps
        .split(",")
        .map((d: string) => d.trim())
        .filter(Boolean);
      for (const topic of topics) {
        autoRegisterWatch(parsed.target, topic);
      }
    }
  }

  // Write scope file for the target agent
  if (parsed?.type === MessageType.TASK_ASSIGN && parsed.target && parsed.taskId) {
    const taskBody = parseBody(text);
    const filesField = taskBody.files;
    if (filesField) {
      const allowed = filesField
        .split(",")
        .map((f: string) => {
          const trimmed = f.trim();
          return trimmed.endsWith("/") ? `${trimmed}**` : trimmed;
        })
        .filter(Boolean);
      writeScopeFile(parsed.target, parsed.taskId, allowed);
    }
  }

  // Create task channel for TASK_ASSIGN
  if (parsed?.type === MessageType.TASK_ASSIGN && parsed.target && parsed.taskId) {
    try {
      const taskBody = parseBody(text);
      const taskChId = await createTaskChannel(parsed.taskId, taskBody.description, parsed.target);
      // Also post the TASK_ASSIGN in the task channel
      const taskCh = await client.channels.fetch(taskChId);
      if (taskCh && "send" in taskCh) {
        await (taskCh as any).send(text.slice(0, 1800));
      }
    } catch (err) {
      process.stderr.write(`hive-gateway: task channel creation failed: ${err}\n`);
    }
  }

  // Resolve chat_id='task' to a conversation channel (formerly task channel)
  if (chatId === "task") {
    const taskId = body.task_id as string | undefined;
    const resolvedChannelId = taskId ? getChannelIdForTask(taskId) : undefined;
    if (resolvedChannelId) {
      chatId = resolvedChannelId;
    } else {
      return jsonErr(`No task channel found for task_id: ${taskId}`);
    }
  }

  // Auto-add sender as active when posting to a conversation channel (Phase 2.4)
  if (sender) {
    const convo = conversationChannels.get(chatId);
    if (convo && !convo.active.has(sender)) {
      convo.observing.delete(sender); // promote from observing if present
      convo.active.add(sender);
      persistConversationChannels();
    }
  }

  // Resolve chat_id='auto' to the target agent's channel
  const targetAgent = body.target_agent as string | undefined;
  if (chatId === "auto" && targetAgent) {
    const worker = workers.get(targetAgent);
    if (worker?.channelId) {
      chatId = worker.channelId;
    } else {
      return jsonErr(`Cannot resolve channel for agent: ${targetAgent}`, 400);
    }
  }

  const ch = await fetchTextChannel(chatId);
  if (!("send" in ch)) throw new Error("channel is not sendable");

  const chunks = chunk(text, MAX_CHUNK);
  const sentIds: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const shouldReplyTo = replyTo != null && i === 0;
    try {
      const nonce = Date.now().toString() + Math.random().toString(36).slice(2, 8);
      if (sender) registerSelfSend(nonce, sender);

      const sent = await ch.send({
        content: chunks[i],
        nonce,
        enforceNonce: true,
        ...(i === 0 && files.length > 0 ? { files: files.map((f) => ({ attachment: f })) } : {}),
        ...(shouldReplyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}),
      });
      noteSent(sent.id, chatId);
      sentIds.push(sent.id);
    } catch (err) {
      process.stderr.write(`hive-gateway: send chunk failed: ${err}\n`);
      return jsonErr(`reply failed after ${sentIds.length} of ${chunks.length} chunks`);
    }
  }

  // Cross-post key protocol messages as embeds to dashboard channel
  if (sender && parsed && DASHBOARD_CHANNEL_ID) {
    // Always cross-post to dashboard since workers now have their own channels
    if (chatId !== DASHBOARD_CHANNEL_ID) {
      const channelLink = ` <#${chatId}>`;
      let embed: EmbedBuilder | null = null;

      switch (parsed.type) {
        case MessageType.STATUS: {
          const status = parsed.status ?? "";
          // Skip HEARTBEAT-like noise, only post meaningful status changes
          if (["READY", "ACCEPTED", "IN_PROGRESS", "BLOCKED", "FAILED"].includes(status)) {
            const colors: Record<string, number> = {
              READY: 0x5865f2,
              ACCEPTED: 0x57f287,
              IN_PROGRESS: 0xfee75c,
              BLOCKED: 0xed4245,
              FAILED: 0xed4245,
            };
            embed = new EmbedBuilder()
              .setColor(colors[status] ?? 0x5865f2)
              .setDescription(
                `**${parsed.sender}** → \`${status}\`${parsed.taskId ? ` (${parsed.taskId})` : ""}${channelLink}`,
              )
              .setTimestamp();
          }
          break;
        }
        case MessageType.COMPLETE: {
          const parsedBody = parseBody(text);
          embed = new EmbedBuilder()
            .setTitle(`Task Complete: ${parsed.taskId ?? ""}`)
            .setColor(0x57f287)
            .addFields(
              { name: "Agent", value: parsed.sender, inline: true },
              { name: "Task", value: parsed.taskId ?? "-", inline: true },
            )
            .setTimestamp();
          if (parsedBody.branch) {
            embed.addFields({ name: "Branch", value: parsedBody.branch, inline: true });
          }
          embed.addFields({ name: "Channel", value: `<#${chatId}>` });
          break;
        }
        case MessageType.QUESTION: {
          embed = new EmbedBuilder()
            .setColor(0xfee75c)
            .setDescription(
              `**${parsed.sender}** has a question${parsed.taskId ? ` (${parsed.taskId})` : ""}${channelLink}`,
            )
            .setTimestamp();
          break;
        }
        case MessageType.ESCALATE: {
          embed = new EmbedBuilder()
            .setColor(0xed4245)
            .setDescription(
              `**${parsed.sender}** escalated${parsed.taskId ? ` (${parsed.taskId})` : ""}${channelLink}`,
            )
            .setTimestamp();
          break;
        }
      }

      if (embed) {
        try {
          const mainChannel = await fetchTextChannel(DASHBOARD_CHANNEL_ID);
          if ("send" in mainChannel) {
            await mainChannel.send({ embeds: [embed] });
          }
        } catch (err) {
          process.stderr.write(`hive-gateway: failed to post embed: ${err}\n`);
        }
      }
    }
  }

  // Signal to inbox-relay: skip direct inbox write if target is an active conversation member
  // (Pass 3 will deliver the message via routeInbound when the echo triggers messageCreate)
  const skipDirectInbox =
    targetAgent &&
    conversationChannels.has(chatId) &&
    conversationChannels.get(chatId)!.active.has(targetAgent);

  return jsonOk({ message_ids: sentIds, ...(skipDirectInbox ? { skip_direct_inbox: true } : {}) });
}

async function handleReact(req: Request): Promise<Response> {
  const body = await readJson(req);
  const ch = await fetchTextChannel(body.chat_id as string);
  const msg = await ch.messages.fetch(body.message_id as string);
  await msg.react(body.emoji as string);
  return jsonOk();
}

// NOTE: msg.edit() fires 'messageUpdate', NOT 'messageCreate'.
// No messageUpdate handler exists, so edits are safe from routing loops.
// If adding messageUpdate handling later, apply nonce-based sender exclusion.
async function handleEdit(req: Request): Promise<Response> {
  const body = await readJson(req);
  const ch = await fetchTextChannel(body.chat_id as string);
  const msg = await ch.messages.fetch(body.message_id as string);
  await msg.edit(body.text as string);
  return jsonOk();
}

async function handleFetch(req: Request): Promise<Response> {
  const body = await readJson(req);
  const ch = await fetchTextChannel(body.channel as string);
  const limit = Math.min((body.limit as number) ?? 20, 100);
  const msgs = await ch.messages.fetch({ limit });
  const arr = [...msgs.values()].reverse();
  const out = arr.map((m) => ({
    id: m.id,
    author: m.author.username,
    content: m.content,
    ts: m.createdAt.toISOString(),
    attachments: m.attachments.size,
    isBot: m.author.bot,
  }));
  return jsonOk({ messages: out });
}

async function handleDownload(req: Request): Promise<Response> {
  const body = await readJson(req);
  const ch = await fetchTextChannel(body.chat_id as string);
  const msg = await ch.messages.fetch(body.message_id as string);

  if (msg.attachments.size === 0) {
    return jsonOk({ files: [], note: "message has no attachments" });
  }

  mkdirSync(INBOX_DIR, { recursive: true });
  const paths: string[] = [];

  for (const att of msg.attachments.values()) {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      return jsonErr(`attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max 25MB`);
    }
    const res = await fetch(att.url);
    const buf = Buffer.from(await res.arrayBuffer());
    const name = att.name ?? `${att.id}`;
    const rawExt = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "bin";
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "") || "bin";
    const safePath = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`);
    if (!safePath.startsWith(INBOX_DIR)) {
      return jsonErr("invalid attachment path", 400);
    }
    writeFileSync(safePath, buf);
    paths.push(safePath);
  }

  return jsonOk({ files: paths });
}

async function handleSetStatus(req: Request): Promise<Response> {
  const body = await readJson(req);
  const workerId = body.workerId as string;
  const status = body.status as string;

  if (!workerId) return jsonErr("workerId required", 400);
  if (!["available", "focused", "blocked"].includes(status)) {
    return jsonErr("status must be available, focused, or blocked", 400);
  }

  const worker = workers.get(workerId);
  if (!worker) return jsonErr(`unknown worker: ${workerId}`, 404);

  worker.status = status as "available" | "focused" | "blocked";
  worker.statusSince = new Date().toISOString();

  process.stderr.write(`hive-gateway: ${workerId} status → ${status}\n`);
  return jsonOk();
}

function handleGetWorkerStatus(url: URL): Response {
  const segments = url.pathname.split("/").filter(Boolean);
  const workerId = segments.length === 2 ? segments[1] : "";
  if (!workerId || !/^[a-zA-Z0-9-]{1,32}$/.test(workerId)) {
    return jsonErr("valid workerId required", 400);
  }

  const worker = workers.get(workerId);
  if (!worker) return jsonErr(`unknown worker: ${workerId}`, 404);

  return jsonOk({
    workerId: worker.workerId,
    status: worker.status,
    statusSince: worker.statusSince,
  });
}

async function handleNudge(req: Request): Promise<Response> {
  const body = await readJson(req);
  const workerId = body.workerId as string;
  const priority = (body.priority as string) ?? "info";

  if (!workerId) return jsonErr("workerId required", 400);
  if (!/^[a-zA-Z0-9-]{1,32}$/.test(workerId)) {
    return jsonErr("invalid workerId format", 400);
  }

  const worker = workers.get(workerId);
  if (!worker) return jsonErr(`unknown worker: ${workerId}`, 404);

  // Smart nudge: focused/blocked workers only interrupted by critical priority
  if (!shouldNudge(worker, priority)) {
    process.stderr.write(
      `hive-gateway: nudge suppressed for ${workerId} (${worker.status}, priority=${priority})\n`,
    );
    return jsonOk({ nudged: false, reason: worker.status });
  }

  if (shouldDebounceNudge(workerId)) {
    process.stderr.write(`hive-gateway: nudge debounced for ${workerId}\n`);
    return jsonOk({ nudged: false, reason: "debounced" });
  }

  const ok = await nudgeViaTmux(workerId);
  return ok ? jsonOk({ nudged: true }) : jsonErr("nudge failed");
}

function handleHealth(): Response {
  if (!channelsReady) {
    return new Response(JSON.stringify({ status: "starting", channelsReady: false }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  const workerList = [...workers.values()].map((w) => ({
    workerId: w.workerId,
    channelId: w.channelId,
    status: w.status,
    statusSince: w.statusSince,
  }));
  return new Response(
    JSON.stringify({
      status: "ok",
      channelsReady: true,
      connectedAs: client.user?.tag ?? "unknown",
      botId: client.user?.id ?? null,
      registeredWorkers: workers.size,
      workers: workerList,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// Conversation channel HTTP endpoints
// ---------------------------------------------------------------------------

async function handleCreateChannel(req: Request): Promise<Response> {
  const body = await readJson(req);
  const topic = body.topic as string;
  const participants = body.participants as string[];
  const message = body.message as string | undefined;
  const creator = body.creator as string;

  if (!topic) return jsonErr("topic required", 400);
  if (!Array.isArray(participants) || participants.length === 0)
    return jsonErr("participants required", 400);
  if (!creator) return jsonErr("creator required", 400);

  // Validate all participant names exist in workers map
  const allNames = [creator, ...participants];
  for (const name of allNames) {
    if (!workers.has(name)) {
      return jsonErr(`unknown worker: ${name}`, 400);
    }
  }

  // Derive slug from topic
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const channelName = `conv-${Date.now().toString(36)}-${slug}`.slice(0, 100);

  // Create Discord channel under Hive category (same pattern as createTaskChannel)
  const dashboardCh = await client.channels.fetch(DASHBOARD_CHANNEL_ID);
  if (!dashboardCh || !("guild" in dashboardCh))
    return jsonErr("Cannot find guild for conversation channel");
  const guild = (dashboardCh as any).guild;
  const categoryId = GATEWAY_CONFIG_DATA?.categoryId;

  const ch = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    ...(categoryId ? { parent: categoryId } : {}),
  });

  // Register in conversationChannels: creator → active, others → observing
  const observingSet = new Set(participants.filter((p: string) => p !== creator));
  const activeSet = new Set([creator]);
  conversationChannels.set(ch.id, {
    name: channelName,
    active: activeSet,
    observing: observingSet,
    createdAt: new Date().toISOString(),
    createdBy: creator,
  });
  persistConversationChannels();

  // Write notification to each participant's inbox
  for (const name of allNames) {
    const notifMsg: InboxMessage = {
      chatId: ch.id,
      messageId: `notify-${Date.now()}-${name}`,
      user: "system",
      ts: new Date().toISOString(),
      content: `You've been added to #${channelName} (topic: ${topic}). Channel ID: ${ch.id}. Use fetch_messages to read history, or hive__set_channel_tier to go active.`,
      attachments: [],
    };
    writeToInbox(name, notifMsg);
  }

  // If message provided, post it in the new Discord channel
  if (message) {
    try {
      await ch.send(message);
    } catch (e) {
      process.stderr.write(
        `hive-gateway: failed to post initial message to ${channelName}: ${e}\n`,
      );
    }
  }

  // Build participant response with status info
  const participantInfo = allNames.map((name: string) => {
    const worker = workers.get(name)!;
    return {
      name,
      tier: activeSet.has(name) ? "active" : "observing",
      status: worker.status,
      statusSince: worker.statusSince,
    };
  });

  return jsonOk({ channelId: ch.id, participants: participantInfo });
}

async function handleAddToChannel(req: Request): Promise<Response> {
  const body = await readJson(req);
  const channelId = body.channel_id as string;
  const agent = body.agent as string;
  const addedBy = body.added_by as string;

  if (!channelId) return jsonErr("channel_id required", 400);
  if (!agent) return jsonErr("agent required", 400);

  const convo = conversationChannels.get(channelId);
  if (!convo) return jsonErr(`unknown conversation channel: ${channelId}`, 404);

  const worker = workers.get(agent);
  if (!worker) return jsonErr(`unknown worker: ${agent}`, 404);

  // If already member, return early
  if (convo.active.has(agent)) {
    return jsonOk({ already_member: true, tier: "active" });
  }
  if (convo.observing.has(agent)) {
    return jsonOk({ already_member: true, tier: "observing" });
  }

  // Add to observing
  convo.observing.add(agent);
  persistConversationChannels();

  // Notify the agent
  const notifMsg: InboxMessage = {
    chatId: channelId,
    messageId: `notify-${Date.now()}-${agent}`,
    user: "system",
    ts: new Date().toISOString(),
    content: `You've been added to #${convo.name} (added by ${addedBy ?? "unknown"}). Channel ID: ${channelId}. Use fetch_messages to read history, or hive__set_channel_tier to go active.`,
    attachments: [],
  };
  writeToInbox(agent, notifMsg);

  // Nudge only if shouldNudge passes
  if (shouldNudge(worker) && !shouldDebounceNudge(agent)) {
    await nudgeViaTmux(agent);
  }

  return jsonOk({
    added: true,
    agent,
    tier: "observing",
    status: worker.status,
    statusSince: worker.statusSince,
  });
}

async function handleSetChannelTier(req: Request): Promise<Response> {
  const body = await readJson(req);
  const channelId = body.channel_id as string;
  const agent = body.agent as string;
  const tier = body.tier as string;

  if (!channelId) return jsonErr("channel_id required", 400);
  if (!agent) return jsonErr("agent required", 400);
  if (tier !== "active" && tier !== "observing")
    return jsonErr("tier must be active or observing", 400);

  const convo = conversationChannels.get(channelId);
  if (!convo) return jsonErr(`unknown conversation channel: ${channelId}`, 404);

  // Validate agent is a member
  const isMember = convo.active.has(agent) || convo.observing.has(agent);
  if (!isMember) return jsonErr(`agent ${agent} is not a member of channel ${channelId}`, 400);

  // Move between sets
  if (tier === "active") {
    convo.observing.delete(agent);
    convo.active.add(agent);
  } else {
    convo.active.delete(agent);
    convo.observing.add(agent);
  }
  persistConversationChannels();

  return jsonOk({ updated: true, agent, tier });
}

async function handleLeaveChannel(req: Request): Promise<Response> {
  const body = await readJson(req);
  const channelId = body.channel_id as string;
  const agent = body.agent as string;

  if (!channelId) return jsonErr("channel_id required", 400);
  if (!agent) return jsonErr("agent required", 400);

  const convo = conversationChannels.get(channelId);
  if (!convo) return jsonErr(`unknown conversation channel: ${channelId}`, 404);

  convo.active.delete(agent);
  convo.observing.delete(agent);
  persistConversationChannels();

  return jsonOk({ left: true, agent });
}

function handleMyChannels(url: URL): Response {
  const workerName = url.searchParams.get("worker");
  if (!workerName) return jsonErr("worker query parameter required", 400);

  const channels: Array<{
    channelId: string;
    name: string;
    tier: string;
    participants: { active: string[]; observing: string[] };
    taskId?: string;
  }> = [];

  for (const [channelId, convo] of conversationChannels) {
    let tier: string | null = null;
    if (convo.active.has(workerName)) tier = "active";
    else if (convo.observing.has(workerName)) tier = "observing";
    if (!tier) continue;

    channels.push({
      channelId,
      name: convo.name,
      tier,
      participants: {
        active: [...convo.active],
        observing: [...convo.observing],
      },
      ...(convo.taskId ? { taskId: convo.taskId } : {}),
    });
  }

  return jsonOk({ channels });
}

function handleTeamStatus(): Response {
  const agents = [...workers.values()].map((w) => ({
    name: w.workerId,
    role: w.role,
    domain: w.domain ?? null,
    status: w.status,
    statusSince: w.statusSince,
  }));
  return jsonOk({ agents });
}

// ---------------------------------------------------------------------------
// HTTP server (Unix domain socket)
// ---------------------------------------------------------------------------

mkdirSync(GATEWAY_DIR, { recursive: true, mode: 0o700 });
chmodSync(GATEWAY_DIR, 0o700);
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

const server = Bun.serve({
  unix: SOCKET_PATH,
  async fetch(req) {
    const url = new URL(req.url, "http://localhost");
    const method = req.method;
    const path = url.pathname;

    try {
      if (method === "GET" && path === "/health") return handleHealth();
      if (method === "GET" && path === "/channels") {
        return new Response(JSON.stringify({ channels: Object.fromEntries(workerChannelMap) }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST" && path === "/register") return await handleRegister(req);
      if (method === "POST" && path === "/deregister") return await handleDeregister(req);
      if (method === "POST" && path === "/send") return await handleSend(req);
      if (method === "POST" && path === "/react") return await handleReact(req);
      if (method === "POST" && path === "/edit") return await handleEdit(req);
      if (method === "POST" && path === "/fetch") return await handleFetch(req);
      if (method === "POST" && path === "/download") return await handleDownload(req);
      if (method === "POST" && path === "/status") return await handleSetStatus(req);
      if (method === "GET" && path.startsWith("/worker-status/")) return handleGetWorkerStatus(url);
      if (method === "POST" && path === "/nudge") return await handleNudge(req);
      if (method === "POST" && path === "/create-channel") return await handleCreateChannel(req);
      if (method === "POST" && path === "/add-to-channel") return await handleAddToChannel(req);
      if (method === "POST" && path === "/set-channel-tier") return await handleSetChannelTier(req);
      if (method === "POST" && path === "/leave-channel") return await handleLeaveChannel(req);
      if (method === "GET" && path === "/my-channels") return handleMyChannels(url);
      if (method === "GET" && path === "/team-status") return handleTeamStatus();
      return jsonErr("not found", 404);
    } catch (err) {
      process.stderr.write(`hive-gateway: request error: ${err}\n`);
      return jsonErr("internal error");
    }
  },
});

process.stderr.write(`hive-gateway: listening on ${SOCKET_PATH}\n`);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write("hive-gateway: shutting down\n");
  client.destroy();
  server.stop();
  try {
    unlinkSync(SOCKET_PATH);
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);

// Safety nets
process.on("unhandledRejection", (err) => {
  process.stderr.write(`hive-gateway: unhandled rejection: ${err}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`hive-gateway: uncaught exception: ${err}\n`);
});

// ---------------------------------------------------------------------------
// Discord login
// ---------------------------------------------------------------------------

client.on("error", (err) => {
  process.stderr.write(`hive-gateway: client error: ${err}\n`);
});

client.once("ready", async (c) => {
  process.stderr.write(`hive-gateway: gateway connected as ${c.user.tag}\n`);
  try {
    workerChannelMap = await ensureWorkerChannels();
    writeFileSync(
      join(STATE_DIR, "gateway", "channels.json"),
      JSON.stringify(Object.fromEntries(workerChannelMap), null, 2),
    );
    channelsReady = true;
    process.stderr.write(`hive-gateway: ${workerChannelMap.size} worker channels ready\n`);

    // Load existing conversation channels from a previous run
    try {
      const ccPath = join(STATE_DIR, "gateway", "conversation-channels.json");
      const tcPath = join(STATE_DIR, "gateway", "task-channels.json");

      if (existsSync(ccPath)) {
        // New format: channelId → { name, active[], observing[], taskId?, ... }
        const data = JSON.parse(readFileSync(ccPath, "utf8"));
        for (const [channelId, entry] of Object.entries(data)) {
          const e = entry as any;
          conversationChannels.set(channelId, {
            name: e.name ?? "",
            active: new Set(e.active ?? []),
            observing: new Set(e.observing ?? []),
            taskId: e.taskId,
            createdAt: e.createdAt ?? new Date().toISOString(),
            createdBy: e.createdBy ?? "unknown",
          });
        }
        process.stderr.write(
          `hive-gateway: loaded ${conversationChannels.size} conversation channel(s)\n`,
        );
      } else if (existsSync(tcPath)) {
        // Migration: old format is taskId → channelId
        const data = JSON.parse(readFileSync(tcPath, "utf8"));
        // Try to backfill active set from agents.json task assignments
        let agentsData: AgentsJson | null = null;
        try {
          agentsData = readAgentsJson();
        } catch {}

        for (const [taskId, channelId] of Object.entries(data)) {
          const chId = channelId as string;
          const active = new Set<string>();
          // Best-effort: find agent assigned to this task from agents.json
          if (agentsData) {
            for (const agent of agentsData.agents) {
              if (agent.status === "running") {
                // Can't determine exact task assignment, leave active empty
              }
            }
          }
          conversationChannels.set(chId, {
            name: `task-${taskId}`,
            active,
            observing: new Set(),
            taskId,
            createdAt: new Date().toISOString(),
            createdBy: "migrated",
          });
        }
        // Persist in new format and log migration
        persistConversationChannels();
        process.stderr.write(
          `hive-gateway: migrated ${conversationChannels.size} task channel(s) to conversation channels\n`,
        );
      }
    } catch {}
  } catch (err) {
    const isPermission =
      String(err).includes("Missing Permissions") || String(err).includes("50013");
    if (isPermission) {
      process.stderr.write(
        `hive-gateway: WARNING — bot lacks Manage Channels permission. Falling back to single-channel mode.\n`,
      );
      process.stderr.write(
        `hive-gateway: Grant the bot "Manage Channels" permission in your Discord server for per-worker channels.\n`,
      );
      // Fall back: all workers share the dashboard channel
      for (const worker of workers.values()) {
        if (!worker.channelId) worker.channelId = DASHBOARD_CHANNEL_ID;
        workerChannelMap.set(worker.workerId, DASHBOARD_CHANNEL_ID);
      }
      writeFileSync(
        join(STATE_DIR, "gateway", "channels.json"),
        JSON.stringify(Object.fromEntries(workerChannelMap), null, 2),
      );
      channelsReady = true;
    } else {
      process.stderr.write(`hive-gateway: channel creation failed: ${err}\n`);
      process.exit(1);
    }
  }
});

client.login(TOKEN).catch((err) => {
  process.stderr.write(`hive-gateway: login failed: ${err}\n`);
  process.exit(1);
});
