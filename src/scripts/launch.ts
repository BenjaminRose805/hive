/**
 * src/scripts/launch.ts
 * TypeScript replacement for launch.sh — orchestrates a full Hive swarm.
 * Manages tmux session with gateway, mind daemon, manager, and workers.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, copyFileSync, chmodSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { HIVE_DIR, getSession, getGatewaySocket, getGatewayDir, getStateDir, getAgentsJsonPath, getPidsJsonPath, worktreesDir, configDir } from '../shared/paths.ts'
import { run, runOrDie } from '../shared/subprocess.ts'
import { validateSafeName, validateAgentNames, parseAgentAssignment, validateRole, validateDomain } from '../shared/validation.ts'
import { loadConfig, resolveProject } from '../shared/project-config.ts'
import { NO_WORKTREE_ROLES, type AgentsJson } from '../shared/agent-types.ts'
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
  domains: Map<string, string>
  personalities: Record<string, string>
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
    domains: new Map(),
    personalities: {},
    token: '',
    tools: '',
    teardown: false,
    clean: false,
  }

  // Load personalities from env (set by projectUp from config.json)
  if (process.env.HIVE_PERSONALITIES) {
    try { args.personalities = JSON.parse(process.env.HIVE_PERSONALITIES) } catch {}
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
          const { name, role, domain } = parseAgentAssignment(pair)
          validateRole(role)
          if (domain) validateDomain(domain)
          args.roles.set(name, role)
          if (domain) args.domains.set(name, domain)
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
// Gateway
// ---------------------------------------------------------------------------

function launchGateway(token: string): string {
  const scriptPath = join(getStateDir(), '.launch-gateway.sh')
  // Single-quoted heredoc prevents expansion; token passed via env
  const script = `#!/usr/bin/env bash
export DISCORD_BOT_TOKEN='${token.replace(/'/g, "'\\''")}'
export HIVE_DIR='${HIVE_DIR}'
export HIVE_GATEWAY_SOCKET='${getGatewaySocket()}'
export HIVE_STATE_DIR='${getStateDir()}'
bun run "$HIVE_DIR/bin/hive-gateway.ts" 2>&1
echo "[hive] Gateway exited with code $?"
read -p "Press enter to close..."
`
  writeFileSync(scriptPath, script)
  chmodSync(scriptPath, 0o700)

  // Kill any existing session and stale gateway socket
  run(['tmux', 'kill-session', '-t', getSession()])
  // Fuser kills any process holding the socket file
  run(['fuser', '-k', getGatewaySocket()])
  Bun.sleepSync(1000)
  // Clean stale socket directory (not just socket — removes stale worker sockets too)
  if (existsSync(getGatewayDir())) {
    run(['rm', '-rf', getGatewayDir()])
  }
  // Remove hive sessions from tmux-resurrect save files to prevent tmux-continuum
  // from auto-restoring stale windows when a new tmux server starts
  for (const dir of [join(homedir(), '.local/share/tmux/resurrect'), join(homedir(), '.tmux/resurrect')]) {
    if (!existsSync(dir)) continue
    // Use sed for reliable tab-delimited line removal
    run(['sed', '-i', '/hive/d', ...readdirSync(dir).filter(f => f.endsWith('.txt')).map(f => join(dir, f))])
  }
  runOrDie(['tmux', 'new-session', '-d', '-s', getSession(), '-n', 'gateway', scriptPath])
  console.log('[hive] Gateway starting...')

  // Give gateway time to start before polling
  Bun.sleepSync(5000)

  // Health check loop (30s timeout)
  for (let attempt = 0; attempt < 30; attempt++) {
    const health = run(['curl', '-s', '--unix-socket', getGatewaySocket(), 'http://localhost/health'])
    if (health.exitCode === 0 && health.stdout) {
      try {
        const json = JSON.parse(health.stdout)
        const botId = json.botId ?? ''
        console.log(`[hive] Gateway ready (${json.connectedAs ?? 'connected'})`)
        return botId
      } catch { /* not valid JSON yet */ }
    }
    // After 10s of polling, check if gateway process died
    if (attempt > 10) {
      const paneCheck = run(['tmux', 'capture-pane', '-t', `${getSession()}:gateway`, '-p'])
      if (paneCheck.stdout.includes('[hive] Gateway exited')) {
        throw new Error('Gateway process crashed. Check: tmux attach -t ' + getSession())
      }
    }
    Bun.sleepSync(1000)
  }
  throw new Error('Gateway health check timed out after 30s')
}

