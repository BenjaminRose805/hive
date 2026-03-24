#!/usr/bin/env bun
/**
 * hive-register-commands.ts
 *
 * Registers Discord application (slash) commands for the Hive gateway.
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=xxx DISCORD_APP_ID=yyy bun run bin/hive-register-commands.ts [--guild <guild-id>]
 *   bun run bin/hive-register-commands.ts --token xxx --app-id yyy [--guild <guild-id>]
 *
 * Use --guild for instant registration (guild-scoped).
 * Omit --guild for global registration (up to 1 hour to propagate).
 *
 * Running twice is idempotent: Discord replaces the full command list.
 */

import { REST } from '@discordjs/rest'
import { ApplicationCommandOptionType, Routes } from 'discord-api-types/v10'

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  return args[idx + 1]
}

const token = getArg('--token') ?? process.env.DISCORD_BOT_TOKEN
const appId = getArg('--app-id') ?? process.env.DISCORD_APP_ID
const guildId = getArg('--guild')

if (!token) {
  process.stderr.write('hive-register-commands: DISCORD_BOT_TOKEN or --token is required\n')
  process.exit(1)
}

if (!appId) {
  process.stderr.write('hive-register-commands: DISCORD_APP_ID or --app-id is required\n')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

const ROLE_CHOICES = [
  { name: 'Backend Developer', value: 'backend-dev' },
  { name: 'Frontend Developer', value: 'frontend-dev' },
  { name: 'Security Reviewer', value: 'security-reviewer' },
  { name: 'QA Engineer', value: 'qa-engineer' },
  { name: 'Tech Lead', value: 'tech-lead' },
  { name: 'DevOps', value: 'devops' },
  { name: 'Developer', value: 'developer' },
]

const commands = [
  {
    name: 'spin-up',
    description: 'Spin up a named agent (spawns a Claude Code process)',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'name',
        description: 'Agent name (alphanumeric + hyphens)',
        required: true,
      },
      {
        type: ApplicationCommandOptionType.String,
        name: 'role',
        description: 'Agent role profile',
        required: false,
        choices: ROLE_CHOICES,
      },
    ],
  },
  {
    name: 'tear-down',
    description: 'Tear down a running agent (sends SIGTERM)',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'name',
        description: 'Agent name to tear down',
        required: true,
      },
    ],
  },
  {
    name: 'assign',
    description: 'Assign a task to a specific agent',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'agent',
        description: 'Agent name to assign the task to',
        required: true,
      },
      {
        type: ApplicationCommandOptionType.String,
        name: 'task',
        description: 'Task description',
        required: true,
      },
    ],
  },
  {
    name: 'status',
    description: 'Show gateway health and registered workers',
    options: [],
  },
  {
    name: 'agents',
    description: 'List all agents from state/agents.json',
    options: [],
  },
  {
    name: 'ask',
    description: 'Send a message to a specific agent',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'agent',
        description: 'Agent name to message',
        required: true,
      },
      {
        type: ApplicationCommandOptionType.String,
        name: 'message',
        description: 'Message to send',
        required: true,
      },
    ],
  },
  {
    name: 'memory',
    description: "View an agent's persistent memory",
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'agent',
        description: 'Agent name',
        required: true,
      },
    ],
  },
  {
    name: 'broadcast',
    description: 'Send a message to ALL registered workers',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'message',
        description: 'Message to broadcast',
        required: true,
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const rest = new REST({ version: '10' }).setToken(token)

async function register(): Promise<void> {
  process.stdout.write(
    `hive-register-commands: registering ${commands.length} commands for app ${appId}` +
      (guildId ? ` in guild ${guildId}` : ' globally') +
      '\n',
  )

  const route = guildId
    ? Routes.applicationGuildCommands(appId!, guildId)
    : Routes.applicationCommands(appId!)

  const result = await rest.put(route, { body: commands })

  const registered = result as unknown[]
  process.stdout.write(
    `hive-register-commands: successfully registered ${registered.length} commands\n`,
  )

  for (const cmd of registered as Array<{ name: string; id: string }>) {
    process.stdout.write(`  /${cmd.name} (${cmd.id})\n`)
  }
}

register().catch((err) => {
  process.stderr.write(`hive-register-commands: registration failed: ${err}\n`)
  process.exit(1)
})
