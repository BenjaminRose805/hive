/**
 * src/validate-tools.ts
 * Pre-flight validation for Hive MCP tool configuration.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve, join, basename } from "path";

const HIVE_ROOT = resolve(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const isTTY = process.stdout.isTTY;
const c = {
  green:  (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:    (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow: (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  bold:   (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
  dim:    (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
};
const ok   = c.green("✓");
const fail = c.red("✗");
const warn = c.yellow("⚠");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ToolDef {
  name: string;
  description?: string;
  command: string;
  args: string[];
  requiredEnv?: string[];
}

interface ToolProfile {
  role: string;
  description?: string;
  tools: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadJsonFiles<T>(dir: string): Array<{ file: string; data: T | null; error: string | null }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const file = join(dir, f);
      try {
        return { file, data: JSON.parse(readFileSync(file, "utf8")) as T, error: null };
      } catch (e: any) {
        return { file, data: null, error: e.message };
      }
    });
}

function parseSecretsEnv(filePath: string): Map<string, boolean> {
  // Returns key -> true for each KEY=VALUE line that has a non-empty value
  const result = new Map<string, boolean>();
  if (!existsSync(filePath)) return result;
  const lines = readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && val) result.set(key, true);
  }
  return result;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ---------------------------------------------------------------------------
// Main (exported for use by bin/hive)
// ---------------------------------------------------------------------------
export async function main(_args: string[]): Promise<void> {
  let structuralErrors = 0;

  // 1. Tool definitions
  // ---------------------------------------------------------------------------
  console.log(c.bold("\nTool Definitions (config/tools/):"));
  const toolsDir = join(HIVE_ROOT, "config", "tools");
  const toolEntries = loadJsonFiles<ToolDef>(toolsDir);
  const toolMap = new Map<string, ToolDef>();

  for (const entry of toolEntries) {
    const shortName = basename(entry.file, ".json");
    if (entry.error) {
      console.log(`  ${fail} ${c.red(shortName)} — parse error: ${entry.error}`);
      structuralErrors++;
      continue;
    }
    const d = entry.data!;
    const missing: string[] = [];
    if (!d.name)                              missing.push("name");
    if (!d.command)                           missing.push("command");
    if (!Array.isArray(d.args))               missing.push("args (array)");

    if (missing.length) {
      console.log(`  ${fail} ${c.red(shortName)} — missing fields: ${missing.join(", ")}`);
      structuralErrors++;
      continue;
    }

    toolMap.set(d.name, d);
    const reqLabel = d.requiredEnv?.length
      ? c.dim(` [requires: ${d.requiredEnv.join(", ")}]`)
      : "";
    const desc = d.description ? ` — ${c.dim(d.description)}` : "";
    console.log(`  ${ok} ${pad(d.name, 16)}${desc}${reqLabel}`);
  }

  if (toolEntries.length === 0) {
    console.log(`  ${warn} No tool definitions found in ${toolsDir}`);
  }

  // 2. Tool profiles
  // ---------------------------------------------------------------------------
  console.log(c.bold("\nRole Profiles (config/tool-profiles/):"));
  const profilesDir = join(HIVE_ROOT, "config", "tool-profiles");
  const profileEntries = loadJsonFiles<ToolProfile>(profilesDir);
  const profileMap = new Map<string, ToolProfile>();

  for (const entry of profileEntries) {
    const shortName = basename(entry.file, ".json");
    if (entry.error) {
      console.log(`  ${fail} ${c.red(shortName)} — parse error: ${entry.error}`);
      structuralErrors++;
      continue;
    }
    const p = entry.data!;
    const missing: string[] = [];
    if (!p.role)                            missing.push("role");
    if (!Array.isArray(p.tools))            missing.push("tools (array)");

    if (missing.length) {
      console.log(`  ${fail} ${c.red(shortName)} — missing fields: ${missing.join(", ")}`);
      structuralErrors++;
      continue;
    }

    // Verify referenced tools exist
    const unknownTools = p.tools.filter(t => !toolMap.has(t));
    if (unknownTools.length) {
      console.log(`  ${fail} ${c.red(p.role)} — references unknown tools: ${unknownTools.join(", ")}`);
      structuralErrors++;
      continue;
    }

    profileMap.set(p.role, p);
    console.log(`  ${ok} ${pad(p.role, 20)} → ${p.tools.join(", ")}`);
  }

  if (profileEntries.length === 0) {
    console.log(`  ${warn} No tool profiles found in ${profilesDir}`);
  }

  // 3. Secrets
  // ---------------------------------------------------------------------------
  console.log(c.bold("\nSecrets Status:"));
  const secretsPath = join(HIVE_ROOT, "config", "secrets.env");
  const secretsEnv = parseSecretsEnv(secretsPath);
  const secretsPresent = existsSync(secretsPath);

  if (!secretsPresent) {
    console.log(`  ${warn} config/secrets.env not found (copy from secrets.env.example)`);
  }

  // Collect all unique requiredEnv across all tools
  const allRequiredEnvs = new Set<string>();
  for (const tool of toolMap.values()) {
    for (const e of tool.requiredEnv ?? []) allRequiredEnvs.add(e);
  }

  const secretStatus = new Map<string, "secrets.env" | "process.env" | "missing">();
  for (const key of allRequiredEnvs) {
    if (secretsEnv.has(key)) {
      secretStatus.set(key, "secrets.env");
    } else if (process.env[key]) {
      secretStatus.set(key, "process.env");
    } else {
      secretStatus.set(key, "missing");
    }
  }

  if (secretStatus.size === 0) {
    console.log(`  ${c.dim("(no tools require secrets)")}`);
  } else {
    for (const [key, status] of secretStatus) {
      if (status === "secrets.env") {
        console.log(`  ${ok} ${pad(key, 20)} — available (from secrets.env)`);
      } else if (status === "process.env") {
        console.log(`  ${ok} ${pad(key, 20)} — available (from env)`);
      } else {
        console.log(`  ${fail} ${c.red(pad(key, 20))} — missing`);
      }
    }
  }

  // 4. Agent readiness (cross-reference profiles × secrets)
  // ---------------------------------------------------------------------------
  console.log(c.bold("\nAgent Readiness:"));
  for (const [role, profile] of profileMap) {
    const issues: string[] = [];
    for (const toolName of profile.tools) {
      const tool = toolMap.get(toolName)!;
      for (const envKey of tool.requiredEnv ?? []) {
        const status = secretStatus.get(envKey);
        if (status === "missing") {
          issues.push(`${toolName}: missing ${envKey}`);
        }
      }
    }
    const total = profile.tools.length;
    const ready = profile.tools.filter(t => {
      const tool = toolMap.get(t)!;
      return (tool.requiredEnv ?? []).every(e => secretStatus.get(e) !== "missing");
    }).length;

    if (issues.length === 0) {
      console.log(`  ${ok} ${pad(role, 20)} → ${ready}/${total} tools ready`);
    } else {
      const detail = issues.map(i => c.yellow(i)).join("; ");
      console.log(`  ${warn} ${pad(role, 20)} → ${ready}/${total} tools ready (${detail})`);
    }
  }

  // 5. Role coverage (prompt profiles vs tool profiles)
  // ---------------------------------------------------------------------------
  console.log(c.bold("\nRole Coverage:"));
  const promptProfilesDir = join(HIVE_ROOT, "config", "prompts", "profiles");
  let promptRoles: string[] = [];

  if (existsSync(promptProfilesDir)) {
    promptRoles = readdirSync(promptProfilesDir)
      .filter(f => f.endsWith(".md") && !f.startsWith("_"))
      .map(f => basename(f, ".md"));
  }

  const missingToolProfiles = promptRoles.filter(r => !profileMap.has(r));

  if (missingToolProfiles.length === 0 && promptRoles.length > 0) {
    console.log(`  ${ok} All prompt profiles have matching tool profiles`);
  } else if (missingToolProfiles.length > 0) {
    console.log(`  ${warn} Missing tool profiles for: ${missingToolProfiles.map(r => c.yellow(r)).join(", ")}`);
  } else {
    console.log(`  ${c.dim("(no prompt profiles found to compare)")}`);
  }

  // ---------------------------------------------------------------------------
  // Final exit
  // ---------------------------------------------------------------------------
  console.log("");
  if (structuralErrors > 0) {
    console.log(c.red(c.bold(`Validation failed — ${structuralErrors} structural error(s) found.`)));
    process.exit(1);
  } else {
    console.log(c.green(c.bold("Validation passed.")));
    process.exit(0);
  }
}
