/**
 * src/scripts/launch.ts
 * TypeScript replacement for launch.sh — orchestrates a full Hive swarm.
 * Manages tmux session with gateway, mind daemon, manager, and workers.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildRelayMcpConfig,
  ensureDir,
  loadGlobalSettings,
  loadSecrets,
  loadToolDefinitions,
  resolveToolsForRole,
  type ToolOverride,
  writeAgentsJson,
  writeJson,
} from "../gen-config.ts";
import { type AgentsJson, NO_WORKTREE_ROLES } from "../shared/agent-types.ts";
import {
  configDir,
  getAgentsJsonPath,
  getGatewayDir,
  getMasterGatewayDir,
  getMasterSocket,
  getPidsJsonPath,
  getSession,
  getStateDir,
  HIVE_DIR,
  worktreesDir,
} from "../shared/paths.ts";
import { loadConfig, resolveProject } from "../shared/project-config.ts";
import { run, runOrDie } from "../shared/subprocess.ts";
import {
  parseAgentAssignment,
  validateAgentNames,
  validateDomain,
  validateRole,
  validateSafeName,
} from "../shared/validation.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LaunchArgs {
  projectRepo: string;
  channelId: string;
  agents: string[];
  roles: Map<string, string>;
  domains: Map<string, string>;
  token: string;
  tools: string;
  teardown: boolean;
  clean: boolean;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): LaunchArgs {
  const args: LaunchArgs = {
    projectRepo: "",
    channelId: "",
    agents: [],
    roles: new Map(),
    domains: new Map(),
    token: "",
    tools: "",
    teardown: false,
    clean: false,
  };

  let i = 0;
  while (i < argv.length) {
    const flag = argv[i];
    switch (flag) {
      case "--project-repo":
        args.projectRepo = argv[++i];
        break;
      case "--channel-id":
        args.channelId = argv[++i];
        break;
      case "--agents":
        args.agents = argv[++i]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--roles": {
        const pairs = argv[++i]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const pair of pairs) {
          const { name, role, domain } = parseAgentAssignment(pair);
          validateRole(role);
          if (domain) validateDomain(domain);
          args.roles.set(name, role);
          if (domain) args.domains.set(name, domain);
        }
        break;
      }
      case "--token":
        args.token = argv[++i];
        break;
      case "--tools":
        args.tools = argv[++i];
        break;
      case "--teardown":
        args.teardown = true;
        break;
      case "--clean":
        args.clean = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
    i++;
  }

  return args;
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

function resolveToken(args: LaunchArgs): string {
  // 1. CLI arg
  if (args.token) return args.token;
  // 2. Environment variable
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;
  // 3. Auto-read from discord channel config
  const envFile = join(homedir(), ".claude/channels/discord/.env");
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("DISCORD_BOT_TOKEN=")) {
        const val = trimmed.slice("DISCORD_BOT_TOKEN=".length);
        if (val) return val;
      }
    }
  }
  throw new Error(
    "Bot token required: pass --token, set DISCORD_BOT_TOKEN, or add it to ~/.claude/channels/discord/.env",
  );
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

function launchGateway(token: string): string {
  const masterSocket = getMasterSocket();
  const masterDir = getMasterGatewayDir();

  // Check if a shared gateway is already running and healthy
  const healthCheck = run([
    "curl", "-s", "--unix-socket", masterSocket, "http://localhost/health",
  ]);
  if (healthCheck.exitCode === 0 && healthCheck.stdout) {
    try {
      const json = JSON.parse(healthCheck.stdout);
      if (json.status === "ok" && json.botId) {
        console.log(`[hive] Reusing existing gateway (${json.connectedAs ?? "connected"})`);
        return json.botId;
      }
    } catch { /* not valid JSON — fall through to start new gateway */ }
  }

  // No healthy gateway found — start a new one
  const scriptPath = join(getStateDir(), ".launch-gateway.sh");
  // Single-quoted heredoc prevents expansion; token passed via env
  const script = `#!/usr/bin/env bash
export DISCORD_BOT_TOKEN='${token.replace(/'/g, "'\\''")}'
export HIVE_DIR='${HIVE_DIR}'
export HIVE_GATEWAY_SOCKET='${masterSocket}'
export HIVE_STATE_DIR='${getStateDir()}'
export HIVE_SESSION='${getSession()}'
bun run "$HIVE_DIR/bin/hive-gateway.ts" 2>&1
echo "[hive] Gateway exited with code $?"
read -p "Press enter to close..."
`;
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o700);

  // Kill any existing session's gateway window and stale socket
  // NOTE: Only kill the gateway tmux window, NOT the entire tmux session
  // (other projects may have workers in the same tmux server)
  run(["tmux", "kill-window", "-t", `${getSession()}:gateway`]);
  run(["fuser", "-k", masterSocket]);
  Bun.sleepSync(1000);
  if (existsSync(masterDir)) {
    run(["rm", "-rf", masterDir]);
  }
  // Remove hive sessions from tmux-resurrect save files to prevent tmux-continuum
  // from auto-restoring stale windows when a new tmux server starts
  for (const dir of [
    join(homedir(), ".local/share/tmux/resurrect"),
    join(homedir(), ".tmux/resurrect"),
  ]) {
    if (!existsSync(dir)) continue;
    // Use sed for reliable tab-delimited line removal
    run([
      "sed",
      "-i",
      "/hive/d",
      ...readdirSync(dir)
        .filter((f) => f.endsWith(".txt"))
        .map((f) => join(dir, f)),
    ]);
  }

  // Create tmux session if it doesn't exist, or add gateway window
  const sessionExists = run(["tmux", "has-session", "-t", getSession()]);
  if (sessionExists.exitCode === 0) {
    runOrDie(["tmux", "new-window", "-t", getSession(), "-n", "gateway", scriptPath]);
  } else {
    runOrDie(["tmux", "new-session", "-d", "-s", getSession(), "-n", "gateway", scriptPath]);
  }
  console.log("[hive] Gateway starting...");

  // Give gateway time to start before polling
  Bun.sleepSync(5000);

  // Health check loop (30s timeout) — use masterSocket
  for (let attempt = 0; attempt < 30; attempt++) {
    const health = run([
      "curl", "-s", "--unix-socket", masterSocket, "http://localhost/health",
    ]);
    if (health.exitCode === 0 && health.stdout) {
      try {
        const json = JSON.parse(health.stdout);
        const botId = json.botId ?? "";
        console.log(`[hive] Gateway ready (${json.connectedAs ?? "connected"})`);
        return botId;
      } catch {
        /* not valid JSON yet */
      }
    }
    // After 10s of polling, check if gateway process died
    if (attempt > 10) {
      const paneCheck = run(["tmux", "capture-pane", "-t", `${getSession()}:gateway`, "-p"]);
      if (paneCheck.stdout.includes("[hive] Gateway exited")) {
        throw new Error(`Gateway process crashed. Check: tmux attach -t ${getSession()}`);
      }
    }
    Bun.sleepSync(1000);
  }
  throw new Error("Gateway health check timed out after 30s");
}

