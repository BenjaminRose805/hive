/**
 * src/gen-config.ts
 * Generates per-worker and manager configuration files for a Hive Discord orchestration setup.
 * Uses single-bot gateway mode with one Discord bot for all sessions.
 * Supports named agents (--agents) or numeric workers (--workers N).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type AgentEntry, type AgentsJson, NO_WORKTREE_ROLES } from "./shared/agent-types.ts";
import { AGENT_NAME_RE, parseAgentAssignment, RESERVED_NAMES, validateDomain, validateRole } from "./shared/validation.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Args {
  workers: number;
  agentNames: string[] | null; // null = use numeric worker-NN names
  agentRoles: Map<string, string>;
  agentDomains: Map<string, string>;
  channelId: string;
  token: string;
  botId: string;
  projectRepo: string | null;
  branchPrefix: string;
  branchPrefixExplicit: boolean; // was --branch-prefix explicitly set?
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

export interface ToolOverride {
  mode: "add" | "remove" | "replace";
  tools: string[];
}

interface GatewayWorkerConfig {
  workerId: string;
  socketPath: string;
  channelId: string;
  mentionPatterns: string[];
  requireMention: boolean;
  role: string;
  domain?: string;
  isSpokesperson?: boolean;
}

interface GatewayConfigJson {
  botToken: string;
  botId: string;
  channelId: string;
  dashboardChannelId: string;
  guildId: string;
  socketPath: string;
  workers: GatewayWorkerConfig[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIVE_ROOT = resolve(import.meta.dir, "..");
const DISCORD_RELAY_PATH = join(HIVE_ROOT, "src/mcp/discord-relay.ts");
const INBOX_RELAY_PATH = join(HIVE_ROOT, "src/mcp/inbox-relay.ts");

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
                            hyphens, 1-32 chars. Reserved: gateway,
                            all-workers, all-agents, hive.
  --roles <name:role:domain,...>  Optional role and domain assignments (e.g. alice:engineer:backend,bob:qa:testing).
                            Domain is optional: alice:engineer is also valid.
  --workers N               Number of workers using auto-names worker-01..NN (default: 3).
                            Ignored when --agents is provided.

OPTIONS
  --channel-id <snowflake>  Discord channel ID used for communication (required)
  --token <string>          Bot token (required)
  --bot-id <string>         Bot user ID (optional — auto-discovered at runtime)
  --project-repo <path>     Git repo path to create worktrees from (optional)
  --branch-prefix <string>  Branch name prefix for worktrees.
                            Default (with HIVE_PROJECT set):
                                     "hive/{project}/" for named agents,
                                     "hive/{project}/worker-" for numeric.
                            Default (without HIVE_PROJECT):
                                     "hive/" for named agents,
                                     "hive/worker-" for numeric.
  --help                    Show this help message

OUTPUT STRUCTURE
  state/
    agents.json
    gateway/
      config.json
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
    --roles alice:engineer:frontend,bob:engineer:backend,carol:qa \\
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
    agentDomains: new Map(),
    channelId: "",
    token: "",
    botId: "",
    projectRepo: null,
    branchPrefix: "hive/worker-",
    branchPrefixExplicit: false,
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
        const names = argv[++i]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        args.agentNames = names;
        break;
      }
      case "--roles": {
        const pairs = argv[++i]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const pair of pairs) {
          const { name, role, domain } = parseAgentAssignment(pair);
          validateRole(role);
          if (domain) validateDomain(domain);
          args.agentRoles.set(name, role);
          if (domain) args.agentDomains.set(name, domain);
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
      case "--tools": {
        const specs = argv[++i]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const spec of specs) {
          const colon = spec.indexOf(":");
          if (colon === -1) {
            console.error(
              `ERROR: Invalid --tools entry "${spec}". Expected format: name:+tool1+tool2`,
            );
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

          const tools = toolSpec
            .split("+")
            .map((s) => s.trim())
            .filter(Boolean);
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
        `ERROR: Invalid agent name "${name}". Names must be alphanumeric + hyphens only, 1-32 characters.`,
      );
      process.exit(1);
    }
    if (RESERVED_NAMES.has(name.toLowerCase())) {
      console.error(
        `ERROR: Agent name "${name}" is reserved. Reserved names: ${[...RESERVED_NAMES].join(", ")}`,
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

export function resolveAgents(args: Args): { names: string[]; branchPrefix: string } {
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

  // Determine branch prefix — namespace by project to prevent collisions
  const project = process.env.HIVE_PROJECT;
  let branchPrefix: string;
  if (args.branchPrefixExplicit) {
    branchPrefix = args.branchPrefix;
  } else if (project && args.agentNames !== null) {
    // Named mode with project: "hive/dev/" → produces "hive/dev/alice"
    branchPrefix = `hive/${project}/`;
  } else if (project) {
    // Numeric mode with project: "hive/dev/worker-" → produces "hive/dev/worker-01"
    branchPrefix = `hive/${project}/worker-`;
  } else if (args.agentNames !== null) {
    // Named mode default (no project): "hive/" → produces "hive/alice"
    branchPrefix = "hive/";
  } else {
    // Numeric mode default (no project): "hive/worker-" → produces "hive/worker-01"
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
  if (Number.isNaN(args.workers) || args.workers < 1)
    errors.push("--workers must be a positive integer");

  if (errors.length > 0) {
    for (const e of errors) console.error(`ERROR: ${e}`);
    console.error("\nRun with --help for usage.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Zero-padded worker label (used only for numeric mode)
// ---------------------------------------------------------------------------

export function workerLabel(n: number, total: number): string {
  const digits = String(total).length;
  return String(n).padStart(Math.max(digits, 2), "0");
}

// ---------------------------------------------------------------------------
// File writers
// ---------------------------------------------------------------------------

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export function loadToolDefinitions(toolsDir: string): Map<string, ToolDefinition> {
  const defs = new Map<string, ToolDefinition>();
  if (!existsSync(toolsDir)) return defs;

  const files = readdirSync(toolsDir).filter((f) => f.endsWith(".json"));
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

export function loadToolProfile(profilesDir: string, role: string): ToolProfile {
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

export function loadSecrets(secretsPath: string): Record<string, string> {
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

export function interpolateEnv(
  env: Record<string, string>,
  secrets: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value.replace(/\$\{(\w+)\}/g, (_, varName) => {
      return secrets[varName] ?? process.env[varName] ?? `\${${varName}}`;
    });
  }
  return result;
}

export function resolveToolsForRole(
  role: string,
  agentName: string,
  toolDefs: Map<string, ToolDefinition>,
  profilesDir: string,
  secrets: Record<string, string>,
  toolOverrides: Map<string, ToolOverride>,
): Record<string, McpServerEntry> {
  const profile = loadToolProfile(profilesDir, role);
  let toolNames = [...profile.tools];

  // Apply overrides if present
  const override = toolOverrides.get(agentName);
  if (override) {
    switch (override.mode) {
      case "replace":
        console.log(
          `  TOOLS  Agent ${agentName}: replacing role '${role}' tools [${toolNames.join(", ")}] with [${override.tools.join(", ")}]`,
        );
        toolNames = [...override.tools];
        break;
      case "add":
        console.log(
          `  TOOLS  Agent ${agentName}: adding [${override.tools.join(", ")}] to role '${role}' tools [${toolNames.join(", ")}]`,
        );
        toolNames = [...toolNames, ...override.tools.filter((t) => !toolNames.includes(t))];
        break;
      case "remove":
        console.log(
          `  TOOLS  Agent ${agentName}: removing [${override.tools.join(", ")}] from role '${role}' tools [${toolNames.join(", ")}]`,
        );
        toolNames = toolNames.filter((t) => !override.tools.includes(t));
        break;
    }
  }

  const result: Record<string, McpServerEntry> = {};

  for (const toolName of toolNames) {
    const def = toolDefs.get(toolName);
    if (!def) {
      console.warn(
        `  WARN  Tool '${toolName}' referenced by role '${role}' not found in config/tools/ — skipping`,
      );
      continue;
    }

    // Check required env vars
    const resolvedEnv = interpolateEnv(def.env, secrets);
    const missingEnv = def.requiredEnv.filter((varName) => {
      const val = secrets[varName] ?? process.env[varName];
      return !val;
    });

    if (missingEnv.length > 0) {
      console.warn(
        `  WARN  Tool '${toolName}' skipped for agent '${agentName}': missing required env vars: ${missingEnv.join(", ")}`,
      );
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

// ---------------------------------------------------------------------------
// Global settings reader (OMC hooks + MCP servers)
// ---------------------------------------------------------------------------

interface GlobalSettings {
  hooks?: Record<string, unknown[]>;
  mcpServers?: Record<string, McpServerEntry>;
}

/**
 * Read Claude global settings files and extract hooks and MCP servers.
 * Merges settings.json and settings.local.json (local takes precedence).
 */
