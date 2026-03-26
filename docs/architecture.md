# Hive Architecture

Hive is a multi-agent Claude Code orchestrator that runs a swarm of autonomous AI developer sessions, coordinated through Discord. Each agent is a full Claude Code instance with its own terminal, git worktree, and MCP tool set. The only communication channel between agents is Discord — no shared filesystem, no direct IPC.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Component Architecture](#2-component-architecture)
3. [Communication Architecture](#3-communication-architecture)
4. [Inbox System](#4-inbox-system)
5. [Smart Nudge System](#5-smart-nudge-system)
6. [Mind Knowledge System](#6-mind-knowledge-system)
7. [Worker Lifecycle](#7-worker-lifecycle)
8. [File Structure](#8-file-structure)
9. [Configuration](#9-configuration)

---

## 1. System Overview

Hive maps a multi-agent swarm onto three physical layers:

- **Discord** — the message bus between humans and agents, and between agents
- **tmux** — the process manager; each agent runs in its own window
- **Git worktrees** — each agent has an isolated checkout on its own branch

```text
┌─────────────────────────────────────────────────────────────┐
│                        DISCORD                               │
│  ┌──────────────┐  ┌────────────┐  ┌────────────────────┐  │
│  │ #dashboard   │  │ #manager   │  │ #worker-01  #alice │  │
│  └──────────────┘  └────────────┘  └────────────────────┘  │
└────────────────────────────┬────────────────────────────────┘
                             │ Discord Gateway API
                    ┌────────▼────────┐
                    │    GATEWAY      │  (single bot connection)
                    │  hive-gateway   │  Unix socket: /tmp/hive-gateway/
                    │  HTTP server    │  gateway.sock
                    └──┬─────────┬───┘
              Inbox    │         │  Nudge
              writes   │         │  (tmux paste)
       ┌───────────────┴──┐   ┌──┴──────────────────────────┐
       │   FILE SYSTEM     │   │         TMUX SESSION         │
       │  inbox/messages/  │   │  gateway | mind | manager   │
       │    manager/       │   │  worker-01 | alice | bob    │
       │    worker-01/     │   └─────────────────────────────┘
       │    alice/         │
       └───────────────────┘
                    │
                    │  Each tmux window runs Claude Code
                    │  with two MCP servers:
                    │
            ┌───────┴────────────────────────────┐
            │  inbox-relay (hive__*)              │
            │  discord-relay (discord__*)         │
            │  + role-specific tools              │
            └─────────────────────────────────────┘

                    ┌──────────────────────┐
                    │   MIND DAEMON        │
                    │  (separate tmux win) │
                    │  watches .hive/mind/ │
                    └──────────────────────┘
```

### Key Design Decisions

- **Single bot token** — all agents share one Discord bot connection through the gateway. No per-agent bot accounts.
- **File-based inbox** — messages are written to files, not pushed over sockets. Agents read at their own pace and can never miss a message.
- **tmux as IPC** — the gateway injects nudge text into agent terminals via `tmux load-buffer` / `paste-buffer`. No daemon sockets on the agent side.
- **No filesystem coupling** — agents communicate only through Discord and the inbox. The Mind daemon handles shared knowledge separately.

---

## 2. Component Architecture

### 2.1 Gateway (`bin/hive-gateway.ts`)

The gateway is the hub of the system. It owns the single Discord bot connection and provides an HTTP API over a Unix domain socket.

```text
┌──────────────────────────────────────────────────────────┐
│                     GATEWAY PROCESS                       │
│                                                           │
│  ┌──────────────┐    ┌──────────────────────────────┐    │
│  │ Discord.js   │    │  HTTP Server (Bun.serve)     │    │
│  │ client       │    │  Unix socket: gateway.sock   │    │
│  │              │    │                              │    │
│  │  on message  │    │  POST /register              │    │
│  │  ──────────► │    │  POST /deregister            │    │
│  │  routeInbound│    │  POST /send                  │    │
│  │              │    │  POST /react                 │    │
│  │  Slash cmds  │    │  POST /edit                  │    │
│  │  /status     │    │  POST /fetch                 │    │
│  │  /agents     │    │  POST /download              │    │
│  │  /broadcast  │    │  POST /nudge                 │    │
│  │  /ask        │    │  POST /status                │    │
│  │  /assign     │    │  GET  /status/:workerId      │    │
│  │  /spin-up    │    │  GET  /health                │    │
│  │  /tear-down  │    │  GET  /channels              │    │
│  └──────────────┘    └──────────────────────────────┘    │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Worker Registry  (in-memory Map<workerId, entry>)  │ │
│  │  - workerId, channelId, mentionPatterns, role       │ │
│  │  - status: available | focused | blocked            │ │
│  │  - failCount, statusSince                           │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────┐ │
│  │ Inbox writer │  │ Nudge engine   │  │ Protocol     │ │
│  │ (atomic file │  │ (tmux inject)  │  │ parser +     │ │
│  │  writes)     │  │ per-worker     │  │ selective    │ │
│  └──────────────┘  │ async mutex    │  │ router       │ │
│                    └────────────────┘  └──────────────┘ │
└──────────────────────────────────────────────────────────┘
```

**Responsibilities:**

- Owns the Discord WebSocket connection (GatewayIntentBits: Guilds, GuildMessages, MessageContent, DirectMessages)
- Routes inbound Discord messages to worker inboxes using the protocol parser and selective router
- Provides HTTP API for worker outbound operations (send, react, edit, fetch, download)
- Creates and manages per-worker Discord channels within a guild category
- Executes the smart nudge (tmux injection) with status-aware suppression
- Handles slash commands for human operators
- Writes scope files to `.hive/scope/{worker}.json` when a TASK_ASSIGN is received
- Auto-registers Mind watches for TASK_ASSIGN dependencies
- Cross-posts key protocol events (STATUS, COMPLETE, QUESTION, ESCALATE) to the dashboard channel as embeds

### 2.2 Mind Daemon (`src/mind/daemon.ts`)

A long-running Bun process that manages shared team knowledge. It is the sole writer to the canonical mind directories.

```text
┌──────────────────────────────────────────────────────────┐
│                    MIND DAEMON                            │
│                                                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │  fs.watch(.hive/mind/pending/) + 2s poll         │    │
│  └───────────────────┬──────────────────────────────┘    │
│                      │ DeltaFile                          │
│                      ▼                                    │
│  ┌──────────────────────────────────────────────────┐    │
│  │  processDelta() — per-topic mutex                │    │
│  │                                                  │    │
│  │  publish     → write canonical, notify readers  │    │
│  │  update      → version bump, last-writer-wins   │    │
│  │  retract     → mark retracted, notify readers   │    │
│  │  register-reader → update reader registry       │    │
│  │  register-watch  → track watch, resolve if ready│    │
│  └───────────────────┬──────────────────────────────┘    │
│                      │                                    │
│         ┌────────────┼────────────────┐                  │
│         ▼            ▼                ▼                   │
│  ┌────────────┐ ┌──────────┐ ┌──────────────────┐       │
│  │ Inbox      │ │ Nudge    │ │ Discord push     │       │
│  │ write to   │ │ POST     │ │ POST /send to    │       │
│  │ gateway    │ │ /nudge   │ │ gateway for echo │       │
│  │ inbox dir  │ │ socket   │ │ to agent channel │       │
│  └────────────┘ └──────────┘ └──────────────────┘       │
│                                                           │
│  Timers:                                                  │
│  - 60s  watch monitor (stale watch detection)            │
│  - 5min git snapshot (contracts + decisions + changelog) │
│  - 30s  heartbeat (update daemon.pid lastActive)         │
└──────────────────────────────────────────────────────────┘
```

**Responsibilities:**

- Single writer for `.hive/mind/contracts/`, `decisions/`, `readers/`, `watches/`, `changelog/`
- Processes delta files from `pending/` in filename (timestamp) order with per-topic mutexes
- Notifies stale readers when a contract/decision they read gets a new version
- Resolves watches when a watched topic is published
- Detects systemic blocks (2+ workers waiting >30 min on the same topic) and alerts the manager
- Takes periodic git snapshots of durable knowledge directories
- Writes heartbeat to `daemon.pid` every 30 seconds

### 2.3 Inbox Relay MCP (`src/mcp/inbox-relay.ts`)

An MCP server that runs as a subprocess of each Claude Code session. It provides three tools.

| Tool | Description |
|------|-------------|
| `hive__check_inbox` | Read and consume all pending messages from this worker's inbox directory. Returns array of message objects, moves files to `.processed/`. |
| `hive__send` | Write a message to another worker's inbox, then POST /nudge and POST /send (Discord echo) to the gateway. |
| `hive__set_status` | POST /status to the gateway to update this worker's status in the registry. |

**Env vars:** `HIVE_INBOX_DIR`, `HIVE_INBOX_ROOT`, `HIVE_WORKER_ID`, `HIVE_GATEWAY_SOCKET`

**Cleanup:** `.processed/` files are deleted after 5 minutes (TTL cleanup runs on each `hive__check_inbox` call).

### 2.4 Discord Relay MCP (`src/mcp/discord-relay.ts`)

An MCP server that proxies all Discord operations through the gateway's HTTP API. Workers never hold a Discord connection — all outbound traffic goes through the gateway.

| Tool | Gateway endpoint | Description |
|------|-----------------|-------------|
| `discord__reply` | `POST /send` | Send a message to a Discord channel (auto-split at 2000 chars). |
| `discord__react` | `POST /react` | Add an emoji reaction to a message. |
| `discord__edit_message` | `POST /edit` | Edit a previously sent message. |
| `discord__fetch_messages` | `POST /fetch` | Fetch recent messages from a channel (max 100). |
| `discord__download_attachment` | `POST /download` | Download message attachments to local files (max 25 MB). |

**Env vars:** `HIVE_GATEWAY_SOCKET`, `HIVE_WORKER_ID`, `HIVE_CHANNEL_ID`

Retries failed gateway requests up to 3 times with exponential backoff (1s, 2s, 4s).

### 2.5 Launch System (`src/scripts/launch.ts`)

Orchestrates the full startup sequence: config generation, worktree creation, and process launch.

```text
hive up <project>
    │
    ├── loadConfig() — read ~/.config/hive/config.json
    ├── resolveProject() — find project by name
    │
    ├── generateConfigs()
    │     ├── Write state/gateway/config.json
    │     ├── For each agent:
    │     │     ├── state/workers/<name>/mcp-config.json
    │     │     ├── state/workers/<name>/settings.json  (non-manager only)
    │     │     └── state/workers/<name>/access.json
    │     └── state/agents.json
    │
    ├── createWorktrees()
    │     └── git worktree add -b hive/<name> worktrees/<name>
    │
    ├── launchGateway()
    │     ├── tmux new-session -d -s <session> -n gateway
    │     └── Poll /health until ready (30s timeout)
    │
    ├── Fetch per-worker channel IDs from GET /channels
    ├── Regenerate MCP configs with real channel IDs
    │
    ├── launchMind()
    │     └── tmux new-window -n mind
    │
    └── For each agent: launchWorker()
          ├── composeSystemPrompt()
          ├── Install pre-commit hook
          ├── Write .launch-worker-<name>.sh
          ├── tmux new-window -n <name>
          ├── Handle onboarding prompts (theme, login, trust)
          └── Send init prompt via tmux send-keys
```

### 2.6 Protocol Parser (`src/gateway/protocol-parser.ts`)

Parses the pipe-delimited first line of every protocol message into a structured header.

**Header format:** `TYPE | sender_or_target | task-id [| status]`

| Message type | Field 2 | Field 3 | Field 4 |
|-------------|---------|---------|---------|
| TASK_ASSIGN | target agent | task-id | — |
| ANSWER | target agent | task-id | — |
| CONTRACT_UPDATE | target agent | topic | — |
| STATUS | sender | task-id | status |
| QUESTION | sender | task-id | — |
| COMPLETE | sender | task-id | — |
| HEARTBEAT | sender | — | — |
| INTEGRATE | sender | — | — |
| ESCALATE | sender | task-id | — |

Body lines (after line 1) are parsed as `Key: value` pairs: Branch, Description, Agents, Scope, Dependencies, Files.

### 2.7 Selective Router (`src/gateway/selective-router.ts`)

Decides whether a parsed message should be delivered to a given worker.

```text
shouldDeliver(parsed, worker, rawContent, bodyAgents) → {deliver, reason}

Precedence (first match wins):
1. Broadcast keyword ("all-workers" or "all-agents" in content) → deliver to all
2. Direct @mention of this worker → deliver
3. Per-type rules:
   TASK_ASSIGN    → deliver only to parsed.target
   ANSWER         → deliver only to parsed.target
   CONTRACT_UPDATE→ deliver only to parsed.target
   QUESTION       → deliver only to manager role
   STATUS         → deliver only to manager role
   HEARTBEAT      → deliver only to manager role
   COMPLETE       → deliver only to manager role
   INTEGRATE      → deliver to workers listed in Agents: body field
   ESCALATE       → broadcast to all workers and manager
   (unknown type) → broadcast (backward compat)
4. Unparsable message → broadcast (backward compat)
```

---

## 3. Communication Architecture

### 3.1 Inbound: Human → Worker

A human types a message in a worker's Discord channel.

```text
Human types in Discord
        │
        ▼
Discord Gateway (WebSocket) → client.on('messageCreate')
        │
        ▼
routeInbound(msg)
  ├── parseHeader(msg.content)        [protocol-parser]
  ├── Pass 1: channel owner + manager [selective-router]
  ├── Pass 2: cross-channel mentions
  │
  └── For each targeted worker:
        ├── writeToInbox(workerId, message)
        │     └── atomic write to /tmp/hive-gateway/inbox/messages/<workerId>/<ts>-<msgId>.json
        └── nudgeViaTmux(workerId)
              ├── tmux load-buffer -b hive-<name> <tmpfile>
              ├── tmux paste-buffer -b hive-<name> -t <session>:<name>
              └── tmux send-keys -t <session>:<name> Enter

Claude Code terminal receives: "[hive] New message — check inbox"
Worker calls: hive__check_inbox()
  └── reads + moves files from inbox dir → returns message array
```

### 3.2 Worker-to-Worker Direct

Worker A sends a message directly to Worker B.

```text
Worker A calls: hive__send({ to: "alice", text: "...", priority: "alert" })
        │
        ├── Validate target name (alphanumeric, 1-32 chars)
        ├── Validate message size (max 10KB)
        │
        ├── Atomic write to /tmp/hive-gateway/inbox/messages/alice/<ts>-<uuid>.json
        │     source: "direct", priority: "alert", user: "worker-a"
        │
        ├── POST /nudge  → gateway                   [priority-gated]
        │     worker.status == "focused" && priority != "critical" → suppressed
        │
        └── POST /send   → gateway → Discord
              text: "[worker-a → alice] ..."         [human visibility echo]
```

### 3.3 Mind Notifications

The daemon notifies readers when a contract they have read is updated.

```text
Worker publishes a contract:
  bun run bin/hive-mind.ts publish --type contract --topic auth-api --agent alice ...
        │
        └── Writes delta to .hive/mind/pending/<ts>-alice-publish.json
                                      │
                              (daemon picks up via fs.watch or 2s poll)
                                      │
                                      ▼
                              processDelta()
                                ├── Write canonical to .hive/mind/contracts/auth-api.json (v2)
                                ├── resolveWatchesForTopic()  [notify watchers]
                                └── notifyStaleReaders()
                                      │
                                      └── For each reader at old version:
                                            ├── atomic write to
                                            │   /tmp/hive-gateway/inbox/messages/<reader>/
                                            │   <ts>-mind-mind-update.json
                                            │   source: "mind", priority: "info"|"alert"
                                            │
                                            ├── POST /nudge → gateway  [priority-gated]
                                            │
                                            └── POST /send  → gateway → Discord
                                                  CONTRACT_UPDATE | <reader> | auth-api
                                                  [human visibility + selective routing]
```

### 3.4 Outbound: Worker → Discord

A worker sends a message to Discord (protocol report, question, etc.).

```text
Worker calls: discord__reply({ chat_id: "123456", text: "COMPLETE | alice | task-42\n..." })
        │
        ▼
discord-relay MCP server
        │
        └── POST /send to gateway.sock
              {chat_id, text, sender: "alice"}
                      │
                      ▼
              gateway handleSend()
                ├── parseHeader(text)
                ├── If TASK_ASSIGN: autoRegisterWatch() + writeScopeFile()
                ├── Resolve chat_id="auto" to worker's channelId
                ├── Split into 2000-char chunks
                ├── ch.send() for each chunk
                │     nonce → registerSelfSend() to prevent routing loop
                ├── noteSent(message.id)  [tracks recent sent IDs]
                └── Cross-post embed to dashboard channel
                      (STATUS, COMPLETE, QUESTION, ESCALATE only)
```

### 3.5 Watch Resolution Flow

Worker B registers a watch because it needs a contract Worker A hasn't published yet.

```text
Worker B calls:
  bun run bin/hive-mind.ts watch --topic auth-api --type contract \
    --agent alice --default "assume REST/JSON" --expect-from alice
        │
        └── Writes delta to pending/ with action: "register-watch"
                    │
            processDelta() → register-watch
              ├── If canonical already exists → resolve immediately
              │     writeInboxMessage(B, watch-resolved)
              │     nudgeWorker(B, "response")
              │
              └── Else: store in watchCache, persist watches/alice.json

(60s watch monitor tick)
  runWatchMonitor()
    ├── For each waiting watch:
    │     If canonical now exists → resolve + notify B
    │     If waiting > 15 min → nudge expect_from (Worker A) with alert
    │     If 2+ workers waiting > 30 min → SYSTEMIC BLOCK alert to manager
    │
    └── When Worker A publishes auth-api:
          resolveWatchesForTopic("contract", "auth-api")
            └── For each waiting watch on this topic:
                  w.status = "resolved"
                  writeInboxMessage(B, watch-resolved, priority="response")
                  nudgeWorker(B, "response")
                  pushDiscordNotification(B, ...)
```

---

## 4. Inbox System

Every worker has a dedicated inbox directory. All message sources (Discord, worker-to-worker, Mind daemon) write to the same directory in the same format.

### Directory Layout

```text
/tmp/hive-gateway/            (GATEWAY_DIR — runtime, per session)
  gateway.sock                (Unix domain socket for HTTP API)
  inbox/
    messages/
      manager/                (manager's inbox)
        1748000000000-<uuid>.json
        1748000000001-<uuid>.json
        .processed/           (consumed messages, TTL 5 min)
      worker-01/              (worker-01's inbox)
      alice/
      bob/
```

### Message Format

All inbox messages share a common JSON structure regardless of source:

```json
{
  "chatId": "123456789",
  "messageId": "abc-uuid",
  "user": "benjamin",
  "ts": "2026-03-25T10:00:00.000Z",
  "content": "TASK_ASSIGN | alice | task-001\nBranch: hive/alice\n...",
  "attachments": [],
  "source": "direct",
  "priority": "alert",
  "mindType": "mind-update",
  "topic": "contracts/auth-api"
}
```

**Source field values:**

| `source` value | Origin |
|---------------|--------|
| absent / omitted | Discord (human or other bot) |
| `"direct"` | Worker-to-worker via `hive__send` |
| `"mind"` | Mind daemon notification |

**Mind-specific fields** (present when `source == "mind"`):

| Field | Values | Meaning |
|-------|--------|---------|
| `mindType` | `mind-update`, `watch-resolved`, `nudge`, `conflict` | Notification category |
| `priority` | `info`, `alert`, `response`, `critical` | Delivery urgency |
| `topic` | e.g. `contracts/auth-api` | Affected mind topic |

### Consume-on-Read

`hive__check_inbox` atomically consumes all pending messages in a single call:

1. `readdirSync` the inbox directory, sort by filename (timestamp prefix = chronological order)
2. For each `.json` file: `readFileSync`, then `renameSync` to `.processed/<filename>`
3. Return all messages as an array
4. On next call: clean `.processed/` files older than 5 minutes

The rename (not delete) ensures messages survive a crash between read and process. Cross-device renames fall back to delete.

### Atomic Writes

All writers (gateway, inbox-relay, daemon) use a tmp-file + rename pattern:

```text
write  → inbox/messages/<worker>/.1748000000-<uuid>.json.tmp
rename → inbox/messages/<worker>/1748000000-<uuid>.json
```

This prevents workers from reading a partially-written file.

---

## 5. Smart Nudge System

The nudge is how the gateway interrupts a worker's Claude Code session to announce a new inbox message. It uses tmux to inject text into the running terminal.

### Worker Statuses

Workers declare their current status so the gateway knows whether to interrupt them.

| Status | Set by | Meaning |
|--------|--------|---------|
| `available` | Worker (task complete, between tasks) | All messages nudge immediately |
| `focused` | Worker (deep in work, task accepted) | Only `critical` priority nudges interrupt |
| `blocked` | Worker (waiting on answer/watch) | All messages nudge immediately |

### Message Priorities

| Priority | Numeric order | Used for |
|----------|--------------|---------|
| `critical` | 0 (highest) | Stop current work immediately — broken shared dependency, data loss risk |
| `alert` | 1 | Problem that affects the recipient's current work |
| `response` | 2 | Answering a question they asked, watch resolved |
| `info` | 3 (lowest) | FYI, heads-up, background notification |

### Nudge Decision Matrix

| Worker status | Message priority | Action |
|--------------|-----------------|--------|
| `available` | any | Nudge immediately |
| `blocked` | any | Nudge immediately |
| `focused` | `critical` | Nudge immediately |
| `focused` | `info` | Suppress — message stays in inbox silently |
| `focused` | `alert` | Suppress — message stays in inbox silently |
| `focused` | `response` | Suppress — message stays in inbox silently |

A suppressed nudge is not lost — the message is still written to the inbox. The worker will read it at the next natural breakpoint when they call `hive__check_inbox`.

### tmux Injection Mechanism

The gateway injects text into the Claude Code terminal via a named tmux buffer:

```text
1. Write nudge text to a temp file in GATEWAY_DIR
2. tmux load-buffer -b hive-<worker> <tmpfile>    (load into named buffer)
3. tmux paste-buffer -b hive-<worker> -t <session>:<worker>  (paste verbatim)
4. tmux send-keys -t <session>:<worker> Enter     (submit as input)
5. tmux delete-buffer -b hive-<worker>            (cleanup)
6. Delete temp file
```

The nudge text is: `[hive] New message — check inbox`

This appears as a line submitted to Claude Code's interactive prompt, which triggers the worker to call `hive__check_inbox`.

### Per-Worker Async Mutex

Each worker has an async mutex (`workerLocks` Map) to serialize tmux operations. Concurrent nudges for the same worker are queued, never interleaved. This prevents tmux command races when multiple messages arrive simultaneously.

---

## 6. Mind Knowledge System

The Mind is a shared knowledge store for the team. It stores two types of durable knowledge and provides a pub/sub notification system.

### Knowledge Types

| Type | Directory | Purpose |
|------|-----------|---------|
| Contract | `.hive/mind/contracts/` | API interfaces, schemas, data models. Other agents depend on these. |
| Decision | `.hive/mind/decisions/` | Architectural choices with rationale: tech stack, patterns, conventions. |

Both types use the same `MindEntry` structure:

```json
{
  "author": "alice",
  "version": 3,
  "content": { ... },
  "updated": "2026-03-25T10:00:00.000Z",
  "tags": ["auth", "api"],
  "retracted": false
}
```

### Delta Processing Pipeline

Agents never write directly to canonical directories. All mutations are staged as delta files:

```text
Agent writes delta to:
  .hive/mind/pending/<timestamp>-<agent>-<action>.json

Daemon picks up via fs.watch (immediate) or 2s poll (fallback):
  processAllPending()
    Sort files by name (timestamp prefix = submission order)
    For each file:
      Acquire per-topic mutex (prevents concurrent mutations)
      processDelta(delta)
        ├── publish        → increment version, write canonical, notify readers
        ├── update         → version bump with optimistic concurrency check
        ├── retract        → mark retracted, notify readers
        ├── register-reader → record agent has read this version
        └── register-watch  → register interest, resolve if canonical exists
      Delete processed delta file
      On error: move to pending/.failed/
```

**Optimistic concurrency:** An `update` delta can include `version_expecting`. If the canonical version has already moved past that, the daemon applies the update anyway (last-writer-wins) but sends a `conflict` inbox message to the agent.

### Reader Tracking

When an agent reads a contract or decision, it registers as a reader:

```text
.hive/mind/readers/
  contracts/
    auth-api.json          ReaderRegistry
    user-schema.json
  decisions/
    tech-stack.json

ReaderRegistry:
{
  "topic": "auth-api",
  "type": "contracts",
  "version": 3,            (current canonical version)
  "readers": [
    { "agent": "bob", "read_version": 3, "read_at": "..." },
    { "agent": "carol", "read_version": 2, "read_at": "..." }  ← stale
  ]
}
```

When version increments to 4, `notifyStaleReaders()` sends:
- `carol`: inbox message `source: "mind"`, `mindType: "mind-update"`, priority `info` (or `alert` if breaking)
- Nudge via gateway (priority-gated)
- Discord echo via gateway `/send`

### Watches

An agent registers a watch when it needs a contract that does not yet exist:

```text
.hive/mind/watches/
  bob.json    [ WatchEntry, WatchEntry, ... ]

WatchEntry:
{
  "topic": "auth-api",
  "type": "contract",
  "status": "waiting",
  "since": "2026-03-25T09:00:00.000Z",
  "default_action": "assume REST with JSON",
  "expect_from": "alice"
}
```

**Watch resolution:** When the daemon processes a `publish` for `auth-api`, it calls `resolveWatchesForTopic()`, which sets all matching watches to `status: "resolved"` and sends `watch-resolved` inbox messages.

**Stale watch escalation (60s monitor):**

| Wait duration | Action |
|--------------|--------|
| > 15 min | Nudge `expect_from` agent with `alert` — "bob is waiting on your contract" |
| > 15 min, no expect_from | Nudge manager with `alert` — "bob is waiting, no publisher known" |
| > 30 min, 2+ workers | Nudge manager with `critical` — "SYSTEMIC BLOCK" + Discord push |

Nudges are rate-limited to once per 15 minutes per topic to avoid spam.

### Priority Mapping for Notifications

| Event | Priority |
|-------|---------|
| Contract/decision updated (non-breaking) | `info` |
| Contract/decision updated (breaking) | `alert` |
| Watch resolved | `response` |
| Version conflict detected | `alert` |
| Watch nudge to publisher | `alert` |
| Systemic block to manager | `critical` |

### Git Snapshots

Every 5 minutes, the daemon commits durable knowledge directories to git:

- Staged directories: `contracts/`, `decisions/`, `agents/`, `changelog/`
- Commit message: `mind: snapshot <ISO-timestamp>`
- Ephemeral directories (`pending/`, `inbox/`, `watches/`, `readers/`) are not committed

### Changelog

Every delta is appended to a daily `.jsonl` file:

```text
.hive/mind/changelog/
  2026-03-25.jsonl    (one JSON object per line)
```

Each entry: `{ timestamp, agent, action, type, topic, version, breaking }`

---

## 7. Worker Lifecycle

### Startup Sequence

```text
1. Config generation (src/gen-config.ts)
   ├── state/gateway/config.json
   ├── state/workers/<name>/mcp-config.json
   ├── state/workers/<name>/settings.json
   └── state/agents.json

2. Worktree creation
   └── git worktree add -b hive/<name> worktrees/<name>

3. Gateway launch
   └── tmux new-session -d -s <session> -n gateway
       ├── Discord bot connects
       ├── Worker channels created (or reused from channels.json)
       └── GET /health returns 200

4. MCP config refresh
   └── Per-worker channel IDs fetched from GET /channels
       MCP configs rewritten with real channel IDs

5. Mind daemon launch
   └── tmux new-window -n mind
       Waits for .hive/mind/daemon.pid (5s timeout)

6. Worker launch (per agent)
   ├── composeSystemPrompt()
   │     worker-system-prompt.md + _base.md + <role>.md + mind-prompt-section.md
   │     + live mind state from `hive-mind.ts load`
   ├── Write .prompt-<name>.md
   ├── Install pre-commit hook (scope enforcement)
   ├── Write .launch-worker-<name>.sh
   ├── tmux new-window -n <name>
   ├── Handle onboarding prompts (theme/login/trust)
   └── Send init prompt via tmux send-keys

7. Worker startup (inside Claude Code)
   ├── Announce: STATUS | <name> | - | READY
   └── Wait for TASK_ASSIGN from manager
```

### Status Transitions

```text
                ┌─────────┐
    task        │         │  task complete /
    accepted    │ focused │  COMPLETE sent
  ┌────────────►│         │◄────────────────────────┐
  │             └────┬────┘                         │
  │                  │                              │
  │             send QUESTION /                     │
  │             register watch                      │
  │                  │                              │
  │                  ▼                              │
  │             ┌─────────┐                         │
  │             │         │  ANSWER received /      │
  │             │ blocked │  watch resolved         │
  │             │         ├─────────────────────────┤
  │             └────┬────┘                         │
  │                  │                              │
  └──────────────────┘                              │
                                                    │
             ┌───────────┐                          │
             │           │                          │
             │ available │◄─────────────────────────┘
             │           │  startup / between tasks
             └───────────┘
```

### Teardown Sequence

```text
hive down <project>
  ├── (--clean) Delete per-worker Discord channels + category via REST API
  ├── Kill mind daemon (SIGTERM via PID file)
  ├── tmux kill-session (terminates all workers + gateway)
  ├── rm -rf /tmp/hive-gateway-<project>/
  ├── Remove .launch-*.sh and .prompt-*.md temp files
  ├── Update agents.json status → "stopped"
  ├── Clear pids.json
  └── (--clean) rm -rf worktrees/
                git worktree prune
                Clean ephemeral mind state (pending/, inbox/, watches/, readers/)
                Durable knowledge (contracts/, decisions/, changelog/) preserved
```

---

## 8. File Structure

```text
hive/                              (HIVE_DIR — the orchestrator repo)
├── bin/
│   ├── hive                       (CLI entry point)
│   ├── hive-gateway.ts            (gateway process)
│   └── hive-mind.ts               (mind CLI + daemon entry)
├── src/
│   ├── gateway/
│   │   ├── protocol-parser.ts     (pipe-delimited message parsing)
│   │   ├── selective-router.ts    (per-worker delivery decisions)
│   │   └── types.ts               (MessageType enum, ParsedHeader, etc.)
│   ├── mcp/
│   │   ├── inbox-relay.ts         (hive__check_inbox, hive__send, hive__set_status)
│   │   └── discord-relay.ts       (discord__reply, react, edit, fetch, download)
│   ├── mind/
│   │   ├── daemon.ts              (mind daemon process)
│   │   ├── mind-types.ts          (MindEntry, WatchEntry, DeltaFile, etc.)
│   │   └── fs-utils.ts            (atomic file write helpers)
│   ├── scripts/
│   │   ├── launch.ts              (hive up / hive down orchestration)
│   │   └── status.ts              (hive status command)
│   ├── shared/
│   │   ├── agent-types.ts         (AgentEntry, AgentsJson)
│   │   ├── paths.ts               (HIVE_DIR, stateDir, getGatewaySocket(), etc.)
│   │   ├── project-config.ts      (loadConfig, resolveProject)
│   │   ├── subprocess.ts          (run, runOrDie helpers)
│   │   └── validation.ts          (validateSafeName, validateAgentNames)
│   └── gen-config.ts              (MCP config + gateway config generation)
├── config/
│   ├── prompts/
│   │   ├── worker-system-prompt.md   (base worker behavior)
│   │   ├── protocol.md               (message format spec)
│   │   ├── mind-prompt-section.md    (Mind system instructions for workers)
│   │   └── profiles/
│   │       ├── _base.md              (universal agent directives)
│   │       ├── manager.md            (manager role profile)
│   │       └── <role>.md             (per-role profiles)
│   ├── tools/
│   │   └── <tool-name>.json          (MCP tool definitions)
│   └── tool-profiles/
│       ├── _base.json                (default tool set)
│       └── <role>.json               (per-role tool sets)
├── hooks/
│   ├── pre-commit-scope.sh           (git pre-commit scope enforcement)
│   └── check-scope.mjs               (Claude Code PreToolUse hook)
├── state/                         (runtime state — gitignored)
│   ├── agents.json                (agent registry with statuses)
│   ├── pids.json                  (session PID metadata)
│   ├── gateway/
│   │   ├── config.json            (gateway + worker configuration)
│   │   └── channels.json          (worker → Discord channel ID map)
│   └── workers/
│       └── <name>/
│           ├── mcp-config.json    (per-worker MCP server config)
│           ├── settings.json      (Claude Code settings + scope hook)
│           └── access.json        (channel access rules)
├── worktrees/                     (git worktrees — gitignored)
│   └── <name>/                    (checkout of project repo on hive/<name>)
└── .hive/                         (mind state — partially committed)
    ├── mind/
    │   ├── contracts/             (canonical contract files — committed)
    │   ├── decisions/             (canonical decision files — committed)
    │   ├── changelog/             (daily .jsonl append logs — committed)
    │   ├── agents/                (per-agent context + history — committed)
    │   ├── pending/               (delta queue — NOT committed)
    │   │   └── .failed/           (failed deltas for inspection)
    │   ├── readers/               (reader registries — NOT committed)
    │   ├── watches/               (watch entries — NOT committed)
    │   └── daemon.pid             (PID + heartbeat)
    └── scope/
        └── <agent>.json           (file scope for scope enforcement hook)
```

### Runtime Socket Layout

```text
/tmp/hive-gateway/              (default; /tmp/hive-gateway-<project>/ when named)
  gateway.sock                  (Unix socket — gateway HTTP API)
  inbox/
    messages/
      <worker-id>/
        <ts>-<id>.json          (pending messages)
        .processed/
          <ts>-<id>.json        (consumed messages, TTL 5 min)
  .nudge-<worker>-<ts>.tmp      (ephemeral nudge temp files)
```

---

## 9. Configuration

### Per-Worker MCP Config (`state/workers/<name>/mcp-config.json`)

Each worker's Claude Code session loads this config to get its MCP servers.

```json
{
  "mcpServers": {
    "discord": {
      "command": "bun",
      "args": ["run", "/path/to/src/mcp/discord-relay.ts"],
      "env": {
        "HIVE_GATEWAY_SOCKET": "/tmp/hive-gateway-myapp/gateway.sock",
        "HIVE_WORKER_ID": "alice",
        "HIVE_CHANNEL_ID": "1234567890123456789"
      }
    },
    "inbox": {
      "command": "bun",
      "args": ["run", "/path/to/src/mcp/inbox-relay.ts"],
      "env": {
        "HIVE_INBOX_DIR": "/tmp/hive-gateway-myapp/inbox/messages/alice",
        "HIVE_INBOX_ROOT": "/tmp/hive-gateway-myapp/inbox/messages",
        "HIVE_WORKER_ID": "alice",
        "HIVE_GATEWAY_SOCKET": "/tmp/hive-gateway-myapp/gateway.sock"
      }
    },
    "github": { ... },       // role-defined tools from config/tools/
    "linear": { ... }
  }
}
```

### Gateway Config (`state/gateway/config.json`)

```json
{
  "botToken": "(from DISCORD_BOT_TOKEN env var)",
  "botId": "(auto-discovered at runtime)",
  "channelId": "1234567890123456789",
  "dashboardChannelId": "1234567890123456789",
  "guildId": "",
  "socketPath": "/tmp/hive-gateway-myapp/gateway.sock",
  "categoryId": "9876543210987654321",
  "workers": [
    {
      "workerId": "manager",
      "socketPath": "/tmp/hive-gateway-myapp/manager.sock",
      "channelId": "",
      "mentionPatterns": ["manager", "hive"],
      "requireMention": false,
      "role": "manager"
    },
    {
      "workerId": "alice",
      "socketPath": "/tmp/hive-gateway-myapp/alice.sock",
      "channelId": "",
      "mentionPatterns": ["alice", "all-workers"],
      "requireMention": true,
      "role": "developer"
    }
  ]
}
```

### System Prompt Composition

Each worker's system prompt is assembled at launch from four parts, in order:

```text
1. config/prompts/worker-system-prompt.md
   {NAME} and {ROLE} placeholders substituted
   Core behavior: startup, execution, reporting, completion, Discord communication

2. config/prompts/profiles/_base.md
   Universal directives: OMC tools, coding standards, cross-boundary collaboration

3. config/prompts/profiles/<role>.md  (if exists)
   Role-specific guidance: manager vs developer vs qa-engineer, etc.

4. config/prompts/mind-prompt-section.md
   Hive Mind instructions: how to publish, read, watch, and save context

5. Live mind state (appended by `hive-mind.ts load --agent <name>`)
   Current context, recent history, known watches from previous sessions
```

### Project Config (`~/.config/hive/config.json`)

```json
{
  "projects": {
    "myapp": {
      "repo": "/home/user/projects/myapp",
      "channel": "1234567890123456789",
      "agents": "manager,alice,bob,carol",
      "roles": "manager:manager,alice:developer,bob:backend-dev,carol:qa-engineer",
      "token": "optional-override",
      "tools": "alice:+github,bob:-linear"
    }
  }
}
```

### Tool Profile Resolution

The tool set for each worker is resolved at config-generation time:

```text
config/tool-profiles/<role>.json   → base tool list for role
  +/- overrides from --tools flag  → final tool list
config/tools/<tool-name>.json      → command, args, env, requiredEnv

Override modes:
  alice:+github        add "github" to role's default tools
  alice:-linear        remove "linear" from role's default tools
  alice:=github+slack  replace all tools with exactly [github, slack]
```

### Multi-Instance Isolation

Multiple Hive instances can run simultaneously on the same host. Set these env vars to isolate:

```bash
export HIVE_SESSION=hive-myapp             # tmux session name
export HIVE_GATEWAY_SOCKET=/tmp/hive-gateway-myapp/gateway.sock
```

`hive up <project>` sets these automatically per-project. The socket path determines the inbox root, so all runtime state is isolated under `/tmp/hive-gateway-<project>/`.

---

## Appendix: Message Protocol Quick Reference

All protocol messages use a pipe-delimited first line followed by optional `Key: value` body lines.

### Messages Workers Send

```
STATUS | <name> | <task-id> | READY|ACCEPTED|IN_PROGRESS|BLOCKED|COMPLETED|FAILED
HEARTBEAT | <name>
Uptime: <time> | Budget: $<spent>/$<total> | Status: <status> | Task: <task-id>

QUESTION | <name> | <task-id>
Re: <topic>
<question text>
Options: A) ... B) ...
Default: Will use option <X> if no response in 10 minutes

COMPLETE | <name> | <task-id>
Branch: hive/<name>
Commits: <n>
Files changed: <n>
Tests: <n> passing, <n> failing
Summary: <text>

ESCALATE | <name> | <task-id>
Scope: task
Re: <topic>
<question>
Options: A) ... B) ...
Default: Will proceed with <X> in 15 minutes
```

### Messages Workers Receive

```
TASK_ASSIGN | <name> | <task-id>
Branch: hive/<name>
Files: src/auth/**, src/api/users.ts
Description: <text>
Acceptance: - criterion 1\n- criterion 2
Dependencies: auth-api,user-schema
Budget: $5

ANSWER | <name> | <task-id>
Re: <topic>
<answer text>

INTEGRATE | manager
Agents: alice,bob,carol
Order: alice,bob,carol
Target: main
```
