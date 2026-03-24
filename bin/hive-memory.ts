#!/usr/bin/env bun
/**
 * hive-memory.ts — Persistent agent memory management
 *
 * Subcommands:
 *   save  --agent <name> --type <context|preferences|history|knowledge> --data '<json>' | stdin
 *   load  --agent <name>  — outputs formatted prompt block for --append-system-prompt
 *   view  [--agent <name>]  — pretty-prints memory; without --agent lists all agents
 *   clear --agent <name> [--type <type>]  — clears all or a specific memory file
 *   list  — lists all agents with memory data and file sizes
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_CAP = 50;
const VALID_TYPES = ["context", "preferences", "history", "knowledge"] as const;
type MemoryType = (typeof VALID_TYPES)[number];

// Resolve paths relative to the hive project root (one level up from bin/)
const SCRIPT_DIR = import.meta.dir;
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const STATE_AGENTS_DIR = join(PROJECT_ROOT, "state", "agents");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function memoryDir(agentName: string): string {
  return join(STATE_AGENTS_DIR, agentName, "memory");
}

function memoryFile(agentName: string, type: MemoryType): string {
  return join(memoryDir(agentName), `${type}.json`);
}

function ensureMemoryDir(agentName: string): void {
  const dir = memoryDir(agentName);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readMemoryFile(agentName: string, type: MemoryType): unknown {
  const file = memoryFile(agentName, type);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf-8");
    if (!raw || raw.trim() === "") return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeMemoryFile(agentName: string, type: MemoryType, data: unknown): void {
  ensureMemoryDir(agentName);
  const file = memoryFile(agentName, type);
  Bun.write(file, JSON.stringify(data, null, 2));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  subcommand: string;
  agent?: string;
  type?: MemoryType;
  data?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip 'bun' and script path
  const subcommand = args[0] ?? "";
  let agent: string | undefined;
  let type: MemoryType | undefined;
  let data: string | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--agent" && args[i + 1]) {
      agent = args[++i];
    } else if (arg === "--type" && args[i + 1]) {
      const t = args[++i];
      if (VALID_TYPES.includes(t as MemoryType)) {
        type = t as MemoryType;
      } else {
        console.error(`Error: Invalid type "${t}". Must be one of: ${VALID_TYPES.join(", ")}`);
        process.exit(1);
      }
    } else if (arg === "--data" && args[i + 1]) {
      data = args[++i];
    }
  }

  return { subcommand, agent, type, data };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** save — write memory data for an agent */
