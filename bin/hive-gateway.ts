#!/usr/bin/env bun
/**
 * hive-gateway.ts
 *
 * Standalone Bun process that owns a single Discord gateway connection and
 * multiplexes messages to/from registered worker processes over local HTTP
 * via a Unix domain socket.
 *
 * Workers register themselves at startup, declaring which channel they care
 * about and whether they require @-mentions. Inbound Discord messages are
 * routed to matching workers; outbound tool calls (send, react, edit, fetch,
 * download) are proxied through the gateway's single bot connection.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  type Message,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { mkdirSync, existsSync, unlinkSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import type { DeltaFile } from '../src/mind/mind-types.ts'
import { parseHeader, parseBody, extractAgentsList } from '../src/gateway/protocol-parser.ts'
import { ThreadManager } from '../src/gateway/thread-manager.ts'
import { shouldDeliver, type WorkerInfo } from '../src/gateway/selective-router.ts'
import { MessageType } from '../src/gateway/types.ts'
import type { AgentEntry, AgentsJson } from '../src/shared/agent-types.ts'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOKEN = process.env.DISCORD_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write('hive-gateway: DISCORD_BOT_TOKEN is required\n')
  process.exit(1)
}

const SOCKET_PATH = process.env.HIVE_GATEWAY_SOCKET ?? '/tmp/hive-gateway/gateway.sock'
const GATEWAY_DIR = dirname(SOCKET_PATH)
const INBOX_DIR = join(GATEWAY_DIR, 'inbox')
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_CHUNK = 2000

// HIVE_ROOT is the project root (directory containing bin/, state/, worktrees/)
const HIVE_ROOT = import.meta.dir ? join(import.meta.dir, '..') : process.cwd()
const AGENTS_JSON = join(HIVE_ROOT, 'state', 'agents.json')

const ADMIN_USER_IDS = new Set(
  (process.env.HIVE_ADMIN_IDS ?? '').split(',').filter(Boolean)
)

function checkAdmin(interaction: ChatInputCommandInteraction): boolean {
  if (ADMIN_USER_IDS.size === 0) return true
  return ADMIN_USER_IDS.has(interaction.user.id)
}
const threadManager = new ThreadManager(HIVE_ROOT)

// ---------------------------------------------------------------------------
// Agent process tracking
// ---------------------------------------------------------------------------

interface AgentProcess {
  process: unknown  // Bun.spawn result or docker run metadata
  pid: number       // 0 for container-managed agents
  startedAt: Date
}

const agentProcesses = new Map<string, AgentProcess>()

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
})

// ---------------------------------------------------------------------------
// Recent sent IDs — central set for reply-to-bot detection
// ---------------------------------------------------------------------------

const recentSentIds = new Set<string>()
const RECENT_SENT_CAP = 200

function noteSent(id: string): void {
  recentSentIds.add(id)
  if (recentSentIds.size > RECENT_SENT_CAP) {
    const first = recentSentIds.values().next().value
    if (first) recentSentIds.delete(first)
  }
}

const selfSendNonces = new Map<string, string>() // nonce → senderWorkerId

function registerSelfSend(nonce: string, senderId: string): void {
  selfSendNonces.set(nonce, senderId)
  setTimeout(() => selfSendNonces.delete(nonce), 30_000)
}

// ---------------------------------------------------------------------------
// Text chunking — split on paragraph boundaries, same algorithm as server.ts
// ---------------------------------------------------------------------------

function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    // Prefer last double-newline (paragraph), then single newline, then space.
    // Fall back to hard cut.
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para
      : line > limit / 2 ? line
      : space > 0 ? space
      : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ---------------------------------------------------------------------------
// Worker Registry
// ---------------------------------------------------------------------------

interface WorkerEntry {
  workerId: string
  endpoint: string
  mentionPatterns: string[]
  channelId: string
  requireMention: boolean
  failCount: number
}

const workers = new Map<string, WorkerEntry>()

// ---------------------------------------------------------------------------
// Channel helper
// ---------------------------------------------------------------------------

async function fetchTextChannel(id: string) {
  const ch = await client.channels.fetch(id)
  if (!ch || !ch.isTextBased()) {
    throw new Error(`channel ${id} not found or not text-based`)
  }
  return ch
}

// ---------------------------------------------------------------------------
// Inbound message routing
// ---------------------------------------------------------------------------

async function isMentioned(msg: Message, mentionPatterns: string[]): Promise<boolean> {
  // Direct @mention
  if (client.user && msg.mentions.has(client.user)) return true

  // Reply to one of our recent messages = implicit mention
  const refId = msg.reference?.messageId
  if (refId && recentSentIds.has(refId)) return true

  // Literal string matching (case-insensitive) — no regex to avoid ReDoS
  for (const pat of mentionPatterns) {
    if (msg.content.toLowerCase().includes(pat.toLowerCase())) return true
  }

  return false
}

client.on('messageCreate', (msg) => {
  if (msg.author.bot && msg.author.id !== client.user?.id) return // ignore other bots

  let excludeSender: string | undefined
  if (msg.author.id === client.user?.id) {
    const nonce = (msg as any).nonce as string | undefined
    if (nonce && selfSendNonces.has(nonce)) {
      excludeSender = selfSendNonces.get(nonce)!
      selfSendNonces.delete(nonce)
    } else {
      return // unknown self-message, drop to prevent loops
    }
  }

  routeInbound(msg, excludeSender).catch((e) =>
    process.stderr.write(`hive-gateway: routeInbound error: ${e}\n`),
  )
})

client.on('threadDelete', (thread) => {
  // Clean up any thread mappings when a thread is externally deleted
  const allMappings = threadManager.getAll()
  for (const mapping of allMappings) {
    if (mapping.threadId === thread.id) {
      threadManager.removeThread(mapping.taskId)
      process.stderr.write(`hive-gateway: cleaned up thread mapping for ${mapping.taskId} (thread deleted)\n`)
    }
  }
})

async function routeInbound(msg: Message, excludeSender?: string): Promise<void> {
  // Resolve effective channel ID — threads inherit parent's channel
  const effectiveChannelId = msg.channel.isThread()
    ? msg.channel.parentId ?? msg.channelId
    : msg.channelId

  // Parse protocol header for selective routing
  const parsed = parseHeader(msg.content)
  const bodyAgents = parsed ? extractAgentsList(msg.content) : undefined

  const targets: WorkerEntry[] = []

  for (const worker of workers.values()) {
    // Channel match
    if (worker.channelId !== effectiveChannelId) continue

    // Skip the sender to avoid echo loops
    if (excludeSender && worker.workerId === excludeSender) continue

    // Mention gate — only for non-protocol messages from humans (no excludeSender)
    if (worker.requireMention && !parsed) {
      const mentioned = await isMentioned(msg, worker.mentionPatterns)
      if (!mentioned) continue
    }

    // Selective routing filter
    const workerInfo: WorkerInfo = { workerId: worker.workerId, channelId: worker.channelId }
    const decision = shouldDeliver(parsed, workerInfo, msg.content, bodyAgents)
    if (!decision.deliver) continue

    targets.push(worker)
  }

  if (targets.length === 0) return

  // Fire typing indicator once for all matching workers
  if ('sendTyping' in msg.channel) {
    void msg.channel.sendTyping().catch(() => {})
  }

  // Build attachment list (names NOT sanitized — that's the worker's job)
  const attachments = [...msg.attachments.values()].map((att) => ({
    name: att.name ?? att.id,
    contentType: att.contentType ?? 'unknown',
    size: att.size,
    url: att.url,
  }))

  const payload = {
    content: msg.content || (attachments.length > 0 ? '(attachment)' : ''),
    chat_id: msg.channelId,
    message_id: msg.id,
    user: msg.author.username,
    user_id: msg.author.id,
    ts: msg.createdAt.toISOString(),
    attachments,
  }

  // Deliver to all matching workers in parallel
  const deliveries = targets.map(async (worker) => {
    try {
      const res = await fetch('http://localhost/inbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        unix: worker.endpoint,
      } as any)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      worker.failCount = 0
    } catch (err) {
      worker.failCount++
      if (worker.failCount >= 3) {
        process.stderr.write(
          `hive-gateway: deregistering worker ${worker.workerId} after ${worker.failCount} failures\n`,
        )
        workers.delete(worker.workerId)
      }
    }
  })

  await Promise.allSettled(deliveries)
}

// ---------------------------------------------------------------------------
// Slash command handlers
// ---------------------------------------------------------------------------

function readAgentsJson(): AgentsJson | null {
  try {
    if (!existsSync(AGENTS_JSON)) return null
    return JSON.parse(readFileSync(AGENTS_JSON, 'utf8')) as AgentsJson
  } catch {
    return null
  }
}

function writeAgentsJson(data: AgentsJson): void {
  mkdirSync(join(HIVE_ROOT, 'state'), { recursive: true })
  writeFileSync(AGENTS_JSON, JSON.stringify(data, null, 2))
}

async function handleSlashStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const workerList = [...workers.values()]
  const embed = new EmbedBuilder()
    .setTitle('Hive Gateway Status')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Bot', value: client.user?.tag ?? 'unknown', inline: true },
      { name: 'Registered Workers', value: String(workerList.length), inline: true },
      { name: 'Spawned Agents', value: String(agentProcesses.size), inline: true },
    )
    .setTimestamp()

  if (workerList.length > 0) {
    const workerSummary = workerList
      .map((w) => `• \`${w.workerId}\` — channel \`${w.channelId}\``)
      .join('\n')
    embed.addFields({ name: 'Workers', value: workerSummary.slice(0, 1024) })
  }

  if (agentProcesses.size > 0) {
    const agentSummary = [...agentProcesses.entries()]
      .map(([name, ap]) => `• \`${name}\` — PID ${ap.pid}, started ${ap.startedAt.toISOString()}`)
      .join('\n')
    embed.addFields({ name: 'Running Agents', value: agentSummary.slice(0, 1024) })
  }

  await interaction.reply({ embeds: [embed], ephemeral: false })
}

async function handleSlashAgents(interaction: ChatInputCommandInteraction): Promise<void> {
  const data = readAgentsJson()
  if (!data || data.agents.length === 0) {
    await interaction.reply({ content: 'No agents registered in `state/agents.json`.', ephemeral: true })
    return
  }

  const embed = new EmbedBuilder()
    .setTitle('Hive Agents')
    .setColor(0x57f287)
    .setTimestamp()

  if (data.mode) embed.addFields({ name: 'Mode', value: data.mode, inline: true })

  const agentLines = data.agents.map((a) => {
    const running = agentProcesses.has(a.name) ? ' [running]' : ''
    const role = a.role ? ` (${a.role})` : ''
    const status = a.status ?? 'unknown'
    return `• \`${a.name}\`${role} — ${status}${running}`
  })

  embed.addFields({ name: `Agents (${data.agents.length})`, value: agentLines.join('\n').slice(0, 1024) })

  await interaction.reply({ embeds: [embed] })
}

async function handleSlashBroadcast(interaction: ChatInputCommandInteraction): Promise<void> {
  const message = interaction.options.getString('message', true)

  if (workers.size === 0) {
    await interaction.reply({ content: 'No registered workers to broadcast to.', ephemeral: true })
    return
  }

  await interaction.deferReply()

  const payload = {
    content: message,
    chat_id: interaction.channelId,
    message_id: interaction.id,
    user: interaction.user.username,
    user_id: interaction.user.id,
    ts: new Date().toISOString(),
    attachments: [],
  }

  const results: string[] = []
  for (const worker of workers.values()) {
    try {
      const res = await fetch('http://localhost/inbound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        unix: worker.endpoint,
      } as any)
      results.push(`\`${worker.workerId}\`: ${res.ok ? 'delivered' : `HTTP ${res.status}`}`)
    } catch (err) {
      process.stderr.write(`hive-gateway: broadcast delivery to ${worker.workerId} failed: ${err}\n`)
      results.push(`\`${worker.workerId}\`: delivery failed`)
    }
  }

  await interaction.editReply({
    content: `Broadcast sent to ${workers.size} worker(s):\n${results.join('\n')}`,
  })
}

async function handleSlashAsk(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString('agent', true)
  const message = interaction.options.getString('message', true)

  const worker = workers.get(agentName)
  if (!worker) {
    await interaction.reply({
      content: `Agent \`${agentName}\` is not registered. Use \`/agents\` to see registered agents.`,
      ephemeral: true,
    })
    return
  }

  await interaction.deferReply()

  const payload = {
    content: message,
    chat_id: interaction.channelId,
    message_id: interaction.id,
    user: interaction.user.username,
    user_id: interaction.user.id,
    ts: new Date().toISOString(),
    attachments: [],
  }

  try {
    const res = await fetch('http://localhost/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      unix: worker.endpoint,
    } as any)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await interaction.editReply({ content: `Message delivered to \`${agentName}\`.` })
  } catch (err) {
    await interaction.editReply({
      content: `Failed to deliver to \`${agentName}\`. Check gateway logs for details.`,
    })
  }
}

async function handleSlashMemory(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString('agent', true)

  await interaction.deferReply()

  try {
    const proc = Bun.spawn(
      ['bun', 'run', join(HIVE_ROOT, 'bin', 'hive-mind.ts'), 'view', '--agent', agentName],
      { cwd: HIVE_ROOT, stdout: 'pipe', stderr: 'pipe' },
    )
    const output = await new Response(proc.stdout).text()
    const errout = await new Response(proc.stderr).text()
    const combined = (output + errout).trim() || '(no memory output)'
    // Discord message limit is 2000 chars; truncate if needed
    const truncated = combined.length > 1900 ? combined.slice(0, 1900) + '\n…(truncated)' : combined
    await interaction.editReply({ content: `**Memory for \`${agentName}\`:**\n\`\`\`\n${truncated}\n\`\`\`` })
  } catch (err) {
    await interaction.editReply({
      content: `Failed to read memory for \`${agentName}\`. Check gateway logs for details.`,
    })
  }
}

async function handleSlashAssign(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString('agent', true)
  const task = interaction.options.getString('task', true)

  const worker = workers.get(agentName)
  if (!worker) {
    await interaction.reply({
      content: `Agent \`${agentName}\` is not registered. Use \`/agents\` to see registered agents.`,
      ephemeral: true,
    })
    return
  }

  await interaction.deferReply()

  // Format as TASK_ASSIGN protocol message (pipe-delimited per config/protocol.md)
  const taskId = `task-${Date.now().toString(36)}`
  const files = interaction.options.getString('files') ?? ''
  const taskMessage = [
    `TASK_ASSIGN | ${agentName} | ${taskId}`,
    `Branch: hive/${agentName}`,
    `Files: ${files}`,
    `Description: ${task}`,
    `Dependencies: none`,
  ].join('\n')

  // Create a task thread so the worker's replies land there (mirrors handleSend logic)
  let chatId = interaction.channelId
  try {
    const mainChannel = await fetchTextChannel(interaction.channelId)
    if ('threads' in mainChannel) {
      const threadId = await threadManager.createTaskThread(mainChannel, agentName, taskId)
      chatId = threadId
    }
  } catch (err) {
    process.stderr.write(`hive-gateway: thread creation failed for ${taskId}, using main channel: ${err}\n`)
  }

  const payload = {
    content: taskMessage,
    chat_id: chatId,
    message_id: interaction.id,
    user: interaction.user.username,
    user_id: interaction.user.id,
    ts: new Date().toISOString(),
    attachments: [],
  }

  try {
    const res = await fetch('http://localhost/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      unix: worker.endpoint,
    } as any)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await interaction.editReply({ content: `Task assigned to \`${agentName}\`:\n> ${task}` })
  } catch (err) {
    await interaction.editReply({
      content: `Failed to assign task to \`${agentName}\`. Check gateway logs for details.`,
    })
  }
}

async function handleSlashSpinUp(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString('name', true)
  const role = interaction.options.getString('role') ?? 'developer'

  if (!checkAdmin(interaction)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true })
    return
  }

  // Validate agent name and role format (security: prevent path traversal)
  if (!/^[a-zA-Z0-9-]{1,32}$/.test(agentName)) {
    await interaction.reply({ content: 'Invalid agent name. Must be alphanumeric + hyphens, 1-32 chars.', ephemeral: true })
    return
  }
  if (!/^[a-zA-Z0-9-]{1,32}$/.test(role)) {
    await interaction.reply({ content: 'Invalid role name. Must be alphanumeric + hyphens, 1-32 chars.', ephemeral: true })
    return
  }

  // Defer immediately — startup takes time
  await interaction.deferReply()

  try {
    // Check if already running
    if (agentProcesses.has(agentName)) {
      await interaction.editReply({ content: `Agent \`${agentName}\` is already running.` })
      return
    }

    // Read agents.json to find agent config
    const agentsData = readAgentsJson()
    const agentEntry = agentsData?.agents.find((a) => a.name === agentName)

    // Create worktree directory
    const worktreeDir = join(HIVE_ROOT, 'worktrees', agentName)
    mkdirSync(worktreeDir, { recursive: true })

    // Compose system prompt from worker-system-prompt.md + profiles + memory
    const workerPromptPath = join(HIVE_ROOT, 'config', 'prompts', 'worker-system-prompt.md')
    let systemPrompt = existsSync(workerPromptPath)
      ? readFileSync(workerPromptPath, 'utf8')
          .replace(/\{NAME\}/g, agentName)
          .replace(/\{ROLE\}/g, role)
      : `You are a Hive agent named ${agentName} with role: ${role}.\nYour branch is hive/${agentName}.\n`

    // Append base profile (always) + role profile (if exists, else warn)
    const basePath = join(HIVE_ROOT, 'config', 'prompts', 'profiles', '_base.md')
    const profilePath = join(HIVE_ROOT, 'config', 'prompts', 'profiles', `${role}.md`)
    if (existsSync(basePath)) {
      systemPrompt += '\n\n' + readFileSync(basePath, 'utf8').replace(/\{NAME\}/g, agentName)
    }
    if (existsSync(profilePath)) {
      systemPrompt += '\n\n' + readFileSync(profilePath, 'utf8')
    }

    // Append mind prompt section
    const mindPromptPath = join(HIVE_ROOT, 'config', 'prompts', 'mind-prompt-section.md')
    if (existsSync(mindPromptPath)) {
      systemPrompt += '\n\n' + readFileSync(mindPromptPath, 'utf8').replace(/\{NAME\}/g, agentName)
    }
    // Append live mind state (context, inbox summary, watches)
    try {
      const mindLoad = Bun.spawnSync(['bun', 'run', join(HIVE_ROOT, 'bin/hive-mind.ts'), 'load', '--agent', agentName])
      if (mindLoad.exitCode === 0 && mindLoad.stdout.toString().trim()) {
        systemPrompt += '\n\n' + mindLoad.stdout.toString()
      }
    } catch { /* mind not available yet, continue without */ }

    // Write system prompt to a temp file for the container
    const promptFile = join(HIVE_ROOT, 'state', `.prompt-${agentName}.md`)
    writeFileSync(promptFile, systemPrompt)

    // Build MCP config path (reuse existing worker config if present)
    const mcpConfigPath = join(HIVE_ROOT, 'state', 'workers', agentName, 'mcp-config.json')
    const settingsPath = join(HIVE_ROOT, 'state', 'workers', agentName, 'settings.json')

    // Remove any existing container with this name
    Bun.spawnSync(['docker', 'rm', '-f', `hive-${agentName}`], { stdout: 'pipe', stderr: 'pipe' })

    // Launch agent in a Docker container (security: containerized isolation)
    // --network=none: disables TCP/UDP. Unix sockets use AF_UNIX and work via bind mount.
    const dockerArgs = [
      'docker', 'run', '-d',
      '--name', `hive-${agentName}`,
      '--network=none',
      '-v', `${worktreeDir}:/workspace`,
      '-v', `${join(HIVE_ROOT, 'config')}:/config:ro`,
      '-v', '/tmp/hive-gateway:/gateway:rw',
      '-v', `${promptFile}:/tmp/system-prompt.md:ro`,
    ]

    // Mount worker state dir if it exists (MCP config, settings)
    const workerStateDir = join(HIVE_ROOT, 'state', 'workers', agentName)
    if (existsSync(workerStateDir)) {
      dockerArgs.push('-v', `${workerStateDir}:/state:ro`)
    }

    dockerArgs.push(
      '-e', 'CLAUDE_API_KEY',
      '-e', 'ANTHROPIC_API_KEY',
      '-e', `HIVE_WORKER_ID=${agentName}`,
      '-e', 'HIVE_ROOT=/workspace',
      'hive-worker',
      '--name', `hive-${agentName}`,
      '--append-system-prompt', systemPrompt,
    )

    if (existsSync(mcpConfigPath)) {
      dockerArgs.push('--mcp-config', '/state/mcp-config.json')
    }
    if (existsSync(settingsPath)) {
      dockerArgs.push('--settings', '/state/settings.json')
    }

    dockerArgs.push('--permission-mode', 'bypassPermissions')

    const proc = Bun.spawnSync(dockerArgs, {
      cwd: HIVE_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const containerId = proc.stdout.toString().trim()
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim()
      process.stderr.write(`hive-gateway: docker run failed for ${agentName}: ${stderr}\n`)
      await interaction.editReply({ content: `Failed to start container for \`${agentName}\`. Check gateway logs.` })
      return
    }

    agentProcesses.set(agentName, {
      process: proc as any,
      pid: 0, // Container-managed, no host PID
      startedAt: new Date(),
    })

    // Update agents.json status
    if (agentsData) {
      if (agentEntry) {
        agentEntry.status = 'running'
      } else {
        agentsData.agents.push({
          name: agentName,
          role,
          status: 'running',
          created: new Date().toISOString(),
        })
      }
      writeAgentsJson(agentsData)
    } else {
      writeAgentsJson({
        agents: [{ name: agentName, role, status: 'running', created: new Date().toISOString() }],
        created: new Date().toISOString(),
        mode: 'single-bot',
      })
    }

    const embed = new EmbedBuilder()
      .setTitle('Agent Spawned (Container)')
      .setColor(0x57f287)
      .addFields(
        { name: 'Name', value: agentName, inline: true },
        { name: 'Role', value: role, inline: true },
        { name: 'Container', value: containerId.slice(0, 12), inline: true },
        { name: 'Worktree', value: worktreeDir },
      )
      .setTimestamp()

    await interaction.editReply({ embeds: [embed] })

  } catch (err) {
    await interaction.editReply({
      content: `Failed to spin up \`${agentName}\`. Check gateway logs for details.`,
    })
  }
}