export function loadGlobalSettings(): GlobalSettings {
  const claudeDir = join(homedir(), ".claude");
  const result: GlobalSettings = {};

  for (const filename of ["settings.json", "settings.local.json"]) {
    const filePath = join(claudeDir, filename);
    if (!existsSync(filePath)) continue;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      // Merge hooks (append arrays per event type)
      if (raw.hooks && typeof raw.hooks === "object") {
        if (!result.hooks) result.hooks = {};
        for (const [event, hookEntries] of Object.entries(raw.hooks)) {
          if (!Array.isArray(hookEntries)) continue;
          if (!result.hooks[event]) result.hooks[event] = [];
          (result.hooks[event] as unknown[]).push(...hookEntries);
        }
      }
      // Merge MCP servers
      if (raw.mcpServers && typeof raw.mcpServers === "object") {
        if (!result.mcpServers) result.mcpServers = {};
        Object.assign(result.mcpServers, raw.mcpServers);
      }
    } catch (err) {
      console.warn(`  WARN  Failed to parse ${filePath}: ${err}`);
    }
  }

  return result;
}

export function buildRelayMcpConfig(
  _stateDir: string,
  workerId: string,
  _workerSocketPath: string,
  channelId: string,
  _mentionPatterns: string,
  _requireMention: boolean,
  roleTools?: Record<string, McpServerEntry>,
  gatewaySocket?: string,
  globalMcpServers?: Record<string, McpServerEntry>,
  agentRole?: string,
): McpConfigJson {
  const gw = gatewaySocket ?? process.env.HIVE_GATEWAY_SOCKET ?? "/tmp/hive-gateway/gateway.sock";
  const projectRoot = process.env.HIVE_PROJECT_DIR ?? process.cwd();
  const mindRoot = join(projectRoot, ".hive", "mind");

  const servers: Record<string, McpServerEntry> = {
    // Global MCP servers (e.g. OMC tools) go first so hive-specific ones take precedence
    ...(globalMcpServers ?? {}),
    inbox: {
      command: "bun",
      args: ["run", INBOX_RELAY_PATH],
      env: {
        HIVE_INBOX_DIR: join(dirname(gw), "inbox", "messages", workerId),
        HIVE_INBOX_ROOT: join(dirname(gw), "inbox", "messages"),
        HIVE_WORKER_ID: workerId,
        HIVE_GATEWAY_SOCKET: gw,
        HIVE_MIND_ROOT: mindRoot,
      },
    },
    ...(roleTools ?? {}),
  };

  // AC8: Discord relay is Oracle-only (product role)
  if (agentRole === "product") {
    servers.discord = {
      command: "bun",
      args: ["run", DISCORD_RELAY_PATH],
      env: {
        HIVE_GATEWAY_SOCKET: gw,
        HIVE_WORKER_ID: workerId,
        HIVE_CHANNEL_ID: channelId,
      },
    };
  }

  return { mcpServers: servers };
}

