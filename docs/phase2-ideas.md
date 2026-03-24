# Hive Phase 2 — Discord Organization & Multi-Project

## Problem

Phase 1 gave us named agents, memory, slash commands, and profiles. But all communication still goes into one flat Discord channel, which gets noisy with 3+ agents. There's also no structured way to run multiple projects.

## Three Features

### 1. Auto-Threading

When the manager sends TASK_ASSIGN to an agent, the gateway automatically creates a Discord thread for that task. All subsequent messages for that task (STATUS, QUESTION, ANSWER, COMPLETE) are routed into the thread. The main channel stays clean — only TASK_ASSIGN summaries and COMPLETE results appear there.

**Why**: A 5-agent hive with 10 tasks generates hundreds of messages. Without threads, the main channel becomes unreadable. Threads give each task its own conversation space.

**Sketch**:
- Gateway intercepts outbound TASK_ASSIGN → creates thread named `<agent>: <task-id>` → posts TASK_ASSIGN inside it
- Gateway tracks `taskId → threadId` mapping
- All messages containing that task-id are routed to the thread
- COMPLETE messages get posted to both the thread and the main channel (as a summary)
- The main channel becomes a dashboard: you see task assignments and completions at a glance, click into a thread for details

**Existing support**: The gateway already handles threads in `routeInbound` (resolves `msg.channel.parentId` for thread messages). The change is making the gateway *create* threads, not just receive from them.

### 2. Multi-Project Support

A simple way to run Hive against multiple projects without manually juggling bot tokens, channel IDs, and state directories.

**Why**: Right now launching a hive requires remembering 5+ flags. Running two projects means two terminals with different flags. A config file makes this declarative.

**Sketch**:
- A `hive-projects.json` (or `~/.hive/projects.json`) file:
  ```json
  {
    "my-api": {
      "repo": "/home/user/my-api",
      "channelId": "123456789",
      "token": "env:HIVE_BOT_TOKEN_API",
      "agents": ["alice", "bob"],
      "roles": { "alice": "backend-dev", "bob": "qa-engineer" }
    },
    "my-frontend": {
      "repo": "/home/user/my-frontend",
      "channelId": "987654321",
      "token": "env:HIVE_BOT_TOKEN_FRONTEND",
      "agents": ["carol", "dave"],
      "roles": { "carol": "frontend-dev", "dave": "designer" }
    }
  }
  ```
- Launch with: `hive-launch.sh --project my-api`
- One bot per project (tokens are free, keeps things isolated)
- State, memory, and worktrees scoped per project automatically

### 3. Thread Summary on Completion

When an agent sends COMPLETE, the gateway posts a rich summary to the main channel with a link to the task thread. This turns the main channel into a progress feed.

**Sketch**:
```
✅ alice completed task auth-middleware
   Branch: hive/alice | 4 commits | 8 files | 12 tests passing
   🔗 Thread: #alice-auth-middleware
```

This is a small addition on top of auto-threading but makes the main channel genuinely useful as a dashboard.

## Priority

1. **Auto-threading + selective routing** — highest value, solves both noise problems at once
2. **Multi-project** — quality of life, can work around it manually
3. **Thread summary** — small add-on to auto-threading

### 4. Selective Message Routing (Reduce Noise)

Right now the gateway delivers messages to every agent that matches a mention pattern. This means agents get pinged for messages they don't need to act on — other agents' STATUS updates, HEARTBEATs, COMPLETE messages between the manager and a different agent, etc. Each unnecessary ping burns context window and budget.

**Why**: An agent working on auth doesn't need to see `STATUS | bob | ui-task | IN_PROGRESS`. But because the manager's `requireMention: false` means the manager sees everything, and `all-workers` broadcasts hit everyone.

**Sketch**:
- **Thread-scoped routing**: If auto-threading is implemented, agents only receive messages from their own task thread + the main channel when directly mentioned. This solves most of the problem naturally.
- **Message type filtering at the gateway**: The gateway already parses message content. It could filter by protocol message type:
  - `TASK_ASSIGN` → only deliver to the named agent
  - `ANSWER` → only deliver to the agent who asked the QUESTION
  - `STATUS/HEARTBEAT/COMPLETE` → only deliver to the manager (not other agents)
  - `INTEGRATE` → deliver to named agents in the Workers/Agents list
  - Direct name mention → deliver to that agent only
  - `all-workers`/`all-agents` → deliver to everyone (true broadcasts only)
- **Result**: Agents only get pinged when they need to read and act on something. No wasted context on irrelevant updates.

**Existing support**: The gateway's `routeInbound` function already checks `worker.requireMention` and `isMentioned()`. The filtering logic would go between the channel match and the mention check — parse the first line for the protocol type and target, then skip delivery if the agent isn't the intended recipient.

## Open Questions for Planning

- Should threads be per-task or per-agent? Per-task is cleaner but creates more threads. Per-agent means one long thread per agent across all their tasks.
- Should the manager also get its own thread for coordination, or stay in the main channel?
- For multi-project: one Discord server with multiple channels, or multiple servers? (Channels are simpler. Servers give more isolation.)
- Should completed task threads be auto-archived after integration?
