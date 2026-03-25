import { existsSync, readFileSync } from 'fs'
import { run } from '../shared/subprocess'
import { SESSION, agentsJsonPath } from '../shared/paths'
import type { AgentsJson } from '../shared/agent-types'

export async function main(_args: string[]): Promise<void> {
  let hasAnything = false

  // Agents
  if (existsSync(agentsJsonPath)) {
    const data: AgentsJson = JSON.parse(readFileSync(agentsJsonPath, 'utf8'))
    if (data.agents?.length) {
      hasAnything = true
      console.log('Agents:')
      for (const a of data.agents) {
        console.log(`  ${a.name} (${a.role ?? 'unknown'}) — ${a.status ?? 'unknown'}`)
      }
    }
  }

  // Docker containers
  const docker = run(['docker', 'ps', '--filter', 'name=hive-', '--format', '{{.Names}}\t{{.Status}}'])
  if (docker.exitCode === 0 && docker.stdout) {
    hasAnything = true
    console.log('Containers:')
    for (const line of docker.stdout.split('\n')) {
      console.log(`  ${line}`)
    }
  }

  // Tmux windows
  const tmux = run(['tmux', 'list-windows', '-t', SESSION])
  if (tmux.exitCode === 0 && tmux.stdout) {
    hasAnything = true
    console.log(`Tmux (${SESSION}):`)
    for (const line of tmux.stdout.split('\n')) {
      console.log(`  ${line}`)
    }
  }

  if (!hasAnything) {
    console.log('No hive running.')
  }
}
