# Hive Phase 1 — Implementation Prompts

Run each prompt in its own Claude Code session. They are independent and can run in parallel (except Prompt 4 which depends on 1-3).

**Before starting**: Read the current codebase at `/home/benjamin/hive/` and the vision document at `/home/benjamin/hive/.omc/plans/hive-team-comms.md` for context on the existing architecture.

---

## Prompt 1: Agent Registry + Named Identity

**Files to modify**: `bin/hive-gen-config.ts`, `config/worker-system-prompt.md`, `config/manager-system-prompt.md`
**Files to create**: `config/example-agents.json`

```
Refactor the Hive config generator at /home/benjamin/hive/bin/hive-gen-config.ts to support named agents instead of numbered workers.

Current state: Workers are identified as worker-01, worker-02, etc. via a numeric loop. The --workers N flag controls how many.

Target state: Agents have human-readable names and optional roles. A new --agents flag accepts a comma-separated list of names (e.g., --agents alice,bob,eve). An optional --roles flag maps names to roles (e.g., --roles alice:backend-dev,bob:frontend-dev,eve:qa-engineer). If no roles are specified, agents get the default "developer" role.

Changes needed:

1. Replace --workers N with --agents <names> (comma-separated). Keep --workers as a fallback that auto-generates names: worker-01, worker-02, etc. for backwards compatibility.

2. Add --roles <name:role,...> optional flag.

3. Create state/agents.json registry file during config generation:
{
  "agents": {
    "alice": {
      "name": "alice",
      "role": "backend-dev",
      "status": "stopped",
      "channelId": "<channel-id>",
      "branch": "hive/alice",
      "createdAt": "<ISO timestamp>",
      "lastActive": null,
      "sessionCount": 0
    }
  }
}

4. Config generation uses agent names instead of worker-NN everywhere:
   - Socket paths: /tmp/hive-gateway/{name}.sock
   - Branch names: hive/{name}
   - MCP config env: HIVE_WORKER_ID={name}
   - Mention patterns: ["{name}", "all-workers"]
   - State dirs: state/agents/{name}/

5. If state/agents.json already exists, MERGE with it — preserve existing agents, add new ones, don't overwrite memory or history.

6. Update the worker system prompt template (config/worker-system-prompt.md): replace {NN} with {NAME} and add a {ROLE} placeholder. Update the identity section to say "You are {NAME}, a {ROLE} on a Hive team" instead of "You are Hive Worker {NN}".

7. Update the manager system prompt (config/manager-system-prompt.md) to reference agents by name instead of worker-NN.

8. Create config/example-agents.json showing the registry format for reference.

9. Update --help text with new flags and examples.

10. In single-bot mode: the gateway config (state/gateway/config.json) should list agents by name in the workers array.

Keep ALL existing multi-bot and --workers backwards compatibility working. Named agents are additive.

Verify: run with --agents alice,bob,eve --single-bot --channel-id 123 --token test and confirm all config files use the correct names.
```

---

## Prompt 2: Persistent Agent Memory

**Files to create**: `bin/hive-memory.ts`
**Files to modify**: `bin/hive-launch.sh` (teardown section only)