async function handleSlashThreads(interaction: ChatInputCommandInteraction): Promise<void> {
  const mappings = threadManager.getAll()
  if (mappings.length === 0) {
    await interaction.reply({ content: 'No active task threads.', ephemeral: true })
    return
  }

  const embed = new EmbedBuilder()
    .setTitle('Active Task Threads')
    .setColor(0x5865f2)
    .setTimestamp()

  const lines = mappings.map(m =>
    `• \`${m.taskId}\` → <#${m.threadId}> (${m.agent}, ${m.createdAt})`
  )
  embed.addFields({ name: `Threads (${mappings.length})`, value: lines.join('\n').slice(0, 1024) })

  await interaction.reply({ embeds: [embed] })
}

async function handleSlashTearDown(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString('name', true)

  if (!checkAdmin(interaction)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true })
    return
  }

  const tracked = agentProcesses.get(agentName)
  if (!tracked) {
    await interaction.reply({
      content: `Agent \`${agentName}\` is not currently running (no tracked process).`,
      ephemeral: true,
    })
    return
  }

  await interaction.deferReply()

  try {
    // Stop and remove the Docker container
    Bun.spawnSync(['docker', 'stop', `hive-${agentName}`], { stdout: 'pipe', stderr: 'pipe' })
    Bun.spawnSync(['docker', 'rm', `hive-${agentName}`], { stdout: 'pipe', stderr: 'pipe' })

    agentProcesses.delete(agentName)

    // Deregister from workers map if present
    workers.delete(agentName)

    // Update agents.json
    const data = readAgentsJson()
    if (data) {
      const entry = data.agents.find((a) => a.name === agentName)
      if (entry) entry.status = 'stopped'
      writeAgentsJson(data)
    }

    await interaction.editReply({ content: `Agent \`${agentName}\` container stopped and removed.` })
  } catch (err) {
    await interaction.editReply({
      content: `Failed to tear down \`${agentName}\`. Check gateway logs for details.`,
    })
  }
}

