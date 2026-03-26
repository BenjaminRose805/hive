export type Role = "manager" | "architect" | "engineer" | "qa" | "devops" | "writer" | "reviewer";
export type CoreDomain =
  | "api"
  | "auth"
  | "data"
  | "frontend"
  | "backend"
  | "security"
  | "infra"
  | "cicd"
  | "performance"
  | "testing";

export const VALID_ROLES: ReadonlySet<string> = new Set<Role>([
  "manager",
  "architect",
  "engineer",
  "qa",
  "devops",
  "writer",
  "reviewer",
]);

export const CORE_DOMAINS: ReadonlySet<string> = new Set<CoreDomain>([
  "api",
  "auth",
  "data",
  "frontend",
  "backend",
  "security",
  "infra",
  "cicd",
  "performance",
  "testing",
]);

/** Roles that don't produce file changes — no worktree, no branch, no scope enforcement */
export const NO_WORKTREE_ROLES: ReadonlySet<string> = new Set(["manager", "architect", "reviewer"]);

export interface AgentEntry {
  name: string;
  role?: string;
  domain?: string;
  status?: string;
  created?: string;
  branch?: string;
  lastActive?: string;
  channelId?: string;
}

export interface AgentsJson {
  agents: AgentEntry[];
  created: string;
  mode: string;
}
