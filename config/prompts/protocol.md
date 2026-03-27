# Hive Message Protocol

## Overview

All inter-session communication between the Hive manager and agent sessions uses the message types defined in this document. Messages are posted to a shared Discord channel that all sessions monitor.

Messages are plain text (no embeds). The soft length limit is **1800 characters** to avoid Discord's 2000-character hard limit causing unexpected message splits. If a task specification exceeds this, write the full spec to a file in the project repository and reference it by path in the TASK_ASSIGN message.

### Header Format

The first line of every message is the header:

```
TYPE | sender | task-id [| optional-status]
```

- `TYPE` — message type (uppercase, one of the eight types below)
- `sender` — `{agent-name}` (e.g. `alice`, `bob`) or `manager`
- `task-id` — short identifier for the task (omitted in HEARTBEAT and INTEGRATE)
- `optional-status` — included only in STATUS messages

### Body Format

Body lines follow the header. Each line is a key-value pair:

```
Key: value
```

Multi-line values use indentation or continuation lines as appropriate for readability.

---

## Message Types

### 1. TASK_ASSIGN — Manager → Agent

Assigns a task to a specific agent session.

```
TASK_ASSIGN | alice | <task-id>
Branch: hive/alice
Files: src/auth/, src/middleware/auth.ts
Description: Implement JWT authentication middleware
Acceptance: - POST /login returns JWT; - Protected routes return 401 without token
Dependencies: none
Budget: $5.00
Stage: IMPLEMENT
Mode: required /ralph
```

Fields:
- `Branch` — the git branch the agent should create and work on
- `Files` — files or directories the agent is expected to touch
- `Description` — plain-language description of the task
- `Acceptance` — list of criteria that define done; each criterion starts with `-`
- `Dependencies` — other task IDs that must complete first, or `none`
- `Budget` — maximum cost budget for this task (agent monitors and self-limits)
- `Stage` — pipeline stage: `IMPLEMENT`, `REVIEW`, or `VERIFY` (see Pipeline Stages below)
- `Mode` — execution mode hint: `required <mode>` (agent must use it), `suggested <mode>` (agent may use it), or omitted (agent chooses)

---

### 2. STATUS — Agent → Manager

Reports the current state of a task. Sent on state transitions and proactively during long-running work.

```
STATUS | alice | <task-id> | <status>
Progress: 3/5 acceptance criteria passing
Current: Writing integration tests
ETA: ~10 minutes
```

Valid `<status>` values:

| Status | Meaning |
|---|---|
| `READY` | Agent is online and ready to accept work |
| `ACCEPTED` | Agent has received TASK_ASSIGN and will begin shortly |
| `IN_PROGRESS` | Agent is actively working on the task |
| `BLOCKED` | Agent cannot proceed without external input |
| `COMPLETED` | Task is finished; COMPLETE message will follow |
| `FAILED` | Task could not be completed; branch has been pushed |

Fields:
- `Progress` — human-readable progress indicator
- `Current` — what the agent is doing right now
- `ETA` — estimated time to completion (optional)

---

### 3. QUESTION — Agent → Manager

Asks the manager a clarifying question. Agents must always include a `Default` action so they never block indefinitely.

```
QUESTION | alice | <task-id>
Re: JWT secret configuration
Should the JWT secret come from env var or config file? Current project uses dotenv.
Options: A) env var  B) config file  C) both with env override
Default: Will use option A if no response in 10 minutes
```

Fields:
- `Re:` — topic of the question (on the line following the header)
- Body — the question itself, written as a paragraph
- `Options` — lettered choices (optional but recommended)
- `Default` — the action the agent will take if no ANSWER is received within the stated timeout

Agents should continue working on other parts of the task while waiting for an answer when possible.

---

### 4. ANSWER — Manager → Agent

Responds to a QUESTION from an agent.

```
ANSWER | alice | <task-id>
Re: JWT secret configuration
Use option C. Env var JWT_SECRET overrides config.
```

Fields:
- `Re:` — echoes the topic from the original QUESTION
- Body — the answer, written as plainly as possible

---

### 5. COMPLETE — Agent → Manager

Reports that a task is finished and the branch is ready for integration.

