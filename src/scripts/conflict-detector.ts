/**
 * conflict-detector.ts — Background conflict detection for Hive agent branches.
 *
 * Periodically compares active agent branches against a target branch to detect
 * file-level conflicts. Writes results to stdout (structured JSON) and to
 * state/conflicts.json for gateway relay.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../shared/subprocess.ts";
import type { AgentEntry, AgentsJson } from "../shared/agent-types.ts";
import { NO_WORKTREE_ROLES } from "../shared/agent-types.ts";
import { getAgentsJsonPath, getStateDir, HIVE_DIR } from "../shared/paths.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentBranch {
  name: string;
  branch: string;
}

export interface ConflictRecord {
  type: "conflict";
  agents: string[];
  files: string[];
  moduleOwners: string[];
  detectedAt: string;
}

interface ScopeFile {
  agent: string;
  taskId?: string;
  allowed: string[];
  shared?: string[];
}

// ---------------------------------------------------------------------------
// Core detection logic
// ---------------------------------------------------------------------------

/**
 * Get the list of files changed by a branch relative to target.
 * Uses three-dot diff so we compare from the common ancestor.
 */
export function getBranchChangedFiles(
  repo: string,
  branch: string,
  target: string,
): string[] {
  const result = run(["git", "diff", "--name-only", `${target}...${branch}`], { cwd: repo });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout ? result.stdout.split("\n").filter(Boolean) : [];
}

/**
 * Check whether two branches actually conflict on a specific file using
 * merge-tree (no working-tree side effects).
 */
export function hasActualConflict(
  repo: string,
  branchA: string,
  branchB: string,
  target: string,
): boolean {
  // Find merge base between the two branches
  const baseResult = run(["git", "merge-base", branchA, branchB], { cwd: repo });
  if (baseResult.exitCode !== 0 || !baseResult.stdout) {
    // Fall back to target as base
    const targetShaResult = run(["git", "rev-parse", target], { cwd: repo });
    if (targetShaResult.exitCode !== 0) return false;
  }

  const base = baseResult.exitCode === 0 && baseResult.stdout
    ? baseResult.stdout
    : run(["git", "rev-parse", target], { cwd: repo }).stdout;

  if (!base) return false;

  // git merge-tree exits non-zero and prints conflict markers when there are conflicts
  const mergeResult = run(["git", "merge-tree", base, branchA, branchB], { cwd: repo });
  return mergeResult.stdout.includes("<<<<<<");
}

/**
 * Find files changed by 2+ agents, and for overlapping files check if they
 * actually conflict via three-way merge simulation.
 *
 * Returns an array of conflict records (one per conflicting agent pair).
 */
export function findOverlappingFiles(
  repo: string,
  agents: AgentBranch[],
  target: string,
): Array<{ agentA: AgentBranch; agentB: AgentBranch; files: string[] }> {
  // Build map: agent -> changed files
  const agentFiles = new Map<string, string[]>();
  for (const agent of agents) {
    const exists = run(["git", "rev-parse", "--verify", `refs/heads/${agent.branch}`], {
      cwd: repo,
    });
    if (exists.exitCode !== 0) {
      // Also try without refs/heads/ (for remote tracking etc.)
      const existsAlt = run(["git", "rev-parse", "--verify", agent.branch], { cwd: repo });
      if (existsAlt.exitCode !== 0) continue;
    }
    const files = getBranchChangedFiles(repo, agent.branch, target);
    if (files.length > 0) {
      agentFiles.set(agent.name, files);
    }
  }

  const results: Array<{ agentA: AgentBranch; agentB: AgentBranch; files: string[] }> = [];

  // Check all pairs
  const agentList = agents.filter((a) => agentFiles.has(a.name));
  for (let i = 0; i < agentList.length; i++) {
    for (let j = i + 1; j < agentList.length; j++) {
      const a = agentList[i];
      const b = agentList[j];
      const filesA = agentFiles.get(a.name) ?? [];
      const filesB = agentFiles.get(b.name) ?? [];

      // Find overlapping files
      const setB = new Set(filesB);
      const overlap = filesA.filter((f) => setB.has(f));

      if (overlap.length === 0) continue;

      // Verify actual conflict via merge-tree
      if (hasActualConflict(repo, a.branch, b.branch, target)) {
        results.push({ agentA: a, agentB: b, files: overlap });
      }
    }
  }

  return results;
}

/**
 * Match a file path against a glob-style pattern.
 * Supports `**` (any depth), `*` (any segment), and `?` (single char).
 */