async function cmdSave(args: ParsedArgs): Promise<void> {
  if (!args.agent) {
    console.error("Error: --agent <name> is required for save");
    process.exit(1);
  }
  if (!args.type) {
    console.error("Error: --type <context|preferences|history|knowledge> is required for save");
    process.exit(1);
  }

  let rawData = args.data;

  // If no --data flag, read from stdin
  if (!rawData) {
    rawData = await new Response(Bun.stdin.stream()).text();
  }

  if (!rawData || rawData.trim() === "") {
    console.error("Error: No data provided (use --data or pipe JSON to stdin)");
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch (e) {
    console.error(`Error: Invalid JSON data: ${(e as Error).message}`);
    process.exit(1);
  }

  // History cap enforcement
  if (args.type === "history") {
    const existing = readMemoryFile(args.agent, "history");
    let entries: unknown[] = Array.isArray(existing) ? existing : [];

    // New data can be a single entry (object) or an array of entries
    const incoming = Array.isArray(parsed) ? parsed : [parsed];
    entries = [...entries, ...incoming];

    // Prune oldest entries beyond cap
    if (entries.length > HISTORY_CAP) {
      entries = entries.slice(entries.length - HISTORY_CAP);
    }

    writeMemoryFile(args.agent, "history", entries);
    console.log(
      `Saved ${incoming.length} history entry(entries) for agent "${args.agent}" (total: ${entries.length}, cap: ${HISTORY_CAP})`
    );
    return;
  }

  writeMemoryFile(args.agent, args.type, parsed);
  console.log(`Saved ${args.type} memory for agent "${args.agent}"`);
}

/** load — output a formatted prompt block for injection into system prompt */
function cmdLoad(args: ParsedArgs): void {
  if (!args.agent) {
    console.error("Error: --agent <name> is required for load");
    process.exit(1);
  }

  const name = args.agent;
  const dir = memoryDir(name);

  // Empty-state: no memory directory or all files missing/empty
  if (!existsSync(dir)) {
    console.log(emptyMemoryBlock(name));
    return;
  }

  const context = readMemoryFile(name, "context") as Record<string, unknown> | null;
  const preferences = readMemoryFile(name, "preferences") as Record<string, unknown> | null;
  const history = readMemoryFile(name, "history") as unknown[] | null;
  const knowledge = readMemoryFile(name, "knowledge") as unknown[] | null;

  const hasAny = context || preferences || history || knowledge;
  if (!hasAny) {
    console.log(emptyMemoryBlock(name));
    return;
  }

  const lines: string[] = [];
  lines.push("--- MEMORY RESTORATION ---");
  lines.push(`You are resuming as "${name}". Here is what you remember:`);
  lines.push("");

  // Last Session from context
  lines.push("## Last Session");
  if (context) {
    const task = (context as Record<string, unknown>).lastTask ?? (context as Record<string, unknown>).lastWorkedOn ?? null;
    const branch = (context as Record<string, unknown>).lastBranch ?? null;
    const outcome = (context as Record<string, unknown>).outcome ?? null;
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
    const knownFiles = (context as Record<string, unknown>).knownFiles;
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
    const discoveries = (context as Record<string, unknown>).discoveries;
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
    const questions = (context as Record<string, unknown>).openQuestions;
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
    const codingStyle = (preferences as Record<string, unknown>).codingStyle ?? null;
    const testingApproach = (preferences as Record<string, unknown>).testingApproach ?? null;
    const communicationStyle = (preferences as Record<string, unknown>).communicationStyle ?? null;
    const tools = (preferences as Record<string, unknown>).tools ?? null;
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

  // Knowledge
  lines.push("## Knowledge");
  if (Array.isArray(knowledge) && knowledge.length > 0) {
    for (const fact of knowledge) {
      if (typeof fact === "object" && fact !== null) {
        const f = fact as Record<string, unknown>;
        const text = f.fact ?? f.text ?? f.content ?? JSON.stringify(fact);
        const source = f.source ? ` [source: ${f.source}]` : "";
        lines.push(`- ${text}${source}`);
      } else {
        lines.push(`- ${fact}`);
      }
    }
  } else {
    lines.push("(none recorded)");
  }
  lines.push("");

  // Recent History (last 3 entries)
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

  lines.push("--- END MEMORY ---");
  console.log(lines.join("\n"));
}

function emptyMemoryBlock(name: string): string {
  return [
    "--- MEMORY RESTORATION ---",
    `You are resuming as "${name}". This is your first session — no prior memory.`,
    "--- END MEMORY ---",
  ].join("\n");
}

/** view — pretty-print memory contents for one or all agents */
function cmdView(args: ParsedArgs): void {
  if (args.agent) {
    // View a specific agent's memory
    const dir = memoryDir(args.agent);
    if (!existsSync(dir)) {
      console.log(`No memory found for agent "${args.agent}"`);
      return;
    }

    console.log(`\n=== Memory for agent: ${args.agent} ===\n`);
    for (const type of VALID_TYPES) {
      const data = readMemoryFile(args.agent, type);
      if (data !== null) {
        console.log(`--- ${type}.json ---`);
        console.log(JSON.stringify(data, null, 2));
        console.log("");
      } else {
        console.log(`--- ${type}.json --- (empty)`);
        console.log("");
      }
    }
  } else {
    // List all agents with memory
    if (!existsSync(STATE_AGENTS_DIR)) {
      console.log("No agents with memory found (state/agents/ does not exist)");
      return;
    }

    const entries = readdirSync(STATE_AGENTS_DIR, { withFileTypes: true });
    const agentsWithMemory: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dir = join(STATE_AGENTS_DIR, entry.name, "memory");
        if (existsSync(dir)) {
          agentsWithMemory.push(entry.name);
        }
      }
    }

    if (agentsWithMemory.length === 0) {
      console.log("No agents with memory found");
      return;
    }

    console.log(`\nAgents with memory (${agentsWithMemory.length}):\n`);
    for (const name of agentsWithMemory.sort()) {
      const dir = memoryDir(name);
      let totalSize = 0;
      const fileSummary: string[] = [];
      for (const type of VALID_TYPES) {
        const file = join(dir, `${type}.json`);
        if (existsSync(file)) {
          const size = fileSize(file);
          totalSize += size;
          fileSummary.push(`${type}: ${formatBytes(size)}`);
        }
      }
      console.log(`  ${name} — total: ${formatBytes(totalSize)} [${fileSummary.join(", ")}]`);
    }
    console.log("");
  }
}

