/**
 * src/scripts/launch.ts
 * TypeScript replacement for launch.sh — orchestrates a full Hive swarm.
 * Manages tmux session with gateway, mind daemon, manager, and Docker-isolated workers.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, copyFileSync, chmodSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { HIVE_DIR, SESSION, GATEWAY_SOCKET, GATEWAY_DIR, stateDir, worktreesDir, configDir, agentsJsonPath, pidsJsonPath } from '../shared/paths.ts'
import { run, runOrDie } from '../shared/subprocess.ts'
import { validateSafeName, validateAgentNames } from '../shared/validation.ts'
import { loadConfig, resolveProject } from '../shared/project-config.ts'
import type { AgentsJson } from '../shared/agent-types.ts'
import {
  buildRelayMcpConfig,
  resolveToolsForRole,
  loadToolDefinitions,
  loadSecrets,
  writeAgentsJson,
  addWorktree,
  ensureDir,
  writeJson,
  type ToolOverride,
} from '../gen-config.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LaunchArgs {
  projectRepo: string
  channelId: string
  agents: string[]
  roles: Map<string, string>
  token: string
  tools: string
  teardown: boolean
  clean: boolean
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): LaunchArgs {
  const args: LaunchArgs = {
    projectRepo: '',
    channelId: '',
    agents: [],
    roles: new Map(),
    token: '',
    tools: '',
    teardown: false,
    clean: false,
  }

  let i = 0
  while (i < argv.length) {
    const flag = argv[i]
    switch (flag) {
      case '--project-repo':
        args.projectRepo = argv[++i]
        break
      case '--channel-id':
        args.channelId = argv[++i]
        break
      case '--agents':
        args.agents = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
        break
      case '--roles': {
        const pairs = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
        for (const pair of pairs) {
          const colon = pair.indexOf(':')
          if (colon !== -1) {
            args.roles.set(pair.slice(0, colon).trim(), pair.slice(colon + 1).trim())
          }
        }
        break
      }
      case '--token':
        args.token = argv[++i]
        break
      case '--tools':
        args.tools = argv[++i]
        break
      case '--teardown':
        args.teardown = true
        break
      case '--clean':
        args.clean = true
        break
      default:
        throw new Error(`Unknown argument: ${flag}`)
    }
    i++
  }

  return args
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

function resolveToken(args: LaunchArgs): string {
  // 1. CLI arg
  if (args.token) return args.token
  // 2. Environment variable
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN
  // 3. Auto-read from discord channel config
  const envFile = join(homedir(), '.claude/channels/discord/.env')
  if (existsSync(envFile)) {
    const content = readFileSync(envFile, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('DISCORD_BOT_TOKEN=')) {
        const val = trimmed.slice('DISCORD_BOT_TOKEN='.length)
        if (val) return val
      }
    }
  }
  throw new Error('Bot token required: pass --token, set DISCORD_BOT_TOKEN, or add it to ~/.claude/channels/discord/.env')
}

// ---------------------------------------------------------------------------
// Docker image
// ---------------------------------------------------------------------------

function buildWorkerImage(): void {
  console.log('[hive] Building worker image...')
  runOrDie(['docker', 'build', '-t', 'hive-worker', HIVE_DIR])
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

function launchGateway(token: string): string {
  const scriptPath = join(stateDir, '.launch-gateway.sh')
  // Single-quoted heredoc prevents expansion; token passed via env
  const script = `#!/usr/bin/env bash
export DISCORD_BOT_TOKEN='${token.replace(/'/g, "'\\''")}'
export HIVE_DIR='${HIVE_DIR}'
bun run "$HIVE_DIR/bin/hive-gateway.ts" 2>&1
`
  writeFileSync(scriptPath, script)
  chmodSync(scriptPath, 0o700)

  // Kill any existing session
  run(['tmux', 'kill-session', '-t', SESSION])
  runOrDie(['tmux', 'new-session', '-d', '-s', SESSION, '-n', 'gateway', scriptPath])
  console.log('[hive] Gateway starting...')

  // Health check loop (30s timeout)
  for (let attempt = 0; attempt < 30; attempt++) {
    const health = run(['curl', '-s', '--unix-socket', GATEWAY_SOCKET, 'http://localhost/health'])
    if (health.exitCode === 0 && health.stdout) {
      try {
        const json = JSON.parse(health.stdout)
        const botId = json.botId ?? ''
        console.log(`[hive] Gateway ready (${json.connectedAs ?? 'connected'})`)
        return botId
      } catch { /* not valid JSON yet */ }
    }
    // Check window still alive
    const windowCheck = run(['tmux', 'list-windows', '-t', SESSION])
    if (!windowCheck.stdout.includes('gateway')) {
      throw new Error('Gateway tmux window died during startup')
    }
    Bun.sleepSync(1000)
  }
  throw new Error('Gateway health check timed out after 30s')
}

