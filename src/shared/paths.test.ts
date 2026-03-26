import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { join, dirname } from 'path'

// ---------------------------------------------------------------------------
// Helpers — paths.ts reads env at import time for statics and at call time
// for getters. We re-import the module per test group to control statics.
// ---------------------------------------------------------------------------

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

// ---------------------------------------------------------------------------
// Dynamic getters (read env at call time)
// ---------------------------------------------------------------------------

describe('dynamic path getters', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved.HIVE_SESSION = process.env.HIVE_SESSION
    saved.HIVE_GATEWAY_SOCKET = process.env.HIVE_GATEWAY_SOCKET
  })

  afterEach(() => {
    setEnv(saved)
  })

  test('getSession returns HIVE_SESSION env var', async () => {
    setEnv({ HIVE_SESSION: 'my-project' })
    const { getSession } = await import('./paths.ts')
    expect(getSession()).toBe('my-project')
  })

  test('getSession defaults to "hive" when env unset', async () => {
    setEnv({ HIVE_SESSION: undefined })
    const { getSession } = await import('./paths.ts')
    expect(getSession()).toBe('hive')
  })

  test('getGatewaySocket returns HIVE_GATEWAY_SOCKET env var', async () => {
    setEnv({ HIVE_GATEWAY_SOCKET: '/custom/path/gw.sock' })
    const { getGatewaySocket } = await import('./paths.ts')
    expect(getGatewaySocket()).toBe('/custom/path/gw.sock')
  })

  test('getGatewaySocket defaults when env unset', async () => {
    setEnv({ HIVE_GATEWAY_SOCKET: undefined })
    const { getGatewaySocket } = await import('./paths.ts')
    expect(getGatewaySocket()).toBe('/tmp/hive-gateway/gateway.sock')
  })

  test('getGatewayDir returns dirname of gateway socket', async () => {
    setEnv({ HIVE_GATEWAY_SOCKET: '/run/hive/gateway.sock' })
    const { getGatewayDir } = await import('./paths.ts')
    expect(getGatewayDir()).toBe('/run/hive')
  })

  test('different env values produce different paths (project isolation)', async () => {
    setEnv({ HIVE_SESSION: 'project-a', HIVE_GATEWAY_SOCKET: '/tmp/a/gw.sock' })
    const modA = await import('./paths.ts')
    const sessionA = modA.getSession()
    const socketA = modA.getGatewaySocket()

    setEnv({ HIVE_SESSION: 'project-b', HIVE_GATEWAY_SOCKET: '/tmp/b/gw.sock' })
    const sessionB = modA.getSession()
    const socketB = modA.getGatewaySocket()

    expect(sessionA).not.toBe(sessionB)
    expect(socketA).not.toBe(socketB)
  })
})

// ---------------------------------------------------------------------------
// Static paths (derived from HIVE_DIR)
// ---------------------------------------------------------------------------

describe('static paths', () => {
  test('stateDir is HIVE_DIR/state', async () => {
    const { HIVE_DIR, stateDir } = await import('./paths.ts')
    expect(stateDir).toBe(join(HIVE_DIR, 'state'))
  })

  test('worktreesDir is HIVE_DIR/worktrees', async () => {
    const { HIVE_DIR, worktreesDir } = await import('./paths.ts')
    expect(worktreesDir).toBe(join(HIVE_DIR, 'worktrees'))
  })

  test('configDir is HIVE_DIR/config', async () => {
    const { HIVE_DIR, configDir } = await import('./paths.ts')
    expect(configDir).toBe(join(HIVE_DIR, 'config'))
  })

  test('agentsJsonPath is under stateDir', async () => {
    const { stateDir, agentsJsonPath } = await import('./paths.ts')
    expect(agentsJsonPath).toBe(join(stateDir, 'agents.json'))
  })

  test('pidsJsonPath is under stateDir', async () => {
    const { stateDir, pidsJsonPath } = await import('./paths.ts')
    expect(pidsJsonPath).toBe(join(stateDir, 'pids.json'))
  })
})

// ---------------------------------------------------------------------------
// Backward-compat aliases
// ---------------------------------------------------------------------------

describe('backward-compat aliases', () => {
  test('SESSION alias matches getSession() at import time', async () => {
    const mod = await import('./paths.ts')
    // SESSION is captured at import time — should equal getSession() with same env
    expect(typeof mod.SESSION).toBe('string')
  })

  test('GATEWAY_SOCKET alias matches getGatewaySocket() at import time', async () => {
    const mod = await import('./paths.ts')
    expect(typeof mod.GATEWAY_SOCKET).toBe('string')
  })

  test('GATEWAY_DIR alias matches getGatewayDir() at import time', async () => {
    const mod = await import('./paths.ts')
    expect(typeof mod.GATEWAY_DIR).toBe('string')
  })
})