```
Build a persistent memory system for Hive agents at /home/benjamin/hive/.

Each agent gets a memory directory at state/agents/{name}/memory/ that survives across hive sessions. When an agent is spun up again with the same name, its memory is restored.

1. Create bin/hive-memory.ts — a Bun script with subcommands:

   bun run bin/hive-memory.ts save <name> --context "..." --knowledge "..." --preferences "..."
   bun run bin/hive-memory.ts load <name>   (prints JSON to stdout)
   bun run bin/hive-memory.ts view <name>   (pretty-prints memory)
   bun run bin/hive-memory.ts clear <name>  (wipes memory)
   bun run bin/hive-memory.ts list          (lists all agents with memory)

2. Memory structure — state/agents/{name}/memory/:

   context.json:
   {
     "project": "project name or path",
     "lastWorkedOn": "description of last task",
     "knownFiles": ["src/auth/", "src/api/"],
     "openQuestions": ["Should we use Passport.js?"],
     "discoveries": ["Auth uses refresh token rotation", "Rate limiting missing on /token/refresh"],
     "currentBranch": "hive/alice",
     "lastCommit": "abc1234",
     "updatedAt": "ISO timestamp"
   }

   preferences.json:
   {
     "codingStyle": "prefers functional patterns",
     "testingApproach": "TDD, property-based tests",
     "communicationStyle": "concise, asks clarifying questions",
     "tools": ["ultrawork for parallel tasks", "grep over find"],
     "updatedAt": "ISO timestamp"
   }

   history.json:
   {
     "sessions": [
       {
         "startedAt": "ISO",
         "endedAt": "ISO",
         "task": "Implement JWT authentication",
         "outcome": "completed",
         "summary": "Built login, register, token refresh. 12 tests passing.",
         "commits": ["abc1234", "def5678"],
         "filesModified": ["src/auth/login.ts", "src/auth/middleware.ts"]
       }
     ]
   }

   knowledge.json:
   {
     "facts": [
       { "fact": "The auth module uses bcrypt for password hashing", "source": "src/auth/hash.ts", "discoveredAt": "ISO" },
       { "fact": "Rate limiting is only on /login, not /token/refresh", "source": "src/middleware/rateLimit.ts", "discoveredAt": "ISO" }
     ]
   }

3. Memory loading generates a prompt block:

   bun run bin/hive-memory.ts load alice

   Outputs:
   --- MEMORY RESTORATION ---
   You are resuming as "alice" (backend-dev). Here is what you remember:

   ## Last Session
   Task: Implement JWT authentication
   Outcome: completed
   Summary: Built login, register, token refresh. 12 tests passing.

   ## Known Files
   src/auth/, src/api/

   ## Discoveries
   - The auth module uses bcrypt for password hashing
   - Rate limiting is only on /login, not /token/refresh

   ## Open Questions
   - Should we use Passport.js?

   ## Your Preferences
   - Coding style: prefers functional patterns
   - Testing: TDD, property-based tests
   --- END MEMORY ---

4. The agent's system prompt should instruct it to update its memory during work. Add to the worker system prompt template a section:

   ## Memory Management
   You have persistent memory. Before your session ends or when you make significant discoveries:
   - Update your context by writing to state/agents/{NAME}/memory/context.json
   - Record new facts in knowledge.json
   - Your preferences are in preferences.json — update if they change

5. Update bin/hive-launch.sh teardown (do_teardown function):
   - On teardown, update state/agents.json: set each agent's status to "stopped", record lastActive timestamp
   - Do NOT delete state/agents/{name}/memory/ — memory persists
   - Only clean up PID tracking, socket files, and tmux sessions

6. Memory is injected at launch time. The launch script should:
   - Check if state/agents/{name}/memory/ exists
   - If yes, run: bun run bin/hive-memory.ts load {name}
   - Prepend the output to the agent's initial prompt

Verify: create memory for a test agent, load it, verify the output format. Test that teardown preserves memory.
```

---

## Prompt 3: Discord Slash Commands

**Files to create**: `bin/hive-register-commands.ts`
**Files to modify**: `bin/hive-gateway.ts`

