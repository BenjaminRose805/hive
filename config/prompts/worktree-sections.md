## Branch Discipline

- **ONLY** commit to branch `hive/{NAME}` — never touch `main`, `develop`, or another agent's branch.
- **Never modify files outside your assigned scope** — the scope enforcement hook will block it.
  If you need cross-boundary changes, publish a contract request:
  `bun run bin/hive-mind.ts publish --type contract --topic <what-you-need> --agent {NAME} --data '{"request": "..."}'`
- Push your branch before sending COMPLETE, BLOCKED, or FAILED. Unpushed work is lost when the session ends.

---

## File Scope Enforcement

Your file scope is defined in the TASK_ASSIGN `Files:` field and enforced at three levels:

1. **Edit-time blocking**: A Claude Code hook checks every Write, Edit, and Bash-write against your scope file at `.hive/scope/{NAME}.json`. Out-of-scope edits are blocked instantly.
2. **Commit-time safety net**: A pre-commit hook rejects commits containing out-of-scope files.
3. **Contract requests**: When you need something from another agent's scope, publish a contract request.

### When You Hit a Scope Boundary

If your edit is blocked with "SCOPE VIOLATION", do NOT try to work around it. Instead:

1. **Publish a contract request** describing what you need:
   ```
   bun run bin/hive-mind.ts publish --type contract --topic <descriptive-name> \
     --agent {NAME} --data '{"request": "what you need", "interface": "proposed API"}'
   ```
2. The agent who owns that file will receive a `CONTRACT_UPDATE` notification automatically.
3. Continue working on other parts of your task while waiting.
4. When the contract is fulfilled, you'll receive a `CONTRACT_UPDATE` in your Discord thread.

### What You CAN Always Touch
- Files listed in your TASK_ASSIGN `Files:` field
- Shared files: `package.json`, `tsconfig.json`, lock files, `node_modules/`
- Hive state: `.hive/**`, `.omc/**`
- Your own branch: `hive/{NAME}`

---

## Completion Protocol (Worktree Roles)

When you believe the task is done:

1. Verify **ALL** acceptance criteria from the TASK_ASSIGN message pass.
2. Run the full test suite relevant to your changes.
3. Commit all changes to branch `hive/{NAME}`.
4. **Push the branch** — this is mandatory before reporting completion.
5. Send COMPLETE:

```
COMPLETE | {NAME} | <task-id>
Branch: hive/{NAME}
Commits: <count>
Files changed: <count>
Tests: <pass count> passing, <fail count> failing
Summary: <1-2 sentence summary of what was built>
```
