# Hive Message Protocol

## Overview

All inter-session communication between the Hive manager and worker sessions uses the message types defined in this document. Messages are posted to a shared Discord channel that all sessions monitor.

Messages are plain text (no embeds). The soft length limit is **1800 characters** to avoid Discord's 2000-character hard limit causing unexpected message splits. If a task specification exceeds this, write the full spec to a file in the project repository and reference it by path in the TASK_ASSIGN message.

### Header Format

The first line of every message is the header:

```
TYPE | sender | task-id [| optional-status]
```

- `TYPE` — message type (uppercase, one of the seven types below)
- `sender` — `worker-NN` (zero-padded, e.g. `worker-01`) or `manager`
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

### 1. TASK_ASSIGN — Manager → Worker

Assigns a task to a specific worker session.

```
TASK_ASSIGN | worker-NN | <task-id>
Branch: hive/worker-NN
Files: src/auth/, src/middleware/auth.ts
Description: Implement JWT authentication middleware
Acceptance: - POST /login returns JWT; - Protected routes return 401 without token
Dependencies: none
Budget: $5.00
```

Fields:
- `Branch` — the git branch the worker should create and work on
- `Files` — files or directories the worker is expected to touch
- `Description` — plain-language description of the task
- `Acceptance` — list of criteria that define done; each criterion starts with `-`
- `Dependencies` — other task IDs that must complete first, or `none`
- `Budget` — maximum cost budget for this task (worker monitors and self-limits)

---

### 2. STATUS — Worker → Manager

Reports the current state of a task. Sent on state transitions and proactively during long-running work.

```
STATUS | worker-NN | <task-id> | <status>
Progress: 3/5 acceptance criteria passing
Current: Writing integration tests
ETA: ~10 minutes
```

Valid `<status>` values:

| Status | Meaning |
|---|---|
| `READY` | Worker is online and ready to accept work |
| `ACCEPTED` | Worker has received TASK_ASSIGN and will begin shortly |
| `IN_PROGRESS` | Worker is actively working on the task |
| `BLOCKED` | Worker cannot proceed without external input |
| `COMPLETED` | Task is finished; COMPLETE message will follow |
| `FAILED` | Task could not be completed; branch has been pushed |

Fields:
- `Progress` — human-readable progress indicator
- `Current` — what the worker is doing right now
- `ETA` — estimated time to completion (optional)

---

### 3. QUESTION — Worker → Manager

Asks the manager a clarifying question. Workers must always include a `Default` action so they never block indefinitely.

```
QUESTION | worker-NN | <task-id>
Re: JWT secret configuration
Should the JWT secret come from env var or config file? Current project uses dotenv.
Options: A) env var  B) config file  C) both with env override
Default: Will use option A if no response in 10 minutes
```

Fields:
- `Re:` — topic of the question (on the line following the header)
- Body — the question itself, written as a paragraph
- `Options` — lettered choices (optional but recommended)
- `Default` — the action the worker will take if no ANSWER is received within the stated timeout

Workers should continue working on other parts of the task while waiting for an answer when possible.

---

### 4. ANSWER — Manager → Worker

Responds to a QUESTION from a worker.

```
ANSWER | worker-NN | <task-id>
Re: JWT secret configuration
Use option C. Env var JWT_SECRET overrides config.
```

Fields:
- `Re:` — echoes the topic from the original QUESTION
- Body — the answer, written as plainly as possible

---

### 5. COMPLETE — Worker → Manager

Reports that a task is finished and the branch is ready for integration.