```
Add Discord slash command support to the Hive gateway at /home/benjamin/hive/.

Read the existing gateway at bin/hive-gateway.ts first to understand the current architecture.

1. Create bin/hive-register-commands.ts — a standalone Bun script that registers Discord application commands:

   DISCORD_BOT_TOKEN=xxx DISCORD_APP_ID=yyy bun run bin/hive-register-commands.ts

   Register these commands using discord.js REST API and SlashCommandBuilder:

   /spin-up
     name: string (required) — agent name
     role: string (optional, choices: backend-dev, frontend-dev, security-reviewer, qa-engineer, tech-lead, devops, developer)
     Description: "Start a new agent or resume a stopped one"

   /tear-down
     name: string (required) — agent name (autocomplete from running agents)
     Description: "Stop an agent and preserve its memory"

   /assign
     agent: string (required) — agent name
     task: string (required) — task description
     Description: "Assign a task to an agent"

   /status
     Description: "Show all agents and their current status"

   /agents
     Description: "List all known agents (running and stopped)"

   /ask
     agent: string (required) — agent name
     message: string (required) — message to send
     Description: "Send a message to a specific agent"

   /memory
     agent: string (required) — agent name
     Description: "View an agent's persistent memory"

   /broadcast
     message: string (required) — message to send to all agents
     Description: "Send a message to all running agents"

   Add a --guild flag for guild-specific registration (faster, instant) vs global (takes up to 1 hour to propagate).

2. Add InteractionCreate handler to bin/hive-gateway.ts:

   After the existing messageCreate handler, add:

   client.on('interactionCreate', async (interaction) => {
     if (!interaction.isChatInputCommand()) return
     try {
       switch (interaction.commandName) {
         case 'spin-up':    return await handleSlashSpinUp(interaction)
         case 'tear-down':  return await handleSlashTearDown(interaction)
         case 'assign':     return await handleSlashAssign(interaction)
         case 'status':     return await handleSlashStatus(interaction)
         case 'agents':     return await handleSlashAgents(interaction)
         case 'ask':        return await handleSlashAsk(interaction)
         case 'memory':     return await handleSlashMemory(interaction)
         case 'broadcast':  return await handleSlashBroadcast(interaction)
       }
     } catch (err) {
       const msg = err instanceof Error ? err.message : String(err)
       if (interaction.replied || interaction.deferred) {
         await interaction.followUp({ content: `Error: ${msg}`, ephemeral: true })
       } else {
         await interaction.reply({ content: `Error: ${msg}`, ephemeral: true })
       }
     }
   })

3. Implement each slash command handler:

   handleSlashStatus: Read state/agents.json, build a Discord embed with a table of agents showing name, role, status (running/stopped), branch, last active. Reply with the embed.

   handleSlashAgents: Similar to status but shows all agents including stopped ones, with memory size info.

   handleSlashAssign: Read state/agents.json, check agent exists and is running. Format a TASK_ASSIGN message per the protocol (config/protocol.md) and route it to the agent via the existing worker registry. Reply with confirmation embed.

   handleSlashAsk: Find the agent in the worker registry, POST to their /inbound socket with the message. Reply with confirmation.

   handleSlashMemory: Read state/agents/{name}/memory/*.json files, format as an embed showing context, knowledge, preferences, and last session summary. Reply with the embed.

   handleSlashBroadcast: Send the message to ALL registered workers' /inbound endpoints. Reply with confirmation showing which agents received it.

   handleSlashSpinUp: This is the most complex one. For Phase 1, it should:
   - Defer the interaction reply (agent startup takes time)
   - Read state/agents.json to check if the agent exists
   - If the agent exists and is stopped: resume (use existing config, restore memory)
   - If the agent doesn't exist: create new entry in agents.json
   - Create/verify the git worktree at worktrees/{name}/
   - Generate MCP config at state/agents/{name}/mcp-config.json (reuse buildRelayMcpConfig logic)
   - Spawn the Claude Code process using Bun.spawn:
     Bun.spawn(["claude", "--name", `hive-${name}`, "--append-system-prompt", systemPrompt, "--mcp-config", mcpConfigPath, "--permission-mode", "bypassPermissions"], { cwd: worktreeDir, stdin: "pipe", stdout: "inherit", stderr: "inherit" })
   - Write the initial prompt to the process stdin (including memory restoration if resuming)
   - Register the worker in the gateway's internal workers Map
   - Update agents.json status to "running"
   - Reply with success embed showing agent name, role, branch

   handleSlashTearDown:
   - Find the agent's Claude process (track PIDs or process refs in a Map)
   - Send SIGTERM to the process
   - Deregister from the worker Map
   - Update agents.json status to "stopped", record lastActive
   - Clean up the agent's Unix socket file
   - Reply with confirmation embed

4. Process tracking: Add a Map<string, { process: Subprocess, pid: number }> to track spawned Claude processes so tear-down can kill them.

5. Import the required discord.js types: ChatInputCommandInteraction, EmbedBuilder, etc.

6. Add the DISCORD_APP_ID env var to the gateway (needed for command registration check). The register-commands script needs it, but the gateway itself doesn't — it just handles incoming interactions.

Verify: Run the register-commands script with a test bot. Verify commands appear in Discord. Test /status and /agents with a mock agents.json.
```

---

## Prompt 4: Launch Script Integration

**Depends on**: Prompts 1, 2, 3
**Files to modify**: `bin/hive-launch.sh`

```
Update the Hive launch script at /home/benjamin/hive/bin/hive-launch.sh to integrate named agents, persistent memory, and the new gateway lifecycle management.

Read the current script first, then read state/agents.json (if it exists) and bin/hive-memory.ts to understand the new data structures.

Changes needed:

1. Replace the numeric worker loop with a registry-based loop:

   OLD: for i in $(seq 1 "$WORKERS"); do worker_id=$(printf '%02d' "$i") ...
   NEW: Read agent names from state/agents.json. For each agent with status != "running":

   while IFS= read -r agent_name; do
     agent_role=$(jq -r ".agents.\"$agent_name\".role // \"developer\"" state/agents.json)
     # ... launch logic using $agent_name and $agent_role
   done < <(jq -r '.agents | keys[]' state/agents.json)

2. Memory restoration on startup:

   For each agent being launched, check for existing memory:
   if [[ -d "state/agents/$agent_name/memory" ]]; then
     memory_block=$(bun run bin/hive-memory.ts load "$agent_name" 2>/dev/null || true)
   fi

   Prepend the memory block to the agent's initial prompt.

3. System prompt composition:

   The agent's system prompt is now composed from:
   a. Base worker prompt (config/worker-system-prompt.md) with {NAME} and {ROLE} substituted
   b. Optional role profile (config/profiles/{role}.md) if it exists
   c. Memory restoration block (if agent has memory)

   sed "s/{NAME}/$agent_name/g; s/{ROLE}/$agent_role/g" config/worker-system-prompt.md

4. Tmux window names use agent names:

   tmux new-window -t hive -n "$agent_name" "$launch_script"

5. The manager's initial prompt should list agents by name:

   "You are the Hive coordinator. Your team: alice (backend-dev), bob (frontend-dev), eve (qa-engineer). Channel ID: $CHANNEL_ID. ..."

   Build the team list dynamically from state/agents.json.

6. Teardown changes:

   On teardown, for each agent in state/agents.json:
   - Set status to "stopped"
   - Record lastActive timestamp
   - Preserve state/agents/{name}/memory/ (do NOT delete)
   - Clean up sockets and PIDs only

7. The --agents flag should be passed through to hive-gen-config.ts if state/agents.json doesn't exist yet.

8. Add backwards compatibility: if --workers N is used instead of --agents, auto-generate names (worker-01, worker-02, ...) and create the registry.

9. Update the summary output to show agent names and roles instead of worker-NN.

10. Keep --single-bot, --tmux, --no-tmux, --teardown, --clean all working.

Verify:
- Launch with --agents alice,bob --roles alice:backend-dev,bob:frontend-dev
- Verify tmux windows are named "alice" and "bob"
- Verify state/agents.json has correct entries
- Teardown and relaunch — verify memory persistence
- Launch with --workers 3 — verify backwards compatibility creates worker-01/02/03
```

