/**
 * Agent name/role validation — security boundary.
 * Prevents injection via names interpolated into scripts and paths.
 */

export const AGENT_NAME_RE = /^[a-zA-Z0-9-]{1,32}$/
export const RESERVED_NAMES = new Set(['manager', 'gateway', 'all-workers', 'all-agents', 'hive'])

export function validateSafeName(val: string): void {
  if (!AGENT_NAME_RE.test(val)) {
    throw new Error(`Invalid name: '${val}' — must be alphanumeric + hyphens, 1-32 chars`)
  }
}

export function validateAgentNames(names: string[]): void {
  const seen = new Set<string>()
  for (const name of names) {
    validateSafeName(name)
    if (RESERVED_NAMES.has(name.toLowerCase())) {
      throw new Error(`Agent name '${name}' is reserved (${[...RESERVED_NAMES].join(', ')})`)
    }
    if (seen.has(name.toLowerCase())) {
      throw new Error(`Duplicate agent name: '${name}'`)
    }
    seen.add(name.toLowerCase())
  }
}
