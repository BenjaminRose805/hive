#!/usr/bin/env bun
/**
 * src/mcp/discord-relay.ts
 *
 * Custom MCP server that provides Discord tools for Hive workers.
 * Forwards all operations to the Hive gateway over a Unix domain socket.
 *
 * Env vars:
 *   HIVE_GATEWAY_SOCKET — path to gateway Unix socket (required)
 *   HIVE_WORKER_ID      — this worker's name (required)
 *   HIVE_CHANNEL_ID     — default Discord channel ID (required)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GATEWAY_SOCKET = process.env.HIVE_GATEWAY_SOCKET
if (!GATEWAY_SOCKET) {
  process.stderr.write('discord-relay: HIVE_GATEWAY_SOCKET is required\n')
  process.exit(1)
}

const WORKER_ID = process.env.HIVE_WORKER_ID ?? 'worker'
const CHANNEL_ID = process.env.HIVE_CHANNEL_ID ?? ''

// ---------------------------------------------------------------------------
// Gateway HTTP helper with retry
// ---------------------------------------------------------------------------

async function gatewayFetch(path: string, body: object): Promise<any> {
  const delays = [1000, 2000, 4000]
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('http://localhost' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        unix: GATEWAY_SOCKET,
      } as any)
      const data = await res.json()
      if (!data.ok && data.error) throw new Error(data.error)
      return data
    } catch (err) {
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, delays[attempt]))
        continue
      }
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'discord__reply',
    description: 'Send a message to a Discord channel. Use this for ALL outbound communication.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'Discord channel ID (snowflake). Defaults to HIVE_CHANNEL_ID.' },
        text: { type: 'string', description: 'Message text to send (max 2000 chars per chunk, auto-split).' },
        reply_to: { type: 'string', description: 'Optional message ID to reply to.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of absolute file paths to attach.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'discord__react',
    description: 'Add an emoji reaction to a Discord message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'Discord channel ID.' },
        message_id: { type: 'string', description: 'Message ID to react to.' },
        emoji: { type: 'string', description: 'Emoji to react with (Unicode char or custom emoji ID).' },
      },
      required: ['chat_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'discord__edit_message',
    description: 'Edit a previously sent Discord message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'Discord channel ID.' },
        message_id: { type: 'string', description: 'Message ID to edit.' },
        text: { type: 'string', description: 'New message text.' },
      },
      required: ['chat_id', 'message_id', 'text'],
    },
  },
  {
    name: 'discord__fetch_messages',
    description: 'Fetch recent messages from a Discord channel.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', description: 'Channel ID to fetch from. Defaults to HIVE_CHANNEL_ID.' },
        limit: { type: 'number', description: 'Number of messages to fetch (max 100, default 20).' },
        before: { type: 'string', description: 'Optional message ID — fetch messages before this one.' },
      },
    },
  },
  {
    name: 'discord__download_attachment',
    description: 'Download attachments from a Discord message to local files.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string', description: 'Discord channel ID.' },
        message_id: { type: 'string', description: 'Message ID with attachments.' },
      },
      required: ['chat_id', 'message_id'],
    },
  },
]

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'discord__reply': {
      const chatId = (args.chat_id as string) || CHANNEL_ID
      const text = args.text as string
      const replyTo = args.reply_to as string | undefined
      const files = (args.files as string[] | undefined) ?? []
      if (!chatId) throw new Error('chat_id is required (no default HIVE_CHANNEL_ID set)')
      if (!text) throw new Error('text is required')
      const result = await gatewayFetch('/send', {
        chat_id: chatId,
        text,
        reply_to: replyTo,
        files,
        sender: WORKER_ID,
      })
      return JSON.stringify({ sent: true, message_ids: result.message_ids ?? [] })
    }

    case 'discord__react': {
      const chatId = (args.chat_id as string) || CHANNEL_ID
      await gatewayFetch('/react', {
        chat_id: chatId,
        message_id: args.message_id,
        emoji: args.emoji,
      })
      return JSON.stringify({ reacted: true })
    }

    case 'discord__edit_message': {
      const chatId = (args.chat_id as string) || CHANNEL_ID
      await gatewayFetch('/edit', {
        chat_id: chatId,
        message_id: args.message_id,
        text: args.text,
      })
      return JSON.stringify({ edited: true })
    }

    case 'discord__fetch_messages': {
      const channel = (args.channel as string) || CHANNEL_ID
      if (!channel) throw new Error('channel is required (no default HIVE_CHANNEL_ID set)')
      const result = await gatewayFetch('/fetch', {
        channel,
        limit: args.limit ?? 20,
        ...(args.before ? { before: args.before } : {}),
      })
      return JSON.stringify(result.messages ?? [])
    }

    case 'discord__download_attachment': {
      const chatId = (args.chat_id as string) || CHANNEL_ID
      const result = await gatewayFetch('/download', {
        chat_id: chatId,
        message_id: args.message_id,
      })
      return JSON.stringify({ files: result.files ?? [] })
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'hive-discord-relay', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  try {
    const result = await handleTool(name, args ?? {})
    return { content: [{ type: 'text', text: result }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`discord-relay: MCP server started (worker=${WORKER_ID}, channel=${CHANNEL_ID})\n`)
}

main().catch((err) => {
  process.stderr.write(`discord-relay: fatal: ${err}\n`)
  process.exit(1)
})
