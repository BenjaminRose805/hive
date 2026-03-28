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
import { shouldDeliverHumanMessage, findSpokesperson, type WorkerInfo } from "../src/gateway/selective-router.ts";
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
  if (worker.status === "focused" && priority !== "critical") {
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
  session: string;
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
const DEFAULT_SESSION = process.env.HIVE_SESSION ?? "hive";
try {
  if (existsSync(GATEWAY_CONFIG_PATH)) {
    const gwConfig = JSON.parse(readFileSync(GATEWAY_CONFIG_PATH, "utf8"));
    for (const w of gwConfig.workers ?? []) {
      const session = w.session ?? DEFAULT_SESSION;
      const compositeKey = `${session}:${w.workerId}`;
      workers.set(compositeKey, {
        workerId: w.workerId,
        session,
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
// Registration persistence
// ---------------------------------------------------------------------------

function persistRegistrations(): void {
  try {
    const data: Record<string, any> = {};
    for (const [key, entry] of workers) {
      data[key] = { ...entry };
    }
    const filePath = join(GATEWAY_DIR, "registrations.json");
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, filePath);
  } catch (err) {
    process.stderr.write(`hive-gateway: failed to persist registrations: ${err}\n`);
  }
}

function loadRegistrations(): void {
  try {
    const filePath = join(GATEWAY_DIR, "registrations.json");
    if (!existsSync(filePath)) return;
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    for (const [key, entry] of Object.entries(data)) {
      if (!workers.has(key)) {
        workers.set(key, entry as WorkerEntry);
      }
    }
    process.stderr.write(`hive-gateway: loaded ${Object.keys(data).length} registration(s) from disk\n`);
  } catch (err) {
    process.stderr.write(`hive-gateway: failed to load registrations: ${err}\n`);
  }
}

loadRegistrations();

// ---------------------------------------------------------------------------
// Worker lookup helpers
// ---------------------------------------------------------------------------

function findWorkerByBareId(workerId: string, session?: string): WorkerEntry | undefined {
  // Prefer session-scoped composite key lookup when session is provided
  if (session) {
    const entry = workers.get(`${session}:${workerId}`);
    if (entry) return entry;
  }

  // Fall back to bare ID scan
  let match: WorkerEntry | undefined;
  let count = 0;
  for (const entry of workers.values()) {
    if (entry.workerId === workerId) {
      if (!match) match = entry;
      count++;
    }
  }

  if (count > 1 && !session) {
    process.stderr.write(
      `hive-gateway: ambiguous bare ID "${workerId}" matches ${count} workers across sessions — pass session for disambiguation\n`,
    );
  }

  return match;
}

function findCompositeKey(workerId: string, session?: string): string | undefined {
  if (session) {
    const key = `${session}:${workerId}`;
    if (workers.has(key)) return key;
  }
  for (const [key, entry] of workers) {
    if (entry.workerId === workerId) return key;
  }
  return undefined;
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
      const worker = findWorkerByBareId(spokesperson.workerId);
      if (worker && !(excludeSender && worker.workerId === excludeSender)) {
        targets.push(worker);
        targeted.add(worker.workerId);
      }
    }
  }

  // Pass 1: Channel owner + coordinator role
  for (const worker of workers.values()) {
    if (targeted.has(worker.workerId)) continue;
    if (excludeSender && worker.workerId === excludeSender) continue;

    if (worker.role === "manager") {
      // Human messages route through spokesperson, not directly to manager
      if (isHumanMsg) continue;
      // Manager always receives non-human messages
      targets.push(worker);
      targeted.add(worker.workerId);
      continue;
    }

    if (worker.channelId === effectiveChannelId) {
      // Channel owner — deliver without mention check
      targets.push(worker);
      targeted.add(worker.workerId);
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
    const chatId = worker.channelId;

    const inboxMsg: InboxMessage = {
      chatId,
      messageId: msg.id,
      user: msg.author.username,
      ts: msg.createdAt.toISOString(),
      content,
      attachments,
    };
    writeToInbox(worker.workerId, inboxMsg);

    // Use shouldNudge + debounce instead of direct nudgeViaTmux
    // Human messages and manager role bypass status-based suppression (always nudge)
    const alwaysNudge = isHumanMessage || worker.role === "manager";
    if ((alwaysNudge || shouldNudge(worker)) && !shouldDebounceNudge(worker.workerId)) {
      const ok = await nudgeViaTmux(`${worker.session}:${worker.workerId}`);
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

async function nudgeViaTmux(compositeKey: string): Promise<boolean> {
  const worker = workers.get(compositeKey);
  const workerId = worker ? worker.workerId : compositeKey.includes(":") ? compositeKey.split(":").slice(1).join(":") : compositeKey;
  const sessionName = worker ? worker.session : (DEFAULT_SESSION);
  return withWorkerLock(compositeKey, async () => {
    const target = `${sessionName}:${workerId}`;
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
    const ok = await nudgeViaTmux(`${worker.session}:${worker.workerId}`);
    results.push(`\`${worker.workerId}\`: ${ok ? "delivered" : "inbox only (nudge failed)"}`);
  }

  await interaction.editReply({
    content: `Broadcast sent to ${workers.size} worker(s):\n${results.join("\n")}`,
  });
}

async function handleSlashAsk(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString("agent", true);
  const message = interaction.options.getString("message", true);

  const worker = findWorkerByBareId(agentName);
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
  const ok = await nudgeViaTmux(`${worker.session}:${agentName}`);

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

  const worker = findWorkerByBareId(agentName);
  if (!worker) {
    await interaction.reply({
      content: `Agent \`${agentName}\` is not registered. Use \`/agents\` to see registered agents.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  // Create task contract file in .hive/mind/tasks/
  const taskId = `task-${Date.now().toString(36)}`;
  const files = interaction.options.getString("files") ?? "";
  const acceptanceCriteria = task.split(";").map((s) => s.trim()).filter(Boolean);
  const now = new Date().toISOString();

  const taskContract = {
    id: taskId,
    title: task,
    description: task,
    assignee: agentName,
    phase: "ASSIGNED",
    acceptanceCriteria,
    process: {
      tests: "PENDING",
      lsp_diagnostics: "PENDING",
      code_review: "PENDING",
    },
    files: files ? files.split(",").map((f: string) => f.trim()).filter(Boolean) : [],
    created: now,
    updated: now,
    history: [],
  };

  // Write task contract to disk
  const tasksDir = join(HIVE_ROOT, ".hive", "mind", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const contractPath = join(tasksDir, `${taskId}.json`);
  writeFileSync(contractPath, JSON.stringify(taskContract, null, 2));

  // Format as TASK_ASSIGN protocol message for the agent's inbox
  const taskMessage = [
    `TASK_ASSIGN | ${agentName} | ${taskId}`,
    `Branch: hive/${agentName}`,
    `Files: ${files}`,
    `Description: ${task}`,
    `Dependencies: none`,
  ].join("\n");

  // Use worker's dedicated channel
  const chatId = worker.channelId || interaction.channelId;

  const assignMsg: InboxMessage = {
    chatId,
    messageId: interaction.id,
    user: interaction.user.username,
    ts: new Date().toISOString(),
    content: taskMessage,
    attachments: [],
  };
  writeToInbox(agentName, assignMsg);
  const ok = await nudgeViaTmux(`${worker.session}:${agentName}`);

  if (ok) {
    await interaction.editReply({ content: `Task assigned to \`${agentName}\` (${taskId}):\n> ${task}` });
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
          const worker = findWorkerByBareId(agentName);
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
    const tearDownWorker = findWorkerByBareId(agentName);
    const SESSION_NAME = tearDownWorker?.session ?? DEFAULT_SESSION;
    Bun.spawnSync(["tmux", "kill-window", "-t", `${SESSION_NAME}:${agentName}`], {
      stdout: "pipe",
      stderr: "pipe",
    });

    agentProcesses.delete(agentName);

    // Deregister from workers map if present
    const compositeKeyToDelete = findCompositeKey(agentName);
    if (compositeKeyToDelete) workers.delete(compositeKeyToDelete);

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


async function handleRegister(req: Request): Promise<Response> {
  const body = await readJson(req);
  const workerId = body.workerId as string;
  if (!workerId) return jsonErr("workerId required", 400);

  // Validate workerId format (security: finding #4 — prevent impersonation)
  if (!/^[a-zA-Z0-9-]{1,32}$/.test(workerId)) {
    return jsonErr("invalid workerId format", 400);
  }

  const session = (body.session as string) ?? DEFAULT_SESSION;
  const compositeKey = `${session}:${workerId}`;

  const entry: WorkerEntry = {
    workerId,
    session,
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

  workers.set(compositeKey, entry);
  persistRegistrations();

  process.stderr.write(
    `hive-gateway: registered worker ${compositeKey} -> channel ${body.channelId}\n`,
  );
  return jsonOk();
}

async function handleDeregister(req: Request): Promise<Response> {
  const body = await readJson(req);
  const workerId = body.workerId as string | undefined;
  const session = (body.session as string) ?? DEFAULT_SESSION;

  // Bulk deregister: session provided without workerId — remove all workers for that session
  if (!workerId && session) {
    const toRemove: string[] = [];
    for (const [key, w] of workers) {
      if (w.session === session) toRemove.push(key);
    }
    for (const key of toRemove) {
      const w = workers.get(key)!;
      agentProcesses.delete(w.workerId);
      workerChannelMap.delete(w.workerId);
      workers.delete(key);
    }
    persistRegistrations();
    process.stderr.write(`hive-gateway: bulk deregistered ${toRemove.length} worker(s) for session ${session}\n`);
    return jsonOk({ removed: toRemove.length });
  }

  if (!workerId) return jsonErr("workerId or session required", 400);

  const compositeKey = `${session}:${workerId}`;
  const entry = workers.get(compositeKey) ?? findWorkerByBareId(workerId);
  const keyToDelete = workers.has(compositeKey) ? compositeKey : findCompositeKey(workerId);

  if (keyToDelete) {
    workers.delete(keyToDelete);
  }

  // Clean up related state
  if (entry) {
    agentProcesses.delete(workerId);
    workerChannelMap.delete(workerId);
  }

  persistRegistrations();
  process.stderr.write(`hive-gateway: deregistered worker ${compositeKey}\n`);
  return jsonOk();
}

async function handleSend(req: Request): Promise<Response> {
  const body = await readJson(req);
  let chatId = body.chat_id as string;
  const text = body.text as string;
  const replyTo = body.reply_to as string | undefined;
  const files = (body.files as string[] | undefined) ?? [];
  const sender = body.sender as string | undefined;

  // Resolve chat_id='auto' to the target agent's channel
  const targetAgent = body.target_agent as string | undefined;
  const senderSession = (body.session as string) ?? undefined;
  if (chatId === "auto" && targetAgent) {
    const worker = findWorkerByBareId(targetAgent, senderSession);
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
  // Simple header detection: "TYPE | sender | ..." on the first line
  if (sender && DASHBOARD_CHANNEL_ID && chatId !== DASHBOARD_CHANNEL_ID) {
    const firstLine = text.split("\n")[0] ?? "";
    const headerMatch = firstLine.match(/^(\w+)\s*\|\s*(\S+)(?:\s*\|\s*(\S+))?/);
    if (headerMatch) {
      const msgType = headerMatch[1];
      const msgSender = headerMatch[2];
      const msgTaskId = headerMatch[3];
      const channelLink = ` <#${chatId}>`;
      let embed: EmbedBuilder | null = null;

      if (msgType === "STATUS") {
        // Extract status from "STATUS | sender | taskId | STATUS_VALUE" or second-line "Status: VALUE"
        const statusParts = firstLine.split("|").map((s) => s.trim());
        const status = statusParts[3] ?? "";
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
              `**${msgSender}** → \`${status}\`${msgTaskId ? ` (${msgTaskId})` : ""}${channelLink}`,
            )
            .setTimestamp();
        }
      } else if (msgType === "COMPLETE") {
        // Extract branch from body lines
        const branchLine = text.match(/^Branch:\s*(.+)$/m);
        embed = new EmbedBuilder()
          .setTitle(`Task Complete: ${msgTaskId ?? ""}`)
          .setColor(0x57f287)
          .addFields(
            { name: "Agent", value: msgSender, inline: true },
            { name: "Task", value: msgTaskId ?? "-", inline: true },
          )
          .setTimestamp();
        if (branchLine?.[1]) {
          embed.addFields({ name: "Branch", value: branchLine[1].trim(), inline: true });
        }
        embed.addFields({ name: "Channel", value: `<#${chatId}>` });
      } else if (msgType === "QUESTION") {
        embed = new EmbedBuilder()
          .setColor(0xfee75c)
          .setDescription(
            `**${msgSender}** has a question${msgTaskId ? ` (${msgTaskId})` : ""}${channelLink}`,
          )
          .setTimestamp();
      } else if (msgType === "ESCALATE") {
        embed = new EmbedBuilder()
          .setColor(0xed4245)
          .setDescription(
            `**${msgSender}** escalated${msgTaskId ? ` (${msgTaskId})` : ""}${channelLink}`,
          )
          .setTimestamp();
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

  return jsonOk({ message_ids: sentIds });
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
  const session = (body.session as string) ?? undefined;

  if (!workerId) return jsonErr("workerId required", 400);
  if (!["available", "focused", "blocked"].includes(status)) {
    return jsonErr("status must be available, focused, or blocked", 400);
  }

  const worker = findWorkerByBareId(workerId, session);
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

  const worker = findWorkerByBareId(workerId);
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
  const session = (body.session as string) ?? undefined;

  if (!workerId) return jsonErr("workerId required", 400);
  if (!/^[a-zA-Z0-9-]{1,32}$/.test(workerId)) {
    return jsonErr("invalid workerId format", 400);
  }

  const worker = findWorkerByBareId(workerId, session);
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

  const ok = await nudgeViaTmux(`${worker.session}:${workerId}`);
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
    session: w.session,
    channelId: w.channelId,
    status: w.status,
    statusSince: w.statusSince,
  }));
  const sessions = [...new Set(workerList.map((w) => w.session))];
  return new Response(
    JSON.stringify({
      status: "ok",
      channelsReady: true,
      connectedAs: client.user?.tag ?? "unknown",
      botId: client.user?.id ?? null,
      registeredWorkers: workers.size,
      sessions,
      workers: workerList,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function handleStatusCard(): Response {
  const fields = [...workers.values()].map((w) => ({
    name: w.workerId,
    value: `${w.role} | ${w.status} | ${w.statusSince}`,
    inline: true,
  }));
  return jsonOk({
    embed: {
      title: "Hive Status",
      color: 0x5865f2,
      fields,
      timestamp: new Date().toISOString(),
    },
  });
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
        const sessionFilter = url.searchParams.get("session");
        const filtered = new Map<string, string>();
        for (const [key, channelId] of workerChannelMap) {
          if (sessionFilter) {
            const worker = findWorkerByBareId(key, sessionFilter ?? undefined);
            if (worker && worker.session === sessionFilter) {
              filtered.set(key, channelId);
            }
          } else {
            filtered.set(key, channelId);
          }
        }
        return new Response(JSON.stringify({ channels: Object.fromEntries(filtered) }), {
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
      if (method === "GET" && path === "/status-card") return handleStatusCard();
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
// Stale session cleanup — remove workers whose tmux session has died
// ---------------------------------------------------------------------------

setInterval(async () => {
  const sessions = new Set<string>();
  for (const w of workers.values()) sessions.add(w.session);

  for (const session of sessions) {
    const check = Bun.spawn(["tmux", "has-session", "-t", session], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await check.exited;
    if (exit !== 0) {
      // Session is dead — remove all workers for this session
      const toRemove: string[] = [];
      for (const [key, w] of workers) {
        if (w.session === session) toRemove.push(key);
      }
      for (const key of toRemove) {
        const w = workers.get(key);
        if (w) {
          agentProcesses.delete(w.workerId);
          workerChannelMap.delete(w.workerId);
        }
        workers.delete(key);
      }
      if (toRemove.length > 0) {
        process.stderr.write(
          `hive-gateway: cleaned ${toRemove.length} stale worker(s) from dead session ${session}\n`,
        );
        persistRegistrations();
      }
    }
  }
}, 5 * 60 * 1000);

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