```
COMPLETE | alice | <task-id>
Branch: hive/alice
Commits: 4
Files changed: 8
Tests: 12 passing, 0 failing
Summary: JWT auth middleware with login endpoint, token validation, and refresh flow.
Ready for integration.
```

Fields:
- `Branch` — branch name containing the completed work
- `Commits` — number of commits on the branch
- `Files changed` — count of files modified
- `Tests` — test results (if applicable)
- `Summary` — one or two sentences describing what was done; do not exhaustively list every change

Agents must push their branch before sending COMPLETE.

---

### 6. HEARTBEAT — Agent → Manager

Periodic liveness signal sent every 5 minutes by each active agent.

```
HEARTBEAT | alice
Uptime: 34m | Budget: $2.10/$5.00 | Status: IN_PROGRESS | Task: auth-middleware
```

No task-id in the header. The body is a single compact line with pipe-separated fields:
- `Uptime` — time since the agent session started
- `Budget` — cost spent vs. budget allocated
- `Status` — current STATUS value
- `Task` — the task-id currently being worked on, or `idle`

HEARTBEAT messages are the smallest in the protocol (~80–120 characters).

---

### 7. INTEGRATE — Manager → All

Instructs agents to prepare for branch integration. Posted when one or more tasks are complete and ready to merge.

```
INTEGRATE | manager
Agents: alice, bob
Order: bob first (no deps), then alice (depends on bob)
Target: main
```

Fields:
- `Agents` — comma-separated list of agents whose branches are being integrated
- `Order` — merge order with rationale (dependency chain)
- `Target` — the branch being merged into (typically `main` or `develop`)

---

### 8. ESCALATE — Worker or Manager → Human

Requests a human decision. Workers send ESCALATE for task-scoped decisions; the manager sends ESCALATE for project-scoped decisions. The gateway broadcasts ESCALATE to the channel so the human can read it.

```
ESCALATE | sender | task-id
Scope: task | project
Re: <topic>
<question>
Options: A) ... B) ...
Default: Will proceed with <X> if no response in <timeout>
```

Fields:
- `Scope` — `task` when the decision is within the agent's assigned work; `project` when it cuts across tasks or the whole project
- `Re:` — topic of the escalation (on the line following the header)
- Body — the question or decision needed, written as a paragraph
- `Options` — lettered choices (optional but recommended)
- `Default` — the action that will be taken if no human response is received within the stated timeout

Agents must always include a `Default` so work is never blocked indefinitely.

---

## Pipeline Stages

Tasks flow through three pipeline stages. The manager enforces gate transitions between stages.

```
IMPLEMENT → REVIEW → VERIFY → DONE
    ↑          |        |
    └──────────┘        |
    └───────────────────┘
    (gate failure loops back)
```

### Stage Definitions

| Stage | Purpose | Assigned To | Gate to Next |
|---|---|---|---|
| **IMPLEMENT** | Build the feature or fix | Engineer agents | COMPLETE with passing tests |
| **REVIEW** | Evaluate code quality, correctness, security | Reviewer agents | Approval with no blocking findings |
| **VERIFY** | Prove all acceptance criteria with evidence | QA agents | All criteria verified with evidence |

### Stage Field in TASK_ASSIGN

Every TASK_ASSIGN includes a `Stage:` field. The agent uses this to understand their role:
- `Stage: IMPLEMENT` — write code, write tests, make acceptance criteria pass
- `Stage: REVIEW` — read and critique code, report findings (do not fix code yourself)
- `Stage: VERIFY` — run tests, check behavior, provide evidence for every criterion

### Mode Field in TASK_ASSIGN

The optional `Mode:` field hints at which OMC execution mode the agent should use:
- `Mode: required /ralph` — agent **must** use `/ralph` (self-referential loop until complete)
- `Mode: required /ultrawork` — agent **must** use `/ultrawork` (parallel fan-out)
- `Mode: suggested /ralph` — agent **may** use `/ralph` but can choose differently
- Omitted — agent chooses the best execution mode for the task

### Gate Failure

When a gate fails (review finds blocking issues, verification fails), the manager sends an ANSWER to the responsible agent with:
- Specific, actionable feedback
- The stage to return to (e.g., `Stage: IMPLEMENT` for a fix cycle)
- Updated acceptance criteria if the scope changed

The agent re-enters the specified stage and works toward a new COMPLETE.

