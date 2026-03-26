/**
 * Centralized path helpers for the Hive project.
 * Dynamic values (SESSION, GATEWAY_SOCKET) use getters so they
 * reflect env var changes made after module load (e.g. projectUp).
 */

import { dirname, join, resolve } from "node:path";

export const HIVE_DIR = process.env.HIVE_DIR ?? resolve(import.meta.dir, "../..");

// Dynamic — read env at call time, not import time
export function getSession(): string {
  return process.env.HIVE_SESSION ?? "hive";
}

export function getGatewaySocket(): string {
  return process.env.HIVE_GATEWAY_SOCKET ?? "/tmp/hive-gateway/gateway.sock";
}

export function getGatewayDir(): string {
  return dirname(getGatewaySocket());
}

// Static — these don't change per-project
export const stateDir = join(HIVE_DIR, "state");
export const worktreesDir = join(HIVE_DIR, "worktrees");
export const configDir = join(HIVE_DIR, "config");
export const agentsJsonPath = join(stateDir, "agents.json");
export const pidsJsonPath = join(stateDir, "pids.json");

// Backward-compat aliases (read once — use getters for dynamic access)
export const SESSION = getSession();
export const GATEWAY_SOCKET = getGatewaySocket();
export const GATEWAY_DIR = getGatewayDir();
