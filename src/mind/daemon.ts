/**
 * src/mind/daemon.ts — Hive Mind daemon process
 *
 * Long-running Bun process that:
 *   - Watches pending/ for delta files and merges them into canonical mind files
 *   - Tracks readers and manages watches with nudge notifications
 *   - Sends inbox notifications on updates
 *   - Takes periodic git snapshots of durable knowledge
 *
 * Single writer for: contracts/, decisions/, readers/, watches/, changelog/
 * CLI writes to:      pending/, inbox/, agents/
 */

import {
  appendFileSync,
  existsSync,
  type FSWatcher,
  watch as fsWatch,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  ChangelogEntry,
  DaemonPid,
  DeltaFile,
  InboxMessage,
  InboxPriority,
  MindEntry,
  ReaderEntry,
  ReaderRegistry,
  WatchEntry,
} from "./mind-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT_DIR = import.meta.dir;
const PROJECT_ROOT = resolve(SCRIPT_DIR, "../..");
const MIND_ROOT = join(PROJECT_ROOT, ".hive", "mind");

const POLL_INTERVAL_MS = 2_000;
const WATCH_MONITOR_INTERVAL_MS = 60_000;
const GIT_SNAPSHOT_INTERVAL_MS = 300_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

const GATEWAY_SOCKET = process.env.HIVE_GATEWAY_SOCKET ?? "/tmp/hive-gateway/gateway.sock";
const PUSH_TIMEOUT_MS = 5_000;

const NUDGE_COOLDOWN_MS = 15 * 60_000; // 15 minutes
const WATCH_NUDGE_THRESHOLD_MS = 15 * 60_000;
const WATCH_ALERT_THRESHOLD_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

import type { AgentsJson } from "../shared/agent-types.ts";
import { atomicWrite, ensureDir, readJSONFile } from "./fs-utils.ts";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function pendingDir(): string {
  return join(MIND_ROOT, "pending");
}

function failedDir(): string {
  return join(MIND_ROOT, "pending", ".failed");
}

function canonicalPath(type: string, topic: string): string {
  return join(MIND_ROOT, `${type}s`, `${topic}.json`);
}

function canonicalDir(type: string): string {
  return join(MIND_ROOT, `${type}s`);
}

function _readersPath(type: string, topic: string): string {
  return join(MIND_ROOT, "readers", `${type}s`, `${topic}.json`);
}

function gatewayInboxDir(agent: string): string {
  return join(dirname(GATEWAY_SOCKET), "inbox", "messages", agent);
}

function _watchesFile(agent: string): string {
  return join(MIND_ROOT, "watches", `${agent}.json`);
}

function changelogDir(): string {
  return join(MIND_ROOT, "changelog");
}