---

## Spokesperson Routing

The manager is the team's single external voice. All human-facing communication flows through the manager.

### Rules

- Agents communicate through protocol messages (QUESTION, ESCALATE, COMPLETE) — never directly to humans in Discord.
- The manager decides what to relay to the human and how.
- **Exception**: if a human sends a direct message (DM or @mention) to a specific agent, that agent may respond directly.
- Agents must not post in Discord channels they were not assigned to.
- Agent-to-agent communication uses `hive__send` (direct inbox messages) — this is internal and does not violate the spokesperson rule.

### Why

- Prevents conflicting or redundant messages reaching the human.
- Keeps external communication coherent — one voice, one status, one thread.
- Lets the manager maintain situational awareness of everything the human sees.

---

## Heartbeat Protocol

- Agents send a HEARTBEAT message every **5 minutes** while active.
- The manager considers an agent **dead** after **3 missed heartbeats** (15 minutes of silence).
- Dead agent branches are preserved in git for manual recovery or task reassignment.
- The PID watchdog in `bin/hive launch` provides faster crash detection by polling every **30 seconds** and posting a STATUS FAILED message to Discord when an agent process exits unexpectedly.

The two mechanisms are complementary: the PID watchdog catches clean process exits quickly; the heartbeat timeout catches hung or zombie processes.

---

## Task Lifecycle

The normal flow for a task:

```
TASK_ASSIGN → STATUS (ACCEPTED) → STATUS (IN_PROGRESS) → COMPLETE
                                        ↓
                                   QUESTION → ANSWER → STATUS (IN_PROGRESS)
                                        ↓
                                   ESCALATE → [human response] → STATUS (IN_PROGRESS)
                                        ↓
                                   STATUS (BLOCKED)
                                        ↓
                                   STATUS (FAILED)
```

State transition rules:
- An agent sends `STATUS ACCEPTED` immediately upon receiving TASK_ASSIGN.
- An agent sends `STATUS IN_PROGRESS` when it begins active work.
- An agent sends `QUESTION` when it needs clarification; state remains IN_PROGRESS unless the blocker is critical.
- An agent sends `STATUS BLOCKED` when it cannot continue until an external dependency is resolved.
- An agent sends `STATUS FAILED` before giving up; the branch must be pushed first.
- An agent sends `COMPLETE` when all acceptance criteria are satisfied and tests pass.

---

## Error Recovery

**Agent sends FAILED:**
The manager may reassign the task to another available agent, or decompose the task further and assign sub-tasks. The failed agent's branch is available as a reference.

**Agent goes silent (missed heartbeats):**
After 3 missed heartbeats the manager marks the task as available for reassignment. The branch is preserved. If the agent comes back online it should send `STATUS READY` or `STATUS IN_PROGRESS` to re-establish liveness.

**Agent exceeds budget:**
The agent sends a STATUS message flagging the budget overrun, completes the current smallest safe subtask, pushes the branch, and then sends COMPLETE or FAILED with a note about partial completion. Agents must not continue spending after exceeding their allocated budget without an explicit ANSWER authorizing more.

**Branch push rule:**
Agents must push their branch before reporting COMPLETE, BLOCKED, or FAILED. Partial work on a pushed branch is always recoverable; work that exists only in a local session is lost when the session ends.

---

## Message Size Guidelines

- All messages must stay under **1800 characters**.
- HEARTBEAT messages are the smallest (~80–120 chars); keep them compact.
- COMPLETE messages should summarize the work, not enumerate every changed line.
- For TASK_ASSIGN messages with complex specifications: write the full spec to a file in the project repository (e.g. `.hive/tasks/<task-id>.md`) and reference it with a `Spec: .hive/tasks/<task-id>.md` field in the message body.
- If a QUESTION or ANSWER needs more context than fits in one message, write the detail to a file and reference it by path.

---

## Conversation Channels

### Per-Task Channels

Each TASK_ASSIGN creates a dedicated Discord text channel (`#task-{id}-{slug}`) under the Hive category. The channel isolates all communication for that task — STATUS updates, QUESTIONs, ANSWERs, and the final COMPLETE message all happen in the channel.