// ---------------------------------------------------------------------------
// Worktree management
// ---------------------------------------------------------------------------

export function addWorktree(projectRepo: string, worktreePath: string, branch: string): void {
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
      execSync(`git -C "${projectRepo}" worktree add "${worktreePath}" "${branch}"`, {
        stdio: "pipe",
      });
    } else {
      execSync(`git -C "${projectRepo}" worktree add -b "${branch}" "${worktreePath}"`, {
        stdio: "pipe",
      });
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

export function loadOrCreateAgentsJson(agentsPath: string): AgentsJson {
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

export function mergeAgentsJson(existing: AgentsJson, newAgents: AgentEntry[]): AgentsJson {
  const existingByName = new Map<string, AgentEntry>(existing.agents.map((a) => [a.name, a]));

  for (const agent of newAgents) {
    const existing = existingByName.get(agent.name);
    if (existing) {
      // Update status and role for re-launched agents
      existing.status = agent.status;
      existing.role = agent.role;
      existing.domain = agent.domain;
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

export function writeAgentsJson(
  _stateRoot: string,
  agentNames: string[],
  agentRoles: Map<string, string>,
  agentsPath: string,
  agentDomains: Map<string, string> = new Map(),
): void {
  const now = new Date().toISOString();
  const newAgents: AgentEntry[] = agentNames.map((name) => {
    const domain = agentDomains.get(name);
    return {
      name,
      role: agentRoles.get(name) ?? "engineer",
      ...(domain ? { domain } : {}),
      created: now,
      status: "configured",
    };
  });

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
  const stateRoot = process.env.HIVE_STATE_DIR ?? join(HIVE_ROOT, "state");
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
    console.log(
      `  TOOLS  Loaded ${toolDefs.size} tool definition(s): ${[...toolDefs.keys()].join(", ")}`,
    );
  }

  // -------------------------------------------------------------------------
  // Build gateway worker list
  // -------------------------------------------------------------------------

  const gatewayWorkers: GatewayWorkerConfig[] = names.map((name) => {
    const role = args.agentRoles.get(name) ?? "engineer";
    const domain = args.agentDomains.get(name);
    const isManager = role === "manager";
    const isOracle = role === "product";
    const isSpokesperson = isManager || isOracle;
    return {
      workerId: name,
      socketPath: `/tmp/hive-gateway/${name}.sock`,
      channelId: "",
      mentionPatterns: isSpokesperson ? [name, "hive"] : [name, "all-workers"],
      requireMention: !isSpokesperson,
      role,
      ...(domain ? { domain } : {}),
      ...(isSpokesperson ? { isSpokesperson: true } : {}),
    };
  });

  // -------------------------------------------------------------------------
  // Write gateway config
  // -------------------------------------------------------------------------

  const gatewayDir = join(stateRoot, "gateway");
  ensureDir(gatewayDir);

  const gatewayConfig: GatewayConfigJson = {
    botToken: "(from DISCORD_BOT_TOKEN env var)",
    botId: args.botId || "(auto-discovered at runtime)",
    channelId: args.channelId,
    dashboardChannelId: args.channelId,
    guildId: "",
    socketPath: process.env.HIVE_GATEWAY_SOCKET ?? "/tmp/hive-gateway/gateway.sock",
    workers: gatewayWorkers,
  };

  writeJson(join(gatewayDir, "config.json"), gatewayConfig);
  console.log(`  CREATE  state/gateway/config.json`);

  // -------------------------------------------------------------------------
  // Generate per-agent configs
  // -------------------------------------------------------------------------

  for (const name of names) {
    const workerDir = join(stateRoot, "workers", name);
    ensureDir(workerDir);

    const agentRole = args.agentRoles.get(name) ?? "engineer";
    const isManager = agentRole === "manager";
    const isOracle = agentRole === "product";
    const isSpokesperson = isManager || isOracle;
    const roleTools = resolveToolsForRole(
      agentRole,
      name,
      toolDefs,
      profilesDir,
      secrets,
      args.toolOverrides,
    );

    const workerAccess: AccessJson = {
      dmPolicy: "disabled",
      allowFrom: [],
      groups: {
        [args.channelId]: {
          requireMention: !isSpokesperson,
          allowFrom: [],
        },
      },
      pending: {},
      mentionPatterns: isSpokesperson ? [name, "hive"] : [name, "all-workers"],
    };

    const globalSettings = loadGlobalSettings();

    writeJson(join(workerDir, "access.json"), workerAccess);
    writeJson(
      join(workerDir, "mcp-config.json"),
      buildRelayMcpConfig(
        workerDir,
        name,
        `/tmp/hive-gateway/${name}.sock`,
        args.channelId,
        isSpokesperson ? `${name},hive` : `${name},all-workers`,
        !isSpokesperson,
        roleTools,
        undefined,
        globalSettings.mcpServers,
        agentRole,
      ),
    );

    console.log(`  CREATE  state/workers/${name}/access.json`);
    console.log(`  CREATE  state/workers/${name}/mcp-config.json`);

    // Generate settings.json with scope enforcement hook (skip for no-worktree roles)
    // Merge OMC hooks from global settings so agent sessions have full OMC capabilities
    if (!NO_WORKTREE_ROLES.has(agentRole)) {
      const mergedHooks: Record<string, unknown[]> = {};

      // Start with global hooks
      if (globalSettings.hooks) {
        for (const [event, entries] of Object.entries(globalSettings.hooks)) {
          mergedHooks[event] = [...(entries as unknown[])];
        }
      }

      // Warn about misconfigured launches — scope hook silently disables without both env vars
      console.warn(
        `  NOTE   Agent ${name}: scope enforcement requires HIVE_WORKER_ID and HIVE_ROOT env vars at launch. ` +
          `If HIVE_ROOT is set but HIVE_WORKER_ID is missing, the scope hook will silently disable.`,
      );

      // Add scope enforcement hook to PreToolUse
      if (!mergedHooks.PreToolUse) mergedHooks.PreToolUse = [];
      mergedHooks.PreToolUse.push({
        matcher: "Write|Edit|NotebookEdit|Bash",
        hooks: [
          {
            type: "command",
            command: `node "${join(HIVE_ROOT, "hooks", "check-scope.mjs")}"`,
          },
        ],
      });

      // Block AskUserQuestion — agents must use Discord instead
      mergedHooks.PreToolUse.push({
        matcher: "AskUserQuestion",
        hooks: [
          {
            type: "command",
            command: `node "${join(HIVE_ROOT, "hooks", "intercept-ask-user.mjs")}"`,
          },
        ],
      });

      // Add OMC mode enforcement hook to PreToolUse (Write|Edit only)
      mergedHooks.PreToolUse.push({
        matcher: "Write|Edit",
        hooks: [
          {
            type: "command",
            command: `node "${join(HIVE_ROOT, "hooks", "enforce-omc-mode.mjs")}"`,
          },
        ],
      });

      // AC7: PostToolUse inbox polling — check for unread messages after every tool call
      if (!mergedHooks.PostToolUse) mergedHooks.PostToolUse = [];
      mergedHooks.PostToolUse.push({
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `node "${join(HIVE_ROOT, "hooks", "check-inbox.mjs")}"`,
          },
        ],
      });

      const workerSettings = { hooks: mergedHooks };
      writeFileSync(join(workerDir, "settings.json"), JSON.stringify(workerSettings, null, 2));
      console.log(`  CREATE  state/workers/${name}/settings.json`);
    }

    // -----------------------------------------------------------------------
    // Git worktree (skip for no-worktree roles)
    // -----------------------------------------------------------------------
    if (args.projectRepo && !NO_WORKTREE_ROLES.has(agentRole)) {
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
  writeAgentsJson(stateRoot, names, args.agentRoles, agentsPath, args.agentDomains);

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  console.log("");
  console.log("Done (single-bot mode). Summary:");
  console.log(`  Bot ID         : ${args.botId || "(auto-discovered at runtime)"}`);
  console.log(`  Agents         : ${names.join(", ")}`);
  console.log(`  Channel ID     : ${args.channelId}`);
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
