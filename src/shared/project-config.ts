/**
 * Project config loader for multi-instance Hive launching.
 * Config lives at ~/.config/hive/config.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProjectConfig {
  repo: string;
  channel: string;
  agents?: string;
  roles?: string;
  personalities?: Record<string, string>;
  token?: string;
  tools?: string;
  budget?: number;
  admin_ids?: string;
}

export interface HiveConfig {
  defaults: Partial<ProjectConfig>;
  projects: Record<string, ProjectConfig>;
}

const CONFIG_PATH = join(homedir(), ".config", "hive", "config.json");

export function loadConfig(): HiveConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found: ${CONFIG_PATH}\nRun: hive init`);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as HiveConfig;
}

export function resolveProject(
  config: HiveConfig,
  name: string,
): ProjectConfig & { repo: string; channel: string } {
  const project = config.projects[name];
  if (!project) {
    const available = Object.keys(config.projects).join(", ") || "(none)";
    throw new Error(`Unknown project: ${name}\nAvailable: ${available}`);
  }
  const merged = { ...config.defaults, ...project };
  if (!merged.repo) throw new Error(`Project '${name}' missing 'repo'`);
  if (!merged.channel) throw new Error(`Project '${name}' missing 'channel'`);
  // Expand ~ in repo path
  merged.repo = merged.repo.replace(/^~/, homedir());
  return merged as ProjectConfig & { repo: string; channel: string };
}

export function initConfig(): void {
  if (existsSync(CONFIG_PATH)) {
    console.log(`Config already exists: ${CONFIG_PATH}`);
    console.log(`Edit it: hive edit`);
    return;
  }
  mkdirSync(join(homedir(), ".config", "hive"), { recursive: true });
  const starter: HiveConfig = {
    defaults: {
      agents: "worker-01,worker-02,worker-03",
    },
    projects: {
      example: {
        repo: "~/projects/my-app",
        channel: "PASTE_CHANNEL_ID_HERE",
        agents: "manager,alice,bob,carol",
        roles: "manager:manager,alice:engineer:backend,bob:engineer:frontend,carol:qa:testing",
      },
    },
  };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(starter, null, 2)}\n`);
  console.log(`Created: ${CONFIG_PATH}`);
}

export function listProjects(config: HiveConfig): void {
  const projects = Object.entries(config.projects);
  if (projects.length === 0) {
    console.log("No projects configured.");
    return;
  }
  console.log(`${"PROJECT".padEnd(14)} ${"REPO".padEnd(36)} ${"AGENTS".padEnd(24)} CHANNEL`);
  console.log("-".repeat(90));
  for (const [name, proj] of projects) {
    const merged = { ...config.defaults, ...proj };
    const repo = (merged.repo ?? "—").replace(homedir(), "~");
    const agents = merged.agents ?? "(defaults)";
    console.log(
      `${name.padEnd(14)} ${repo.padEnd(36)} ${agents.padEnd(24)} ${merged.channel ?? "—"}`,
    );
  }
}

export const configPath = CONFIG_PATH;