// ---------------------------------------------------------------------------
// Interaction handler (slash commands)
// ---------------------------------------------------------------------------

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return

  try {
    switch (interaction.commandName) {
      case 'status':
        await handleSlashStatus(interaction)
        break
      case 'agents':
        await handleSlashAgents(interaction)
        break
      case 'broadcast':
        await handleSlashBroadcast(interaction)
        break
      case 'ask':
        await handleSlashAsk(interaction)
        break
      case 'memory':
        await handleSlashMemory(interaction)
        break
      case 'assign':
        await handleSlashAssign(interaction)
        break
      case 'spin-up':
        await handleSlashSpinUp(interaction)
        break
      case 'tear-down':
        await handleSlashTearDown(interaction)
        break
      case 'threads':
        await handleSlashThreads(interaction)
        break
      default:
        if (interaction.isRepliable()) {
          await interaction.reply({ content: `Unknown command: \`/${interaction.commandName}\``, ephemeral: true })
        }
    }
  } catch (err) {
    process.stderr.write(`hive-gateway: interaction handler error: ${err}\n`)
    try {
      if (interaction.isRepliable()) {
        process.stderr.write(`hive-gateway: interaction error: ${err}\n`)
        const msg = 'An internal error occurred. Check gateway logs for details.'
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: msg })
        } else {
          await interaction.reply({ content: msg, ephemeral: true })
        }
      }
    } catch {}
  }
})

