/**
 * src/shared/contracts.ts — Public API contract for the shared module.
 *
 * All types, interfaces, and functions intended for external consumption
 * MUST be re-exported here. Other modules should import from this file.
 */

// Agent types
export type { Role, CoreDomain, AgentEntry, AgentsJson } from "./agent-types.ts";
export { VALID_ROLES, CORE_DOMAINS, NO_WORKTREE_ROLES } from "./agent-types.ts";

// Paths
export {
  HIVE_DIR,
  getSession,
  getGatewaySocket,
  getGatewayDir,
  getStateDir,
  getAgentsJsonPath,
  getPidsJsonPath,
  worktreesDir,
  configDir,
  stateDir,
  agentsJsonPath,
  pidsJsonPath,
  SESSION,
  GATEWAY_SOCKET,
  GATEWAY_DIR,
} from "./paths.ts";

// Project config
export type { ProjectConfig, HiveConfig } from "./project-config.ts";
export {
  loadConfig,
  resolveProject,
  initConfig,
  listProjects,
  configPath,
} from "./project-config.ts";

// Subprocess
export type { RunResult } from "./subprocess.ts";
export { run, runOrDie } from "./subprocess.ts";

// Validation
export {
  AGENT_NAME_RE,
  RESERVED_NAMES,
  validateSafeName,
  validateRole,
  validateDomain,
  parseAgentAssignment,
  validateAgentNames,
} from "./validation.ts";
