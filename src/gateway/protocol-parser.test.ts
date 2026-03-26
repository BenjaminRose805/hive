import { describe, expect, test } from 'bun:test'
import { parseHeader, parseBody, extractAgentsList } from './protocol-parser.ts'
import { MessageType } from './types.ts'

// ---------------------------------------------------------------------------
// parseHeader — all message types
// ---------------------------------------------------------------------------

describe('parseHeader', () => {
  // --- TASK_ASSIGN (manager-directed: field 2 = target) ---

  test('TASK_ASSIGN: parses target and taskId', () => {
    const h = parseHeader('TASK_ASSIGN | alice | auth-001')
    expect(h).not.toBeNull()
    expect(h!.type).toBe(MessageType.TASK_ASSIGN)
    expect(h!.sender).toBe('manager')
    expect(h!.target).toBe('alice')
    expect(h!.taskId).toBe('auth-001')
  })

  test('TASK_ASSIGN: two fields only (no taskId)', () => {
    const h = parseHeader('TASK_ASSIGN | alice')
    expect(h).not.toBeNull()
    expect(h!.type).toBe(MessageType.TASK_ASSIGN)
    expect(h!.target).toBe('alice')
    expect(h!.taskId).toBeUndefined()
  })

  // --- ANSWER (manager-directed: field 2 = target) ---

  test('ANSWER: parses target and taskId', () => {
    const h = parseHeader('ANSWER | bob | BUG-042')
    expect(h).not.toBeNull()
    expect(h!.type).toBe(MessageType.ANSWER)
    expect(h!.sender).toBe('manager')
    expect(h!.target).toBe('bob')
    expect(h!.taskId).toBe('BUG-042')
  })

  // --- STATUS (agent-sent: field 2 = sender, field 4 = status) ---

  test('STATUS: parses sender, taskId, and status', () => {
    const h = parseHeader('STATUS | alice | auth-001 | IN_PROGRESS')
    expect(h).not.toBeNull()
    expect(h!.type).toBe(MessageType.STATUS)
    expect(h!.sender).toBe('alice')
    expect(h!.target).toBeUndefined()
    expect(h!.taskId).toBe('auth-001')
    expect(h!.status).toBe('IN_PROGRESS')
  })

  test('STATUS: all valid status values parse correctly', () => {
    for (const status of ['READY', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'FAILED']) {
      const h = parseHeader(`STATUS | agent-1 | T1 | ${status}`)
      expect(h).not.toBeNull()
      expect(h!.status).toBe(status)
    }
  })

  test('STATUS: without status field', () => {
    const h = parseHeader('STATUS | alice | auth-001')
    expect(h).not.toBeNull()
    expect(h!.type).toBe(MessageType.STATUS)
    expect(h!.taskId).toBe('auth-001')
    expect(h!.status).toBeUndefined()
  })

  // --- QUESTION (agent-sent) ---

  test('QUESTION: parses sender and taskId', () => {
    const h = parseHeader('QUESTION | alice | auth-001')
    expect(h).not.toBeNull()
    expect(h!.type).toBe(MessageType.QUESTION)
    expect(h!.sender).toBe('alice')
    expect(h!.taskId).toBe('auth-001')
  })

  // --- COMPLETE (agent-sent) ---

  test('COMPLETE: parses sender and taskId', () => {
    const h = parseHeader('COMPLETE | bob | FEAT-007')
    expect(h).not.toBeNull()
    expect(h!.type).toBe(MessageType.COMPLETE)
    expect(h!.sender).toBe('bob')
    expect(h!.taskId).toBe('FEAT-007')
  })

  // --- HEARTBEAT (agent-sent, no taskId) ---

  test('HEARTBEAT: parses sender only, no taskId', () => {
    const h = parseHeader('HEARTBEAT | alice')
    expect(h).not.toBeNull()
    expect(h!.type).toBe(MessageType.HEARTBEAT)
    expect(h!.sender).toBe('alice')
    expect(h!.taskId).toBeUndefined()
  })

  test('HEARTBEAT: extra fields ignored for taskId', () => {
    // HEARTBEAT with extra pipe-separated text — taskId should still be undefined
    const h = parseHeader('HEARTBEAT | alice | extra-data')
    expect(h).not.toBeNull()
    expect(h!.type).toBe(MessageType.HEARTBEAT)
    expect(h!.taskId).toBeUndefined()
  })

  // --- INTEGRATE (manager-sent, no taskId) ---

  test('INTEGRATE: parses sender, no taskId', () => {
    const h = parseHeader('INTEGRATE | manager')
    expect(h).not.toBeNull()
    expect(h!.type).toBe(MessageType.INTEGRATE)
    expect(h!.sender).toBe('manager')
    expect(h!.taskId).toBeUndefined()
  })

  // --- ESCALATE (any sender) ---

  test('ESCALATE: parses sender and taskId', () => {
    const h = parseHeader('ESCALATE | alice | auth-001')
    expect(h).not.toBeNull()
    expect(h!.type).toBe(MessageType.ESCALATE)
    expect(h!.sender).toBe('alice')
    expect(h!.taskId).toBe('auth-001')
  })

  // --- CONTRACT_UPDATE (manager-directed: field 2 = target) ---

  test('CONTRACT_UPDATE: parses target and taskId', () => {
    const h = parseHeader('CONTRACT_UPDATE | bob | SCHEMA-01')
    expect(h).not.toBeNull()
    expect(h!.type).toBe(MessageType.CONTRACT_UPDATE)
    expect(h!.sender).toBe('manager')
    expect(h!.target).toBe('bob')
    expect(h!.taskId).toBe('SCHEMA-01')
  })

  // --- Multiline messages (only first line parsed as header) ---

  test('multiline message: only first line is header', () => {
    const msg = `STATUS | alice | T1 | IN_PROGRESS
Progress: 3/5
Current: Writing tests`
    const h = parseHeader(msg)
    expect(h).not.toBeNull()
    expect(h!.type).toBe(MessageType.STATUS)
    expect(h!.sender).toBe('alice')
    expect(h!.status).toBe('IN_PROGRESS')
  })

  // --- Whitespace handling ---

  test('trims whitespace around pipe-delimited fields', () => {
    const h = parseHeader('  TASK_ASSIGN  |  alice  |  T1  ')
    expect(h).not.toBeNull()
    expect(h!.target).toBe('alice')
    expect(h!.taskId).toBe('T1')
  })

  // --- Malformed / edge cases ---

  test('returns null for empty string', () => {
    expect(parseHeader('')).toBeNull()
  })

  test('returns null for plain text (no pipes)', () => {
    expect(parseHeader('Hello everyone, status update coming')).toBeNull()
  })

  test('returns null for unknown message type', () => {
    expect(parseHeader('UNKNOWN | alice | T1')).toBeNull()
  })

  test('returns null for single field (no pipe separator)', () => {
    expect(parseHeader('STATUS')).toBeNull()
  })

  test('returns null for pipe-only input', () => {
    expect(parseHeader('|')).toBeNull()
  })

  test('returns null for valid-looking but lowercase type', () => {
    expect(parseHeader('status | alice | T1')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseBody — Key: value line parsing
// ---------------------------------------------------------------------------

describe('parseBody', () => {
  test('parses Branch field', () => {
    const body = parseBody('TASK_ASSIGN | alice | T1\nBranch: hive/alice')
    expect(body.branch).toBe('hive/alice')
  })

  test('parses Description field', () => {
    const body = parseBody('TASK_ASSIGN | alice | T1\nDescription: Implement JWT auth')
    expect(body.description).toBe('Implement JWT auth')
  })

  test('parses Agents field as array', () => {
    const body = parseBody('INTEGRATE | manager\nAgents: alice, bob, carol')
    expect(body.agents).toEqual(['alice', 'bob', 'carol'])
  })

  test('parses Scope field', () => {
    const body = parseBody('ESCALATE | alice | T1\nScope: task')
    expect(body.scope).toBe('task')
  })

  test('parses Dependencies field', () => {
    const body = parseBody('TASK_ASSIGN | alice | T1\nDependencies: T0, T-1')
    expect(body.dependencies).toBe('T0, T-1')
  })

  test('parses Files field', () => {
    const body = parseBody('TASK_ASSIGN | alice | T1\nFiles: src/auth/, src/middleware/auth.ts')
    expect(body.files).toBe('src/auth/, src/middleware/auth.ts')
  })

  test('parses multiple fields from a full message', () => {
    const msg = `TASK_ASSIGN | alice | auth-001
Branch: hive/alice
Files: src/auth/, src/middleware/auth.ts
Description: Implement JWT authentication middleware
Dependencies: none`
    const body = parseBody(msg)
    expect(body.branch).toBe('hive/alice')
    expect(body.files).toBe('src/auth/, src/middleware/auth.ts')
    expect(body.description).toBe('Implement JWT authentication middleware')
    expect(body.dependencies).toBe('none')
  })

  test('ignores lines without colon-space separator', () => {
    const body = parseBody('TASK_ASSIGN | alice | T1\nThis line has no key-value pair\nBranch: hive/alice')
    expect(body.branch).toBe('hive/alice')
  })

  test('handles empty body (header only)', () => {
    const body = parseBody('STATUS | alice | T1 | IN_PROGRESS')
    expect(body.branch).toBeUndefined()
    expect(body.description).toBeUndefined()
    expect(body.agents).toBeUndefined()
  })

  test('ignores unknown keys', () => {
    const body = parseBody('STATUS | alice | T1\nProgress: 3/5\nCurrent: writing tests')
    // Progress and Current are not in the ParsedBody interface
    expect(body.branch).toBeUndefined()
  })

  test('handles colon in value (only first colon-space splits)', () => {
    const body = parseBody('TASK_ASSIGN | alice | T1\nDescription: Fix bug: null pointer in auth')
    expect(body.description).toBe('Fix bug: null pointer in auth')
  })
})

// ---------------------------------------------------------------------------
// extractAgentsList — convenience wrapper
// ---------------------------------------------------------------------------

describe('extractAgentsList', () => {
  test('extracts agents from INTEGRATE message', () => {
    const msg = `INTEGRATE | manager
Agents: alice, bob
Order: bob first, then alice
Target: main`
    expect(extractAgentsList(msg)).toEqual(['alice', 'bob'])
  })

  test('returns empty array when no Agents field', () => {
    expect(extractAgentsList('STATUS | alice | T1 | IN_PROGRESS')).toEqual([])
  })

  test('returns empty array for header-only message', () => {
    expect(extractAgentsList('HEARTBEAT | alice')).toEqual([])
  })

  test('handles single agent', () => {
    const msg = 'INTEGRATE | manager\nAgents: alice'
    expect(extractAgentsList(msg)).toEqual(['alice'])
  })

  test('trims whitespace around agent names', () => {
    const msg = 'INTEGRATE | manager\nAgents:  alice ,  bob , carol  '
    const agents = extractAgentsList(msg)
    expect(agents).toEqual(['alice', 'bob', 'carol'])
  })
})