/** clear — remove memory files for an agent */
function cmdClear(args: ParsedArgs): void {
  if (!args.agent) {
    console.error("Error: --agent <name> is required for clear");
    process.exit(1);
  }

  const dir = memoryDir(args.agent);
  if (!existsSync(dir)) {
    console.log(`No memory found for agent "${args.agent}" — nothing to clear`);
    return;
  }

  if (args.type) {
    // Clear a specific memory type
    const file = memoryFile(args.agent, args.type);
    if (existsSync(file)) {
      Bun.write(file, "");
      console.log(`Cleared ${args.type} memory for agent "${args.agent}"`);
    } else {
      console.log(`No ${args.type} memory found for agent "${args.agent}" — nothing to clear`);
    }
  } else {
    // Clear all memory files
    let cleared = 0;
    for (const type of VALID_TYPES) {
      const file = memoryFile(args.agent, type);
      if (existsSync(file)) {
        Bun.write(file, "");
        cleared++;
      }
    }
    console.log(`Cleared all memory for agent "${args.agent}" (${cleared} file(s) cleared)`);
  }
}

/** list — list all agents with memory data and file sizes */
function cmdList(): void {
  if (!existsSync(STATE_AGENTS_DIR)) {
    console.log("No agents with memory found (state/agents/ does not exist)");
    return;
  }

  const entries = readdirSync(STATE_AGENTS_DIR, { withFileTypes: true });
  const rows: Array<{ name: string; files: string[]; totalSize: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(STATE_AGENTS_DIR, entry.name, "memory");
    if (!existsSync(dir)) continue;

    let totalSize = 0;
    const files: string[] = [];
    for (const type of VALID_TYPES) {
      const file = join(dir, `${type}.json`);
      if (existsSync(file)) {
        const size = fileSize(file);
        if (size > 0) {
          totalSize += size;
          files.push(`${type}(${formatBytes(size)})`);
        }
      }
    }

    if (files.length > 0 || existsSync(dir)) {
      rows.push({ name: entry.name, files, totalSize });
    }
  }

  if (rows.length === 0) {
    console.log("No agents with memory data found");
    return;
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`\nAgents with memory data (${rows.length}):\n`);
  console.log("  NAME                 FILES                                    TOTAL");
  console.log("  " + "-".repeat(70));
  for (const row of rows) {
    const nameCol = row.name.padEnd(20);
    const filesCol = (row.files.length > 0 ? row.files.join(", ") : "(empty dir)").padEnd(40);
    const sizeCol = formatBytes(row.totalSize);
    console.log(`  ${nameCol} ${filesCol} ${sizeCol}`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  switch (args.subcommand) {
    case "save":
      await cmdSave(args);
      break;
    case "load":
      cmdLoad(args);
      break;
    case "view":
      cmdView(args);
      break;
    case "clear":
      cmdClear(args);
      break;
    case "list":
      cmdList();
      break;
    default:
      console.error(
        `Usage: bun run bin/hive-memory.ts <save|load|view|clear|list> [options]

Subcommands:
  save  --agent <name> --type <context|preferences|history|knowledge> [--data '<json>']
  load  --agent <name>
  view  [--agent <name>]
  clear --agent <name> [--type <type>]
  list`
      );
      if (args.subcommand) {
        console.error(`\nUnknown subcommand: "${args.subcommand}"`);
        process.exit(1);
      }
      process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