function pidFile(): string {
  return join(MIND_ROOT, "daemon.pid");
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** Reader registries keyed by "{type}s/{topic}" */
const readerRegistries = new Map<string, ReaderRegistry>();

/** Watch entries keyed by agent name */
const watchCache = new Map<string, WatchEntry[]>();

/** Per-topic mutex keyed by "{target_type}/{target_topic}" */
const topicMutexes = new Map<string, Promise<void>>();

/** Last nudge timestamp per topic for rate limiting */
const nudgeTimestamps = new Map<string, number>();

/** Tracks whether changelog has new entries since last git snapshot */
let changesSinceSnapshot = false;

/** Interval/watcher handles for cleanup */
let pendingWatcher: FSWatcher | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let watchMonitorTimer: ReturnType<typeof setInterval> | null = null;
let gitSnapshotTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** Flag to prevent re-entrant processing */
let processing = false;

/** Shutdown flag */
let shuttingDown = false;

// ---------------------------------------------------------------------------
// Inbox notification helper
// ---------------------------------------------------------------------------

async function writeInboxMessage(
  toAgent: string,
  msg: Omit<InboxMessage, "id" | "read" | "timestamp">,
): Promise<void> {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  // Write in unified inbox format (compatible with hive__check_inbox MCP tool)
  const inboxMsg = {
    chatId: "",
    messageId: id,
    user: msg.from,
    ts: timestamp,
    content: msg.content,
    attachments: [],
    source: "mind",
    mindType: msg.type,
    priority: msg.priority,
    topic: msg.topic,
  };

  const dir = gatewayInboxDir(toAgent);
  mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-mind-${msg.type}.json`;
  const tmpPath = join(dir, `.${filename}.tmp`);
  const finalPath = join(dir, filename);
  writeFileSync(tmpPath, JSON.stringify(inboxMsg, null, 2));
  renameSync(tmpPath, finalPath);
}

async function nudgeWorker(agent: string, priority: string = "info"): Promise<void> {
  try {
    await fetch("http://localhost/nudge", {
      unix: GATEWAY_SOCKET,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: agent, priority }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    } as any);
  } catch {
    // Best-effort — gateway may not be running yet during startup
  }
}

// ---------------------------------------------------------------------------
// Discord push notification helper
// ---------------------------------------------------------------------------

/** Push a CONTRACT_UPDATE message to an agent via the gateway's Discord connection */
async function pushDiscordNotification(
  targetAgent: string,
  topic: string,
  version: number,
  isBreaking: boolean,
  summary: string,
): Promise<void> {
  const message = [
    `CONTRACT_UPDATE | ${targetAgent} | ${topic}`,
    `Version: ${version}`,
    `Breaking: ${isBreaking ? "yes" : "no"}`,
    `Summary: ${summary}`,
  ].join("\n");

  try {
    const resp = await fetch("http://localhost/send", {
      unix: GATEWAY_SOCKET,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: "auto",
        text: message,
        target_agent: targetAgent,
      }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      process.stderr.write(
        `[hive-mind-daemon] Discord push failed (${resp.status}): ${await resp.text()}\n`,
      );
    }
  } catch {
    process.stderr.write(`[hive-mind-daemon] Gateway unavailable, using inbox-only notification\n`);
  }
}

// ---------------------------------------------------------------------------
// Changelog helper
// ---------------------------------------------------------------------------

function appendChangelog(entry: ChangelogEntry): void {
  const dir = changelogDir();
  ensureDir(dir);
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filePath = join(dir, `${date}.jsonl`);
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
  changesSinceSnapshot = true;
}

// ---------------------------------------------------------------------------
// Reader registry helpers
// ---------------------------------------------------------------------------

function registryKey(type: string, topic: string): string {
  return `${type}s/${topic}`;
}

function loadReadersFromDisk(): void {
  const readersRoot = join(MIND_ROOT, "readers");
  if (!existsSync(readersRoot)) return;

  for (const typeDir of readdirSync(readersRoot)) {
    const typePath = join(readersRoot, typeDir);
    try {
      const _stat = Bun.file(typePath);
      // Skip if not a directory-like path (we check by listing)
      const files = readdirSync(typePath);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const registry = readJSONFile<ReaderRegistry>(join(typePath, file));
        if (registry) {
          const topic = file.replace(/\.json$/, "");
          readerRegistries.set(`${typeDir}/${topic}`, registry);
        }
      }
    } catch {
      // Not a directory or unreadable, skip
    }
  }
}

function loadWatchesFromDisk(): void {
  const watchesRoot = join(MIND_ROOT, "watches");
  if (!existsSync(watchesRoot)) return;

  for (const file of readdirSync(watchesRoot)) {
    if (!file.endsWith(".json")) continue;
    const agent = file.replace(/\.json$/, "");
    const watches = readJSONFile<WatchEntry[]>(join(watchesRoot, file));
    if (watches && Array.isArray(watches)) {
      watchCache.set(agent, watches);
    }
  }
}

async function flushReaderRegistry(type: string, topic: string): Promise<void> {
  const key = registryKey(type, topic);
  const registry = readerRegistries.get(key);
  if (!registry) return;
  const dir = join(MIND_ROOT, "readers", `${type}s`);
  await atomicWrite(dir, `${topic}.json`, registry);
}

async function flushWatches(agent: string): Promise<void> {
  const watches = watchCache.get(agent);
  if (!watches) return;
  const dir = join(MIND_ROOT, "watches");
  await atomicWrite(dir, `${agent}.json`, watches);
}

// ---------------------------------------------------------------------------
// Notify stale readers
// ---------------------------------------------------------------------------

async function notifyStaleReaders(
  type: string,
  topic: string,
  newVersion: number,
  author: string,
  breaking: boolean,
): Promise<void> {
  const key = registryKey(type, topic);
  const registry = readerRegistries.get(key);
  if (!registry) return;

  for (const reader of registry.readers) {
    if (reader.read_version < newVersion && reader.agent !== author) {
      const priority: InboxPriority = breaking ? "alert" : "info";
      await writeInboxMessage(reader.agent, {
        from: "hive-mind",
        type: "mind-update",
        priority,
        topic: `${type}s/${topic}`,
        content: `${type} "${topic}" updated to v${newVersion} by ${author}${breaking ? " [BREAKING]" : ""}`,
        old_version: reader.read_version,
        new_version: newVersion,
      });
      await nudgeWorker(reader.agent, breaking ? "alert" : "info");
      await pushDiscordNotification(
        reader.agent,
        `${type}s/${topic}`,
        newVersion,
        breaking ?? false,
        `${type}s/${topic} updated to v${newVersion}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Resolve matching watches on publish
// ---------------------------------------------------------------------------

async function resolveWatchesForTopic(type: string, topic: string): Promise<void> {
  for (const [agent, watches] of watchCache.entries()) {
    let changed = false;
    for (const w of watches) {
      if (w.status === "waiting" && w.type === type && w.topic === topic) {
        w.status = "resolved";
        w.resolved_at = new Date().toISOString();
        changed = true;

        await writeInboxMessage(agent, {
          from: "hive-mind",
          type: "watch-resolved",
          priority: "response",
          topic: `${type}s/${topic}`,
          content: `Watch resolved: ${type} "${topic}" is now available`,
        });
        await nudgeWorker(agent, "response");
        await pushDiscordNotification(
          agent,
          `${type}s/${topic}`,
          0,
          false,
          `${type}s/${topic} is now available (watch resolved)`,
        );
      }
    }
    if (changed) {
      await flushWatches(agent);
    }
  }
}

// ---------------------------------------------------------------------------
// Delta processing
// ---------------------------------------------------------------------------

async function processDelta(delta: DeltaFile): Promise<void> {
  const { action, target_type: type, target_topic: topic, agent } = delta;

  switch (action) {
    case "publish": {
      const cPath = canonicalPath(type, topic);
      const existing = readJSONFile<MindEntry>(cPath);
      const version = existing ? existing.version + 1 : 1;

      const entry: MindEntry = {
        author: agent,
        version,
        content: delta.content,
        updated: new Date().toISOString(),
        tags: delta.tags ?? [],
      };

      ensureDir(canonicalDir(type));
      await atomicWrite(canonicalDir(type), `${topic}.json`, entry);

      // Update reader registry version
      const key = registryKey(type, topic);
      const reg = readerRegistries.get(key);
      if (reg) {
        reg.version = version;
      }

      await notifyStaleReaders(type, topic, version, agent, delta.breaking ?? false);
      await resolveWatchesForTopic(type, topic);

      appendChangelog({
        timestamp: new Date().toISOString(),
        agent,
        action: "publish",
        type,
        topic,
        version,
        breaking: delta.breaking ?? false,
      });
      break;
    }

    case "update": {
      const cPath = canonicalPath(type, topic);
      const existing = readJSONFile<MindEntry>(cPath);

      if (!existing) {
        // Treat as publish if nothing exists
        const entry: MindEntry = {
          author: agent,
          version: 1,
          content: delta.content,
          updated: new Date().toISOString(),
          tags: delta.tags ?? [],
        };
        ensureDir(canonicalDir(type));
        await atomicWrite(canonicalDir(type), `${topic}.json`, entry);

        appendChangelog({
          timestamp: new Date().toISOString(),
          agent,
          action: "update",
          type,
          topic,
          version: 1,
          breaking: delta.breaking ?? false,
        });
        break;
      }

      const newVersion = existing.version + 1;

      // Optimistic concurrency check
      if (delta.version_expecting !== undefined && delta.version_expecting !== existing.version) {
        await writeInboxMessage(agent, {
          from: "hive-mind",
          type: "conflict",
          priority: "alert",
          topic: `${type}s/${topic}`,
          content: `Version conflict on ${type} "${topic}": you expected v${delta.version_expecting} but current is v${existing.version}. Your changes were applied (last-writer-wins) as v${newVersion}.`,
          old_version: existing.version,
          new_version: newVersion,
        });
        await nudgeWorker(agent, "alert");
      }

      // Last-writer-wins merge
      const updated: MindEntry = {
        ...existing,
        author: agent,
        version: newVersion,
        content: delta.content ?? existing.content,
        updated: new Date().toISOString(),
        tags: delta.tags ?? existing.tags,
      };

      await atomicWrite(canonicalDir(type), `${topic}.json`, updated);

      // Update reader registry version
      const key = registryKey(type, topic);
      const reg = readerRegistries.get(key);
      if (reg) {
        reg.version = newVersion;
      }

      await notifyStaleReaders(type, topic, newVersion, agent, delta.breaking ?? false);

      appendChangelog({
        timestamp: new Date().toISOString(),
        agent,
        action: "update",
        type,
        topic,
        version: newVersion,
        breaking: delta.breaking ?? false,
      });
      break;
    }

    case "retract": {
      const cPath = canonicalPath(type, topic);
      const existing = readJSONFile<MindEntry>(cPath);
      if (!existing) break; // Nothing to retract

      const retracted: MindEntry = {
        ...existing,
        retracted: true,
        retracted_at: new Date().toISOString(),
        retracted_by: agent,
      };

      await atomicWrite(canonicalDir(type), `${topic}.json`, retracted);

      await notifyStaleReaders(type, topic, existing.version, agent, delta.breaking ?? false);

      appendChangelog({
        timestamp: new Date().toISOString(),
        agent,
        action: "retract",
        type,
        topic,
        version: existing.version,
        breaking: delta.breaking ?? false,
      });
      break;
    }

    case "register-reader": {
      const key = registryKey(type, topic);
      let registry = readerRegistries.get(key);

      // Determine current version from canonical file
      const cPath = canonicalPath(type, topic);
      const existing = readJSONFile<MindEntry>(cPath);
      const currentVersion = existing?.version ?? 0;

      if (!registry) {
        registry = {
          topic,
          type: `${type}s`,
          version: currentVersion,
          readers: [],
        };
        readerRegistries.set(key, registry);
      }

      const readVersion = delta.reader?.read_version ?? currentVersion;

      // Update or add reader entry
      const existingReader = registry.readers.find((r) => r.agent === agent);
      if (existingReader) {
        existingReader.read_version = readVersion;
        existingReader.read_at = new Date().toISOString();
      } else {
        const entry: ReaderEntry = {
          agent,
          read_version: readVersion,
          read_at: new Date().toISOString(),
        };
        registry.readers.push(entry);
      }

      await flushReaderRegistry(type, topic);
      break;
    }

    case "register-watch": {
      if (!delta.watch) break;

      const watches = watchCache.get(agent) ?? [];

      // Check if already watching this topic
      const existingIdx = watches.findIndex(
        (w) => w.topic === delta.watch?.topic && w.type === delta.watch?.type,
      );
      if (existingIdx >= 0) {
        watches[existingIdx] = delta.watch;
      } else {
        watches.push(delta.watch);
      }
      watchCache.set(agent, watches);
      await flushWatches(agent);

      // Check if canonical file already exists — resolve immediately
      const cPath = canonicalPath(type, topic);
      if (existsSync(cPath)) {
        const entry = readJSONFile<MindEntry>(cPath);
        if (entry && !entry.retracted) {
          delta.watch.status = "resolved";
          delta.watch.resolved_at = new Date().toISOString();
          await flushWatches(agent);

          await writeInboxMessage(agent, {
            from: "hive-mind",
            type: "watch-resolved",
            priority: "response",
            topic: `${type}s/${topic}`,
            content: `Watch resolved: ${type} "${topic}" already exists (v${entry.version})`,
          });
          await nudgeWorker(agent, "response");
        }
      }
      break;
    }
  }
}

async function processAllPending(): Promise<void> {
  if (processing) return;
  processing = true;

  try {
    const dir = pendingDir();
    if (!existsSync(dir)) {
      return;
    }

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"))
      .sort(); // Timestamp order by filename convention

    for (const file of files) {
      if (shuttingDown) break;

      const filePath = join(dir, file);
      let delta: DeltaFile;

      // Parse delta
      try {
        const raw = readFileSync(filePath, "utf-8");
        delta = JSON.parse(raw) as DeltaFile;
      } catch (err) {
        process.stderr.write(
          `[hive-mind-daemon] Failed to parse ${file}: ${(err as Error).message}\n`,
        );
        ensureDir(failedDir());
        try {
          renameSync(filePath, join(failedDir(), file));
        } catch {
          // If rename fails, try to just remove it
          try {
            unlinkSync(filePath);
          } catch {
            /* abandon */
          }
        }
        continue;
      }

      // Acquire per-topic mutex
      const mutexKey = `${delta.target_type}/${delta.target_topic}`;
      const existingMutex = topicMutexes.get(mutexKey) ?? Promise.resolve();

      const newMutex = existingMutex.then(async () => {
        try {
          await processDelta(delta);
          // Delete processed file
          try {
            unlinkSync(filePath);
          } catch {
            // File may have been removed already
          }
        } catch (err) {
          process.stderr.write(
            `[hive-mind-daemon] Error processing ${file}: ${(err as Error).message}\n`,
          );
          ensureDir(failedDir());
          try {
            renameSync(filePath, join(failedDir(), file));
          } catch {
            // Best effort
          }
        }
      });

      topicMutexes.set(mutexKey, newMutex);
      await newMutex;
    }

    // Update heartbeat after processing
    await updatePidFile();
  } finally {
    processing = false;
  }
}

// ---------------------------------------------------------------------------
// Manager name resolver
// ---------------------------------------------------------------------------

const HIVE_DIR = PROJECT_ROOT;

function resolveManagerName(): string {
  try {
    const agentsPath = join(process.env.HIVE_STATE_DIR ?? join(HIVE_DIR, "state"), "agents.json");
    const data = JSON.parse(readFileSync(agentsPath, "utf8")) as AgentsJson;
    const manager = data.agents.find((a) => a.role === "manager");
    return manager?.name ?? "manager";
  } catch {
    return "manager";
  }
}

// ---------------------------------------------------------------------------
// Watch monitor
// ---------------------------------------------------------------------------

async function runWatchMonitor(): Promise<void> {
  const now = Date.now();

  // Track how many workers are waiting per topic for systemic block detection
  const waitingPerTopic = new Map<string, string[]>();

  for (const [agent, watches] of watchCache.entries()) {
    for (const w of watches) {
      if (w.status !== "waiting") continue;

      const topicKey = `${w.type}s/${w.topic}`;

      // Check if canonical file now exists
      const cPath = canonicalPath(w.type, w.topic);
      if (existsSync(cPath)) {
        const entry = readJSONFile<MindEntry>(cPath);
        if (entry && !entry.retracted) {
          w.status = "resolved";
          w.resolved_at = new Date().toISOString();
          await flushWatches(agent);

          await writeInboxMessage(agent, {
            from: "hive-mind",
            type: "watch-resolved",
            priority: "response",
            topic: topicKey,
            content: `Watch resolved: ${w.type} "${w.topic}" is now available (v${entry.version})`,
          });
          await nudgeWorker(agent, "response");
          await pushDiscordNotification(
            agent,
            topicKey,
            entry.version,
            false,
            `${topicKey} is now available (watch resolved)`,
          );
          continue;
        }
      }

      const waitMs = now - new Date(w.since).getTime();

      // Track for systemic block detection
      if (!waitingPerTopic.has(topicKey)) {
        waitingPerTopic.set(topicKey, []);
      }
      waitingPerTopic.get(topicKey)?.push(agent);

      // Nudge after 15 minutes
      if (waitMs > WATCH_NUDGE_THRESHOLD_MS) {
        const lastNudge = nudgeTimestamps.get(topicKey) ?? 0;
        if (now - lastNudge < NUDGE_COOLDOWN_MS) continue; // Rate limited

        nudgeTimestamps.set(topicKey, now);

        if (w.expect_from) {
          await writeInboxMessage(w.expect_from, {
            from: "hive-mind",
            type: "nudge",
            priority: "alert",
            topic: topicKey,
            content: `${agent} is waiting on your ${w.type} "${w.topic}" — please publish when ready`,
          });
          await nudgeWorker(w.expect_from, "alert");
        } else {
          await writeInboxMessage(resolveManagerName(), {
            from: "hive-mind",
            type: "nudge",
            priority: "alert",
            topic: topicKey,
            content: `${agent} is waiting on ${w.type} "${w.topic}" but no expected publisher specified — please advise`,
          });
          await nudgeWorker(resolveManagerName(), "alert");
        }
      }
    }
  }

  // Systemic block detection: 2+ workers waiting >30 min on same topic
  for (const [topicKey, agents] of waitingPerTopic.entries()) {
    if (agents.length < 2) continue;

    // Check if all have been waiting >30 min
    let allLong = true;
    for (const agent of agents) {
      const watches = watchCache.get(agent) ?? [];
      const w = watches.find((w) => w.status === "waiting" && `${w.type}s/${w.topic}` === topicKey);
      if (!w || Date.now() - new Date(w.since).getTime() < WATCH_ALERT_THRESHOLD_MS) {
        allLong = false;
        break;
      }
    }

    if (allLong) {
      const lastNudge = nudgeTimestamps.get(`alert:${topicKey}`) ?? 0;
      if (Date.now() - lastNudge < NUDGE_COOLDOWN_MS) continue;

      nudgeTimestamps.set(`alert:${topicKey}`, Date.now());

      await writeInboxMessage(resolveManagerName(), {
        from: "hive-mind",
        type: "nudge",
        priority: "critical",
        topic: topicKey,
        content: `SYSTEMIC BLOCK: ${agents.length} workers (${agents.join(", ")}) waiting on ${topicKey} for 30+ min — possible decomposition issue`,
      });
      await nudgeWorker(resolveManagerName(), "critical");
      await pushDiscordNotification(
        resolveManagerName(),
        topicKey,
        0,
        true,
        `Systemic block: ${agents.length} agents waiting on ${topicKey} for >30m`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Git snapshot
// ---------------------------------------------------------------------------

function runGitSnapshot(): void {
  if (!changesSinceSnapshot) return;

  try {
    // Stage only durable knowledge directories
    const addResult = Bun.spawnSync({
      cmd: [
        "git",
        "add",
        join(MIND_ROOT, "contracts"),
        join(MIND_ROOT, "decisions"),
        join(MIND_ROOT, "agents"),
        join(MIND_ROOT, "changelog"),
      ],
      cwd: PROJECT_ROOT,
      stderr: "pipe",
    });

    if (addResult.exitCode !== 0) {
      // Nothing to add or git issue — skip
      return;
    }

    // Check if there are actually staged changes
    const diffResult = Bun.spawnSync({
      cmd: ["git", "diff", "--cached", "--quiet"],
      cwd: PROJECT_ROOT,
      stderr: "pipe",
    });

    if (diffResult.exitCode === 0) {
      // No staged changes
      changesSinceSnapshot = false;
      return;
    }

    const date = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const commitResult = Bun.spawnSync({
      cmd: ["git", "commit", "-m", `mind: snapshot ${date}`, "--no-verify"],
      cwd: PROJECT_ROOT,
      stderr: "pipe",
    });

    if (commitResult.exitCode === 0) {
      changesSinceSnapshot = false;
    } else {
      const stderr = commitResult.stderr.toString();
      if (stderr) {
        process.stderr.write(`[hive-mind-daemon] Git snapshot failed: ${stderr}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[hive-mind-daemon] Git snapshot error: ${(err as Error).message}\n`);
  }
}

// ---------------------------------------------------------------------------
// PID / heartbeat
// ---------------------------------------------------------------------------

async function writePidFile(): Promise<void> {
  const pid: DaemonPid = {
    pid: process.pid,
    started: new Date().toISOString(),
    lastActive: new Date().toISOString(),
  };
  ensureDir(join(MIND_ROOT));
  await Bun.write(pidFile(), JSON.stringify(pid, null, 2));
}

async function updatePidFile(): Promise<void> {
  const existing = readJSONFile<DaemonPid>(pidFile());
  if (!existing) return;
  existing.lastActive = new Date().toISOString();
  await Bun.write(pidFile(), JSON.stringify(existing, null, 2));
}

function removePidFile(): void {
  try {
    unlinkSync(pidFile());
  } catch {
    // Already gone
  }
}

// ---------------------------------------------------------------------------
// Ensure directory structure
// ---------------------------------------------------------------------------

function ensureMindDirs(): void {
  const dirs = [
    MIND_ROOT,
    join(MIND_ROOT, "contracts"),
    join(MIND_ROOT, "decisions"),
    join(MIND_ROOT, "pending"),
    join(MIND_ROOT, "pending", ".failed"),
    join(MIND_ROOT, "agents"),
    join(MIND_ROOT, "readers"),
    join(MIND_ROOT, "readers", "contracts"),
    join(MIND_ROOT, "readers", "decisions"),
    join(MIND_ROOT, "watches"),
    join(MIND_ROOT, "changelog"),
  ];
  for (const d of dirs) {
    ensureDir(d);
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function startup(): Promise<void> {
  console.log("[hive-mind-daemon] Starting...");

  // Ensure directory structure
  ensureMindDirs();

  // Write PID file
  await writePidFile();
  console.log(`[hive-mind-daemon] PID ${process.pid} written to ${pidFile()}`);

  // Load in-memory state from disk
  loadReadersFromDisk();
  loadWatchesFromDisk();

  const readerCount = readerRegistries.size;
  const watchCount = Array.from(watchCache.values()).reduce((n, ws) => n + ws.length, 0);
  console.log(`[hive-mind-daemon] Loaded ${readerCount} reader registries, ${watchCount} watches`);

  // Crash recovery: process any existing pending deltas
  await processAllPending();

  // Start fs.watch on pending/
  const pDir = pendingDir();
  try {
    pendingWatcher = fsWatch(pDir, { persistent: true }, (_event, _filename) => {
      // Debounce: just trigger processing
      if (!processing && !shuttingDown) {
        processAllPending().catch((err) => {
          process.stderr.write(`[hive-mind-daemon] Processing error: ${(err as Error).message}\n`);
        });
      }
    });
  } catch (err) {
    process.stderr.write(
      `[hive-mind-daemon] fs.watch failed, relying on polling: ${(err as Error).message}\n`,
    );
  }

  // Polling fallback (belt-and-suspenders)
  pollTimer = setInterval(() => {
    if (!shuttingDown) {
      processAllPending().catch((err) => {
        process.stderr.write(
          `[hive-mind-daemon] Poll processing error: ${(err as Error).message}\n`,
        );
      });
    }
  }, POLL_INTERVAL_MS);

  // Watch monitor
  watchMonitorTimer = setInterval(() => {
    if (!shuttingDown) {
      runWatchMonitor().catch((err) => {
        process.stderr.write(`[hive-mind-daemon] Watch monitor error: ${(err as Error).message}\n`);
      });
    }
  }, WATCH_MONITOR_INTERVAL_MS);

  // Git snapshot
  gitSnapshotTimer = setInterval(() => {
    if (!shuttingDown) {
      runGitSnapshot();
    }
  }, GIT_SNAPSHOT_INTERVAL_MS);

  // Heartbeat
  heartbeatTimer = setInterval(() => {
    if (!shuttingDown) {
      updatePidFile().catch(() => {});
    }
  }, HEARTBEAT_INTERVAL_MS);

  console.log("[hive-mind-daemon] Running — watching for deltas");
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("[hive-mind-daemon] Shutting down...");

  // Stop watchers and timers
  if (pendingWatcher) {
    pendingWatcher.close();
    pendingWatcher = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (watchMonitorTimer) {
    clearInterval(watchMonitorTimer);
    watchMonitorTimer = null;
  }
  if (gitSnapshotTimer) {
    clearInterval(gitSnapshotTimer);
    gitSnapshotTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // Drain remaining pending deltas
  processing = false; // Reset so processAllPending can run
  await processAllPending();

  // Final git snapshot
  changesSinceSnapshot = true; // Force check
  runGitSnapshot();

  // Remove PID file
  removePidFile();

  console.log("[hive-mind-daemon] Shutdown complete");
  process.exit(0);
}

// Register signal handlers
process.on("SIGTERM", () => {
  shutdown().catch((err) => {
    process.stderr.write(`[hive-mind-daemon] Shutdown error: ${(err as Error).message}\n`);
    process.exit(1);
  });
});

process.on("SIGINT", () => {
  shutdown().catch((err) => {
    process.stderr.write(`[hive-mind-daemon] Shutdown error: ${(err as Error).message}\n`);
    process.exit(1);
  });
});

// ---------------------------------------------------------------------------
// Run on import (daemon starts when this module is loaded)
// ---------------------------------------------------------------------------

startup().catch((err) => {
  process.stderr.write(`[hive-mind-daemon] Fatal startup error: ${(err as Error).message}\n`);
  process.exit(1);
});