- **Channel naming**: `task-{id}-{slug}` (e.g. `task-1-auth-middleware`)
- **Created by**: The gateway, upon processing an outbound TASK_ASSIGN
- **Persisted**: `state/gateway/conversation-channels.json` — survives gateway restarts
- **Cleanup**: `hive down --clean` deletes all conversation channels

### Two-Tier Participation

Conversation channels track participants in two tiers:
- **Active**: receives every message in their inbox (real-time collaboration)
- **Observing**: gets zero inbox delivery — reads Discord history via `fetch_messages` on their own schedule

The assigned agent is automatically **active**. Other agents added via `hive__add_to_channel` start as **observing** and can promote themselves to active with `hive__set_channel_tier`.

### Ad-Hoc Conversation Channels

Agents can create conversation channels for multi-party discussions beyond task scope using `hive__create_channel`. The creator is active; other participants start as observing. Channel naming: `conv-{timestamp}-{slug}`.

### Manager View

The manager receives all messages via role-based routing (Pass 1) and is never added as a conversation channel participant. The manager sees:
- All messages in all channels via role-based routing
- HEARTBEAT messages in agent channels
- COMPLETE embed summaries on the dashboard
- INTEGRATE messages

### Channel Permissions

The bot requires `Manage Channels` permission in the Discord server to create per-task and conversation channels.

---

## Routing Rules

The gateway applies selective routing so each worker only receives messages relevant to it. This reduces noise and prevents workers from seeing tasks assigned to other agents.

| Message Type | Delivered To | Reason |
|---|---|---|
| TASK_ASSIGN | Target agent only (field 2) | Field 2 = target agent name |
| ANSWER | Target agent only (field 2) | Field 2 = target agent name |
| QUESTION | Manager only | Manager handles clarifications |
| STATUS | Manager only | Manager tracks progress |
| HEARTBEAT | Manager only | Manager monitors liveness |
| COMPLETE | Manager only | Manager coordinates integration |
| INTEGRATE | Named agents in body `Agents:` field | Only involved agents need to act |
| ESCALATE | All workers and manager | Human decision broadcast to entire channel |
| Direct @name mention | Named agent only | Explicit targeting |
| `all-workers` / `all-agents` keyword | All workers | Broadcast override |
| Conversation channel message | Active participants (Pass 3) | Channel membership delivery |
| Unparsable message | All workers | Backward compatibility fallback |

### Field-2 Semantics

- For **TASK_ASSIGN** and **ANSWER**: field 2 is the **target** agent (the recipient), not the sender. The sender is implicitly the manager.
- For **all other types**: field 2 is the **sender** (the agent reporting).

---

## Channel Lifecycle

```
TASK_ASSIGN processed → Gateway creates #task-{id}-{slug} → Agent added as active participant
    ↓
Agent replies go to task channel (using chatId from inbox message)
    ↓
Other agents added via hive__add_to_channel (start as observing, promote when ready)
    ↓
COMPLETE posted in task channel + embed summary on dashboard
    ↓
Channel persists for reference — cleaned up by hive down --clean
```

- **Creation**: Gateway creates a text channel on TASK_ASSIGN, registers as a conversation channel with the assigned agent as active
- **Active use**: Active participants receive every message in their inbox. Observing participants read Discord history on demand.
- **Participation changes**: Agents promote/demote with `hive__set_channel_tier`, leave with `hive__leave_channel`
- **Completion**: COMPLETE message stays in channel; dashboard gets an embed summary
- **Cleanup**: `hive down --clean` deletes all conversation channels. Agent teardown removes the agent from all participant sets.

---

## Parsing Hints

These rules hold for all message types and allow robust programmatic parsing:

- The **header is always the first line**.
- Fields are **pipe-delimited** (`|`) with surrounding spaces.
- `TYPE` is always the **first field** (uppercase alpha, underscores allowed).
- `sender` is always the **second field** (`{agent-name}` or `manager`).
- `task-id` is the **third field** when present (absent in HEARTBEAT and INTEGRATE; present in ESCALATE).
- `status` is the **fourth field** when present (STATUS messages only).
- Body lines are **key-value pairs** separated by the first `: ` on the line.
- Lines that do not contain `: ` are continuation text belonging to the preceding key.
- Messages from other sessions arrive as push notifications wrapped in `<channel>` tags in the session context.
- Ignore messages where `sender` is your own session ID (you sent them).