// ---------------------------------------------------------------------------
// Worker registration
// ---------------------------------------------------------------------------

function registerWorkers(names: string[], roles: Map<string, string>, domains: Map<string, string>): void {
  const masterSocket = getMasterSocket();
  const session = getSession();

  for (const name of names) {
    const role = roles.get(name) ?? "engineer";
    const isManager = role === "manager";
    const isOracle = role === "product";
    const isSpokesperson = isManager || isOracle;

    const body = JSON.stringify({
      workerId: name,
      session,
      mentionPatterns: isSpokesperson ? [name, "hive"] : [name, "all-workers"],
      requireMention: !isSpokesperson,
      role,
      domain: domains.get(name),
    });

    const result = run([
      "curl", "-s", "-X", "POST",
      "--unix-socket", masterSocket,
      "-H", "Content-Type: application/json",
      "-d", body,
      "http://localhost/register",
    ]);

    if (result.exitCode !== 0) {
      console.warn(`[hive] Warning: failed to register worker ${name}`);
    }
  }
  console.log(`[hive] Registered ${names.length} workers for session ${session}`);
}

// ---------------------------------------------------------------------------
// Mind daemon
// ---------------------------------------------------------------------------

function launchMind(): void {
  const scriptPath = join(getStateDir(), ".launch-mind.sh");
  const script = `#!/usr/bin/env bash
export HIVE_STATE_DIR='${getStateDir()}'
bun run "${HIVE_DIR}/bin/hive-mind.ts" daemon 2>&1
`;
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o700);

  runOrDie(["tmux", "new-window", "-t", getSession(), "-n", "mind", scriptPath]);
  console.log("[hive] Mind daemon starting...");

  // Wait for daemon.pid (5s)
  const pidFile = join(HIVE_DIR, ".hive/mind/daemon.pid");
  for (let i = 0; i < 5; i++) {
    if (existsSync(pidFile)) {
      console.log("[hive] Mind daemon ready");
      return;
    }
    Bun.sleepSync(1000);
  }
}

// ---------------------------------------------------------------------------
// System prompt composition
// ---------------------------------------------------------------------------

interface TeamMember {
  name: string;
  role: string;
  domain?: string;
}

function buildTeamRoster(self: string, members: TeamMember[]): string {
  const lines = [
    "## Your Team",
    "",
    "| Agent | Role | Domain | Worktree |",
    "|-------|------|--------|----------|",
  ];
  for (const m of members) {
    const you = m.name === self ? " **(you)**" : "";
    const domain = m.domain ?? "(generalist)";
    const wt = NO_WORKTREE_ROLES.has(m.role) ? "no (read-only)" : "yes";
    lines.push(`| ${m.name}${you} | ${m.role} | ${domain} | ${wt} |`);
  }
  lines.push("", "**Who to ask for what:**");
  // Group by role for quick reference
  const byRole = new Map<string, TeamMember[]>();
  for (const m of members) {
    if (m.name === self) continue;
    const list = byRole.get(m.role) ?? [];
    list.push(m);
    byRole.set(m.role, list);
  }
  for (const [role, agents] of byRole) {
    const names = agents.map((a) => `${a.name}${a.domain ? ` (${a.domain})` : ""}`).join(", ");
    switch (role) {
      case "manager":
        lines.push(`- **Coordination, task changes, blockers** → ${names}`);
        break;
      case "architect":
        lines.push(`- **Design questions, contracts, trade-offs** → ${names}`);
        break;
      case "engineer":
        lines.push(`- **Implementation help, code questions** → ${names}`);
        break;
      case "qa":
        lines.push(`- **Testing, verification, bug reports** → ${names}`);
        break;
      case "reviewer":
        lines.push(`- **Code review, security audit, quality** → ${names}`);
        break;
      case "devops":
        lines.push(`- **Build, CI/CD, deployment issues** → ${names}`);
        break;
      case "writer":
        lines.push(`- **Documentation, guides, API docs** → ${names}`);
        break;
      case "product":
        lines.push(`- **Product decisions, user-facing communication, human interface** → ${names}`);
        break;
    }
  }
  return lines.join("\n");
}

