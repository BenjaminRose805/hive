# Hive Task Contract Protocol

## Overview

Task lifecycle is managed through **MCP tool calls** (`hive__task_*`), not free-text Discord messages. Each task is a **contract** — a JSON document stored at `.hive/tasks/<task-id>.json` that tracks phase, acceptance criteria, process checklist, and audit history.

Discord is used only for: HEARTBEAT liveness signals, ESCALATE human decisions, INTEGRATE merge coordination, and the initial READY announcement.

### Task Contract Structure

Every task contract contains:
- `id` — unique task identifier
- `title` — short task title
- `description` — full task description
- `assignee` — agent name
- `acceptance` — list of acceptance criteria
- `process` — checklist items with status (PASS/FAIL/N/A/PENDING)
- `files` — scoped file paths
- `dependencies` — dependent task IDs
- `stage` — pipeline stage (IMPLEMENT, REVIEW, VERIFY)
- `phase` — current lifecycle phase
- `history` — audit trail of all phase transitions

### Task Phases

```
ASSIGNED → ACCEPTED → IN_PROGRESS → REVIEW → VERIFY → COMPLETE
                          ↓                              ↓
                        FAILED                         FAILED
```

Phases are sequential — you cannot skip or go backward. The phase order is:
`ASSIGNED` (0) → `ACCEPTED` (1) → `IN_PROGRESS` (2) → `REVIEW` (3) → `VERIFY` (4) → `COMPLETE` (5) / `FAILED` (5)

---

## Task Lifecycle Tools

### 1. hive__task_create — Manager → Agent

Creates a new task contract. Sets phase to ASSIGNED. The assigned agent receives the contract via inbox.

```
hive__task_create({
  id: "auth-middleware",
  title: "Implement JWT authentication",
  description: "Add JWT auth middleware with login endpoint and token validation",
  assignee: "alice",
  acceptance: [
    "POST /login returns JWT",
    "Protected routes return 401 without token",
    "Token refresh flow works"
  ],
  process: [
    { name: "notepad_write_priority at ACCEPT", status: "PENDING" },
    { name: "explore before coding", status: "PENDING" },
    { name: "lsp_diagnostics 0 errors", status: "PENDING" },
    { name: "/code-review before COMPLETE", status: "PENDING" }
  ],
  files: ["src/auth/", "src/middleware/auth.ts"],
  dependencies: [],
  stage: "IMPLEMENT"
})
```

Parameters:
- `id` (required) — unique task ID (e.g. `task-auth-flow`)
- `title` (required) — short task title
- `description` (required) — full task description
- `assignee` (required) — agent name assigned to this task
- `acceptance` (required) — array of acceptance criteria strings
- `process` — checklist items, each with `name` and `status` (default all PENDING)
- `files` — scoped file paths
- `dependencies` — dependent task IDs
- `budget` — USD budget for this task
- `stage` — pipeline stage: IMPLEMENT, REVIEW, or VERIFY

---

### 2. hive__task_accept — Agent acknowledges assignment

Transitions the task from ASSIGNED to ACCEPTED.

```
hive__task_accept({ task_id: "auth-middleware" })
```

---

### 3. hive__task_update — Agent reports progress

Updates the task phase. Enforces sequential phase ordering — cannot skip or go backward. Can also update process checklist items.

```
hive__task_update({
  task_id: "auth-middleware",
  phase: "IN_PROGRESS",
  reason: "Starting implementation",
  process_updates: [
    { name: "notepad_write_priority at ACCEPT", status: "PASS", detail: "Saved task-id + ACs" },
    { name: "explore before coding", status: "PASS", detail: "Mapped 12 files" }
  ]
})
```

Parameters:
- `task_id` (required) — task ID to update
- `phase` (required) — target phase (must be sequential: ASSIGNED → ACCEPTED → IN_PROGRESS → REVIEW → VERIFY → COMPLETE). Always include the current phase even when only updating process items.
- `reason` — reason for the transition
- `process_updates` — array of process item updates with `name`, `status`, and optional `detail`

---