// ---------------------------------------------------------------------------
// HTTP request helpers
// ---------------------------------------------------------------------------

async function readJson(req: Request): Promise<Record<string, unknown>> {
  return (await req.json()) as Record<string, unknown>
}

function jsonOk(data: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

function jsonErr(error: string, status = 500): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** Auto-register a Hive Mind watch on behalf of a worker when TASK_ASSIGN has Dependencies */
function autoRegisterWatch(agent: string, topic: string): void {
  const delta: DeltaFile = {
    agent,
    action: 'register-watch',
    target_type: 'contract',
    target_topic: topic,
    watch: {
      topic,
      type: 'contract',
      status: 'waiting',
      since: new Date().toISOString(),
      default_action: `proceed with last known version of ${topic}`,
    },
  }
  const filename = `${Date.now()}-${agent}-auto-watch-${topic}.json`
  const pendingDir = join(HIVE_ROOT, '.hive', 'mind', 'pending')
  const tmpPath = join(pendingDir, `.tmp-${crypto.randomUUID()}.json`)
  const finalPath = join(pendingDir, filename)
  try {
    mkdirSync(pendingDir, { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(delta, null, 2))
    renameSync(tmpPath, finalPath)
    process.stderr.write(`hive-gateway: auto-watch registered for ${agent} on topic ${topic}\n`)
  } catch (err) {
    process.stderr.write(`hive-gateway: auto-watch failed for ${agent}/${topic}: ${err}\n`)
  }
}

async function handleRegister(req: Request): Promise<Response> {
  const body = await readJson(req)
  const workerId = body.workerId as string
  if (!workerId) return jsonErr('workerId required', 400)

  // Validate workerId format (security: finding #4 — prevent impersonation)
  if (!/^[a-zA-Z0-9-]{1,32}$/.test(workerId)) {
    return jsonErr('invalid workerId format', 400)
  }

  workers.set(workerId, {
    workerId,
    endpoint: (body.endpoint as string) ?? '',
    mentionPatterns: (body.mentionPatterns as string[]) ?? [],
    channelId: (body.channelId as string) ?? '',
    requireMention: (body.requireMention as boolean) ?? true,
    failCount: 0,
  })

  process.stderr.write(`hive-gateway: registered worker ${workerId} -> channel ${body.channelId}\n`)
  return jsonOk()
}

async function handleDeregister(req: Request): Promise<Response> {
  const body = await readJson(req)
  const workerId = body.workerId as string
  if (!workerId) return jsonErr('workerId required', 400)
  workers.delete(workerId)
  process.stderr.write(`hive-gateway: deregistered worker ${workerId}\n`)
  return jsonOk()
}

function writeScopeFile(agent: string, taskId: string, allowed: string[]): void {
  const scope = {
    agent,
    taskId,
    allowed,
    shared: ['package.json', 'tsconfig.json', '*.lock', '.hive/**', '.omc/**', 'node_modules/**'],
    createdAt: new Date().toISOString(),
  }
  const scopeDir = join(HIVE_ROOT, '.hive', 'scope')
  mkdirSync(scopeDir, { recursive: true })
  const tmpPath = join(scopeDir, `.tmp-${crypto.randomUUID()}.json`)
  const finalPath = join(scopeDir, `${agent}.json`)
  writeFileSync(tmpPath, JSON.stringify(scope, null, 2))
  renameSync(tmpPath, finalPath)
  process.stderr.write(`hive-gateway: scope file written for ${agent} (${allowed.length} patterns)\n`)
}

async function handleSend(req: Request): Promise<Response> {
  const body = await readJson(req)
  let chatId = body.chat_id as string
  const text = body.text as string
  const replyTo = body.reply_to as string | undefined
  const files = (body.files as string[] | undefined) ?? []
  const sender = body.sender as string | undefined
  const originalChatId = chatId

  const parsed = parseHeader(text)

  // TASK_ASSIGN: create thread, redirect message there
  if (parsed?.type === MessageType.TASK_ASSIGN && parsed.target && parsed.taskId) {
    try {
      const mainChannel = await fetchTextChannel(chatId)
      if ('threads' in mainChannel) {
        const threadId = await threadManager.createTaskThread(mainChannel, parsed.target, parsed.taskId)
        chatId = threadId  // send TASK_ASSIGN into the thread
      }
    } catch (err) {
      process.stderr.write(`hive-gateway: thread creation failed for ${parsed.taskId}, using main channel: ${err}\n`)
    }
  }

  // Auto-register watches for dependencies listed in TASK_ASSIGN
  if (parsed?.type === MessageType.TASK_ASSIGN && parsed.target) {
    const body = parseBody(text)
    const deps = body.dependencies
    if (deps && deps !== 'none') {
      const topics = deps.split(',').map((d: string) => d.trim()).filter(Boolean)
      for (const topic of topics) {
        autoRegisterWatch(parsed.target, topic)
      }
    }
  }

  // Write scope file for the target agent
  if (parsed?.type === MessageType.TASK_ASSIGN && parsed.target && parsed.taskId) {
    const taskBody = parseBody(text)
    const filesField = taskBody.files
    if (filesField) {
      const allowed = filesField.split(',').map((f: string) => {
        const trimmed = f.trim()
        return trimmed.endsWith('/') ? trimmed + '**' : trimmed
      }).filter(Boolean)
      writeScopeFile(parsed.target, parsed.taskId, allowed)
    }
  }

  // Resolve chat_id='auto' to the target agent's thread or channel (daemon push)
  const targetAgent = body.target_agent as string | undefined
  if (chatId === 'auto' && targetAgent) {
    const allThreads = threadManager.getAll()
    let resolved = false
    for (const mapping of allThreads) {
      if (mapping.agent === targetAgent) {
        chatId = mapping.threadId
        resolved = true
        break
      }
    }
    if (!resolved) {
      const worker = workers.get(targetAgent)
      if (worker?.channelId) {
        chatId = worker.channelId
      } else {
        return jsonErr(`Cannot resolve channel for agent: ${targetAgent}`, 400)
      }
    }
  }

  const ch = await fetchTextChannel(chatId)
  if (!('send' in ch)) throw new Error('channel is not sendable')

  const chunks = chunk(text, MAX_CHUNK)
  const sentIds: string[] = []

  for (let i = 0; i < chunks.length; i++) {
    const shouldReplyTo = replyTo != null && i === 0
    try {
      const nonce = Date.now().toString() + Math.random().toString(36).slice(2, 8)
      if (sender) registerSelfSend(nonce, sender)

      const sent = await ch.send({
        content: chunks[i],
        nonce,
        enforceNonce: true,
        ...(i === 0 && files.length > 0
          ? { files: files.map((f) => ({ attachment: f })) }
          : {}),
        ...(shouldReplyTo
          ? { reply: { messageReference: replyTo, failIfNotExists: false } }
          : {}),
      })
      noteSent(sent.id)
      sentIds.push(sent.id)
    } catch (err) {
      process.stderr.write(`hive-gateway: send chunk failed: ${err}\n`)
      return jsonErr(
        `reply failed after ${sentIds.length} of ${chunks.length} chunks`,
      )
    }
  }

  // COMPLETE: post embed summary to main channel (after the normal send)
  if (parsed?.type === MessageType.COMPLETE && parsed.taskId) {
    const parsedBody = parseBody(text)
    const threadId = threadManager.getThread(parsed.taskId)
    if (threadId) {
      try {
        // Find the main channel from the sending worker's registration
        const workerEntry = sender ? workers.get(sender) : undefined
        const mainChannelId = workerEntry?.channelId ?? originalChatId
        if (mainChannelId && mainChannelId !== threadId) {
          const mainChannel = await fetchTextChannel(mainChannelId)
          if ('send' in mainChannel) {
            const embed = new EmbedBuilder()
              .setTitle(`Task Complete: ${parsed.taskId}`)
              .setColor(0x57f287)
              .addFields(
                { name: 'Agent', value: parsed.sender, inline: true },
                { name: 'Task', value: parsed.taskId, inline: true },
              )
              .setTimestamp()
            if (parsedBody.branch) {
              embed.addFields({ name: 'Branch', value: parsedBody.branch, inline: true })
            }
            embed.addFields({ name: 'Thread', value: `<#${threadId}>` })
            await mainChannel.send({ embeds: [embed] })
          }
        }
      } catch (err) {
        process.stderr.write(`hive-gateway: failed to post COMPLETE embed: ${err}\n`)
      }
    }
  }

  return jsonOk({ message_ids: sentIds })
}

async function handleReact(req: Request): Promise<Response> {
  const body = await readJson(req)
  const ch = await fetchTextChannel(body.chat_id as string)
  const msg = await ch.messages.fetch(body.message_id as string)
  await msg.react(body.emoji as string)
  return jsonOk()
}

// NOTE: msg.edit() fires 'messageUpdate', NOT 'messageCreate'.
// No messageUpdate handler exists, so edits are safe from routing loops.
// If adding messageUpdate handling later, apply nonce-based sender exclusion.
async function handleEdit(req: Request): Promise<Response> {
  const body = await readJson(req)
  const ch = await fetchTextChannel(body.chat_id as string)
  const msg = await ch.messages.fetch(body.message_id as string)
  await msg.edit(body.text as string)
  return jsonOk()
}

async function handleFetch(req: Request): Promise<Response> {
  const body = await readJson(req)
  const ch = await fetchTextChannel(body.channel as string)
  const limit = Math.min((body.limit as number) ?? 20, 100)
  const msgs = await ch.messages.fetch({ limit })
  const me = client.user?.id
  const arr = [...msgs.values()].reverse()
  const out = arr.map((m) => ({
    id: m.id,
    author: m.author.username,
    content: m.content,
    ts: m.createdAt.toISOString(),
    attachments: m.attachments.size,
    isBot: m.author.bot,
  }))
  return jsonOk({ messages: out })
}

async function handleDownload(req: Request): Promise<Response> {
  const body = await readJson(req)
  const ch = await fetchTextChannel(body.chat_id as string)
  const msg = await ch.messages.fetch(body.message_id as string)

  if (msg.attachments.size === 0) {
    return jsonOk({ files: [], note: 'message has no attachments' })
  }

  mkdirSync(INBOX_DIR, { recursive: true })
  const paths: string[] = []

  for (const att of msg.attachments.values()) {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      return jsonErr(
        `attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max 25MB`,
      )
    }
    const res = await fetch(att.url)
    const buf = Buffer.from(await res.arrayBuffer())
    const name = att.name ?? `${att.id}`
    const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const safePath = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
    if (!safePath.startsWith(INBOX_DIR)) {
      return jsonErr('invalid attachment path', 400)
    }
    writeFileSync(safePath, buf)
    paths.push(safePath)
  }

  return jsonOk({ files: paths })
}

function handleHealth(): Response {
  const workerList = [...workers.values()].map((w) => ({
    workerId: w.workerId,
    channelId: w.channelId,
  }))
  return new Response(
    JSON.stringify({
      status: 'ok',
      connectedAs: client.user?.tag ?? 'unknown',
      botId: client.user?.id ?? null,
      registeredWorkers: workers.size,
      workers: workerList,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

// ---------------------------------------------------------------------------
// HTTP server (Unix domain socket)
// ---------------------------------------------------------------------------

mkdirSync(GATEWAY_DIR, { recursive: true, mode: 0o700 })
chmodSync(GATEWAY_DIR, 0o700)
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH)

const server = Bun.serve({
  unix: SOCKET_PATH,
  async fetch(req) {
    const url = new URL(req.url, 'http://localhost')
    const method = req.method
    const path = url.pathname

    try {
      if (method === 'GET' && path === '/health') return handleHealth()
      if (method === 'POST' && path === '/register') return await handleRegister(req)
      if (method === 'POST' && path === '/deregister') return await handleDeregister(req)
      if (method === 'POST' && path === '/send') return await handleSend(req)
      if (method === 'POST' && path === '/react') return await handleReact(req)
      if (method === 'POST' && path === '/edit') return await handleEdit(req)
      if (method === 'POST' && path === '/fetch') return await handleFetch(req)
      if (method === 'POST' && path === '/download') return await handleDownload(req)
      return jsonErr('not found', 404)
    } catch (err) {
      process.stderr.write(`hive-gateway: request error: ${err}\n`)
      return jsonErr('internal error')
    }
  },
})

process.stderr.write(`hive-gateway: listening on ${SOCKET_PATH}\n`)

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('hive-gateway: shutting down\n')
  client.destroy()
  server.stop()
  try { unlinkSync(SOCKET_PATH) } catch {}
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.stdin.on('end', shutdown)

// Safety nets
process.on('unhandledRejection', (err) => {
  process.stderr.write(`hive-gateway: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', (err) => {
  process.stderr.write(`hive-gateway: uncaught exception: ${err}\n`)
})

// ---------------------------------------------------------------------------
// Discord login
// ---------------------------------------------------------------------------

client.on('error', (err) => {
  process.stderr.write(`hive-gateway: client error: ${err}\n`)
})

client.once('ready', (c) => {
  process.stderr.write(`hive-gateway: gateway connected as ${c.user.tag}\n`)
})

client.login(TOKEN).catch((err) => {
  process.stderr.write(`hive-gateway: login failed: ${err}\n`)
  process.exit(1)
})
