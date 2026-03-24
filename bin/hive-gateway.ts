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
import { mkdirSync, existsSync, unlinkSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOKEN = process.env.DISCORD_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write('hive-gateway: DISCORD_BOT_TOKEN is required\n')
  process.exit(1)
}

const SOCKET_PATH = process.env.HIVE_GATEWAY_SOCKET ?? '/tmp/hive-gateway/gateway.sock'
const GATEWAY_DIR = '/tmp/hive-gateway'
const INBOX_DIR = join(GATEWAY_DIR, 'inbox')
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_CHUNK = 2000

// HIVE_ROOT is the project root (directory containing bin/, state/, worktrees/)
const HIVE_ROOT = import.meta.dir ? join(import.meta.dir, '..') : process.cwd()
const AGENTS_JSON = join(HIVE_ROOT, 'state', 'agents.json')

// ---------------------------------------------------------------------------
// Agent process tracking
// ---------------------------------------------------------------------------

interface AgentProcess {
  process: ReturnType<typeof Bun.spawn>
  pid: number
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

  // Custom regex patterns (case-insensitive)
  for (const pat of mentionPatterns) {
    try {
      if (new RegExp(pat, 'i').test(msg.content)) return true
    } catch {}
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

async function routeInbound(msg: Message, excludeSender?: string): Promise<void> {
  // Resolve effective channel ID — threads inherit parent's channel
  const effectiveChannelId = msg.channel.isThread()
    ? msg.channel.parentId ?? msg.channelId
    : msg.channelId

  const targets: WorkerEntry[] = []

  for (const worker of workers.values()) {
    // Channel match
    if (worker.channelId !== effectiveChannelId) continue

    // Skip the sender to avoid echo loops
    if (excludeSender && worker.workerId === excludeSender) continue

    // Mention gate
    if (worker.requireMention) {
      const mentioned = await isMentioned(msg, worker.mentionPatterns)
      if (!mentioned) continue
    }

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

interface AgentEntry {
  name: string
  role?: string
  status?: string
  branch?: string
  created?: string
}

interface AgentsJson {
  agents: AgentEntry[]
  created?: string
  mode?: string
}

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
      results.push(`\`${worker.workerId}\`: failed (${err instanceof Error ? err.message : String(err)})`)
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
      content: `Failed to deliver to \`${agentName}\`: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

async function handleSlashMemory(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString('agent', true)

  await interaction.deferReply()

  try {
    const proc = Bun.spawn(
      ['bun', 'run', join(HIVE_ROOT, 'bin', 'hive-memory.ts'), 'view', '--agent', agentName],
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
      content: `Failed to read memory for \`${agentName}\`: ${err instanceof Error ? err.message : String(err)}`,
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

  // Format as TASK_ASSIGN protocol message
  const taskMessage = [
    `TYPE: TASK_ASSIGN`,
    `FROM: manager`,
    `TO: ${agentName}`,
    `TASK: ${task}`,
    `TS: ${new Date().toISOString()}`,
  ].join('\n')

  const payload = {
    content: taskMessage,
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
    await interaction.editReply({ content: `Task assigned to \`${agentName}\`:\n> ${task}` })
  } catch (err) {
    await interaction.editReply({
      content: `Failed to assign task to \`${agentName}\`: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

async function handleSlashSpinUp(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString('name', true)
  const role = interaction.options.getString('role') ?? 'developer'

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
    const workerPromptPath = join(HIVE_ROOT, 'config', 'worker-system-prompt.md')
    let systemPrompt = existsSync(workerPromptPath)
      ? readFileSync(workerPromptPath, 'utf8')
          .replace(/\{NAME\}/g, agentName)
          .replace(/\{ROLE\}/g, role)
      : `You are a Hive agent named ${agentName} with role: ${role}.\nYour branch is hive/${agentName}.\n`

    // Append base profile (always) + role profile (if exists, else warn)
    const basePath = join(HIVE_ROOT, 'config', 'profiles', '_base.md')
    const profilePath = join(HIVE_ROOT, 'config', 'profiles', `${role}.md`)
    if (existsSync(basePath)) {
      systemPrompt += '\n\n' + readFileSync(basePath, 'utf8').replace(/\{NAME\}/g, agentName)
    }
    if (existsSync(profilePath)) {
      systemPrompt += '\n\n' + readFileSync(profilePath, 'utf8')
    }

    // Append memory prompt section + memory restoration
    const memoryPromptPath = join(HIVE_ROOT, 'config', 'memory-prompt-section.md')
    if (existsSync(memoryPromptPath)) {
      systemPrompt += '\n\n' + readFileSync(memoryPromptPath, 'utf8').replace(/\{NAME\}/g, agentName)
    }

    // Build MCP config path (reuse existing worker config if present)
    const mcpConfigPath = join(HIVE_ROOT, 'state', 'workers', agentName, 'mcp-config.json')

    const spawnArgs: string[] = [
      'claude',
      '--name', `hive-${agentName}`,
      '--append-system-prompt', systemPrompt,
    ]

    if (existsSync(mcpConfigPath)) {
      spawnArgs.push('--mcp-config', mcpConfigPath)
    }

    spawnArgs.push('--permission-mode', 'bypassPermissions')

    const proc = Bun.spawn(spawnArgs, {
      cwd: worktreeDir,
      stdin: 'pipe',
      stdout: 'inherit',
      stderr: 'inherit',
    })

    agentProcesses.set(agentName, {
      process: proc,
      pid: proc.pid,
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
      // Create agents.json from scratch
      writeAgentsJson({
        agents: [{ name: agentName, role, status: 'running', created: new Date().toISOString() }],
        created: new Date().toISOString(),
        mode: 'single-bot',
      })
    }

    const embed = new EmbedBuilder()
      .setTitle('Agent Spawned')
      .setColor(0x57f287)
      .addFields(
        { name: 'Name', value: agentName, inline: true },
        { name: 'Role', value: role, inline: true },
        { name: 'PID', value: String(proc.pid), inline: true },
        { name: 'Worktree', value: worktreeDir },
      )
      .setTimestamp()

    await interaction.editReply({ embeds: [embed] })

    // Clean up tracking when process exits
    proc.exited.then(() => {
      agentProcesses.delete(agentName)
      const d = readAgentsJson()
      if (d) {
        const entry = d.agents.find((a) => a.name === agentName)
        if (entry) entry.status = 'stopped'
        writeAgentsJson(d)
      }
    }).catch(() => {})

  } catch (err) {
    await interaction.editReply({
      content: `Failed to spin up \`${agentName}\`: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

async function handleSlashTearDown(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentName = interaction.options.getString('name', true)

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
    tracked.process.kill('SIGTERM')
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

    await interaction.editReply({ content: `Agent \`${agentName}\` (PID ${tracked.pid}) has been sent SIGTERM.` })
  } catch (err) {
    await interaction.editReply({
      content: `Failed to tear down \`${agentName}\`: ${err instanceof Error ? err.message : String(err)}`,
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
      default:
        if (interaction.isRepliable()) {
          await interaction.reply({ content: `Unknown command: \`/${interaction.commandName}\``, ephemeral: true })
        }
    }
  } catch (err) {
    process.stderr.write(`hive-gateway: interaction handler error: ${err}\n`)
    try {
      if (interaction.isRepliable()) {
        const msg = `An error occurred: ${err instanceof Error ? err.message : String(err)}`
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

async function handleRegister(req: Request): Promise<Response> {
  const body = await readJson(req)
  const workerId = body.workerId as string
  if (!workerId) return jsonErr('workerId required', 400)

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

async function handleSend(req: Request): Promise<Response> {
  const body = await readJson(req)
  const chatId = body.chat_id as string
  const text = body.text as string
  const replyTo = body.reply_to as string | undefined
  const files = (body.files as string[] | undefined) ?? []
  const sender = body.sender as string | undefined

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
      const msg = err instanceof Error ? err.message : String(err)
      return jsonErr(
        `reply failed after ${sentIds.length} of ${chunks.length} chunks: ${msg}`,
      )
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
    const path = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
    writeFileSync(path, buf)
    paths.push(path)
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

mkdirSync(GATEWAY_DIR, { recursive: true })
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
      const msg = err instanceof Error ? err.message : String(err)
      return jsonErr(msg)
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