### 4. hive__task_complete — Agent marks task done

Marks a task as COMPLETE. **Validates all process items are PASS or N/A before accepting.** If any process item is still PENDING or FAIL, the completion is rejected.

```
hive__task_complete({
  task_id: "auth-middleware",
  summary: "JWT auth with login, validation, and refresh flow. 12 tests passing.",
  process_updates: [
    { name: "lsp_diagnostics 0 errors", status: "PASS", detail: "0 errors, 0 warnings" },
    { name: "/code-review before COMPLETE", status: "PASS", detail: "Self-reviewed via /code-review" }
  ]
})
```

Parameters:
- `task_id` (required) — task ID to complete
- `summary` — completion summary
- `process_updates` — final process item updates before the completion check

---

### 5. hive__task_fail — Agent reports failure

Marks a task as FAILED with a reason. The agent must push their branch before calling this.

```
hive__task_fail({
  task_id: "auth-middleware",
  reason: "Cannot resolve OAuth2 provider dependency conflict after 2 attempts"
})
```

---

### 6. hive__task_question — Agent asks a question

Sends a question about a task to the manager or another agent via inbox.

```
hive__task_question({
  task_id: "auth-middleware",
  to: "monarch",
  question: "Should JWT secret come from env var or config file?",
  options: ["A) env var", "B) config file", "C) both with env override"],
  default_action: "Will use option A if no answer in 10 minutes"
})
```

Parameters:
- `task_id` (required) — related task ID
- `question` (required) — the question text
- `to` — target agent (defaults to task assignee or manager)
- `options` — suggested options
- `default_action` — default if no answer within timeout

Agents should continue working on other parts of the task while waiting for an answer.

---

### 7. hive__task_answer — Manager responds to a question

Answers a question about a task.

```
hive__task_answer({
  task_id: "auth-middleware",
  to: "alice",
  answer: "Use option C. Env var JWT_SECRET overrides config."
})
```

---

### 8. hive__task_review — Submit a review

Submits a review for a task with a verdict. Can update process items.

```
hive__task_review({
  task_id: "auth-middleware",
  verdict: "approve",
  comments: "Clean implementation, good test coverage. One minor nit: rename `tok` to `token` for clarity.",
  process_updates: [
    { name: "code review", status: "PASS", detail: "Approved with minor nit" }
  ]
})
```

Parameters:
- `task_id` (required) — task ID to review
- `verdict` (required) — `approve`, `request-changes`, or `comment`
- `comments` (required) — review comments
- `process_updates` — process item updates from the review

---

### 9. hive__task_get — Query a task

Returns the current state of a task contract including phase, acceptance, process checklist, and history.

```
hive__task_get({ task_id: "auth-middleware" })
```

---

### 10. hive__task_list — List tasks

Lists all task contracts, optionally filtered by assignee or phase.

```
hive__task_list({ assignee: "alice" })
hive__task_list({ phase: "IN_PROGRESS" })
hive__task_list({})  // all tasks
```

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
| **IMPLEMENT** | Build the feature or fix | Engineer agents | `hive__task_complete` with passing tests |
| **REVIEW** | Evaluate code quality, correctness, security | Engineer agents (cross-review) | `hive__task_review` with `verdict: "approve"` |
| **VERIFY** | Prove all acceptance criteria with evidence | Engineer agents (independent verification) | All criteria verified with evidence |

### Stage Behavior

- `Stage: IMPLEMENT` — write code, write tests, make acceptance criteria pass
- `Stage: REVIEW` — read and critique code, report findings via `hive__task_review` (do not fix code yourself)
- `Stage: VERIFY` — run tests, check behavior, provide evidence for every criterion

### Gate Failure

When a gate fails (review finds blocking issues, verification fails), the manager sends `hive__task_answer` to the responsible agent with:
- Specific, actionable feedback
- The stage to return to (e.g., re-enter IMPLEMENT for a fix cycle)
- Updated acceptance criteria if the scope changed

---

## Spokesperson Routing

The **oracle** (product agent) is the team's single external voice. All human-facing communication flows through the oracle.