```
COMPLETE | worker-NN | <task-id>
Branch: hive/worker-NN
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

Workers must push their branch before sending COMPLETE.

---

### 6. HEARTBEAT — Worker → Manager

Periodic liveness signal sent every 5 minutes by each active worker.

```
HEARTBEAT | worker-NN
Uptime: 34m | Budget: $2.10/$5.00 | Status: IN_PROGRESS | Task: auth-middleware
```

No task-id in the header. The body is a single compact line with pipe-separated fields:
- `Uptime` — time since the worker session started
- `Budget` — cost spent vs. budget allocated
- `Status` — current STATUS value
- `Task` — the task-id currently being worked on, or `idle`

HEARTBEAT messages are the smallest in the protocol (~80–120 characters).

---

### 7. INTEGRATE — Manager → All

Instructs workers to prepare for branch integration. Posted when one or more tasks are complete and ready to merge.

```
INTEGRATE | manager
Workers: worker-01, worker-03
Order: worker-03 first (no deps), then worker-01 (depends on worker-03)
Target: main
```

Fields:
- `Workers` — comma-separated list of workers whose branches are being integrated
- `Order` — merge order with rationale (dependency chain)
- `Target` — the branch being merged into (typically `main` or `develop`)

---

## Heartbeat Protocol

- Workers send a HEARTBEAT message every **5 minutes** while active.
- The manager considers a worker **dead** after **3 missed heartbeats** (15 minutes of silence).
- Dead worker branches are preserved in git for manual recovery or task reassignment.
- The PID watchdog in `hive-launch.sh` provides faster crash detection by polling every **30 seconds** and posting a STATUS FAILED message to Discord when a worker process exits unexpectedly.

The two mechanisms are complementary: the PID watchdog catches clean process exits quickly; the heartbeat timeout catches hung or zombie processes.

---

## Task Lifecycle

The normal flow for a task:

```
TASK_ASSIGN → STATUS (ACCEPTED) → STATUS (IN_PROGRESS) → COMPLETE
                                        ↓
                                   QUESTION → ANSWER → STATUS (IN_PROGRESS)
                                        ↓
                                   STATUS (BLOCKED)
                                        ↓
                                   STATUS (FAILED)
```

State transition rules:
- A worker sends `STATUS ACCEPTED` immediately upon receiving TASK_ASSIGN.
- A worker sends `STATUS IN_PROGRESS` when it begins active work.
- A worker sends `QUESTION` when it needs clarification; state remains IN_PROGRESS unless the blocker is critical.
- A worker sends `STATUS BLOCKED` when it cannot continue until an external dependency is resolved.
- A worker sends `STATUS FAILED` before giving up; the branch must be pushed first.
- A worker sends `COMPLETE` when all acceptance criteria are satisfied and tests pass.

---

## Error Recovery

**Worker sends FAILED:**
The manager may reassign the task to another available worker, or decompose the task further and assign sub-tasks. The failed worker's branch is available as a reference.

**Worker goes silent (missed heartbeats):**
After 3 missed heartbeats the manager marks the task as available for reassignment. The branch is preserved. If the worker comes back online it should send `STATUS READY` or `STATUS IN_PROGRESS` to re-establish liveness.

**Worker exceeds budget:**
The worker sends a STATUS message flagging the budget overrun, completes the current smallest safe subtask, pushes the branch, and then sends COMPLETE or FAILED with a note about partial completion. Workers must not continue spending after exceeding their allocated budget without an explicit ANSWER authorizing more.

**Branch push rule:**
Workers must push their branch before reporting COMPLETE, BLOCKED, or FAILED. Partial work on a pushed branch is always recoverable; work that exists only in a local session is lost when the session ends.

---

## Message Size Guidelines

- All messages must stay under **1800 characters**.
- HEARTBEAT messages are the smallest (~80–120 chars); keep them compact.
- COMPLETE messages should summarize the work, not enumerate every changed line.
- For TASK_ASSIGN messages with complex specifications: write the full spec to a file in the project repository (e.g. `.hive/tasks/<task-id>.md`) and reference it with a `Spec: .hive/tasks/<task-id>.md` field in the message body.
- If a QUESTION or ANSWER needs more context than fits in one message, write the detail to a file and reference it by path.

---

## Parsing Hints

These rules hold for all message types and allow robust programmatic parsing:

- The **header is always the first line**.
- Fields are **pipe-delimited** (`|`) with surrounding spaces.
- `TYPE` is always the **first field** (uppercase alpha, underscores allowed).
- `sender` is always the **second field** (`worker-NN` or `manager`).
- `task-id` is the **third field** when present (absent in HEARTBEAT and INTEGRATE).
- `status` is the **fourth field** when present (STATUS messages only).
- Body lines are **key-value pairs** separated by the first `: ` on the line.
- Lines that do not contain `: ` are continuation text belonging to the preceding key.
- Messages from other sessions arrive as push notifications wrapped in `<channel>` tags in the session context.
- Ignore messages where `sender` is your own session ID (you sent them).