---

## Prompt 5: Agent Profiles (Optional, can be done later)

**Files to create**: `config/profiles/` directory with role files

```
Create agent profile templates for the Hive system at /home/benjamin/hive/config/profiles/.

Each profile is a markdown file that gets appended to an agent's system prompt based on their role. Profiles contain domain-specific expertise and behavioral instructions.

Create these profiles:

1. config/profiles/developer.md (default role):
   - General software development best practices
   - Follow project conventions
   - Write tests for all new code
   - Ask questions when requirements are ambiguous

2. config/profiles/backend-dev.md:
   - API design (REST, versioning, error handling)
   - Database schema design and migrations
   - Authentication and authorization patterns
   - Performance: caching, connection pooling, query optimization
   - Security: input validation, SQL injection prevention, rate limiting

3. config/profiles/frontend-dev.md:
   - Component architecture (composition over inheritance)
   - State management patterns
   - Accessibility (WCAG 2.1 AA)
   - Responsive design
   - Performance: bundle size, lazy loading, memoization

4. config/profiles/security-reviewer.md:
   - OWASP Top 10 awareness
   - Authentication/authorization review
   - Input validation and sanitization
   - Secret management
   - Dependency vulnerability scanning
   - Threat modeling

5. config/profiles/qa-engineer.md:
   - Test strategy (unit, integration, e2e)
   - Edge case identification
   - Property-based testing
   - Regression testing
   - Test data management
   - Bug report writing (reproduce steps, expected vs actual)

6. config/profiles/tech-lead.md:
   - Architecture review before implementation
   - Code review with constructive feedback
   - Technical debt tracking
   - Cross-cutting concern identification
   - Dependency evaluation
   - Documentation standards

7. config/profiles/devops.md:
   - CI/CD pipeline design
   - Docker and containerization
   - Infrastructure as code
   - Monitoring and alerting
   - Log aggregation
   - Deployment strategies (blue-green, canary)

Each profile should be 30-60 lines of focused, actionable instructions. Not generic advice — specific behavioral directives that shape how the agent approaches work. The agent should behave differently with a backend-dev profile vs a security-reviewer profile.

Also create config/profiles/_base.md with instructions common to all agents:
- You are part of a Hive team
- Communicate via Discord using the message protocol
- Update your memory when you make discoveries
- Push your work to your branch frequently
- Ask other team members for help when needed

Verify: Each file exists and is 30-60 lines. No overlap between profiles (each has unique expertise).
```

---

## Running These Prompts

Each prompt is self-contained. Run them in separate Claude Code sessions:

```bash
# Session 1: Agent Registry
claude -p "$(cat docs/phase1-prompts.md | sed -n '/^## Prompt 1/,/^## Prompt 2/p' | head -n -2)"

# Session 2: Persistent Memory
claude -p "$(cat docs/phase1-prompts.md | sed -n '/^## Prompt 2/,/^## Prompt 3/p' | head -n -2)"

# Session 3: Slash Commands
claude -p "$(cat docs/phase1-prompts.md | sed -n '/^## Prompt 3/,/^## Prompt 4/p' | head -n -2)"

# Session 4: Integration (after 1-3 complete)
claude -p "$(cat docs/phase1-prompts.md | sed -n '/^## Prompt 4/,/^## Prompt 5/p' | head -n -2)"

# Session 5: Profiles (optional, independent)
claude -p "$(cat docs/phase1-prompts.md | sed -n '/^## Prompt 5/,/^## Running/p' | head -n -2)"
```

Or better yet — use Hive itself to run them in parallel once the current version is stable.