### How It Works

- Human messages are routed to the oracle first (Pass 0 in the gateway).
- The oracle gathers requirements, clarifies intent, and produces specs for the manager.
- The manager decomposes specs into tasks via `hive__task_create` — the manager never talks to humans directly.
- Agents communicate through task tools (`hive__task_question`, `hive__task_complete`) — never directly to humans in Discord.
- The oracle decides what to relay to the human and how.

### Rules

- **Exception**: if a human sends a direct message (DM or @mention) to a specific agent, that agent may respond directly.
- Agents must not post in Discord channels they were not assigned to.
- Agent-to-agent communication uses `hive__send` (direct inbox messages) — this is internal and does not violate the spokesperson rule.

### Why

- Prevents conflicting or redundant messages reaching the human.
- Keeps external communication coherent — one voice, one status, one thread.
- Separates product concerns (oracle) from coordination concerns (manager).

---

## Discord Messages (Non-Task)

These messages still use Discord text format because they are not part of the task lifecycle:

### HEARTBEAT — Agent → Manager

Periodic liveness signal sent every 5 minutes by each active agent to their agent channel.

```
HEARTBEAT | {NAME}
Uptime: <time> | Status: <phase> | Task: <task-id or idle>
```

The manager considers an agent **dead** after **3 missed heartbeats** (15 minutes of silence).

### ESCALATE — Worker or Manager → Human

Requests a human decision. Posted to Discord so the oracle can translate for the human.

```
ESCALATE | {NAME} | <task-id>
Scope: task | project
Re: <topic>
<question>
Options: A) ... B) ...
Default: Will proceed with <X> if no response in <timeout>
```

### INTEGRATE — Manager → All

Instructs agents to prepare for branch integration.

```
INTEGRATE | manager
Agents: alice, bob
Order: bob first (no deps), then alice
Target: main
```

### READY Announcement

Agents announce themselves on startup via Discord before any task is assigned:

```
STATUS | {NAME} | - | READY
<personality announcement>
```

---

## Task Lifecycle Flow

The normal flow for a task:

```
hive__task_create (manager)
    → hive__task_accept (agent)
    → hive__task_update phase:IN_PROGRESS (agent)
    → [work happens]
    → hive__task_complete (agent)
    → hive__task_review (cross-reviewer)
    → hive__task_update phase:VERIFY (manager reassigns)
    → hive__task_complete (verifier)
```

Alternate flows:
- Agent blocked → `hive__task_question` → `hive__task_answer` → continue
- Agent fails → `hive__task_fail` → manager reassigns
- Review rejects → `hive__task_answer` with feedback → agent re-implements
- Human decision needed → ESCALATE via Discord → oracle relays

---

## Error Recovery

**Agent sends task_fail:**
The manager may reassign the task to another available agent, or decompose the task further. The failed agent's branch is available as a reference.

**Agent goes silent (missed heartbeats):**
After 3 missed heartbeats the manager marks the task as available for reassignment. The branch is preserved.

**Branch push rule:**
Agents must push their branch before calling `hive__task_complete`, `hive__task_fail`, or reporting blocked status. Partial work on a pushed branch is always recoverable.

---

## Routing Rules

The gateway applies selective routing so each worker only receives messages relevant to it.

| Message Type | Delivered To | Reason |
|---|---|---|
| Task contract notifications | Target agent only | Agent is the assignee |
| HEARTBEAT | Manager only | Manager monitors liveness |
| ESCALATE | All workers and manager | Human decision broadcast |
| INTEGRATE | Named agents in body | Only involved agents need to act |
| Direct @name mention | Named agent only | Explicit targeting |
| `all-workers` keyword | All workers | Broadcast override |

---

## Message Size Guidelines

- Discord messages must stay under **1800 characters**.
- HEARTBEAT messages are the smallest (~80–120 chars); keep them compact.
- For task descriptions that exceed Discord limits, the contract JSON stores the full spec — no need to split across messages.
- If a `hive__task_question` or `hive__task_answer` needs extensive context, write the detail to a file and reference it by path.