function composeSystemPrompt(
  name: string,
  role: string,
  domain?: string,
  team?: TeamMember[],
): string {
  const domainLabel = domain ? ` specializing in ${domain}` : "";
  const sub = (text: string) =>
    text
      .replaceAll("{NAME}", name)
      .replaceAll("{ROLE}", role + domainLabel)
      .replaceAll("{DOMAIN}", domain ?? "");

  // Base worker prompt
  const workerPromptPath = join(configDir, "prompts/worker-system-prompt.md");
  let prompt = sub(readFileSync(workerPromptPath, "utf8"));

  // Base profile (always included)
  const baseProfilePath = join(configDir, "prompts/profiles/_base.md");
  if (existsSync(baseProfilePath)) {
    prompt += `\n\n${sub(readFileSync(baseProfilePath, "utf8"))}`;
  }

  // Worktree-specific sections (branch discipline, scope enforcement, completion protocol)
  if (!NO_WORKTREE_ROLES.has(role)) {
    const worktreeSectionsPath = join(configDir, "prompts/worktree-sections.md");
    if (existsSync(worktreeSectionsPath)) {
      prompt += `\n\n${sub(readFileSync(worktreeSectionsPath, "utf8"))}`;
    }
  }

  // Role prompt (from config/prompts/roles/)
  const rolePath = join(configDir, `prompts/roles/${role}.md`);
  if (existsSync(rolePath)) {
    prompt += `\n\n${sub(readFileSync(rolePath, "utf8"))}`;
  }

  // Team roster (so every agent knows who's on the team)
  if (team && team.length > 0) {
    prompt += `\n\n${buildTeamRoster(name, team)}`;
  }

  // Mind prompt section
  const mindSectionPath = join(configDir, "prompts/mind-prompt-section.md");
  if (existsSync(mindSectionPath)) {
    prompt += `\n\n${readFileSync(mindSectionPath, "utf8").replaceAll("{NAME}", name)}`;
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Claude binary resolution
// ---------------------------------------------------------------------------

/** Find the global claude binary, skipping any local node_modules shadows */
function resolveClaudePath(): string {
  const result = run(["which", "-a", "claude"]);
  if (result.exitCode === 0) {
    const globalPath = result.stdout
      .split("\n")
      .find((p) => p.trim() && !p.includes("node_modules"));
    if (globalPath) return globalPath.trim();
  }
  return "claude";
}

// ---------------------------------------------------------------------------
// Worker launch
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Worker launch — split into phases for parallel startup
// ---------------------------------------------------------------------------

interface PreparedWorker {
  name: string;
  role: string;
  domain: string | undefined;
  scriptPath: string;
  promptFile: string;
  workDir: string;
}

/** Phase 1: Prepare configs, scripts, and hooks for a worker (no tmux, no sleeps) */
function prepareWorker(
  name: string,
  role: string,
  domain: string | undefined,
  args: LaunchArgs,
  team: TeamMember[],
): PreparedWorker {
  validateSafeName(name);
  validateSafeName(role);

  const isNoWorktreeRole = NO_WORKTREE_ROLES.has(role);
  const workDir = isNoWorktreeRole ? resolve(args.projectRepo) : join(worktreesDir, name);

  // Compose and write system prompt
  const prompt = composeSystemPrompt(name, role, domain, team);
  const promptFile = join(getStateDir(), `.prompt-${name}.md`);
  writeFileSync(promptFile, prompt);

  // Install pre-commit hook (worktree roles only)
  if (!isNoWorktreeRole) {
    const dotGitPath = join(workDir, ".git");
    if (existsSync(dotGitPath)) {
      const dotGit = readFileSync(dotGitPath, "utf8").trim();
      const gitDir = dotGit.startsWith("gitdir: ") ? dotGit.slice(8) : dotGitPath;
      const hooksDir = join(gitDir, "hooks");
      ensureDir(hooksDir);
      const hookDest = join(hooksDir, "pre-commit");
      copyFileSync(join(HIVE_DIR, "hooks/pre-commit-scope.sh"), hookDest);
      chmodSync(hookDest, 0o755);
    }
  }

  // Write launch script
  const scriptPath = join(getStateDir(), `.launch-worker-${name}.sh`);
  const settingsPath = join(getStateDir(), "workers", name, "settings.json");
  const settingsFlag = existsSync(settingsPath) ? `\\\n  --settings "${settingsPath}"` : "";
  const script = `#!/usr/bin/env bash
# Prevent parent Claude Code from suppressing child instances
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT
export HIVE_WORKER_ID='${name}'
export HIVE_ROOT='${workDir}'
cd '${workDir}'
'${resolveClaudePath()}' --name "hive-${name}" \\
  --append-system-prompt-file '${promptFile}' \\
  --mcp-config "${join(getStateDir(), "workers", name, "mcp-config.json")}" \\
  --strict-mcp-config ${settingsFlag} \\
  --permission-mode bypassPermissions
`;
  writeFileSync(scriptPath, script);
  chmodSync(scriptPath, 0o700);

  return { name, role, domain, scriptPath, promptFile, workDir };
}

/** Phase 2: Create tmux window for a worker (fast, no sleep needed) */
function spawnWorkerWindow(worker: PreparedWorker): void {
  runOrDie(["tmux", "new-window", "-t", getSession(), "-n", worker.name, worker.scriptPath]);
  console.log(`[hive] Spawned tmux window: ${worker.name} (${worker.role})`);
}

/** Phase 3: Handle onboarding prompts for all workers in parallel rounds */
function onboardWorkers(workers: PreparedWorker[]): void {
  const pending = new Set(workers.map(w => w.name));
  const session = getSession();

  // Wait for initial startup
  Bun.sleepSync(5000);

  for (let round = 0; round < 8 && pending.size > 0; round++) {
    for (const name of [...pending]) {
      const pane = run(["tmux", "capture-pane", "-t", `${session}:${name}`, "-p"]);
      const text = pane.stdout.toLowerCase();
      if (text.includes("text style") || text.includes("dark mode")) {
        run(["tmux", "send-keys", "-t", `${session}:${name}`, "", "Enter"]);
      } else if (
        text.includes("select login method") ||
        text.includes("claude account with subscription")
      ) {
        run(["tmux", "send-keys", "-t", `${session}:${name}`, "", "Enter"]);
      } else if (
        text.includes("trust") ||
        text.includes("syntax highlighting") ||
        text.includes("get started")
      ) {
        run(["tmux", "send-keys", "-t", `${session}:${name}`, "", "Enter"]);
      } else if (text.includes("❯") || text.includes(">")) {
        pending.delete(name);
      }
    }
    if (pending.size > 0) Bun.sleepSync(3000);
  }
}

/** Phase 4: Send init prompts to all workers */
function sendInitPrompts(workers: PreparedWorker[], args: LaunchArgs): void {
  // Load channel map once
  let channels: Record<string, string> = {};
  try {
    const channelsPath = join(getStateDir(), "gateway", "channels.json");
    if (existsSync(channelsPath)) {
      channels = JSON.parse(readFileSync(channelsPath, "utf8"));
    }
  } catch {}

  const session = getSession();
  for (const w of workers) {
    const workerChannelId = channels[w.name] ?? args.channelId;
    const domainLabel = w.domain ? ` specializing in ${w.domain}` : "";
    const initPrompt =
      w.role === "manager"
        ? `You are ${w.name}, the Hive coordinator for project repo: ${args.projectRepo}. Your Discord channel ID is ${workerChannelId}. IMPORTANT: ALWAYS use this channel ID (${workerChannelId}) as the chat_id when calling discord__reply — never use a channel ID from an incoming message. This is YOUR channel. Read state/agents.json to learn each agent's name, role, and domain. First, announce yourself on Discord with "STATUS | ${w.name} | - | READY" followed by a brief message with personality — you're the coordinator, set the tone for the team. Then wait for agents to announce themselves as READY. You do NOT start work autonomously — wait for the user to tell you what to build. When instructed, decompose the project into tasks and assign them to agents by name.`
        : `You are ${w.name} (${w.role}${domainLabel}) on a Hive team with a coordinator and other agents. Your Discord channel ID is ${workerChannelId} — ALWAYS use this numeric ID (${workerChannelId}) as the chat_id when calling discord__reply, never use a channel ID from incoming messages. Announce yourself as READY on Discord with personality (see your system prompt for details) and wait for task assignment.`;
    run(["tmux", "send-keys", "-t", `${session}:${w.name}`, initPrompt, "Enter"]);
  }
  console.log(`[hive] Sent init prompts to ${workers.length} agents`);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

function resolveTokenSafe(): string | null {
  try {
    // Try env first, then config file
    if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;
    const envFile = join(homedir(), ".claude/channels/discord/.env");
    if (existsSync(envFile)) {
      const content = readFileSync(envFile, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("DISCORD_BOT_TOKEN=")) {
          const val = trimmed.slice("DISCORD_BOT_TOKEN=".length);
          if (val) return val;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function doTeardown(clean: boolean): void {
  // Clean up Discord channels BEFORE killing gateway/tmux
  if (clean) {
    try {
      const token = resolveTokenSafe();
      const channelsPath = join(getStateDir(), "gateway", "channels.json");
      const gwConfigPath = join(getStateDir(), "gateway", "config.json");
      if (token && existsSync(channelsPath) && existsSync(gwConfigPath)) {
        const channels: Record<string, string> = JSON.parse(readFileSync(channelsPath, "utf8"));
        const gwConfig = JSON.parse(readFileSync(gwConfigPath, "utf8"));
        for (const channelId of Object.values(channels)) {
          run([
            "curl",
            "-s",
            "-X",
            "DELETE",
            "-H",
            `Authorization: Bot ${token}`,
            `https://discord.com/api/v10/channels/${channelId}`,
          ]);
        }
        // Delete conversation channels (new format: keyed by channelId)
        const convChannelsPath = join(getStateDir(), "gateway", "conversation-channels.json");
        const taskChannelsPath = join(getStateDir(), "gateway", "task-channels.json");
        if (existsSync(convChannelsPath)) {
          try {
            const convChannels: Record<string, unknown> = JSON.parse(
              readFileSync(convChannelsPath, "utf8"),
            );
            const channelIds = Object.keys(convChannels);
            for (const channelId of channelIds) {
              run([
                "curl",
                "-s",
                "-X",
                "DELETE",
                "-H",
                `Authorization: Bot ${token}`,
                `https://discord.com/api/v10/channels/${channelId}`,
              ]);
            }
            console.log(`[hive] Deleted ${channelIds.length} conversation channel(s)`);
            unlinkSync(convChannelsPath);
          } catch (e) {
            console.warn(`[hive] Warning: failed to clean up conversation channels: ${e}`);
          }
        } else if (existsSync(taskChannelsPath)) {
          // Fallback: backward compatibility with old task-channels.json format (keyed by taskId)
          try {
            const taskChannels: Record<string, string> = JSON.parse(
              readFileSync(taskChannelsPath, "utf8"),
            );
            for (const channelId of Object.values(taskChannels)) {
              run([
                "curl",
                "-s",
                "-X",
                "DELETE",
                "-H",
                `Authorization: Bot ${token}`,
                `https://discord.com/api/v10/channels/${channelId}`,
              ]);
            }
            console.log(
              `[hive] Deleted ${Object.keys(taskChannels).length} task channel(s) (legacy)`,
            );
            unlinkSync(taskChannelsPath);
          } catch (e) {
            console.warn(`[hive] Warning: failed to clean up task channels: ${e}`);
          }
        }
        if (gwConfig.categoryId) {
          run([
            "curl",
            "-s",
            "-X",
            "DELETE",
            "-H",
            `Authorization: Bot ${token}`,
            `https://discord.com/api/v10/channels/${gwConfig.categoryId}`,
          ]);
        }
        console.log("[hive] Deleted Discord worker channels");
      }
    } catch {
      /* best-effort cleanup */
    }
  }

  // 1. Deregister workers from shared gateway
  const masterSocket = getMasterSocket();
  const deregResult = run([
    "curl", "-s", "-X", "POST",
    "--unix-socket", masterSocket,
    "-H", "Content-Type: application/json",
    "-d", JSON.stringify({ session: getSession() }),
    "http://localhost/deregister",
  ]);
  if (deregResult.exitCode === 0) {
    console.log(`[hive] Deregistered workers for session ${getSession()}`);
  }

  // Check if other sessions are still using the gateway
  const healthResult = run([
    "curl", "-s", "--unix-socket", masterSocket,
    "http://localhost/health",
  ]);
  let otherSessionsExist = false;
  if (healthResult.exitCode === 0 && healthResult.stdout) {
    try {
      const health = JSON.parse(healthResult.stdout);
      // If there are still registered workers from other sessions, keep the gateway alive
      if (health.registeredWorkers > 0) {
        otherSessionsExist = true;
        console.log(`[hive] Gateway still serving other sessions — keeping alive`);
      }
    } catch {}
  }

  // 2. Kill mind daemon (tmux kill-session in step 3 handles workers)
  const pidFile = join(HIVE_DIR, ".hive/mind/daemon.pid");
  if (existsSync(pidFile)) {
    try {
      const pidData = JSON.parse(readFileSync(pidFile, "utf8"));
      const pid = pidData.pid;
      if (pid) {
        run(["kill", String(pid)]);
        Bun.sleepSync(2000);
        run(["kill", "-9", String(pid)]);
        console.log(`[hive] Stopped mind daemon (PID ${pid})`);
      }
    } catch {
      /* pid file unreadable */
    }
  }

  // 3. Kill tmux session (or just worker windows if gateway is shared)
  if (otherSessionsExist) {
    // Kill all windows except gateway to preserve shared gateway for other sessions
    const windowList = run(["tmux", "list-windows", "-t", getSession(), "-F", "#{window_name}"]);
    if (windowList.exitCode === 0) {
      for (const windowName of windowList.stdout.split("\n").filter(Boolean)) {
        if (windowName === "gateway") continue;
        run(["tmux", "kill-window", "-t", `${getSession()}:${windowName}`]);
      }
    }
    console.log(`[hive] Killed worker windows (gateway preserved for other sessions)`);
  } else {
    // No other sessions — kill everything
    const tmuxResult = run(["tmux", "kill-session", "-t", getSession()]);
    if (tmuxResult.exitCode === 0) {
      console.log(`[hive] Killed tmux session '${getSession()}'`);
    }
    // Remove master gateway socket dir
    const masterDir = getMasterGatewayDir();
    if (existsSync(masterDir)) {
      run(["rm", "-rf", masterDir]);
    }
  }

  // 4. Remove per-project relay socket dir
  if (existsSync(getGatewayDir())) {
    run(["rm", "-rf", getGatewayDir()]);
  }

  // 5. Remove launch scripts, prompt files, and stale container configs
  if (existsSync(getStateDir())) {
    try {
      for (const f of readdirSync(getStateDir())) {
        if (
          (f.startsWith(".launch-") && f.endsWith(".sh")) ||
          (f.startsWith(".prompt-") && f.endsWith(".md")) ||
          f.startsWith(".container-")
        ) {
          unlinkSync(join(getStateDir(), f));
        }
      }
    } catch {
      /* state dir may not exist */
    }
  }

  // 6. Update agents.json statuses
  if (existsSync(getAgentsJsonPath())) {
    try {
      const data = JSON.parse(readFileSync(getAgentsJsonPath(), "utf8")) as AgentsJson;
      const now = new Date().toISOString();
      data.agents = data.agents.map((a) => ({ ...a, status: "stopped", lastActive: now }));
      writeFileSync(getAgentsJsonPath(), `${JSON.stringify(data, null, 2)}\n`);
    } catch {
      /* ignore */
    }
  }

  // 7. Clear pids.json
  if (existsSync(getPidsJsonPath())) {
    writeFileSync(getPidsJsonPath(), "{}\n");
  }

  if (clean) {
    // Remove worktrees and prune stale git references
    if (existsSync(worktreesDir)) {
      // Find the parent repo by reading a worktree's .git file before deletion
      let parentRepo: string | null = null;
      try {
        for (const name of readdirSync(worktreesDir)) {
          const dotGitPath = join(worktreesDir, name, ".git");
          if (existsSync(dotGitPath)) {
            const content = readFileSync(dotGitPath, "utf8").trim();
            if (content.startsWith("gitdir: ")) {
              // gitdir points to .git/worktrees/<name> — walk up to find repo root
              const gitDir = content.slice(8);
              const worktreeParent = join(gitDir, "..", "..", "..");
              if (existsSync(join(worktreeParent, ".git"))) {
                parentRepo = resolve(worktreeParent);
                break;
              }
            }
          }
        }
      } catch {
        /* best-effort */
      }

      run(["rm", "-rf", worktreesDir]);
      console.log("[hive] Removed worktrees");

      // Prune stale worktree references from the parent repo
      if (parentRepo) {
        run(["git", "-C", parentRepo, "worktree", "prune"]);
        console.log("[hive] Pruned stale git worktree references");
      }
    }
    // Clean active-worktree state (per-story worktree mappings)
    const activeWtDir = join(HIVE_DIR, ".hive/active-worktree");
    if (existsSync(activeWtDir)) {
      run(["rm", "-rf", activeWtDir]);
      console.log("[hive] Cleaned active-worktree state");
    }

    // Clean ephemeral mind state (preserve durable knowledge)
    const mindDir = join(HIVE_DIR, ".hive/mind");
    if (existsSync(mindDir)) {
      for (const sub of ["pending", "inbox", "watches", "readers"]) {
        run(["rm", "-rf", join(mindDir, sub)]);
      }
      console.log("[hive] Cleaned ephemeral mind state");
    }
  }

  console.log("[hive] Teardown complete");
}

// ---------------------------------------------------------------------------
// Config generation (delegates to gen-config.ts exports)
// ---------------------------------------------------------------------------

function generateConfigs(names: string[], roles: Map<string, string>, args: LaunchArgs): void {
  // Parse tool overrides
  const toolOverrides = new Map<string, ToolOverride>();
  if (args.tools) {
    const specs = args.tools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const spec of specs) {
      const colon = spec.indexOf(":");
      if (colon === -1) continue;
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

      const tools = toolSpec
        .split("+")
        .map((s) => s.trim())
        .filter(Boolean);
      toolOverrides.set(agentName, { mode, tools });
    }
  }

  // Load tool definitions and secrets
  const toolsDir = join(configDir, "tools");
  const profilesDir = join(configDir, "tool-profiles");
  const secretsPath = join(configDir, "secrets.env");
  const toolDefs = loadToolDefinitions(toolsDir);
  const secrets = loadSecrets(secretsPath);

  // Gateway worker list for gateway config
  const gatewayWorkers = names.map((name) => {
    const role = roles.get(name) ?? "engineer";
    const domain = args.domains.get(name);
    const isManager = role === "manager";
    const isOracle = role === "product";
    const isSpokesperson = isManager || isOracle;
    return {
      workerId: name,
      socketPath: `${getGatewayDir()}/${name}.sock`,
      channelId: "",
      mentionPatterns: isSpokesperson ? [name, "hive"] : [name, "all-workers"],
      requireMention: !isSpokesperson,
      role,
      ...(domain ? { domain } : {}),
      ...(isSpokesperson ? { isSpokesperson: true } : {}),
    };
  });

  // Write gateway config
  const gatewayConfigDir = join(getStateDir(), "gateway");
  ensureDir(gatewayConfigDir);
  writeJson(join(gatewayConfigDir, "config.json"), {
    botToken: "(from DISCORD_BOT_TOKEN env var)",
    botId: "(auto-discovered at runtime)",
    channelId: args.channelId,
    dashboardChannelId: args.channelId,
    guildId: "",
    socketPath: getMasterSocket(),
    workers: gatewayWorkers,
  });

  // Load global settings once for all agents (OMC hooks + MCP servers)
  const globalSettings = loadGlobalSettings();

  // Per-agent configs (including manager)
  for (const name of names) {
    const workerDir = join(getStateDir(), "workers", name);
    ensureDir(workerDir);
    const role = roles.get(name) ?? "engineer";
    const isManager = role === "manager";
    const isOracle = role === "product";
    const isSpokesperson = isManager || isOracle;
    const roleTools = resolveToolsForRole(
      role,
      name,
      toolDefs,
      profilesDir,
      secrets,
      toolOverrides,
    );

    writeJson(
      join(workerDir, "mcp-config.json"),
      buildRelayMcpConfig(
        workerDir,
        name,
        `${getGatewayDir()}/${name}.sock`,
        args.channelId,
        isSpokesperson ? `${name},hive` : `${name},all-workers`,
        !isSpokesperson,
        roleTools,
        getMasterSocket(),
        globalSettings.mcpServers,
        role,
      ),
    );

    // Settings with scope enforcement hook + merged global OMC hooks (skip for no-worktree roles)
    if (!NO_WORKTREE_ROLES.has(role)) {
      const mergedHooks: Record<string, unknown[]> = {};

      // Start with global hooks (OMC hooks from ~/.claude/settings.json)
      if (globalSettings.hooks) {
        for (const [event, entries] of Object.entries(globalSettings.hooks)) {
          mergedHooks[event] = [...(entries as unknown[])];
        }
      }

      // Add scope enforcement hook to PreToolUse
      if (!mergedHooks.PreToolUse) mergedHooks.PreToolUse = [];
      mergedHooks.PreToolUse.push({
        matcher: "Write|Edit|Bash",
        hooks: [
          {
            type: "command",
            command: `node "${join(HIVE_DIR, "hooks", "check-scope.mjs")}"`,
          },
        ],
      });

      // Block AskUserQuestion — agents must use Discord instead
      mergedHooks.PreToolUse.push({
        matcher: "AskUserQuestion",
        hooks: [
          {
            type: "command",
            command: `node "${join(HIVE_DIR, "hooks", "intercept-ask-user.mjs")}"`,
          },
        ],
      });

      // OMC mode enforcement hook (Write|Edit only)
      mergedHooks.PreToolUse.push({
        matcher: "Write|Edit",
        hooks: [
          {
            type: "command",
            command: `node "${join(HIVE_DIR, "hooks", "enforce-omc-mode.mjs")}"`,
          },
        ],
      });

      // PostToolUse inbox polling — check for unread messages after every tool call
      if (!mergedHooks.PostToolUse) mergedHooks.PostToolUse = [];
      mergedHooks.PostToolUse.push({
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `node "${join(HIVE_DIR, "hooks", "check-inbox.mjs")}"`,
          },
        ],
      });

      // Stop hooks — agent liveness and recovery
      if (!mergedHooks.Stop) mergedHooks.Stop = [];

      // Layer 1: Block stop when agent has active (non-terminal) task contracts
      mergedHooks.Stop.push({
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `node "${join(HIVE_DIR, "hooks", "keep-working.mjs")}"`,
          },
        ],
      });

      // Layer 2: Session-end safety net — mark orphaned tasks FAILED on true session death
      mergedHooks.Stop.push({
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `node "${join(HIVE_DIR, "hooks", "session-end.mjs")}"`,
          },
        ],
      });

      writeJson(join(workerDir, "settings.json"), { hooks: mergedHooks });
    }
  }

  // Write agents.json
  writeAgentsJson(getStateDir(), names, roles, getAgentsJsonPath(), args.domains);

  console.log(`[hive] Generated configs for ${names.length} agents`);
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

async function launchHive(args: LaunchArgs): Promise<void> {
  const token = resolveToken(args);

  // Resolve agent names
  if (args.agents.length === 0) {
    args.agents = ["worker-01", "worker-02", "worker-03"];
  }
  validateAgentNames(args.agents);

  // Migration check: manager must be in agents list with manager role
  if (!args.agents.some((a) => args.roles.get(a) === "manager")) {
    throw new Error(
      'No agent with role "manager" found. Since v0.3, the manager must be in the agents list.\n' +
        'Update your config: agents: "manager,alice,bob,carol", roles: "manager:manager,..."',
    );
  }

  // Generate configs
  generateConfigs(args.agents, args.roles, args);

  // AC6: Per-story worktrees — worktrees are created at task_accept time, not launch time.
  // The createWorktrees function is retained for backward compatibility but no longer called here.

  // Launch gateway
  launchGateway(token);

  // Register workers with the shared gateway
  registerWorkers(args.agents, args.roles, args.domains);

  // Fetch per-worker channel IDs from gateway
  let workerChannels: Record<string, string> = {};
  const masterSocket = getMasterSocket();
  const channelsRes = run([
    "curl",
    "-s",
    "--unix-socket",
    masterSocket,
    `http://localhost/channels?session=${encodeURIComponent(getSession())}`,
  ]);
  if (channelsRes.exitCode === 0 && channelsRes.stdout) {
    try {
      workerChannels = JSON.parse(channelsRes.stdout).channels ?? {};
      console.log(`[hive] Fetched ${Object.keys(workerChannels).length} channel IDs from gateway`);
    } catch {
      console.warn(
        "[hive] Warning: failed to parse /channels response — workers will use dashboard channel ID",
      );
    }
  }

  // Regenerate MCP configs with real per-worker channel IDs
  if (Object.keys(workerChannels).length > 0) {
    const toolsDir = join(configDir, "tools");
    const profilesDir = join(configDir, "tool-profiles");
    const secretsPath = join(configDir, "secrets.env");
    const toolDefs = loadToolDefinitions(toolsDir);
    const secrets = loadSecrets(secretsPath);
    const toolOverrides = new Map<string, ToolOverride>();

    // Update all agent MCP configs (including manager)
    for (const name of args.agents) {
      const channelId = workerChannels[name] ?? args.channelId;
      const workerDir = join(getStateDir(), "workers", name);
      const role = args.roles.get(name) ?? "engineer";
      const isManager = role === "manager";
      const isOracle = role === "product";
      const isSpokesperson = isManager || isOracle;
      const roleTools = resolveToolsForRole(
        role,
        name,
        toolDefs,
        profilesDir,
        secrets,
        toolOverrides,
      );
      writeJson(
        join(workerDir, "mcp-config.json"),
        buildRelayMcpConfig(
          workerDir,
          name,
          `${getGatewayDir()}/${name}.sock`,
          channelId,
          isSpokesperson ? `${name},hive` : `${name},all-workers`,
          !isSpokesperson,
          roleTools,
          getMasterSocket(),
          loadGlobalSettings().mcpServers,
          role,
        ),
      );
    }

    console.log("[hive] Regenerated MCP configs with per-worker channel IDs");
  }

  // Launch mind daemon
  launchMind();

  // Build team roster for prompt injection
  const team: TeamMember[] = args.agents.map((n) => ({
    name: n,
    role: args.roles.get(n) ?? "engineer",
    domain: args.domains.get(n),
  }));

  // Launch workers — phased for parallel startup
  // Phase 1: Prepare all configs and scripts
  const prepared: PreparedWorker[] = args.agents.map(name => {
    const role = args.roles.get(name) ?? "engineer";
    const domain = args.domains.get(name);
    return prepareWorker(name, role, domain, args, team);
  });

  // Phase 2: Spawn all tmux windows (fast, no sleeps between them)
  for (const w of prepared) spawnWorkerWindow(w);

  // Phase 3: Handle onboarding for all agents in parallel rounds
  onboardWorkers(prepared);

  // Phase 4: Send init prompts to all agents
  sendInitPrompts(prepared, args);

  // Write pids.json
  writeJson(getPidsJsonPath(), {
    mode: "tmux",
    session: getSession(),
    started: new Date().toISOString(),
    workers: args.agents.length,
  });

  console.log(`[hive] Hive '${getSession()}' launched: ${args.agents.length} agents.`);
  console.log(`[hive] Attach with: tmux attach -t ${getSession()}`);
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/** Direct launch with CLI args */
export async function main(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (parsed.teardown) {
    doTeardown(parsed.clean);
    return;
  }

  if (!parsed.projectRepo) throw new Error("--project-repo is required");
  if (!parsed.channelId) throw new Error("--channel-id is required");

  await launchHive(parsed);
}

/** Resolve project config, set env vars, call main */
export async function projectUp(args: string[]): Promise<void> {
  const projectName = args[0];
  if (!projectName) throw new Error("Project name required: hive up <project>");

  // Set per-project isolation env vars (read by paths.ts getters)
  process.env.HIVE_SESSION = `hive-${projectName}`;
  process.env.HIVE_PROJECT = projectName;
  // Per-project relay socket path (used for MCP relay configs, not the shared gateway)
  process.env.HIVE_GATEWAY_SOCKET = `/tmp/hive-gateway-${projectName}/gateway.sock`;
  process.env.HIVE_STATE_DIR = join(HIVE_DIR, "state", projectName);

  const config = loadConfig();
  const project = resolveProject(config, projectName);

  if (project.admin_ids) process.env.HIVE_ADMIN_IDS = project.admin_ids;

  const cliArgs: string[] = ["--project-repo", project.repo, "--channel-id", project.channel];
  if (project.agents) cliArgs.push("--agents", project.agents);
  if (project.roles) cliArgs.push("--roles", project.roles);
  if (project.token) cliArgs.push("--token", project.token);
  if (project.tools) cliArgs.push("--tools", project.tools);

  await main(cliArgs);
}

/** Resolve project config, set env vars, call doTeardown */
export async function projectDown(args: string[]): Promise<void> {
  const projectName = args.find((a) => !a.startsWith("-"));
  if (projectName) {
    process.env.HIVE_SESSION = `hive-${projectName}`;
    process.env.HIVE_GATEWAY_SOCKET = `/tmp/hive-gateway-${projectName}/gateway.sock`;
    process.env.HIVE_STATE_DIR = join(HIVE_DIR, "state", projectName);
  }
  doTeardown(args.includes("--clean"));
}

/** Teardown --clean, remove state, call projectUp */
export async function projectFresh(args: string[]): Promise<void> {
  // Set env vars BEFORE teardown so it targets the correct project state
  const projectName = args.find((a) => !a.startsWith("-"));
  if (projectName) {
    process.env.HIVE_SESSION = `hive-${projectName}`;
    process.env.HIVE_GATEWAY_SOCKET = `/tmp/hive-gateway-${projectName}/gateway.sock`;
    process.env.HIVE_STATE_DIR = join(HIVE_DIR, "state", projectName);
  }

  doTeardown(true);

  // Remove state dir contents (but keep the directory)
  if (existsSync(getStateDir())) {
    run(["rm", "-rf", getStateDir()]);
    ensureDir(getStateDir());
  }

  await projectUp(args);
}
