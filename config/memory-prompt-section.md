## Memory Management

You have persistent memory that survives across sessions. Memory files live in `state/agents/{NAME}/memory/` and are loaded at session start via `--append-system-prompt`.

### What each file holds

- `context.json` — current task, branch, outcome, known files, discoveries, open questions
- `knowledge.json` — array of facts discovered (pattern, gotcha, convention), each with `fact`, `source`, `discoveredAt`
- `preferences.json` — your coding style, test approach, communication style, preferred tools
- `history.json` — capped at 50 entries; one entry per completed/failed session with task, outcome, summary, commits, files, date

### When to Save

1. **Before sending COMPLETE** — save context with the outcome and a history entry
2. **When you discover something important** — save to knowledge immediately
3. **When your working preferences evolve** — update preferences
4. **At session end** — save a history entry summarizing your work

### Save Commands

```bash
# Save context
bun run bin/hive-memory.ts save --agent {NAME} --type context --data '{"lastTask":"...","lastBranch":"hive/{NAME}","outcome":"completed","knownFiles":["src/..."],"discoveries":["..."],"openQuestions":[]}'

# Record a fact
bun run bin/hive-memory.ts save --agent {NAME} --type knowledge --data '{"fact":"...","source":"...","discoveredAt":"<ISO-8601>"}'

# Record session history
bun run bin/hive-memory.ts save --agent {NAME} --type history --data '{"task":"...","outcome":"completed","summary":"...","commits":["<sha>"],"files":["..."],"date":"<ISO-8601>"}'
```

Your memory is loaded at each session start. The more accurately you maintain it, the more effectively you can resume work across sessions.
