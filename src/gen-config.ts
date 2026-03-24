/**
 * src/gen-config.ts
 * Generates per-worker and manager configuration files for a Hive Discord orchestration setup.
 * Uses single-bot gateway mode with one Discord bot for all sessions.
 * Supports named agents (--agents) or numeric workers (--workers N).
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { execSync } from "child_process";
import type { AgentEntry, AgentsJson } from './shared/agent-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Args {
  workers: number;
  agentNames: string[] | null;   // null = use numeric worker-NN names
  agentRoles: Map<string, string>;
  channelId: string;
  token: string;
  botId: string;
  projectRepo: string | null;
  branchPrefix: string;
  branchPrefixExplicit: boolean;  // was --branch-prefix explicitly set?
  budget: number;
  toolOverrides: Map<string, ToolOverride>;
  help: boolean;
}

interface AccessJson {
  dmPolicy: "disabled" | "enabled";
  allowFrom: string[];
  groups: Record<string, { requireMention: boolean; allowFrom: string[] }>;
  pending: Record<string, never>;
  mentionPatterns: string[];
}

interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface McpConfigJson {
  mcpServers: Record<string, McpServerEntry>;
}

interface ToolDefinition {
  name: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  requiredEnv: string[];
}

interface ToolProfile {
  role: string;
  description?: string;
  tools: string[];
}

interface ToolOverride {
  mode: "add" | "remove" | "replace";
  tools: string[];
}

interface GatewayWorkerConfig {
  workerId: string;
  socketPath: string;
  mentionPatterns: string[];
  requireMention: boolean;
}

interface GatewayConfigJson {
  botToken: string;
  botId: string;
  channelId: string;
  socketPath: string;
  workers: GatewayWorkerConfig[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIVE_ROOT = resolve(import.meta.dir, "..");
const DISCORD_PLUGIN_PATH = process.env.DISCORD_PLUGIN_PATH
  ?? join(process.env.HOME ?? "", ".claude/plugins/cache/claude-plugins-official/discord/0.0.1");

const RESERVED_NAMES = new Set(["manager", "gateway", "all-workers", "all-agents", "hive"]);
const AGENT_NAME_RE = /^[a-zA-Z0-9-]{1,32}$/;

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
hive-gen-config — Generate per-worker configuration files for Hive

USAGE
  bun run src/gen-config.ts [OPTIONS]

AGENT NAMING
  --agents <names>          Comma-separated agent names (e.g. alice,bob,carol).
                            Overrides --workers N. Names must be alphanumeric +
                            hyphens, 1-32 chars. Reserved: manager, gateway,
                            all-workers, all-agents, hive.
  --roles <name:role,...>   Optional role assignments (e.g. alice:developer,bob:qa).
  --workers N               Number of workers using auto-names worker-01..NN (default: 3).
                            Ignored when --agents is provided.

OPTIONS
  --channel-id <snowflake>  Discord channel ID used for communication (required)
  --token <string>          Bot token (required)
  --bot-id <string>         Bot user ID (optional — auto-discovered at runtime)
  --project-repo <path>     Git repo path to create worktrees from (optional)
  --branch-prefix <string>  Branch name prefix for worktrees.
                            Default: "hive/" when --agents is used,
                                     "hive/worker-" when --workers N is used.
  --budget <number>         USD budget per worker (default: 5)
  --help                    Show this help message

OUTPUT STRUCTURE
  state/
    agents.json
    gateway/
      config.json
    manager/
      access.json
      mcp-config.json
    workers/
      <name>/
        access.json
        mcp-config.json

  worktrees/
    <name>/                  (if --project-repo is provided)

EXAMPLES
  # Named agents
  bun run src/gen-config.ts \\
    --agents alice,bob,carol \\
    --roles alice:developer,bob:backend-dev,carol:qa-engineer \\
    --token "Bot MySecretToken" \\
    --channel-id 1234567890123456789

  # Numeric workers
  bun run src/gen-config.ts \\
    --token "Bot MySecretToken" \\
    --channel-id 1234567890123456789 \\
    --workers 3
`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const args: Args = {
    workers: 3,
    agentNames: null,
    agentRoles: new Map(),
    channelId: "",
    token: "",
    botId: "",
    projectRepo: null,
    branchPrefix: "hive/worker-",
    branchPrefixExplicit: false,
    budget: 5,
    toolOverrides: new Map(),
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    switch (flag) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--workers":
        args.workers = parseInt(argv[++i], 10);
        break;
      case "--agents": {
        const names = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
        args.agentNames = names;
        break;
      }
      case "--roles": {
        const pairs = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
        for (const pair of pairs) {
          const colon = pair.indexOf(":");
          if (colon === -1) {
            console.error(`ERROR: Invalid --roles entry "${pair}". Expected format: name:role`);
            process.exit(1);
          }
          const name = pair.slice(0, colon).trim();
          const role = pair.slice(colon + 1).trim();
          if (name && role) {
            args.agentRoles.set(name, role);
          }
        }
        break;
      }
      case "--channel-id":
        args.channelId = argv[++i];
        break;
      case "--token":
        args.token = argv[++i];
        break;
      case "--bot-id":
        args.botId = argv[++i];
        break;
      case "--project-repo":
        args.projectRepo = argv[++i];
        break;
      case "--branch-prefix":
        args.branchPrefix = argv[++i];
        args.branchPrefixExplicit = true;
        break;
      case "--budget":
        args.budget = parseFloat(argv[++i]);
        break;
      case "--tools": {
        const specs = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
        for (const spec of specs) {
          const colon = spec.indexOf(":");
          if (colon === -1) {
            console.error(`ERROR: Invalid --tools entry "${spec}". Expected format: name:+tool1+tool2`);
            process.exit(1);
          }
          const agentName = spec.slice(0, colon).trim();
          let toolSpec = spec.slice(colon + 1).trim();

          let mode: "add" | "remove" | "replace" = "add";
          if (toolSpec.startsWith("=")) {
            mode = "replace";
            toolSpec = toolSpec.slice(1);
          } else if (toolSpec.startsWith("-")) {
            mode = "remove";
            toolSpec = toolSpec.slice(1);
          } else if (toolSpec.startsWith("+")) {
            toolSpec = toolSpec.slice(1);
          }
          // else: bare names default to "add"

          const tools = toolSpec.split("+").map(s => s.trim()).filter(Boolean);
          args.toolOverrides.set(agentName, { mode, tools });
        }
        break;
      }
      default:
        console.error(`Unknown argument: ${flag}`);
        process.exit(1);
    }
    i++;
  }

  return args;
}

// ---------------------------------------------------------------------------
// Agent name validation
// ---------------------------------------------------------------------------

function validateAgentNames(names: string[]): void {
  for (const name of names) {
    if (!AGENT_NAME_RE.test(name)) {
      console.error(
        `ERROR: Invalid agent name "${name}". Names must be alphanumeric + hyphens only, 1-32 characters.`
      );
      process.exit(1);
    }
    if (RESERVED_NAMES.has(name.toLowerCase())) {
      console.error(
        `ERROR: Agent name "${name}" is reserved. Reserved names: ${[...RESERVED_NAMES].join(", ")}`
      );
      process.exit(1);
    }
  }

  // Check for duplicates
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name.toLowerCase())) {
      console.error(`ERROR: Duplicate agent name "${name}".`);
      process.exit(1);
    }
    seen.add(name.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// Resolve effective agent list + branch prefix
// ---------------------------------------------------------------------------

function resolveAgents(args: Args): { names: string[]; branchPrefix: string } {
  let names: string[];

  if (args.agentNames !== null) {
    // Named mode: validate provided names
    validateAgentNames(args.agentNames);
    names = args.agentNames;
    // Derive worker count from names list
    args.workers = names.length;
  } else {
    // Numeric mode: auto-generate worker-01, worker-02, ...
    names = [];
    for (let n = 1; n <= args.workers; n++) {
      names.push(`worker-${workerLabel(n, args.workers)}`);
    }
  }

  // Determine branch prefix
  let branchPrefix: string;
  if (args.branchPrefixExplicit) {
    branchPrefix = args.branchPrefix;
  } else if (args.agentNames !== null) {
    // Named mode default: "hive/" → produces "hive/alice"
    branchPrefix = "hive/";
  } else {
    // Numeric mode default: "hive/worker-" → produces "hive/worker-01"
    branchPrefix = "hive/worker-";
  }

  return { names, branchPrefix };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(args: Args): void {
  const errors: string[] = [];

  if (!args.channelId) errors.push("--channel-id is required");
  if (!args.token) errors.push("--token is required");
  // --bot-id is optional — the gateway discovers it at runtime from client.user.id
  if (isNaN(args.workers) || args.workers < 1) errors.push("--workers must be a positive integer");

  if (errors.length > 0) {
    for (const e of errors) console.error(`ERROR: ${e}`);
    console.error("\nRun with --help for usage.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Zero-padded worker label (used only for numeric mode)
// ---------------------------------------------------------------------------

function workerLabel(n: number, total: number): string {
  const digits = String(total).length;
  return String(n).padStart(Math.max(digits, 2), "0");
}

// ---------------------------------------------------------------------------
// File writers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function loadToolDefinitions(toolsDir: string): Map<string, ToolDefinition> {
  const defs = new Map<string, ToolDefinition>();
  if (!existsSync(toolsDir)) return defs;

  const files = readdirSync(toolsDir).filter(f => f.endsWith(".json"));
  for (const file of files) {
    try {
      const raw = readFileSync(join(toolsDir, file), "utf-8");
      const def = JSON.parse(raw) as ToolDefinition;
      if (!def.name || !def.command || !Array.isArray(def.args)) {
        console.warn(`  WARN  Skipping malformed tool definition: ${file}`);
        continue;
      }
      defs.set(def.name, def);
    } catch (err) {
      console.warn(`  WARN  Failed to parse tool definition ${file}: ${err}`);
    }
  }
  return defs;
}

function loadToolProfile(profilesDir: string, role: string): ToolProfile {
  // Try role-specific profile first
  const rolePath = join(profilesDir, `${role}.json`);
  if (existsSync(rolePath)) {
    try {
      const raw = readFileSync(rolePath, "utf-8");
      return JSON.parse(raw) as ToolProfile;
    } catch (err) {
      console.warn(`  WARN  Failed to parse tool profile for role '${role}': ${err}`);
    }
  }

  // Fall back to _base.json
  const defaultPath = join(profilesDir, "_base.json");
  if (existsSync(defaultPath)) {
    try {
      const raw = readFileSync(defaultPath, "utf-8");
      const profile = JSON.parse(raw) as ToolProfile;
      console.warn(`  WARN  No tool profile for role '${role}' — using _base`);
      return profile;
    } catch (err) {
      console.warn(`  WARN  Failed to parse _base tool profile: ${err}`);
    }
  }

  // No profiles at all — discord only
  return { role, tools: [] };
}

function loadSecrets(secretsPath: string): Record<string, string> {
  const secrets: Record<string, string> = {};
  if (!existsSync(secretsPath)) return secrets;

  const content = readFileSync(secretsPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key) secrets[key] = value;
  }
  return secrets;
}

function interpolateEnv(
  env: Record<string, string>,
  secrets: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value.replace(/\$\{(\w+)\}/g, (_, varName) => {
      return secrets[varName] ?? process.env[varName] ?? `\${${varName}}`;
    });
  }
  return result;
}

function resolveToolsForRole(
  role: string,
  agentName: string,
  toolDefs: Map<string, ToolDefinition>,
  profilesDir: string,
  secrets: Record<string, string>,
  toolOverrides: Map<string, ToolOverride>
): Record<string, McpServerEntry> {
  const profile = loadToolProfile(profilesDir, role);
  let toolNames = [...profile.tools];

  // Apply overrides if present
  const override = toolOverrides.get(agentName);
  if (override) {
    switch (override.mode) {
      case "replace":
        console.log(`  TOOLS  Agent ${agentName}: replacing role '${role}' tools [${toolNames.join(", ")}] with [${override.tools.join(", ")}]`);
        toolNames = [...override.tools];
        break;
      case "add":
        console.log(`  TOOLS  Agent ${agentName}: adding [${override.tools.join(", ")}] to role '${role}' tools [${toolNames.join(", ")}]`);
        toolNames = [...toolNames, ...override.tools.filter(t => !toolNames.includes(t))];
        break;
      case "remove":
        console.log(`  TOOLS  Agent ${agentName}: removing [${override.tools.join(", ")}] from role '${role}' tools [${toolNames.join(", ")}]`);
        toolNames = toolNames.filter(t => !override.tools.includes(t));
        break;
    }
  }

  const result: Record<string, McpServerEntry> = {};

  for (const toolName of toolNames) {
    const def = toolDefs.get(toolName);
    if (!def) {
      console.warn(`  WARN  Tool '${toolName}' referenced by role '${role}' not found in config/tools/ — skipping`);
      continue;
    }

    // Check required env vars
    const resolvedEnv = interpolateEnv(def.env, secrets);
    const missingEnv = def.requiredEnv.filter(varName => {
      const val = secrets[varName] ?? process.env[varName];
      return !val;
    });

    if (missingEnv.length > 0) {
      console.warn(`  WARN  Tool '${toolName}' skipped for agent '${agentName}': missing required env vars: ${missingEnv.join(", ")}`);
      continue;
    }

    result[toolName] = {
      command: def.command,
      args: [...def.args],
      env: resolvedEnv,
    };
  }

  if (Object.keys(result).length > 0) {
    console.log(`  TOOLS  Agent ${agentName} (${role}): ${Object.keys(result).join(", ")}`);
  }

  return result;
}

function buildRelayMcpConfig(
  stateDir: string,
  workerId: string,
  workerSocketPath: string,
  channelId: string,
  mentionPatterns: string,
  requireMention: boolean,
  roleTools?: Record<string, McpServerEntry>
): McpConfigJson {
  return {
    mcpServers: {
      discord: {
        command: "bun",
        args: [
          "run",
          "--cwd",
          DISCORD_PLUGIN_PATH,
          "--shell=bun",
          "--silent",
          "start",
        ],
        env: {
          DISCORD_STATE_DIR: stateDir,
          DISCORD_ACCESS_MODE: "static",
          HIVE_GATEWAY_SOCKET: "/tmp/hive-gateway/gateway.sock",
          HIVE_WORKER_ID: workerId,
          HIVE_WORKER_PORT: workerSocketPath,
          HIVE_CHANNEL_ID: channelId,
          HIVE_MENTION_PATTERNS: mentionPatterns,
          HIVE_REQUIRE_MENTION: requireMention ? "true" : "false",
        },
      },
      ...(roleTools ?? {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Worktree management
// ---------------------------------------------------------------------------

function addWorktree(
  projectRepo: string,
  worktreePath: string,
  branch: string
): void {
  if (existsSync(worktreePath)) {
    console.warn(`  SKIP  Worktree already exists: ${worktreePath}`);
    return;
  }

  // Check if branch already exists in the repo
  let branchExists = false;
  try {
    execSync(`git -C "${projectRepo}" rev-parse --verify "${branch}"`, {
      stdio: "pipe",
    });
    branchExists = true;
  } catch {
    branchExists = false;
  }

  try {
    if (branchExists) {
      execSync(
        `git -C "${projectRepo}" worktree add "${worktreePath}" "${branch}"`,
        { stdio: "pipe" }
      );
    } else {
      execSync(
        `git -C "${projectRepo}" worktree add -b "${branch}" "${worktreePath}"`,
        { stdio: "pipe" }
      );
    }
    console.log(`  CREATE  Worktree: ${worktreePath} (branch: ${branch})`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ERROR   Failed to create worktree ${worktreePath}: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// agents.json management
// ---------------------------------------------------------------------------

function loadOrCreateAgentsJson(agentsPath: string): AgentsJson {
  if (existsSync(agentsPath)) {
    try {
      const raw = readFileSync(agentsPath, "utf-8");
      return JSON.parse(raw) as AgentsJson;
    } catch {
      console.warn(`  WARN  Could not parse existing state/agents.json — starting fresh.`);
    }
  }
  return { agents: [], created: new Date().toISOString(), mode: "single-bot" };
}

function mergeAgentsJson(
  existing: AgentsJson,
  newAgents: AgentEntry[]
): AgentsJson {
  const existingByName = new Map<string, AgentEntry>(
    existing.agents.map((a) => [a.name, a])
  );

  for (const agent of newAgents) {
    if (existingByName.has(agent.name)) {
      console.warn(`  WARN  Agent "${agent.name}" already exists in agents.json — preserving existing entry.`);
    } else {
      existingByName.set(agent.name, agent);
    }
  }

  return {
    agents: [...existingByName.values()],
    created: existing.created,
    mode: "single-bot" as const,
  };
}

function writeAgentsJson(
  stateRoot: string,
  agentNames: string[],
  agentRoles: Map<string, string>,
  agentsPath: string
): void {
  const now = new Date().toISOString();
  const newAgents: AgentEntry[] = agentNames.map((name) => ({
    name,
    role: agentRoles.get(name) ?? "developer",
    created: now,
    status: "configured",
  }));

  const existing = loadOrCreateAgentsJson(agentsPath);
  const merged = mergeAgentsJson(existing, newAgents);

  writeJson(agentsPath, merged);
  console.log(`  CREATE  state/agents.json`);
}

// ---------------------------------------------------------------------------
// Single-bot mode generation
// ---------------------------------------------------------------------------

function generateSingleBot(args: Args): void {
  const { names, branchPrefix } = resolveAgents(args);
  const stateRoot = join(HIVE_ROOT, "state");
  const worktreesRoot = join(HIVE_ROOT, "worktrees");

  // -------------------------------------------------------------------------
  // Load tool definitions and secrets
  // -------------------------------------------------------------------------

  const toolsDir = join(HIVE_ROOT, "config", "tools");
  const profilesDir = join(HIVE_ROOT, "config", "tool-profiles");
  const secretsPath = join(HIVE_ROOT, "config", "secrets.env");

  const toolDefs = loadToolDefinitions(toolsDir);
  const secrets = loadSecrets(secretsPath);

  if (toolDefs.size > 0) {
    console.log(`  TOOLS  Loaded ${toolDefs.size} tool definition(s): ${[...toolDefs.keys()].join(", ")}`);
  }

  // -------------------------------------------------------------------------
  // Build gateway worker list
  // -------------------------------------------------------------------------

  const gatewayWorkers: GatewayWorkerConfig[] = [
    {
      workerId: "manager",
      socketPath: "/tmp/hive-gateway/manager.sock",
      mentionPatterns: ["manager", "hive"],
      requireMention: false,
    },
  ];

  for (const name of names) {
    gatewayWorkers.push({
      workerId: name,
      socketPath: `/tmp/hive-gateway/${name}.sock`,
      mentionPatterns: [name, "all-workers"],
      requireMention: true,
    });
  }

  // -------------------------------------------------------------------------
  // Write gateway config
  // -------------------------------------------------------------------------

  const gatewayDir = join(stateRoot, "gateway");
  ensureDir(gatewayDir);

  const gatewayConfig: GatewayConfigJson = {
    botToken: args.token,
    botId: args.botId || "(auto-discovered at runtime)",
    channelId: args.channelId,
    socketPath: "/tmp/hive-gateway/gateway.sock",
    workers: gatewayWorkers,
  };

  writeJson(join(gatewayDir, "config.json"), gatewayConfig);
  console.log(`  CREATE  state/gateway/config.json`);

  // -------------------------------------------------------------------------
  // Generate manager config
  // -------------------------------------------------------------------------

  const managerStateDir = join(stateRoot, "manager");
  ensureDir(managerStateDir);

  const managerAccess: AccessJson = {
    dmPolicy: "disabled",
    allowFrom: [],
    groups: {
      [args.channelId]: {
        requireMention: false,
        allowFrom: [],
      },
    },
    pending: {},
    mentionPatterns: ["manager", "hive"],
  };

  const managerTools = resolveToolsForRole("manager", "manager", toolDefs, profilesDir, secrets, args.toolOverrides);

  writeJson(join(managerStateDir, "access.json"), managerAccess);
  writeJson(
    join(managerStateDir, "mcp-config.json"),
    buildRelayMcpConfig(
      managerStateDir,
      "manager",
      "/tmp/hive-gateway/manager.sock",
      args.channelId,
      "manager,hive",
      false,
      managerTools
    )
  );

  console.log(`  CREATE  state/manager/access.json`);
  console.log(`  CREATE  state/manager/mcp-config.json`);

  // -------------------------------------------------------------------------
  // Generate per-agent configs
  // -------------------------------------------------------------------------

  for (const name of names) {
    const workerDir = join(stateRoot, "workers", name);
    ensureDir(workerDir);

    const agentRole = args.agentRoles.get(name) ?? "developer";
    const roleTools = resolveToolsForRole(agentRole, name, toolDefs, profilesDir, secrets, args.toolOverrides);

    const workerAccess: AccessJson = {
      dmPolicy: "disabled",
      allowFrom: [],
      groups: {
        [args.channelId]: {
          requireMention: true,
          allowFrom: [],
        },
      },
      pending: {},
      mentionPatterns: [name, "all-workers"],
    };

    writeJson(join(workerDir, "access.json"), workerAccess);
    writeJson(
      join(workerDir, "mcp-config.json"),
      buildRelayMcpConfig(
        workerDir,
        name,
        `/tmp/hive-gateway/${name}.sock`,
        args.channelId,
        `${name},all-workers`,
        true,
        roleTools
      )
    );

    console.log(`  CREATE  state/workers/${name}/access.json`);
    console.log(`  CREATE  state/workers/${name}/mcp-config.json`);

    // Generate settings.json with scope enforcement hook
    const workerSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write|Edit|Bash',
            hooks: [
              {
                type: 'command',
                command: `node "${join(HIVE_ROOT, 'hooks', 'check-scope.mjs')}"`,
              },
            ],
          },
        ],
      },
    }
    writeFileSync(join(workerDir, 'settings.json'), JSON.stringify(workerSettings, null, 2))
    console.log(`  CREATE  state/workers/${name}/settings.json`);

    // -----------------------------------------------------------------------
    // Git worktree
    // -----------------------------------------------------------------------
    if (args.projectRepo) {
      const repoPath = resolve(args.projectRepo);
      const worktreePath = join(worktreesRoot, name);
      const branch = `${branchPrefix}${name}`;
      addWorktree(repoPath, worktreePath, branch);
    }
  }

  // -------------------------------------------------------------------------
  // Write agents.json
  // -------------------------------------------------------------------------

  const agentsPath = join(stateRoot, "agents.json");
  writeAgentsJson(stateRoot, names, args.agentRoles, agentsPath);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  console.log("");
  console.log("Done (single-bot mode). Summary:");
  console.log(`  Bot ID         : ${args.botId || "(auto-discovered at runtime)"}`);
  console.log(`  Agents         : ${names.join(", ")}`);
  console.log(`  Channel ID     : ${args.channelId}`);
  console.log(`  Budget/agent   : $${args.budget}`);
  console.log(`  State root     : ${stateRoot}`);
  console.log(`  Gateway config : ${join(gatewayDir, "config.json")}`);
  if (args.projectRepo) {
    console.log(`  Worktrees      : ${worktreesRoot}`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("  1. Start the gateway process with state/gateway/config.json");
  console.log("  2. Start each agent session with its mcp-config.json");
  console.log("  3. Use the Hive manager to coordinate agents via Discord");
}

// ---------------------------------------------------------------------------
// Main (exported for use by bin/hive)
// ---------------------------------------------------------------------------

export async function main(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  // Resolve agents first so workers count is correct before validation
  if (parsed.agentNames !== null) {
    validateAgentNames(parsed.agentNames);
    parsed.workers = parsed.agentNames.length;
  }
  validate(parsed);
  generateSingleBot(parsed);
}