// ---------------------------------------------------------------------------
// Mind daemon
// ---------------------------------------------------------------------------

function launchMind(): void {
  const scriptPath = join(stateDir, '.launch-mind.sh')
  const script = `#!/usr/bin/env bash
bun run "${HIVE_DIR}/bin/hive-mind.ts" daemon 2>&1
`
  writeFileSync(scriptPath, script)
  chmodSync(scriptPath, 0o700)

  runOrDie(['tmux', 'new-window', '-t', SESSION, '-n', 'mind', scriptPath])
  console.log('[hive] Mind daemon starting...')

  // Wait for daemon.pid (5s)
  const pidFile = join(HIVE_DIR, '.hive/mind/daemon.pid')
  for (let i = 0; i < 5; i++) {
    if (existsSync(pidFile)) {
      console.log('[hive] Mind daemon ready')
      return
    }
    Bun.sleepSync(1000)
  }
}

// ---------------------------------------------------------------------------
// System prompt composition
// ---------------------------------------------------------------------------

function composeSystemPrompt(name: string, role: string): string {
  const sub = (text: string) => text.replaceAll('{NAME}', name).replaceAll('{ROLE}', role)

  // Base worker prompt
  const workerPromptPath = join(configDir, 'prompts/worker-system-prompt.md')
  let prompt = sub(readFileSync(workerPromptPath, 'utf8'))

  // Base profile (always included)
  const baseProfilePath = join(configDir, 'prompts/profiles/_base.md')
  prompt += '\n\n' + sub(readFileSync(baseProfilePath, 'utf8'))

  // Role profile (if exists)
  const roleProfilePath = join(configDir, `prompts/profiles/${role}.md`)
  if (existsSync(roleProfilePath)) {
    prompt += '\n\n' + sub(readFileSync(roleProfilePath, 'utf8'))
  }

  // Mind prompt section
  const mindSectionPath = join(configDir, 'prompts/mind-prompt-section.md')
  if (existsSync(mindSectionPath)) {
    prompt += '\n\n' + readFileSync(mindSectionPath, 'utf8').replaceAll('{NAME}', name)
  }

  // Mind restoration block
  const mindLoad = run(['bun', 'run', join(HIVE_DIR, 'bin/hive-mind.ts'), 'load', '--agent', name])
  if (mindLoad.exitCode === 0 && mindLoad.stdout) {
    prompt += '\n\n' + mindLoad.stdout
  }

  return prompt
}

// ---------------------------------------------------------------------------
// Worker launch
// ---------------------------------------------------------------------------

function launchWorker(name: string, role: string, args: LaunchArgs): void {
  validateSafeName(name)
  validateSafeName(role)

  const worktreeDir = join(worktreesDir, name)

  // Compose and write system prompt
  const prompt = composeSystemPrompt(name, role)
  const promptFile = join(stateDir, `.prompt-${name}.md`)
  writeFileSync(promptFile, prompt)

  // Install pre-commit hook
  const hookDest = join(worktreeDir, '.git/hooks/pre-commit')
  copyFileSync(join(HIVE_DIR, 'hooks/pre-commit-scope.sh'), hookDest)
  chmodSync(hookDest, 0o755)

  // Write launch script
  const scriptPath = join(stateDir, `.launch-worker-${name}.sh`)
  const script = `#!/usr/bin/env bash
docker rm -f "hive-${name}" 2>/dev/null || true
docker run -d --name "hive-${name}" \\
  --network=none \\
  -v "${worktreeDir}:/workspace" \\
  -v "${configDir}:/config:ro" \\
  -v "${GATEWAY_DIR}:/gateway:rw" \\
  -v "${promptFile}:/tmp/system-prompt.md:ro" \\
  -v "${stateDir}/workers/${name}:/state:ro" \\
  -e CLAUDE_API_KEY \\
  -e ANTHROPIC_API_KEY \\
  -e "HIVE_WORKER_ID=${name}" \\
  -e "HIVE_ROOT=/workspace" \\
  hive-worker \\
    --name "hive-${name}" \\
    --append-system-prompt "$(cat /tmp/system-prompt.md)" \\
    --mcp-config "/state/mcp-config.json" \\
    --strict-mcp-config \\
    --settings "/state/settings.json" \\
    --permission-mode bypassPermissions
`
  writeFileSync(scriptPath, script)
  chmodSync(scriptPath, 0o700)

  // Launch in tmux
  runOrDie(['tmux', 'new-window', '-t', SESSION, '-n', name, scriptPath])
  Bun.sleepSync(2000)

  // Attach to the container
  run(['tmux', 'send-keys', '-t', `${SESSION}:${name}`, `docker attach hive-${name}`, 'Enter'])
  Bun.sleepSync(3000)

  // Send init prompt
  const initPrompt = `You are ${name} (${role}) on a Hive team with a coordinator (mention 'manager') and other agents. Your Discord channel ID is ${args.channelId} — always use this numeric ID with Discord tools. You can message any team member by mentioning their name. Announce yourself as READY on Discord and wait for task assignment.`
  run(['tmux', 'send-keys', '-t', `${SESSION}:${name}`, initPrompt, 'Enter'])

  console.log(`[hive] Started ${name} (${role})`)
}

