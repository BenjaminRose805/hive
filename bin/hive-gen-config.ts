#!/usr/bin/env bun
/**
 * hive-gen-config.ts
 * Generates per-worker and manager configuration files for a Hive Discord orchestration setup.
 * Supports multi-bot mode (default) and single-bot gateway mode (--single-bot).
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Args {
  workers: number;
  channelId: string;
  // multi-bot fields
  managerBotId: string;
  workerBotIds: string[];
  tokensFile: string;
  // single-bot fields
  singleBot: boolean;
  token: string;
  botId: string;
  // shared
  projectRepo: string | null;
  branchPrefix: string;
  budget: number;
  help: boolean;
}

interface AccessJson {
  dmPolicy: "disabled" | "enabled";
  allowFrom: string[];
  groups: Record<string, { requireMention: boolean; allowFrom: string[] }>;
  pending: Record<string, never>;
  mentionPatterns: string[];
}

interface McpConfigJson {
  mcpServers: {
    discord: {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
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
const DISCORD_PLUGIN_PATH =
  "/home/benjamin/.claude/plugins/cache/claude-plugins-official/discord/0.0.1";

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
hive-gen-config — Generate per-worker configuration files for Hive

USAGE
  bun run bin/hive-gen-config.ts [OPTIONS]

MODES
  Multi-bot mode (default): each worker has its own Discord bot token.
  Single-bot mode (--single-bot): one bot token shared via a gateway process.

OPTIONS (shared)
  --workers N               Number of worker bots (default: 3)
  --channel-id <snowflake>  Discord channel ID used for communication (required)
  --project-repo <path>     Git repo path to create worktrees from (optional)
  --branch-prefix <string>  Branch name prefix for worktrees (default: hive/worker-)
  --budget <number>         USD budget per worker (default: 5)
  --help                    Show this help message

OPTIONS (multi-bot mode)
  --manager-bot-id <id>     Discord bot user ID of the manager bot
  --worker-bot-ids <ids>    Comma-separated Discord bot user IDs for workers
  --tokens-file <path>      File with one bot token per line (manager first)

OPTIONS (single-bot mode)
  --single-bot              Enable single-bot gateway mode
  --token <string>          Single bot token (replaces --tokens-file)
  --bot-id <string>         Single bot user ID (replaces --manager-bot-id + --worker-bot-ids)

OUTPUT STRUCTURE (multi-bot mode)
  state/
    manager/
      access.json
      .env
      mcp-config.json
    workers/
      worker-NN/
        access.json
        .env
        mcp-config.json

OUTPUT STRUCTURE (single-bot mode)
  state/
    gateway/
      config.json
    manager/
      access.json
      mcp-config.json         (relay mode — no .env)
    workers/
      worker-NN/
        access.json
        mcp-config.json       (relay mode — no .env)

  worktrees/
    worker-NN/               (if --project-repo is provided)

EXAMPLES
  # Multi-bot mode
  bun run bin/hive-gen-config.ts \\
    --workers 3 \\
    --channel-id 1234567890123456789 \\
    --manager-bot-id 111111111111111111 \\
    --worker-bot-ids 222222222222222222,333333333333333333,444444444444444444 \\
    --tokens-file ./tokens.txt

  # Single-bot mode
  bun run bin/hive-gen-config.ts \\
    --single-bot \\
    --token "Bot MySecretToken" \\
    --bot-id 111111111111111111 \\
    --channel-id 1234567890123456789 \\
    --workers 2
`);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const args: Args = {
    workers: 3,
    channelId: "",
    managerBotId: "",
    workerBotIds: [],
    tokensFile: "",
    singleBot: false,
    token: "",
    botId: "",
    projectRepo: null,
    branchPrefix: "hive/worker-",
    budget: 5,
    help: false,
  };

  const raw = argv.slice(2); // strip "bun" and script path
  let i = 0;
  while (i < raw.length) {
    const flag = raw[i];
    switch (flag) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--workers":
        args.workers = parseInt(raw[++i], 10);
        break;
      case "--channel-id":
        args.channelId = raw[++i];
        break;
      case "--manager-bot-id":
        args.managerBotId = raw[++i];
        break;
      case "--worker-bot-ids":
        args.workerBotIds = raw[++i].split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--tokens-file":
        args.tokensFile = raw[++i];
        break;
      case "--single-bot":
        args.singleBot = true;
        break;
      case "--token":
        args.token = raw[++i];
        break;
      case "--bot-id":
        args.botId = raw[++i];
        break;
      case "--project-repo":
        args.projectRepo = raw[++i];
        break;
      case "--branch-prefix":
        args.branchPrefix = raw[++i];
        break;
      case "--budget":
        args.budget = parseFloat(raw[++i]);
        break;
      default:
        console.error(`Unknown argument: ${flag}`);
        process.exit(1);
    }
    i++;
  }

  return args;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateMultiBot(args: Args): { tokens: string[] } {
  const errors: string[] = [];

  if (!args.channelId) errors.push("--channel-id is required");
  if (!args.managerBotId) errors.push("--manager-bot-id is required");
  if (args.workerBotIds.length === 0) errors.push("--worker-bot-ids is required");
  if (!args.tokensFile) errors.push("--tokens-file is required");
  if (isNaN(args.workers) || args.workers < 1) errors.push("--workers must be a positive integer");

  if (errors.length > 0) {
    for (const e of errors) console.error(`ERROR: ${e}`);
    console.error("\nRun with --help for usage.");
    process.exit(1);
  }

  // Verify worker bot ID count matches --workers
  if (args.workerBotIds.length !== args.workers) {
    console.error(
      `ERROR: --worker-bot-ids has ${args.workerBotIds.length} IDs but --workers is ${args.workers}. They must match.`
    );
    process.exit(1);
  }

  // Read tokens file
  if (!existsSync(args.tokensFile)) {
    console.error(`ERROR: Tokens file not found: ${args.tokensFile}`);
    console.error("The file should have one bot token per line: manager token first, then one per worker.");
    process.exit(1);
  }

  const tokens = readFileSync(args.tokensFile, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const expected = args.workers + 1; // manager + N workers
  if (tokens.length !== expected) {
    console.error(
      `ERROR: Tokens file has ${tokens.length} token(s) but expected ${expected} (1 manager + ${args.workers} workers).`
    );
    process.exit(1);
  }

  // Unique bot IDs
  const allBotIds = [args.managerBotId, ...args.workerBotIds];
  const uniqueIds = new Set(allBotIds);
  if (uniqueIds.size !== allBotIds.length) {
    console.error("ERROR: Bot IDs are not unique. Each bot must have a distinct user ID.");
    process.exit(1);
  }

  // Unique tokens
  const uniqueTokens = new Set(tokens);
  if (uniqueTokens.size !== tokens.length) {
    console.error("ERROR: Tokens are not unique. Each bot must have a distinct token.");
    process.exit(1);
  }

  return { tokens };
}

function validateSingleBot(args: Args): void {
  const errors: string[] = [];

  if (!args.channelId) errors.push("--channel-id is required");
  if (!args.token) errors.push("--token is required in --single-bot mode");
  if (!args.botId) errors.push("--bot-id is required in --single-bot mode");
  if (isNaN(args.workers) || args.workers < 1) errors.push("--workers must be a positive integer");

  // Reject multi-bot flags
  if (args.tokensFile) errors.push("--tokens-file cannot be used with --single-bot (use --token instead)");
  if (args.managerBotId) errors.push("--manager-bot-id cannot be used with --single-bot (use --bot-id instead)");
  if (args.workerBotIds.length > 0) errors.push("--worker-bot-ids cannot be used with --single-bot (use --bot-id instead)");

  if (errors.length > 0) {
    for (const e of errors) console.error(`ERROR: ${e}`);
    console.error("\nRun with --help for usage.");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Zero-padded worker label
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

function writeEnv(filePath: string, token: string): void {
  const content = `DISCORD_BOT_TOKEN=${token}\nDISCORD_ACCESS_MODE=static\n`;
  writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
  chmodSync(filePath, 0o600);
}

function buildMcpConfig(stateDir: string): McpConfigJson {
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
        },
      },
    },
  };
}

function buildRelayMcpConfig(
  stateDir: string,
  workerId: string,
  workerSocketPath: string,
  channelId: string,
  mentionPatterns: string,
  requireMention: boolean
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
// Single-bot mode generation
// ---------------------------------------------------------------------------

function generateSingleBot(args: Args): void {
  const stateRoot = join(HIVE_ROOT, "state");
  const worktreesRoot = join(HIVE_ROOT, "worktrees");

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

  for (let n = 1; n <= args.workers; n++) {
    const label = workerLabel(n, args.workers);
    gatewayWorkers.push({
      workerId: `worker-${label}`,
      socketPath: `/tmp/hive-gateway/worker-${label}.sock`,
      mentionPatterns: [`worker-${label}`, "all-workers"],
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
    botId: args.botId,
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

  writeJson(join(managerStateDir, "access.json"), managerAccess);
  writeJson(
    join(managerStateDir, "mcp-config.json"),
    buildRelayMcpConfig(
      managerStateDir,
      "manager",
      "/tmp/hive-gateway/manager.sock",
      args.channelId,
      "manager,hive",
      false
    )
  );

  console.log(`  CREATE  state/manager/access.json`);
  console.log(`  CREATE  state/manager/mcp-config.json`);

  // -------------------------------------------------------------------------
  // Generate per-worker configs
  // -------------------------------------------------------------------------

  for (let n = 1; n <= args.workers; n++) {
    const label = workerLabel(n, args.workers);
    const workerDir = join(stateRoot, "workers", `worker-${label}`);
    ensureDir(workerDir);

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
      mentionPatterns: [`worker-${label}`, "all-workers"],
    };

    writeJson(join(workerDir, "access.json"), workerAccess);
    writeJson(
      join(workerDir, "mcp-config.json"),
      buildRelayMcpConfig(
        workerDir,
        `worker-${label}`,
        `/tmp/hive-gateway/worker-${label}.sock`,
        args.channelId,
        `worker-${label},all-workers`,
        true
      )
    );

    console.log(`  CREATE  state/workers/worker-${label}/access.json`);
    console.log(`  CREATE  state/workers/worker-${label}/mcp-config.json`);

    // -----------------------------------------------------------------------
    // Git worktree
    // -----------------------------------------------------------------------
    if (args.projectRepo) {
      const repoPath = resolve(args.projectRepo);
      const worktreePath = join(worktreesRoot, `worker-${label}`);
      const branch = `${args.branchPrefix}${label}`;
      addWorktree(repoPath, worktreePath, branch);
    }
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  console.log("");
  console.log("Done (single-bot mode). Summary:");
  console.log(`  Bot ID         : ${args.botId}`);
  console.log(`  Workers        : ${args.workers}`);
  console.log(`  Channel ID     : ${args.channelId}`);
  console.log(`  Budget/worker  : $${args.budget}`);
  console.log(`  State root     : ${stateRoot}`);
  console.log(`  Gateway config : ${join(gatewayDir, "config.json")}`);
  if (args.projectRepo) {
    console.log(`  Worktrees      : ${worktreesRoot}`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("  1. Start the gateway process with state/gateway/config.json");
  console.log("  2. Start each worker session with its mcp-config.json");
  console.log("  3. Use the Hive manager to coordinate workers via Discord");
}

// ---------------------------------------------------------------------------
// Multi-bot mode generation
// ---------------------------------------------------------------------------

function generateMultiBot(args: Args, tokens: string[]): void {
  const managerToken = tokens[0];
  const workerTokens = tokens.slice(1);

  const stateRoot = join(HIVE_ROOT, "state");
  const worktreesRoot = join(HIVE_ROOT, "worktrees");

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
        allowFrom: [...args.workerBotIds],
      },
    },
    pending: {},
    mentionPatterns: ["manager", "hive"],
  };

  writeJson(join(managerStateDir, "access.json"), managerAccess);
  writeEnv(join(managerStateDir, ".env"), managerToken);
  writeJson(join(managerStateDir, "mcp-config.json"), buildMcpConfig(managerStateDir));

  console.log(`  CREATE  state/manager/access.json`);
  console.log(`  CREATE  state/manager/.env (mode 0600)`);
  console.log(`  CREATE  state/manager/mcp-config.json`);

  // -------------------------------------------------------------------------
  // Generate per-worker configs
  // -------------------------------------------------------------------------

  for (let n = 1; n <= args.workers; n++) {
    const label = workerLabel(n, args.workers);
    const workerDir = join(stateRoot, "workers", `worker-${label}`);
    ensureDir(workerDir);

    const otherWorkerIds = args.workerBotIds.filter((_, idx) => idx !== n - 1);

    const workerAccess: AccessJson = {
      dmPolicy: "disabled",
      allowFrom: [],
      groups: {
        [args.channelId]: {
          requireMention: true,
          allowFrom: [args.managerBotId, ...otherWorkerIds],
        },
      },
      pending: {},
      mentionPatterns: [`worker-${label}`, "all-workers"],
    };

    writeJson(join(workerDir, "access.json"), workerAccess);
    writeEnv(join(workerDir, ".env"), workerTokens[n - 1]);
    writeJson(join(workerDir, "mcp-config.json"), buildMcpConfig(workerDir));

    console.log(`  CREATE  state/workers/worker-${label}/access.json`);
    console.log(`  CREATE  state/workers/worker-${label}/.env (mode 0600)`);
    console.log(`  CREATE  state/workers/worker-${label}/mcp-config.json`);

    // -----------------------------------------------------------------------
    // Git worktree
    // -----------------------------------------------------------------------
    if (args.projectRepo) {
      const repoPath = resolve(args.projectRepo);
      const worktreePath = join(worktreesRoot, `worker-${label}`);
      const branch = `${args.branchPrefix}${label}`;
      addWorktree(repoPath, worktreePath, branch);
    }
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  console.log("");
  console.log("Done. Summary:");
  console.log(`  Manager bot ID : ${args.managerBotId}`);
  console.log(`  Workers        : ${args.workers}`);
  console.log(`  Channel ID     : ${args.channelId}`);
  console.log(`  Budget/worker  : $${args.budget}`);
  console.log(`  State root     : ${stateRoot}`);
  if (args.projectRepo) {
    console.log(`  Worktrees      : ${worktreesRoot}`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("  1. Start each bot session with its mcp-config.json");
  console.log("  2. Set DISCORD_STATE_DIR to the appropriate state directory");
  console.log("  3. Use the Hive manager to coordinate workers via Discord");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(Bun.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.singleBot) {
    validateSingleBot(args);
    generateSingleBot(args);
  } else {
    const { tokens } = validateMultiBot(args);
    generateMultiBot(args, tokens);
  }
}

main();
