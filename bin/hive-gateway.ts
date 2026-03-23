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
  type Message,
} from 'discord.js'
import { mkdirSync, existsSync, unlinkSync, readFileSync, writeFileSync, statSync } from 'fs'
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
  // Skip self-messages
  if (msg.author.id === client.user?.id) return
  routeInbound(msg).catch((e) =>
    process.stderr.write(`hive-gateway: routeInbound error: ${e}\n`),
  )
})

async function routeInbound(msg: Message): Promise<void> {
  // Resolve effective channel ID — threads inherit parent's channel
  const effectiveChannelId = msg.channel.isThread()
    ? msg.channel.parentId ?? msg.channelId
    : msg.channelId

  const targets: WorkerEntry[] = []

  for (const worker of workers.values()) {
    // Channel match
    if (worker.channelId !== effectiveChannelId) continue

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

  const ch = await fetchTextChannel(chatId)
  if (!('send' in ch)) throw new Error('channel is not sendable')

  const chunks = chunk(text, MAX_CHUNK)
  const sentIds: string[] = []

  for (let i = 0; i < chunks.length; i++) {
    const shouldReplyTo = replyTo != null && i === 0
    try {
      const sent = await ch.send({
        content: chunks[i],
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