function matchGlob(file: string, pattern: string): boolean {
  // Convert glob to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials except * and ?
    .replace(/\*\*/g, "\x00") // placeholder for **
    .replace(/\*/g, "[^/]*") // * -> any non-slash
    .replace(/\?/g, "[^/]") // ? -> single non-slash
    .replace(/\x00/g, ".*"); // ** -> any (including slashes)
  try {
    return new RegExp(`^${escaped}$`).test(file);
  } catch {
    return false;
  }
}

/**
 * Find which agents own which conflicting files by reading scope/*.json files.
 * Returns a unique list of owner agent names.
 */
export function lookupModuleOwners(conflictFiles: string[], hiveDir: string): string[] {
  const scopeDir = join(hiveDir, ".hive", "scope");
  if (!existsSync(scopeDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(scopeDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const owners = new Set<string>();

  for (const entry of entries) {
    let scope: ScopeFile;
    try {
      scope = JSON.parse(readFileSync(join(scopeDir, entry), "utf8")) as ScopeFile;
    } catch {
      continue;
    }

    if (!scope.agent || !Array.isArray(scope.allowed)) continue;

    for (const file of conflictFiles) {
      for (const pattern of scope.allowed) {
        if (matchGlob(file, pattern)) {
          owners.add(scope.agent);
          break;
        }
      }
    }
  }

  return Array.from(owners);
}

/**
 * Read active agent branches from agents.json, filtering out no-worktree roles.
 */
export function readActiveAgents(agentsJsonPath: string): AgentBranch[] {
  if (!existsSync(agentsJsonPath)) return [];

  let data: AgentsJson;
  try {
    data = JSON.parse(readFileSync(agentsJsonPath, "utf8")) as AgentsJson;
  } catch {
    return [];
  }

  return (data.agents ?? [])
    .filter((a: AgentEntry) => {
      if (!a.name) return false;
      if (a.role && NO_WORKTREE_ROLES.has(a.role)) return false;
      return true;
    })
    .map((a: AgentEntry) => ({
      name: a.name,
      branch: a.branch ?? `hive/core/${a.name}`,
    }));
}

// ---------------------------------------------------------------------------
// Main detection function
// ---------------------------------------------------------------------------

/**
 * Run one round of conflict detection across all active agent branches.
 * Returns the list of conflicts found (empty if none).
 */
export async function detectConflicts(
  repo: string,
  target: string,
  outputPath?: string,
): Promise<ConflictRecord[]> {
  const agentsJsonPath = getAgentsJsonPath();
  const agents = readActiveAgents(agentsJsonPath);

  if (agents.length < 2) {
    return [];
  }

  const pairs = findOverlappingFiles(repo, agents, target);
  if (pairs.length === 0) {
    return [];
  }

  const hiveDir = HIVE_DIR;
  const conflicts: ConflictRecord[] = [];

  for (const pair of pairs) {
    const moduleOwners = lookupModuleOwners(pair.files, hiveDir);
    const record: ConflictRecord = {
      type: "conflict",
      agents: [pair.agentA.name, pair.agentB.name],
      files: pair.files,
      moduleOwners,
      detectedAt: new Date().toISOString(),
    };
    conflicts.push(record);
  }

  if (conflicts.length > 0) {
    // Write to stdout for parent process consumption
    for (const c of conflicts) {
      process.stdout.write(JSON.stringify(c) + "\n");
    }

    // Write to state/conflicts.json for gateway relay
    const dest = outputPath ?? join(getStateDir(), "conflicts.json");
    writeFileSync(dest, JSON.stringify(conflicts, null, 2));
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

interface CliArgs {
  repo: string;
  target: string;
  interval: number | null;
  output: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  let repo = "";
  let target = "master";
  let interval: number | null = null;
  let output: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--repo":
        repo = argv[++i] ?? "";
        break;
      case "--target":
        target = argv[++i] ?? "master";
        break;
      case "--interval":
        interval = Number.parseInt(argv[++i] ?? "0", 10) || null;
        break;
      case "--output":
        output = argv[++i] ?? null;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: conflict-detector.ts --repo PATH [--target BRANCH] [--interval SECONDS] [--output PATH]",
        );
        process.exit(0);
      default:
        console.error(`ERROR: Unknown option: ${argv[i]}`);
        console.error("Run with --help for usage.");
        process.exit(1);
    }
  }

  if (!repo) {
    console.error("ERROR: --repo is required");
    process.exit(1);
  }

  return { repo, target, interval, output };
}

export async function main(args: string[]): Promise<void> {
  const { repo, target, interval, output } = parseArgs(args);

  const run_ = () =>
    detectConflicts(repo, target, output ?? undefined).catch((err) => {
      process.stderr.write(`ERROR: ${(err as Error).message}\n`);
    });

  if (interval && interval > 0) {
    // Run once immediately, then on interval
    await run_();
    setInterval(run_, interval * 1000);
  } else {
    await run_();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  });
}
