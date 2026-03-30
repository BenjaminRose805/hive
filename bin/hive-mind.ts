#!/usr/bin/env bun
/**
 * hive-mind.ts — Hive Mind CLI: shared knowledge, contracts, decisions, and messaging
 *
 * Subcommands:
 *   publish      --type contract|decision --topic <name> --agent <name> --data '<json>' [--breaking] [--tags t1,t2]
 *   read         --type contract|decision --topic <name> --agent <name>
 *   list         --type contracts|decisions [--author <name>]
 *   load         --agent <name>
 *   save         --agent <name> --type context|preferences|history --data '<json>'
 *   clear        --agent <name> [--type <type>]
 *   view         --agent <name>
 */

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CliError, DeltaFile, MindEntry } from "../src/mind/mind-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_CAP = 50;
const VALID_SAVE_TYPES = ["context", "preferences", "history"] as const;
type SaveType = (typeof VALID_SAVE_TYPES)[number];

const VALID_ENTRY_TYPES = ["contract", "decision"] as const;
type EntryType = (typeof VALID_ENTRY_TYPES)[number];

const TOPIC_RE = /^[a-z0-9-]+$/;
const TOPIC_MAX = 64;
const AGENT_RE = /^[a-z0-9-]+$/;
const AGENT_MAX = 32;

