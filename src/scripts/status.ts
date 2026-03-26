import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { run } from '../shared/subprocess'
import { getSession, getStateDir, getAgentsJsonPath } from '../shared/paths'
import type { AgentsJson } from '../shared/agent-types'

export async function main(_args: string[]): Promise<void> {
  let hasAnything = false

  // Load channel map if available
  let channels: Record<string, string> = {}
  try {
    const channelsPath = join(getStateDir(), 'gateway', 'channels.json')
    if (existsSync(channelsPath)) {
      channels = JSON.parse(readFileSync(channelsPath, 'utf8'))
    }
  } catch {}

  // Agents
  const ajPath = getAgentsJsonPath()
  if (existsSync(ajPath)) {
    const data: AgentsJson = JSON.parse(readFileSync(ajPath, 'utf8'))
    if (data.agents?.length) {
      hasAnything = true
      console.log('Agents:')
      for (const a of data.agents) {
        const ch = channels[a.name] ? ` [channel: ${channels[a.name]}]` : ''
        const roleLabel = a.domain ? `${a.role}:${a.domain}` : (a.role ?? 'unknown')
        console.log(`  ${a.name} (${roleLabel}) — ${a.status ?? 'unknown'}${ch}`)
      }
    }
  }

  // Tmux windows
  const session = getSession()
  const tmux = run(['tmux', 'list-windows', '-t', session])
  if (tmux.exitCode === 0 && tmux.stdout) {
    hasAnything = true
    console.log(`Tmux (${session}):`)
    for (const line of tmux.stdout.split('\n')) {
      console.log(`  ${line}`)
    }
  }

  if (!hasAnything) {
    console.log('No hive running.')
  }
}
