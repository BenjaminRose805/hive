/**
 * Agent name/role/domain validation — security boundary.
 * Prevents injection via names interpolated into scripts and paths.
 */

import { VALID_ROLES } from './agent-types.ts'

export const AGENT_NAME_RE = /^[a-zA-Z0-9-]{1,32}$/
export const RESERVED_NAMES = new Set(['gateway', 'all-workers', 'all-agents', 'hive'])

export function validateSafeName(val: string): void {
  if (!AGENT_NAME_RE.test(val)) {
    throw new Error(`Invalid name: '${val}' — must be alphanumeric + hyphens, 1-32 chars`)
  }
}

export function validateRole(role: string): void {
  if (!VALID_ROLES.has(role)) {
    throw new Error(
      `Invalid role: '${role}'. Valid roles: ${[...VALID_ROLES].join(', ')}`
    )
  }
}

export function validateDomain(domain: string): void {
  if (!AGENT_NAME_RE.test(domain)) {
    throw new Error(`Invalid domain: '${domain}' — must be alphanumeric + hyphens, 1-32 chars`)
  }
}

/**
 * Parse a full agent assignment: "name:role" or "name:role:domain".
 */
export function parseAgentAssignment(pair: string): { name: string; role: string; domain?: string } {
  const parts = pair.split(':')
  if (parts.length === 3) {
    return { name: parts[0].trim(), role: parts[1].trim(), domain: parts[2].trim() }
  }
  if (parts.length === 2) {
    return { name: parts[0].trim(), role: parts[1].trim() }
  }
  throw new Error(`Invalid agent assignment: '${pair}'. Expected name:role or name:role:domain`)
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
