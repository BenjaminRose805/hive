## Memory Management

You have persistent memory that survives across sessions. Before your session ends or when you make significant discoveries:

- Update your context: write to `state/agents/{NAME}/memory/context.json`
- Record new facts in `knowledge.json`
- Your preferences are in `preferences.json` — update if they change
- Session history is tracked automatically

### Context Schema

```json
{
  "lastTask": "description of the last task you worked on",
  "lastBranch": "hive/your-name",
  "outcome": "completed|partial|blocked",
  "knownFiles": ["src/auth/index.ts", "src/api/routes.ts"],
  "discoveries": ["auth uses JWT with 1h expiry", "tests require Docker"],
  "openQuestions": ["Should we migrate to OAuth2?"]
}
```

### Knowledge Schema

```json
[
  {
    "fact": "The database uses PostgreSQL 15 with pgvector extension",
    "source": "README.md",
    "discoveredAt": "2026-01-15T10:00:00Z"
  }
]
```

### Preferences Schema

```json
{
  "codingStyle": "TypeScript strict mode, functional patterns preferred",
  "testingApproach": "unit tests for logic, integration tests for API endpoints",
  "communicationStyle": "concise status updates, flag blockers immediately",
  "tools": ["ripgrep", "bun", "TypeScript compiler"]
}
```

### History Schema (capped at 50 entries)

```json
[
  {
    "task": "Implement JWT refresh token rotation",
    "outcome": "completed",
    "summary": "Added refresh token table, rotation logic, and tests",
    "commits": ["abc1234"],
    "files": ["src/auth/refresh.ts"],
    "date": "2026-01-15T12:00:00Z"
  }
]
```

### How to Save Memory

Use the hive-memory tool from your session:

```bash
# Save context after completing work
bun run bin/hive-memory.ts save --agent {NAME} --type context --data '{
  "lastTask": "your task description",
  "lastBranch": "hive/{NAME}",
  "outcome": "completed",
  "knownFiles": ["src/..."],
  "discoveries": ["important thing you learned"],
  "openQuestions": ["unresolved question"]
}'

# Record a new fact
bun run bin/hive-memory.ts save --agent {NAME} --type knowledge --data '{
  "fact": "your discovery",
  "source": "file or context where you found it",
  "discoveredAt": "ISO-8601 timestamp"
}'

# Record a completed session
bun run bin/hive-memory.ts save --agent {NAME} --type history --data '{
  "task": "what you worked on",
  "outcome": "completed|partial|blocked",
  "summary": "brief summary of what was done",
  "commits": ["commit sha"],
  "files": ["files modified"],
  "date": "ISO-8601 timestamp"
}'
```

### When to Save

1. **Before responding to a TASK_COMPLETE** — save context with the outcome
2. **When you discover something important** — save to knowledge immediately
3. **When your working preferences evolve** — update preferences
4. **At session end** — save a history entry summarizing your work

Your memory is loaded at each session start via `--append-system-prompt`. The more accurately you maintain it, the more effectively you can resume work across sessions.