// Resolve paths relative to the hive project root (one level up from bin/)
const SCRIPT_DIR = import.meta.dir;
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const MIND_ROOT = join(PROJECT_ROOT, ".hive", "mind");

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function cliError(error: string, code: number, detail: string): never {
  const err: CliError = { error, code, detail };
  process.stderr.write(`${JSON.stringify(err)}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateAgent(agent: string | undefined): string {
  if (!agent) cliError("missing_agent", 1, "--agent <name> is required");
  if (!AGENT_RE.test(agent) || agent.length > AGENT_MAX) {
    cliError("invalid_agent", 1, `Agent name must match [a-z0-9-] and be 1-${AGENT_MAX} chars`);
  }
  return agent;
}

function validateTopic(topic: string | undefined): string {
  if (!topic) cliError("missing_topic", 1, "--topic <name> is required");
  if (!TOPIC_RE.test(topic) || topic.length > TOPIC_MAX) {
    cliError("invalid_topic", 1, `Topic must match [a-z0-9-] and be 1-${TOPIC_MAX} chars`);
  }
  return topic;
}

function validateEntryType(type: string | undefined): EntryType {
  if (!type) cliError("missing_type", 1, "--type contract|decision is required");
  // Allow plural forms for convenience, normalize to singular
  const normalized = type.replace(/s$/, "") as EntryType;
  if (!VALID_ENTRY_TYPES.includes(normalized)) {
    cliError("invalid_type", 1, `--type must be "contract" or "decision", got "${type}"`);
  }
  return normalized;
}

function validateJSON(data: string | undefined): unknown {
  if (!data) cliError("missing_data", 1, "--data <json> is required");
  try {
    return JSON.parse(data);
  } catch (e) {
    cliError("invalid_json", 1, `Invalid JSON: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

import { atomicWrite, readJSONFile } from "../src/mind/fs-utils.ts";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function pendingDir(): string {
  return join(MIND_ROOT, "pending");
}

function typesDir(type: EntryType): string {
  return join(MIND_ROOT, `${type}s`);
}

function canonicalPath(type: EntryType, topic: string): string {
  return join(typesDir(type), `${topic}.json`);
}

function agentDir(agent: string): string {
  return join(MIND_ROOT, "agents", agent);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  subcommand: string;
  agent?: string;
  type?: string;
  topic?: string;
  data?: string;
  breaking?: boolean;
  tags?: string[];
  to?: string;
  from?: string;
  markRead?: boolean;
  unreadOnly?: boolean;
  author?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip 'bun' and script path
  const subcommand = args[0] ?? "";
  const result: ParsedArgs = { subcommand };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--agent":
        result.agent = args[++i];
        break;
      case "--type":
        result.type = args[++i];
        break;
      case "--topic":
        result.topic = args[++i];
        break;
      case "--data":
        result.data = args[++i];
        break;
      case "--breaking":
        result.breaking = true;
        break;
      case "--tags":
        result.tags = (args[++i] ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        break;
      case "--to":
        result.to = args[++i];
        break;
      case "--from":
        result.from = args[++i];
        break;
      case "--mark-read":
        result.markRead = true;
        break;
      case "--unread-only":
        result.unreadOnly = true;
        break;
      case "--author":
        result.author = args[++i];
        break;
      default:
        // Ignore unknown flags silently
        break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** publish — write a delta to pending/ */
async function cmdPublish(args: ParsedArgs): Promise<void> {
  const agent = validateAgent(args.agent);
  const type = validateEntryType(args.type);
  const topic = validateTopic(args.topic);
  const content = validateJSON(args.data);
  const tags = args.tags ?? [];
  const breaking = args.breaking ?? false;

  const delta: DeltaFile = {
    agent,
    action: "publish",
    target_type: type,
    target_topic: topic,
    content,
    tags,
    breaking,
  };

  const filename = `${Date.now()}-${agent}-publish.json`;
  await atomicWrite(pendingDir(), filename, delta);

  console.log(JSON.stringify({ status: "queued", delta: filename }));
}

/** read — read canonical file */
function cmdRead(args: ParsedArgs): void {
  const type = validateEntryType(args.type);
  const topic = validateTopic(args.topic);

  const filePath = canonicalPath(type, topic);
  const entry = readJSONFile(filePath) as MindEntry | null;

  if (!entry) {
    cliError("not_found", 2, `${type}s/${topic} not published`);
  }

  // Print the canonical entry to stdout
  console.log(JSON.stringify(entry, null, 2));
}

/** list — list all contracts or decisions */
function cmdList(args: ParsedArgs): void {
  // Accept plural or singular
  const rawType = args.type;
  if (!rawType) cliError("missing_type", 1, "--type contracts|decisions is required");

  // Normalize: ensure we get the plural directory name
  const singular = rawType.replace(/s$/, "") as EntryType;
  if (!VALID_ENTRY_TYPES.includes(singular)) {
    cliError("invalid_type", 1, `--type must be "contracts" or "decisions", got "${rawType}"`);
  }

  const dir = typesDir(singular);
  if (!existsSync(dir)) {
    console.log(`No ${singular}s found (directory does not exist)`);
    return;
  }

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.log(`No ${singular}s published yet`);
    return;
  }

  const entries: Array<{ topic: string; author: string; version: number; updated: string }> = [];
  for (const file of files) {
    const data = readJSONFile(join(dir, file)) as MindEntry | null;
    if (!data) continue;
    if (data.retracted) continue;
    const topic = file.replace(/\.json$/, "");
    if (args.author && data.author !== args.author) continue;
    entries.push({
      topic,
      author: data.author,
      version: data.version,
      updated: data.updated,
    });
  }

  if (entries.length === 0) {
    console.log(
      args.author
        ? `No ${singular}s found by author "${args.author}"`
        : `No ${singular}s published yet`,
    );
    return;
  }

  entries.sort((a, b) => a.topic.localeCompare(b.topic));

  console.log(`\n${singular.charAt(0).toUpperCase() + singular.slice(1)}s (${entries.length}):\n`);
  console.log("  TOPIC                          AUTHOR               VERSION  UPDATED");
  console.log(`  ${"-".repeat(78)}`);
  for (const e of entries) {
    const topicCol = e.topic.padEnd(30);
    const authorCol = e.author.padEnd(20);
    const versionCol = String(e.version).padEnd(8);
    const updatedCol = e.updated;
    console.log(`  ${topicCol} ${authorCol} ${versionCol} ${updatedCol}`);
  }
  console.log("");
}

/** load — generate system prompt section */
function cmdLoad(args: ParsedArgs): void {
  const agent = validateAgent(args.agent);
  const agDir = agentDir(agent);

  const lines: string[] = [];
  lines.push("--- MEMORY RESTORATION ---");
  lines.push(`You are resuming as "${agent}". Here is what you remember:`);
  lines.push("");

  // --- Personal context ---
  const context = readJSONFile(join(agDir, "context.json")) as Record<string, unknown> | null;
  const preferences = readJSONFile(join(agDir, "preferences.json")) as Record<
    string,
    unknown
  > | null;
  const history = readJSONFile(join(agDir, "history.json")) as unknown[] | null;

  lines.push("## Last Session");
  if (context) {
    const task = context.lastTask ?? context.lastWorkedOn ?? null;
    const branch = context.lastBranch ?? null;
    const outcome = context.outcome ?? null;
    if (task) lines.push(`Task: ${task}`);
    if (branch) lines.push(`Branch: ${branch}`);
    if (outcome) lines.push(`Outcome: ${outcome}`);
    if (!task && !branch && !outcome) lines.push("(context recorded — see full context below)");
  } else {
    lines.push("(no context recorded)");
  }
  lines.push("");

  // Known Files
  lines.push("## Known Files");
  if (context) {
    const knownFiles = context.knownFiles;
    if (Array.isArray(knownFiles) && knownFiles.length > 0) {
      for (const f of knownFiles) lines.push(`- ${f}`);
    } else {
      lines.push("(none recorded)");
    }
  } else {
    lines.push("(none recorded)");
  }
  lines.push("");

  // Discoveries
  lines.push("## Discoveries");
  if (context) {
    const discoveries = context.discoveries;
    if (Array.isArray(discoveries) && discoveries.length > 0) {
      for (const d of discoveries) lines.push(`- ${d}`);
    } else {
      lines.push("(none recorded)");
    }
  } else {
    lines.push("(none recorded)");
  }
  lines.push("");

  // Open Questions
  lines.push("## Open Questions");
  if (context) {
    const questions = context.openQuestions;
    if (Array.isArray(questions) && questions.length > 0) {
      for (const q of questions) lines.push(`- ${q}`);
    } else {
      lines.push("(none recorded)");
    }
  } else {
    lines.push("(none recorded)");
  }
  lines.push("");

  // Preferences
  lines.push("## Your Preferences");
  if (preferences) {
    const codingStyle = preferences.codingStyle ?? null;
    const testingApproach = preferences.testingApproach ?? null;
    const communicationStyle = preferences.communicationStyle ?? null;
    const tools = preferences.tools ?? null;
    if (codingStyle) lines.push(`Coding Style: ${codingStyle}`);
    if (testingApproach) lines.push(`Testing Approach: ${testingApproach}`);
    if (communicationStyle) lines.push(`Communication Style: ${communicationStyle}`);
    if (tools) {
      if (Array.isArray(tools)) {
        lines.push(`Preferred Tools: ${tools.join(", ")}`);
      } else {
        lines.push(`Preferred Tools: ${tools}`);
      }
    }
    if (!codingStyle && !testingApproach && !communicationStyle && !tools) {
      lines.push("(preferences recorded — see full preferences below)");
    }
  } else {
    lines.push("(none recorded)");
  }
  lines.push("");

  // Recent History (last 3)
  if (Array.isArray(history) && history.length > 0) {
    lines.push("## Recent Task History");
    const recent = history.slice(-3);
    for (const entry of recent) {
      if (typeof entry === "object" && entry !== null) {
        const e = entry as Record<string, unknown>;
        const task = e.task ?? e.description ?? "(unknown task)";
        const outcome = e.outcome ?? e.result ?? "(unknown outcome)";
        const date = e.date ?? e.timestamp ?? e.completedAt ?? null;
        lines.push(`- Task: ${task} | Outcome: ${outcome}${date ? ` | Date: ${date}` : ""}`);
      }
    }
    lines.push("");
  }

  // --- Hive Mind sections ---

  // Recently published by this agent
  lines.push("## Your Published Items");
  let hasPublished = false;
  for (const entryType of VALID_ENTRY_TYPES) {
    const dir = typesDir(entryType);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const entry = readJSONFile(join(dir, file)) as MindEntry | null;
      if (!entry || entry.author !== agent || entry.retracted) continue;
      const topic = file.replace(/\.json$/, "");
      lines.push(`- ${entryType}/${topic} v${entry.version} (updated ${entry.updated})`);
      hasPublished = true;
    }
  }
  if (!hasPublished) {
    lines.push("(none published)");
  }
  lines.push("");

  // Hive Mind overview — all published contracts/decisions for team awareness
  lines.push("## Hive Mind Overview");
  let overviewCount = 0;
  for (const entryType of VALID_ENTRY_TYPES) {
    const dir = typesDir(entryType);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const entry = readJSONFile(join(dir, file)) as MindEntry | null;
      if (!entry || entry.retracted) continue;
      const topic = file.replace(/\.json$/, "");
      const tags = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
      lines.push(`- ${entryType}/${topic} by ${entry.author} v${entry.version}${tags}`);
      overviewCount++;
    }
  }
  if (overviewCount === 0) {
    lines.push("(no contracts or decisions published yet)");
  }
  lines.push("");

  lines.push("--- END MEMORY ---");
  console.log(lines.join("\n"));
}

/** save — write to agents/{name}/{type}.json */
async function cmdSave(args: ParsedArgs): Promise<void> {
  const agent = validateAgent(args.agent);
  const type = args.type;
  if (!type || !VALID_SAVE_TYPES.includes(type as SaveType)) {
    cliError("invalid_type", 1, `--type must be one of: ${VALID_SAVE_TYPES.join(", ")}`);
  }
  const saveType = type as SaveType;

  let rawData = args.data;
  if (!rawData) {
    rawData = await new Response(Bun.stdin.stream()).text();
  }
  if (!rawData || rawData.trim() === "") {
    cliError("missing_data", 1, "No data provided (use --data or pipe JSON to stdin)");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch (e) {
    cliError("invalid_json", 1, `Invalid JSON: ${(e as Error).message}`);
  }

  const dir = agentDir(agent);

  // History cap enforcement
  if (saveType === "history") {
    const existing = readJSONFile(join(dir, "history.json"));
    let entries: unknown[] = Array.isArray(existing) ? existing : [];
    const incoming = Array.isArray(parsed) ? parsed : [parsed];
    entries = [...entries, ...incoming];
    if (entries.length > HISTORY_CAP) {
      entries = entries.slice(entries.length - HISTORY_CAP);
    }
    await atomicWrite(dir, "history.json", entries);
    console.log(
      `Saved ${incoming.length} history entry(ies) for agent "${agent}" (total: ${entries.length}, cap: ${HISTORY_CAP})`,
    );
    return;
  }

  await atomicWrite(dir, `${saveType}.json`, parsed);
  console.log(`Saved ${saveType} for agent "${agent}"`);
}

/** clear — remove agent's personal context files */
function cmdClear(args: ParsedArgs): void {
  const agent = validateAgent(args.agent);
  const dir = agentDir(agent);

  if (!existsSync(dir)) {
    console.log(`No mind data found for agent "${agent}" — nothing to clear`);
    return;
  }

  if (args.type) {
    const validType = args.type as SaveType;
    if (!VALID_SAVE_TYPES.includes(validType)) {
      cliError("invalid_type", 1, `--type must be one of: ${VALID_SAVE_TYPES.join(", ")}`);
    }
    const file = join(dir, `${validType}.json`);
    if (existsSync(file)) {
      unlinkSync(file);
      console.log(`Cleared ${validType} for agent "${agent}"`);
    } else {
      console.log(`No ${validType} found for agent "${agent}" — nothing to clear`);
    }
  } else {
    let cleared = 0;
    for (const t of VALID_SAVE_TYPES) {
      const file = join(dir, `${t}.json`);
      if (existsSync(file)) {
        unlinkSync(file);
        cleared++;
      }
    }
    console.log(`Cleared all mind data for agent "${agent}" (${cleared} file(s) removed)`);
  }
}

/** view — pretty-print mind state for an agent */
function cmdView(args: ParsedArgs): void {
  const agent = validateAgent(args.agent);
  const dir = agentDir(agent);

  console.log(`\n=== Mind State for agent: ${agent} ===\n`);

  // Personal context files
  console.log("--- Personal Context ---");
  for (const t of VALID_SAVE_TYPES) {
    const file = join(dir, `${t}.json`);
    const data = readJSONFile(file);
    if (data !== null) {
      console.log(`\n  ${t}.json:`);
      console.log(`  ${JSON.stringify(data, null, 2).split("\n").join("\n  ")}`);
    } else {
      console.log(`\n  ${t}.json: (empty)`);
    }
  }
  console.log("");

  // Published items
  console.log("--- Published Items ---");
  let hasItems = false;
  for (const entryType of VALID_ENTRY_TYPES) {
    const typeDir = typesDir(entryType);
    if (!existsSync(typeDir)) continue;
    const files = readdirSync(typeDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const entry = readJSONFile(join(typeDir, file)) as MindEntry | null;
      if (!entry || entry.author !== agent) continue;
      const topic = file.replace(/\.json$/, "");
      const retracted = entry.retracted ? " [RETRACTED]" : "";
      console.log(`  ${entryType}/${topic} v${entry.version}${retracted} — ${entry.updated}`);
      hasItems = true;
    }
  }
  if (!hasItems) {
    console.log("  (none published)");
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  switch (args.subcommand) {
    case "publish":
      await cmdPublish(args);
      break;
    case "read":
      cmdRead(args);
      break;
    case "list":
      cmdList(args);
      break;
    case "load":
      cmdLoad(args);
      break;
    case "save":
      await cmdSave(args);
      break;
    case "clear":
      cmdClear(args);
      break;
    case "view":
      cmdView(args);
      break;
    case "daemon":
      await import("../src/mind/daemon.ts");
      break;
    default:
      console.error(
        `Usage: bun run bin/hive-mind.ts <command> [options]

Commands:
  publish       --type contract|decision --topic <name> --agent <name> --data '<json>' [--breaking] [--tags t1,t2]
  read          --type contract|decision --topic <name> --agent <name>
  list          --type contracts|decisions [--author <name>]
  load          --agent <name>
  save          --agent <name> --type context|preferences|history --data '<json>'
  clear         --agent <name> [--type <type>]
  view          --agent <name>
  daemon        Start the Hive Mind daemon process`,
      );
      if (args.subcommand) {
        console.error(`\nUnknown command: "${args.subcommand}"`);
        process.exit(1);
      }
      process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
