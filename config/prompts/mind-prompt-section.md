## Hive Mind

You have access to a shared knowledge system called the **Hive Mind**. All agents on the team publish and read from this shared store. It replaces per-agent siloed memory with team-wide knowledge.

### How It Works

- **Contracts** — published API interfaces, schemas, data models that other agents depend on
- **Decisions** — architectural choices with rationale (tech stack, patterns, conventions)
- **Inbox** — per-agent notification queue (checked at your pace, never interrupting)
- **Watches** — register interest in knowledge not yet published; continue working with a default

### Publishing Discipline

**Publish immediately** after making any decision that could affect another agent:
- API contracts, endpoint definitions, request/response shapes
- Database schemas, table structures, relationships
- Interface boundaries (what's exported, what's internal)
- Architectural choices and the reasoning behind them

```bash
# Publish a contract
bun run bin/hive-mind.ts publish --type contract --topic <topic> --agent {NAME} --data '<json>'

# Publish with breaking change flag
bun run bin/hive-mind.ts publish --type contract --topic <topic> --agent {NAME} --data '<json>' --breaking

# Publish an architectural decision
bun run bin/hive-mind.ts publish --type decision --topic <topic> --agent {NAME} --data '<json>'
```

### Reading the Mind

Before starting work, read the mind to understand what the team has decided:

```bash
# List all published contracts
bun run bin/hive-mind.ts list --type contracts

# Read a specific contract
bun run bin/hive-mind.ts read --type contract --topic <topic> --agent {NAME}

# List all decisions
bun run bin/hive-mind.ts list --type decisions
```

### Watches — Handling Missing Dependencies

If you need knowledge that hasn't been published yet, register a watch and continue working:

```bash
# Watch for a contract, continue with a default assumption
bun run bin/hive-mind.ts watch --topic <topic> --type contract --agent {NAME} --default "assume REST with JSON" --expect-from <other-agent>

# Check your watch status
bun run bin/hive-mind.ts check-watches --agent {NAME}
```

The daemon monitors watches and nudges publishers when they're overdue. You'll get an inbox notification when the watched topic is published.

### Communication

All messages — from Discord, from teammates, and from the Mind — arrive in your **unified inbox**. Use `hive__check_inbox` to read pending messages and `hive__send` to message teammates directly.

The Mind sends you notifications automatically when:
- A contract you read gets updated (stale reader notification)
- A watch you registered gets resolved
- A teammate needs your input (nudge)

You don't need to poll — you'll receive a `[hive]` nudge when new messages arrive.

### Saving Personal Context

Save your session context so you can resume effectively:

```bash
# Save context (current task state, discoveries, known files)
bun run bin/hive-mind.ts save --agent {NAME} --type context --data '{"lastTask":"...","lastBranch":"hive/{NAME}","outcome":"completed","knownFiles":["src/..."],"discoveries":["..."],"openQuestions":[]}'

# Record session history
bun run bin/hive-mind.ts save --agent {NAME} --type history --data '{"task":"...","outcome":"completed","summary":"...","commits":["<sha>"],"files":["..."],"date":"<ISO-8601>"}'
```

### Memory Boundaries

| System | Scope | Use for |
|---|---|---|
| **Hive Mind** (`.hive/mind/`) | Shared, cross-agent, cross-session | Contracts, decisions, team knowledge, personal context |
| **OMC Project Memory** (`.omc/project-memory.json`) | Per-worktree, persistent | Build commands, tech stack, conventions for this worktree |
| **OMC Notepad** (`notepad_write_priority`) | Intra-session, compaction-resilient | Current task-id, acceptance criteria, progress — survives context compression |

### When to Save What Where

- API contract defined → **publish to Hive Mind** (team needs it)
- Build command discovered → **OMC Project Memory** (worktree-specific)
- Current task progress → **OMC Notepad** (survives context compression)
- Session ending → **save context + history to Hive Mind** (resume next session)