// ---------------------------------------------------------------------------
// Mind daemon
// ---------------------------------------------------------------------------

function launchMind(): void {
  const scriptPath = join(getStateDir(), '.launch-mind.sh')
  const script = `#!/usr/bin/env bash
export HIVE_STATE_DIR='${getStateDir()}'
bun run "${HIVE_DIR}/bin/hive-mind.ts" daemon 2>&1
`
  writeFileSync(scriptPath, script)
  chmodSync(scriptPath, 0o700)

  runOrDie(['tmux', 'new-window', '-t', getSession(), '-n', 'mind', scriptPath])
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

interface TeamMember {
  name: string
  role: string
  domain?: string
}

function buildTeamRoster(self: string, members: TeamMember[]): string {
  const lines = ['## Your Team', '', '| Agent | Role | Domain | Worktree |', '|-------|------|--------|----------|']
  for (const m of members) {
    const you = m.name === self ? ' **(you)**' : ''
    const domain = m.domain ?? '(generalist)'
    const wt = NO_WORKTREE_ROLES.has(m.role) ? 'no (read-only)' : 'yes'
    lines.push(`| ${m.name}${you} | ${m.role} | ${domain} | ${wt} |`)
  }
  lines.push('', '**Who to ask for what:**')
  // Group by role for quick reference
  const byRole = new Map<string, TeamMember[]>()
  for (const m of members) {
    if (m.name === self) continue
    const list = byRole.get(m.role) ?? []
    list.push(m)
    byRole.set(m.role, list)
  }
  for (const [role, agents] of byRole) {
    const names = agents.map(a => `${a.name}${a.domain ? ` (${a.domain})` : ''}`).join(', ')
    switch (role) {
      case 'manager': lines.push(`- **Coordination, task changes, blockers** → ${names}`); break
      case 'architect': lines.push(`- **Design questions, contracts, trade-offs** → ${names}`); break
      case 'engineer': lines.push(`- **Implementation help, code questions** → ${names}`); break
      case 'qa': lines.push(`- **Testing, verification, bug reports** → ${names}`); break
      case 'reviewer': lines.push(`- **Code review, security audit, quality** → ${names}`); break
      case 'devops': lines.push(`- **Build, CI/CD, deployment issues** → ${names}`); break
      case 'writer': lines.push(`- **Documentation, guides, API docs** → ${names}`); break
    }
  }
  return lines.join('\n')
}

function composeSystemPrompt(name: string, role: string, domain?: string, team?: TeamMember[], personality?: string): string {
  const domainLabel = domain ? ` specializing in ${domain}` : ''
  const sub = (text: string) => text
    .replaceAll('{NAME}', name)
    .replaceAll('{ROLE}', role + domainLabel)
    .replaceAll('{DOMAIN}', domain ?? '')

  // Base worker prompt
  const workerPromptPath = join(configDir, 'prompts/worker-system-prompt.md')
  let prompt = sub(readFileSync(workerPromptPath, 'utf8'))

  // Base profile (always included)
  const baseProfilePath = join(configDir, 'prompts/profiles/_base.md')
  if (existsSync(baseProfilePath)) {
    prompt += '\n\n' + sub(readFileSync(baseProfilePath, 'utf8'))
  }

  // Worktree-specific sections (branch discipline, scope enforcement, completion protocol)
  if (!NO_WORKTREE_ROLES.has(role)) {
    const worktreeSectionsPath = join(configDir, 'prompts/worktree-sections.md')
    if (existsSync(worktreeSectionsPath)) {
      prompt += '\n\n' + sub(readFileSync(worktreeSectionsPath, 'utf8'))
    }
  }

  // Role prompt (from config/prompts/roles/)
  const rolePath = join(configDir, `prompts/roles/${role}.md`)
  if (existsSync(rolePath)) {
    prompt += '\n\n' + sub(readFileSync(rolePath, 'utf8'))
  }

  // Domain prompt (from config/prompts/domains/)
  if (domain) {
    const domainPath = join(configDir, `prompts/domains/${domain}.md`)
    if (existsSync(domainPath)) {
      prompt += '\n\n' + sub(readFileSync(domainPath, 'utf8'))
    }
  }

  // Team roster (so every agent knows who's on the team)
  if (team && team.length > 0) {
    prompt += '\n\n' + buildTeamRoster(name, team)
  }

  // Agent personality (individual character on top of role voice)
  if (personality) {
    prompt += '\n\n## Your Personality\n\n'
    prompt += `You are **${name}**. ${personality}\n\n`
    prompt += 'Let this personality color your announcements, status updates, and peer messages. '
    prompt += 'Stay professional in protocol messages (TASK_ASSIGN, COMPLETE, etc.) but let your character show in casual communication and your READY announcement.'
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
// Claude binary resolution
// ---------------------------------------------------------------------------

/** Find the global claude binary, skipping any local node_modules shadows */
function resolveClaudePath(): string {
  const result = run(['which', '-a', 'claude'])
  if (result.exitCode === 0) {
    const globalPath = result.stdout.split('\n').find(p => p.trim() && !p.includes('node_modules'))
    if (globalPath) return globalPath.trim()
  }
  return 'claude'
}

// ---------------------------------------------------------------------------
// Worker launch
// ---------------------------------------------------------------------------

function launchWorker(name: string, role: string, domain: string | undefined, personality: string | undefined, args: LaunchArgs, team: TeamMember[]): void {
  validateSafeName(name)
  validateSafeName(role)

  const isNoWorktreeRole = NO_WORKTREE_ROLES.has(role)
  // No-worktree roles work from the project repo directly; worktree roles get their own directory
  const workDir = isNoWorktreeRole ? resolve(args.projectRepo) : join(worktreesDir, name)

  // Compose and write system prompt
  const prompt = composeSystemPrompt(name, role, domain, team, personality)
  const promptFile = join(getStateDir(), `.prompt-${name}.md`)
  writeFileSync(promptFile, prompt)

  // Install pre-commit hook (worktree roles only — worktree .git is a file pointing to real gitdir)
  if (!isNoWorktreeRole) {
    const dotGitPath = join(workDir, '.git')
    if (existsSync(dotGitPath)) {
      const dotGit = readFileSync(dotGitPath, 'utf8').trim()
      const gitDir = dotGit.startsWith('gitdir: ') ? dotGit.slice(8) : dotGitPath
      const hooksDir = join(gitDir, 'hooks')
      ensureDir(hooksDir)
      const hookDest = join(hooksDir, 'pre-commit')
      copyFileSync(join(HIVE_DIR, 'hooks/pre-commit-scope.sh'), hookDest)
      chmodSync(hookDest, 0o755)
    }
  }

  // Write launch script (host-direct)
  const scriptPath = join(getStateDir(), `.launch-worker-${name}.sh`)
  const settingsPath = join(getStateDir(), 'workers', name, 'settings.json')
  const settingsFlag = existsSync(settingsPath) ? `\\\n  --settings "${settingsPath}"` : ''
  const script = `#!/usr/bin/env bash
# Prevent parent Claude Code from suppressing child instances
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT
export HIVE_WORKER_ID='${name}'
export HIVE_ROOT='${workDir}'
cd '${workDir}'
'${resolveClaudePath()}' --name "hive-${name}" \\
  --append-system-prompt-file '${promptFile}' \\
  --mcp-config "${join(getStateDir(), 'workers', name, 'mcp-config.json')}" \\
  --strict-mcp-config ${settingsFlag} \\
  --permission-mode bypassPermissions
`
  writeFileSync(scriptPath, script)
  chmodSync(scriptPath, 0o700)

  // Launch in tmux
  runOrDie(['tmux', 'new-window', '-t', getSession(), '-n', name, scriptPath])
  Bun.sleepSync(5000)

  // Handle onboarding prompts (theme picker, preview confirmation, trust)
  // Each step: capture pane, detect prompt, send input, wait
  for (let step = 0; step < 5; step++) {
    const pane = run(['tmux', 'capture-pane', '-t', `${getSession()}:${name}`, '-p'])
    const text = pane.stdout.toLowerCase()
    if (text.includes('text style') || text.includes('dark mode')) {
      // Theme picker — option 1 (dark mode) is pre-selected, just press Enter
      run(['tmux', 'send-keys', '-t', `${getSession()}:${name}`, '', 'Enter'])
    } else if (text.includes('select login method') || text.includes('claude account with subscription')) {
      // Login method — select option 1 (subscription)
      run(['tmux', 'send-keys', '-t', `${getSession()}:${name}`, '', 'Enter'])
    } else if (text.includes('trust') || text.includes('syntax highlighting') || text.includes('get started')) {
      // Preview confirmation or trust prompt — press Enter to proceed
      run(['tmux', 'send-keys', '-t', `${getSession()}:${name}`, '', 'Enter'])
    } else if (text.includes('❯') || text.includes('>')) {
      // Claude Code interactive prompt reached
      break
    }
    Bun.sleepSync(3000)
  }

  // Send init prompt
  // Read per-worker channel ID from gateway channels.json if available
  let workerChannelId = args.channelId
  try {
    const channelsPath = join(getStateDir(), 'gateway', 'channels.json')
    if (existsSync(channelsPath)) {
      const channels = JSON.parse(readFileSync(channelsPath, 'utf8'))
      if (channels[name]) workerChannelId = channels[name]
    }
  } catch {}
  const domainLabel = domain ? ` specializing in ${domain}` : ''
  const initPrompt = role === 'manager'
    ? `You are ${name}, the Hive coordinator for project repo: ${args.projectRepo}. Your Discord channel ID is ${workerChannelId}. IMPORTANT: ALWAYS use this channel ID (${workerChannelId}) as the chat_id when calling discord__reply — never use a channel ID from an incoming message. This is YOUR channel. Read state/agents.json to learn each agent's name, role, and domain. First, announce yourself on Discord with "STATUS | ${name} | - | READY" followed by a brief message with personality — you're the coordinator, set the tone for the team. Then wait for agents to announce themselves as READY. You do NOT start work autonomously — wait for the user to tell you what to build. When instructed, decompose the project into tasks and assign them to agents by name.`
    : `You are ${name} (${role}${domainLabel}) on a Hive team with a coordinator and other agents. Your Discord channel ID is ${workerChannelId} — ALWAYS use this numeric ID (${workerChannelId}) as the chat_id when calling discord__reply, never use a channel ID from incoming messages. Announce yourself as READY on Discord with personality (see your system prompt for details) and wait for task assignment.`
  run(['tmux', 'send-keys', '-t', `${getSession()}:${name}`, initPrompt, 'Enter'])

  console.log(`[hive] Started ${name} (${role})`)
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

function resolveTokenSafe(): string | null {
  try {
    // Try env first, then config file
    if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN
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
    return null
  } catch { return null }
}

function doTeardown(clean: boolean): void {
  // Clean up Discord channels BEFORE killing gateway/tmux
  if (clean) {
    try {
      const token = resolveTokenSafe()
      const channelsPath = join(getStateDir(), 'gateway', 'channels.json')
      const gwConfigPath = join(getStateDir(), 'gateway', 'config.json')
      if (token && existsSync(channelsPath) && existsSync(gwConfigPath)) {
        const channels: Record<string, string> = JSON.parse(readFileSync(channelsPath, 'utf8'))
        const gwConfig = JSON.parse(readFileSync(gwConfigPath, 'utf8'))
        for (const channelId of Object.values(channels)) {
          run(['curl', '-s', '-X', 'DELETE', '-H', `Authorization: Bot ${token}`,
            `https://discord.com/api/v10/channels/${channelId}`])
        }
        // Delete conversation channels (new format: keyed by channelId)
        const convChannelsPath = join(getStateDir(), 'gateway', 'conversation-channels.json')
        const taskChannelsPath = join(getStateDir(), 'gateway', 'task-channels.json')
        if (existsSync(convChannelsPath)) {
          try {
            const convChannels: Record<string, unknown> = JSON.parse(readFileSync(convChannelsPath, 'utf8'))
            const channelIds = Object.keys(convChannels)
            for (const channelId of channelIds) {
              run(['curl', '-s', '-X', 'DELETE',
                '-H', `Authorization: Bot ${token}`,
                `https://discord.com/api/v10/channels/${channelId}`])
            }
            console.log(`[hive] Deleted ${channelIds.length} conversation channel(s)`)
            unlinkSync(convChannelsPath)
          } catch (e) {
            console.warn(`[hive] Warning: failed to clean up conversation channels: ${e}`)
          }
        } else if (existsSync(taskChannelsPath)) {
          // Fallback: backward compatibility with old task-channels.json format (keyed by taskId)
          try {
            const taskChannels: Record<string, string> = JSON.parse(readFileSync(taskChannelsPath, 'utf8'))
            for (const channelId of Object.values(taskChannels)) {
              run(['curl', '-s', '-X', 'DELETE',
                '-H', `Authorization: Bot ${token}`,
                `https://discord.com/api/v10/channels/${channelId}`])
            }
            console.log(`[hive] Deleted ${Object.keys(taskChannels).length} task channel(s) (legacy)`)
            unlinkSync(taskChannelsPath)
          } catch (e) {
            console.warn(`[hive] Warning: failed to clean up task channels: ${e}`)
          }
        }
        if (gwConfig.categoryId) {
          run(['curl', '-s', '-X', 'DELETE', '-H', `Authorization: Bot ${token}`,
            `https://discord.com/api/v10/channels/${gwConfig.categoryId}`])
        }
        console.log('[hive] Deleted Discord worker channels')
      }
    } catch { /* best-effort cleanup */ }
  }

  // 1. Kill mind daemon (tmux kill-session in step 2 handles workers)
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

  // 2. Kill tmux session (terminates all worker processes)
  const tmuxResult = run(['tmux', 'kill-session', '-t', getSession()])
  if (tmuxResult.exitCode === 0) {
    console.log(`[hive] Killed tmux session '${getSession()}'`)
  }

  // 3. Remove gateway socket dir
  if (existsSync(getGatewayDir())) {
    run(['rm', '-rf', getGatewayDir()])
  }

  // 4. Remove launch scripts, prompt files, and stale container configs
  if (existsSync(getStateDir())) {
    try {
      for (const f of readdirSync(getStateDir())) {
        if (f.startsWith('.launch-') && f.endsWith('.sh') || f.startsWith('.prompt-') && f.endsWith('.md') || f.startsWith('.container-')) {
          unlinkSync(join(getStateDir(), f))
        }
      }
    } catch { /* state dir may not exist */ }
  }

  // 5. Update agents.json statuses
  if (existsSync(getAgentsJsonPath())) {
    try {
      const data = JSON.parse(readFileSync(getAgentsJsonPath(), 'utf8')) as AgentsJson
      const now = new Date().toISOString()
      data.agents = data.agents.map(a => ({ ...a, status: 'stopped', lastActive: now }))
      writeFileSync(getAgentsJsonPath(), JSON.stringify(data, null, 2) + '\n')
    } catch { /* ignore */ }
  }

  // 6. Clear pids.json
  if (existsSync(getPidsJsonPath())) {
    writeFileSync(getPidsJsonPath(), '{}\n')
  }

  if (clean) {
    // Remove worktrees and prune stale git references
    if (existsSync(worktreesDir)) {
      // Find the parent repo by reading a worktree's .git file before deletion
      let parentRepo: string | null = null
      try {
        for (const name of readdirSync(worktreesDir)) {
          const dotGitPath = join(worktreesDir, name, '.git')
          if (existsSync(dotGitPath)) {
            const content = readFileSync(dotGitPath, 'utf8').trim()
            if (content.startsWith('gitdir: ')) {
              // gitdir points to .git/worktrees/<name> — walk up to find repo root
              const gitDir = content.slice(8)
              const worktreeParent = join(gitDir, '..', '..', '..')
              if (existsSync(join(worktreeParent, '.git'))) {
                parentRepo = resolve(worktreeParent)
                break
              }
            }
          }
        }
      } catch { /* best-effort */ }

      run(['rm', '-rf', worktreesDir])
      console.log('[hive] Removed worktrees')

      // Prune stale worktree references from the parent repo
      if (parentRepo) {
        run(['git', '-C', parentRepo, 'worktree', 'prune'])
        console.log('[hive] Pruned stale git worktree references')
      }
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
  const gatewayWorkers = names.map(name => {
    const role = roles.get(name) ?? 'engineer'
    const domain = args.domains.get(name)
    const isManager = role === 'manager'
    return {
      workerId: name,
      socketPath: `${getGatewayDir()}/${name}.sock`,
      channelId: '',
      mentionPatterns: isManager ? [name, 'hive'] : [name, 'all-workers'],
      requireMention: !isManager,
      role,
      ...(domain ? { domain } : {}),
    }
  })

  // Write gateway config
  const gatewayConfigDir = join(getStateDir(), 'gateway')
  ensureDir(gatewayConfigDir)
  writeJson(join(gatewayConfigDir, 'config.json'), {
    botToken: '(from DISCORD_BOT_TOKEN env var)',
    botId: '(auto-discovered at runtime)',
    channelId: args.channelId,
    dashboardChannelId: args.channelId,
    guildId: '',
    socketPath: getGatewaySocket(),
    workers: gatewayWorkers,
  })

  // Per-agent configs (including manager)
  for (const name of names) {
    const workerDir = join(getStateDir(), 'workers', name)
    ensureDir(workerDir)
    const role = roles.get(name) ?? 'engineer'
    const isManager = role === 'manager'
    const roleTools = resolveToolsForRole(role, name, toolDefs, profilesDir, secrets, toolOverrides)

    writeJson(join(workerDir, 'mcp-config.json'), buildRelayMcpConfig(
      workerDir, name, `${getGatewayDir()}/${name}.sock`, args.channelId,
      isManager ? `${name},hive` : `${name},all-workers`, !isManager, roleTools, getGatewaySocket(),
    ))

    // Settings with scope enforcement hook (skip for no-worktree roles)
    if (!NO_WORKTREE_ROLES.has(role)) {
      writeJson(join(workerDir, 'settings.json'), {
        hooks: {
          PreToolUse: [{
            matcher: 'Write|Edit|Bash',
            hooks: [{ type: 'command', command: `node "${join(HIVE_DIR, 'hooks', 'check-scope.mjs')}"` }],
          }],
        },
      })
    }
  }

  // Write agents.json
  writeAgentsJson(getStateDir(), names, roles, getAgentsJsonPath(), args.domains)

  console.log(`[hive] Generated configs for ${names.length} agents`)
}

// ---------------------------------------------------------------------------
// Worktree creation
// ---------------------------------------------------------------------------

function createWorktrees(names: string[], roles: Map<string, string>, repo: string, branchPrefix: string): void {
  for (const name of names) {
    const role = roles.get(name) ?? 'engineer'
    if (NO_WORKTREE_ROLES.has(role)) continue
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

  // Migration check: manager must be in agents list with manager role
  if (!args.agents.some(a => args.roles.get(a) === 'manager')) {
    throw new Error(
      'No agent with role "manager" found. Since v0.3, the manager must be in the agents list.\n' +
      'Update your config: agents: "manager,alice,bob,carol", roles: "manager:manager,..."'
    )
  }

  const branchPrefix = args.agents.some(n => !n.startsWith('worker-')) ? 'hive/' : 'hive/worker-'

  // Generate configs
  generateConfigs(args.agents, args.roles, args)

  // Create worktrees (skip for no-worktree roles like manager, architect, reviewer)
  if (args.projectRepo) {
    createWorktrees(args.agents, args.roles, resolve(args.projectRepo), branchPrefix)
  }

  // Launch gateway
  launchGateway(token)

  // Fetch per-worker channel IDs from gateway
  let workerChannels: Record<string, string> = {}
  const channelsRes = run(['curl', '-s', '--unix-socket', getGatewaySocket(), 'http://localhost/channels'])
  if (channelsRes.exitCode === 0 && channelsRes.stdout) {
    try {
      workerChannels = JSON.parse(channelsRes.stdout).channels ?? {}
      console.log(`[hive] Fetched ${Object.keys(workerChannels).length} channel IDs from gateway`)
    } catch {
      console.warn('[hive] Warning: failed to parse /channels response — workers will use dashboard channel ID')
    }
  }

  // Regenerate MCP configs with real per-worker channel IDs
  if (Object.keys(workerChannels).length > 0) {
    const toolsDir = join(configDir, 'tools')
    const profilesDir = join(configDir, 'tool-profiles')
    const secretsPath = join(configDir, 'secrets.env')
    const toolDefs = loadToolDefinitions(toolsDir)
    const secrets = loadSecrets(secretsPath)
    const toolOverrides = new Map<string, ToolOverride>()

    // Update all agent MCP configs (including manager)
    for (const name of args.agents) {
      const channelId = workerChannels[name] ?? args.channelId
      const workerDir = join(getStateDir(), 'workers', name)
      const role = args.roles.get(name) ?? 'engineer'
      const isManager = role === 'manager'
      const roleTools = resolveToolsForRole(role, name, toolDefs, profilesDir, secrets, toolOverrides)
      writeJson(join(workerDir, 'mcp-config.json'), buildRelayMcpConfig(
        workerDir, name, `${getGatewayDir()}/${name}.sock`, channelId,
        isManager ? `${name},hive` : `${name},all-workers`, !isManager, roleTools, getGatewaySocket(),
      ))
    }

    console.log('[hive] Regenerated MCP configs with per-worker channel IDs')
  }

  // Launch mind daemon
  launchMind()

  // Build team roster for prompt injection
  const team: TeamMember[] = args.agents.map(n => ({
    name: n,
    role: args.roles.get(n) ?? 'engineer',
    domain: args.domains.get(n),
  }))

  // Launch workers
  for (const name of args.agents) {
    const role = args.roles.get(name) ?? 'engineer'
    const domain = args.domains.get(name)
    const personality = args.personalities[name]
    launchWorker(name, role, domain, personality, args, team)
  }

  // Write pids.json
  writeJson(getPidsJsonPath(), {
    mode: 'tmux',
    session: getSession(),
    started: new Date().toISOString(),
    workers: args.agents.length,
  })

  console.log(`[hive] Hive '${getSession()}' launched: ${args.agents.length} agents.`)
  console.log(`[hive] Attach with: tmux attach -t ${getSession()}`)
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

  // Set per-project isolation env vars (read by paths.ts getters)
  process.env.HIVE_SESSION = `hive-${projectName}`
  process.env.HIVE_GATEWAY_SOCKET = `/tmp/hive-gateway-${projectName}/gateway.sock`
  process.env.HIVE_STATE_DIR = join(HIVE_DIR, 'state', projectName)

  const config = loadConfig()
  const project = resolveProject(config, projectName)

  if (project.admin_ids) process.env.HIVE_ADMIN_IDS = project.admin_ids
  if (project.personalities) process.env.HIVE_PERSONALITIES = JSON.stringify(project.personalities)

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

/** Resolve project config, set env vars, call doTeardown */
export async function projectDown(args: string[]): Promise<void> {
  const projectName = args.find(a => !a.startsWith('-'))
  if (projectName) {
    process.env.HIVE_SESSION = `hive-${projectName}`
    process.env.HIVE_GATEWAY_SOCKET = `/tmp/hive-gateway-${projectName}/gateway.sock`
    process.env.HIVE_STATE_DIR = join(HIVE_DIR, 'state', projectName)
  }
  doTeardown(args.includes('--clean'))
}

/** Teardown --clean, remove state, call projectUp */
export async function projectFresh(args: string[]): Promise<void> {
  doTeardown(true)

  // Remove state dir contents (but keep the directory)
  if (existsSync(getStateDir())) {
    run(['rm', '-rf', getStateDir()])
    ensureDir(getStateDir())
  }

  await projectUp(args)
}