// ---------------------------------------------------------------------------
// Manager launch
// ---------------------------------------------------------------------------

function launchManager(args: LaunchArgs): void {
  // Build team list from agents.json
  const agentsData = JSON.parse(readFileSync(agentsJsonPath, 'utf8')) as AgentsJson
  const teamList = agentsData.agents.map(a => `${a.name} (${a.role ?? 'developer'})`).join(', ')

  const scriptPath = join(stateDir, '.launch-manager.sh')
  const script = `#!/usr/bin/env bash
claude --name "hive-manager" \\
  --append-system-prompt "$(cat "${configDir}/prompts/manager-system-prompt.md")" \\
  --mcp-config "${stateDir}/manager/mcp-config.json" \\
  --permission-mode bypassPermissions
`
  writeFileSync(scriptPath, script)
  chmodSync(scriptPath, 0o700)

  runOrDie(['tmux', 'new-window', '-t', SESSION, '-n', 'manager', scriptPath])
  Bun.sleepSync(5000)

  const initPrompt = `You are the Hive coordinator for project repo: ${args.projectRepo}. Your team: ${teamList}. Channel ID: ${args.channelId}. You do NOT start work autonomously — wait for the user to tell you what to build. Read state/agents.json to learn each agent's name and role. Agents will announce themselves as READY on Discord. When instructed, decompose the project into tasks and assign them to agents by name.`
  run(['tmux', 'send-keys', '-t', `${SESSION}:manager`, initPrompt, 'Enter'])

  console.log('[hive] Manager started')
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

function doTeardown(clean: boolean): void {
  // 1. Stop all hive-* Docker containers
  const containers = run(['docker', 'ps', '-q', '--filter', 'name=hive-'])
  if (containers.stdout) {
    for (const id of containers.stdout.split('\n').filter(Boolean)) {
      const nameResult = run(['docker', 'inspect', '--format', '{{.Name}}', id])
      run(['docker', 'stop', id])
      run(['docker', 'rm', id])
      console.log(`[hive] Stopped container ${nameResult.stdout.replace(/^\//, '')}`)
    }
  }

  // 2. Kill mind daemon
  const pidFile = join(HIVE_DIR, '.hive/mind/daemon.pid')
  if (existsSync(pidFile)) {
    try {
      const pidData = JSON.parse(readFileSync(pidFile, 'utf8'))
      const pid = pidData.pid
      if (pid) {
        run(['kill', String(pid)])
        Bun.sleepSync(2000)
        run(['kill', '-9', String(pid)])
        console.log(`[hive] Stopped mind daemon (PID ${pid})`)
      }
    } catch { /* pid file unreadable */ }
  }

  // 3. Kill tmux session
  const tmuxResult = run(['tmux', 'kill-session', '-t', SESSION])
  if (tmuxResult.exitCode === 0) {
    console.log(`[hive] Killed tmux session '${SESSION}'`)
  }

  // 4. Remove gateway socket dir
  if (existsSync(GATEWAY_DIR)) {
    run(['rm', '-rf', GATEWAY_DIR])
  }

  // 5. Remove launch scripts and prompt files
  if (existsSync(stateDir)) {
    try {
      for (const f of readdirSync(stateDir)) {
        if (f.startsWith('.launch-') && f.endsWith('.sh') || f.startsWith('.prompt-') && f.endsWith('.md')) {
          unlinkSync(join(stateDir, f))
        }
      }
    } catch { /* state dir may not exist */ }
  }

  // 6. Update agents.json statuses
  if (existsSync(agentsJsonPath)) {
    try {
      const data = JSON.parse(readFileSync(agentsJsonPath, 'utf8')) as AgentsJson
      const now = new Date().toISOString()
      data.agents = data.agents.map(a => ({ ...a, status: 'stopped', lastActive: now }))
      writeFileSync(agentsJsonPath, JSON.stringify(data, null, 2) + '\n')
    } catch { /* ignore */ }
  }

  // 7. Clear pids.json
  if (existsSync(pidsJsonPath)) {
    writeFileSync(pidsJsonPath, '{}\n')
  }

  if (clean) {
    // Remove worktrees
    if (existsSync(worktreesDir)) {
      run(['rm', '-rf', worktreesDir])
      console.log('[hive] Removed worktrees')
    }
    // Clean ephemeral mind state (preserve durable knowledge)
    const mindDir = join(HIVE_DIR, '.hive/mind')
    if (existsSync(mindDir)) {
      for (const sub of ['pending', 'inbox', 'watches', 'readers']) {
        run(['rm', '-rf', join(mindDir, sub)])
      }
      console.log('[hive] Cleaned ephemeral mind state')
    }
  }

  console.log('[hive] Teardown complete')
}

// ---------------------------------------------------------------------------
// Config generation (delegates to gen-config.ts exports)
// ---------------------------------------------------------------------------

function generateConfigs(names: string[], roles: Map<string, string>, args: LaunchArgs): void {
  // Parse tool overrides
  const toolOverrides = new Map<string, ToolOverride>()
  if (args.tools) {
    const specs = args.tools.split(',').map(s => s.trim()).filter(Boolean)
    for (const spec of specs) {
      const colon = spec.indexOf(':')
      if (colon === -1) continue
      const agentName = spec.slice(0, colon).trim()
      let toolSpec = spec.slice(colon + 1).trim()

      let mode: 'add' | 'remove' | 'replace' = 'add'
      if (toolSpec.startsWith('=')) { mode = 'replace'; toolSpec = toolSpec.slice(1) }
      else if (toolSpec.startsWith('-')) { mode = 'remove'; toolSpec = toolSpec.slice(1) }
      else if (toolSpec.startsWith('+')) { toolSpec = toolSpec.slice(1) }

      const tools = toolSpec.split('+').map(s => s.trim()).filter(Boolean)
      toolOverrides.set(agentName, { mode, tools })
    }
  }

  // Load tool definitions and secrets
  const toolsDir = join(configDir, 'tools')
  const profilesDir = join(configDir, 'tool-profiles')
  const secretsPath = join(configDir, 'secrets.env')
  const toolDefs = loadToolDefinitions(toolsDir)
  const secrets = loadSecrets(secretsPath)

  // Gateway worker list for gateway config
  const gatewayWorkers = [
    { workerId: 'manager', socketPath: `${GATEWAY_DIR}/manager.sock`, mentionPatterns: ['manager', 'hive'], requireMention: false },
    ...names.map(name => ({ workerId: name, socketPath: `${GATEWAY_DIR}/${name}.sock`, mentionPatterns: [name, 'all-workers'], requireMention: true })),
  ]

  // Write gateway config
  const gatewayConfigDir = join(stateDir, 'gateway')
  ensureDir(gatewayConfigDir)
  writeJson(join(gatewayConfigDir, 'config.json'), {
    botToken: '(from DISCORD_BOT_TOKEN env var)',
    botId: '(auto-discovered at runtime)',
    channelId: args.channelId,
    socketPath: GATEWAY_SOCKET,
    workers: gatewayWorkers,
  })

  // Manager config
  const managerDir = join(stateDir, 'manager')
  ensureDir(managerDir)
  const managerTools = resolveToolsForRole('manager', 'manager', toolDefs, profilesDir, secrets, toolOverrides)
  writeJson(join(managerDir, 'mcp-config.json'), buildRelayMcpConfig(
    managerDir, 'manager', `${GATEWAY_DIR}/manager.sock`, args.channelId,
    'manager,hive', false, managerTools, GATEWAY_SOCKET,
  ))

  // Per-worker configs
  for (const name of names) {
    const workerDir = join(stateDir, 'workers', name)
    ensureDir(workerDir)
    const role = roles.get(name) ?? 'developer'
    const roleTools = resolveToolsForRole(role, name, toolDefs, profilesDir, secrets, toolOverrides)

    writeJson(join(workerDir, 'mcp-config.json'), buildRelayMcpConfig(
      workerDir, name, `${GATEWAY_DIR}/${name}.sock`, args.channelId,
      `${name},all-workers`, true, roleTools, GATEWAY_SOCKET,
    ))

    // Settings with scope enforcement hook
    writeJson(join(workerDir, 'settings.json'), {
      hooks: {
        PreToolUse: [{
          matcher: 'Write|Edit|Bash',
          hooks: [{ type: 'command', command: `node "${join(HIVE_DIR, 'hooks', 'check-scope.mjs')}"` }],
        }],
      },
    })
  }

  // Write agents.json
  writeAgentsJson(stateDir, names, roles, agentsJsonPath)

  console.log(`[hive] Generated configs for ${names.length} agents`)
}

// ---------------------------------------------------------------------------
// Worktree creation
// ---------------------------------------------------------------------------

function createWorktrees(names: string[], repo: string, branchPrefix: string): void {
  for (const name of names) {
    const worktreePath = join(worktreesDir, name)
    const branch = `${branchPrefix}${name}`
    addWorktree(repo, worktreePath, branch)
  }
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

async function launchHive(args: LaunchArgs): Promise<void> {
  const token = resolveToken(args)

  // Resolve agent names
  if (args.agents.length === 0) {
    args.agents = ['worker-01', 'worker-02', 'worker-03']
  }
  validateAgentNames(args.agents)

  const branchPrefix = args.agents.some(n => !n.startsWith('worker-')) ? 'hive/' : 'hive/worker-'

  // Build Docker image
  buildWorkerImage()

  // Generate configs
  generateConfigs(args.agents, args.roles, args)

  // Create worktrees
  if (args.projectRepo) {
    createWorktrees(args.agents, resolve(args.projectRepo), branchPrefix)
  }

  // Launch gateway
  launchGateway(token)

  // Launch mind daemon
  launchMind()

  // Launch manager
  launchManager(args)

  // Launch workers
  for (const name of args.agents) {
    const role = args.roles.get(name) ?? 'developer'
    launchWorker(name, role, args)
  }

  // Write pids.json
  writeJson(pidsJsonPath, {
    mode: 'tmux',
    session: SESSION,
    started: new Date().toISOString(),
    workers: args.agents.length,
  })

  console.log(`[hive] Hive '${SESSION}' launched: ${args.agents.length} agents. tmux attach -t ${SESSION}`)
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/** Direct launch with CLI args */
export async function main(args: string[]): Promise<void> {
  const parsed = parseArgs(args)

  if (parsed.teardown) {
    doTeardown(parsed.clean)
    return
  }

  if (!parsed.projectRepo) throw new Error('--project-repo is required')
  if (!parsed.channelId) throw new Error('--channel-id is required')

  await launchHive(parsed)
}

/** Resolve project config, set env vars, call main */
export async function projectUp(args: string[]): Promise<void> {
  const projectName = args[0]
  if (!projectName) throw new Error('Project name required: hive up <project>')

  const config = loadConfig()
  const project = resolveProject(config, projectName)

  const cliArgs: string[] = [
    '--project-repo', project.repo,
    '--channel-id', project.channel,
  ]
  if (project.agents) cliArgs.push('--agents', project.agents)
  if (project.roles) cliArgs.push('--roles', project.roles)
  if (project.token) cliArgs.push('--token', project.token)
  if (project.tools) cliArgs.push('--tools', project.tools)

  await main(cliArgs)
}

/** Resolve project config, call doTeardown */
export async function projectDown(args: string[]): Promise<void> {
  doTeardown(args.includes('--clean'))
}

/** Teardown --clean, remove state, call projectUp */
export async function projectFresh(args: string[]): Promise<void> {
  doTeardown(true)

  // Remove state dir contents (but keep the directory)
  if (existsSync(stateDir)) {
    run(['rm', '-rf', stateDir])
    ensureDir(stateDir)
  }

  await projectUp(args)
}
