import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentsJson } from "../shared/agent-types";
import { agentsJsonPath, SESSION, stateDir } from "../shared/paths";
import { run } from "../shared/subprocess";

export async function main(_args: string[]): Promise<void> {
  let hasAnything = false;

  // Load channel map if available
  let channels: Record<string, string> = {};
  try {
    const channelsPath = join(stateDir, "gateway", "channels.json");
    if (existsSync(channelsPath)) {
      channels = JSON.parse(readFileSync(channelsPath, "utf8"));
    }
  } catch {}

  // Agents
  if (existsSync(agentsJsonPath)) {
    const data: AgentsJson = JSON.parse(readFileSync(agentsJsonPath, "utf8"));
    if (data.agents?.length) {
      hasAnything = true;
      console.log("Agents:");
      for (const a of data.agents) {
        const ch = channels[a.name] ? ` [channel: ${channels[a.name]}]` : "";
        const roleLabel = a.domain ? `${a.role}:${a.domain}` : (a.role ?? "unknown");
        console.log(`  ${a.name} (${roleLabel}) — ${a.status ?? "unknown"}${ch}`);
      }
    }
  }

  // Tmux windows
  const tmux = run(["tmux", "list-windows", "-t", SESSION]);
  if (tmux.exitCode === 0 && tmux.stdout) {
    hasAnything = true;
    console.log(`Tmux (${SESSION}):`);
    for (const line of tmux.stdout.split("\n")) {
      console.log(`  ${line}`);
    }
  }

  if (!hasAnything) {
    console.log("No hive running.");
  }
}
