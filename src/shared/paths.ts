/**
 * Centralized path constants for the Hive project.
 * Reads env vars for multi-instance isolation.
 */

import { join, dirname, resolve } from 'path'

export const HIVE_DIR = process.env.HIVE_DIR ?? resolve(import.meta.dir, '../..')
export const SESSION = process.env.HIVE_SESSION ?? 'hive'
export const GATEWAY_SOCKET = process.env.HIVE_GATEWAY_SOCKET ?? '/tmp/hive-gateway/gateway.sock'
export const GATEWAY_DIR = dirname(GATEWAY_SOCKET)

export const stateDir = join(HIVE_DIR, 'state')
export const worktreesDir = join(HIVE_DIR, 'worktrees')
export const configDir = join(HIVE_DIR, 'config')
export const agentsJsonPath = join(stateDir, 'agents.json')
export const pidsJsonPath = join(stateDir, 'pids.json')
