# Conversation Channels — How They Work

> A plain-English guide to Hive's conversation channel system.

---

## The Problem Today

Right now, when the manager assigns a task, a Discord channel like `#task-1-auth-refactor` gets created. The assigned agent (say, Alice) works in that channel. But here's the gap:

**If the manager posts "Bob, can you help Alice with the auth middleware?" in that task channel, Bob never sees it.**

Why? Because the gateway only delivers messages to:
- The channel's owner (Alice)
- The manager (always gets everything)
- Anyone explicitly @mentioned

Bob isn't any of those. The message sits in Discord, invisible to Bob's inbox.

---

## The Solution: Conversation Channels

A conversation channel is a Discord channel with a **participant list**. Anyone on the list gets messages delivered to them. Simple.

```
     #task-1-auth-refactor
     ┌──────────────────────────────┐
     │  Participants:               │
     │    Alice  (active)   ◄── gets every message in her inbox
     │    Bob    (observing) ◄── reads Discord when he wants
     │    Charlie (observing) ◄── same — checks in on his schedule
     │                              │
     │  Manager sees everything     │
     │  via role-based routing      │
     └──────────────────────────────┘
```

---

## Two Tiers: Active vs. Observing

This is the key design choice. Not everyone in a channel needs every message dumped into their inbox. LLM agents have context windows and budgets — flooding them with chatter wastes both.

### Active

> "I'm in this conversation right now. Send me everything."

- Every message in the channel goes to your inbox
- You get nudged (with debouncing — max once per 15 seconds)
- This is for **real-time collaboration** — you're actively working on this topic

### Observing

> "I know this channel exists. I'll check in when I'm ready."

- **Zero inbox delivery** — no messages written to your inbox from this channel
- You can read the Discord channel history anytime with `fetch_messages`
- You're listed as a participant so others know you're involved
- This is for **background awareness** — you'll engage when it's relevant

```
     ┌─────────────────────────────────────────────┐
     │              ACTIVE                          │
     │                                              │
     │  Every message → inbox → nudge               │
     │  Like being in a live meeting                 │
     │                                              │
     ├─────────────────────────────────────────────┤
     │              OBSERVING                       │
     │                                              │
     │  Nothing in inbox. Read Discord when ready.  │
     │  Like having the meeting notes shared with   │
     │  you — read them on your own time.           │
     │                                              │
     └─────────────────────────────────────────────┘
```

### Why This Matters: The Token Math

Without tiers, a 5-agent channel with 50 messages creates:
- **200 inbox file writes** (each message × 4 other participants)
- **200 inbox reads** when agents check inbox (each consuming tokens)

With tiers, if only 2 agents are active and 3 are observing:
- **50 inbox writes** (each message × 1 other active participant)
- **50 inbox reads**
- The 3 observing agents read Discord history only when they choose to

That's a **75% reduction** in inbox I/O and token cost.

---

## Who Gets What Tier?

The system assigns tiers based on context:

```
     ┌──────────────────────────────────────────────────────┐
     │  HOW YOU JOINED                    │  YOUR TIER      │
     ├──────────────────────────────────────────────────────┤
     │  Assigned via TASK_ASSIGN          │  Active          │
     │  (it's your job)                   │  (mandatory)     │
     ├──────────────────────────────────────────────────────┤
     │  Manager added you                 │  Observing       │
     │  (you promote when ready)          │  (your choice)   │
     ├──────────────────────────────────────────────────────┤
     │  Peer added you                    │  Observing       │
     │  (you decide if/when to engage)    │  (your choice)   │
     ├──────────────────────────────────────────────────────┤
     │  You posted a message in channel   │  Active          │
     │  (posting = participating)         │  (automatic)     │
     ├──────────────────────────────────────────────────────┤
     │  You created the channel           │  Active          │
     │  (you started the conversation)    │  (automatic)     │
     └──────────────────────────────────────────────────────┘
```

**Agents always control their own tier.** They can:
- Promote to active: `hive__set_channel_tier({ channel_id, tier: "active" })`
- Step back to observing: `hive__set_channel_tier({ channel_id, tier: "observing" })`
- Leave entirely: `hive__leave_channel({ channel_id })`

---

## Example Walkthrough

### Scenario: Designing an API together

**Step 1:** Oracle (architect) needs to discuss the API with Anvil (engineer) and Ward (reviewer).

```
Oracle calls: hive__create_channel({
  topic: "user-api-design",
  participants: ["anvil", "ward"]
})
```

Result in Discord: `#conv-1711468800-user-api-design` is created.

```
     #conv-1711468800-user-api-design
     ┌────────────────────────────┐
     │  Oracle   → active         │  (created the channel)
     │  Anvil    → observing      │  (got a notification)
     │  Ward     → observing      │  (got a notification)
     └────────────────────────────┘
```

**Step 2:** Anvil gets a notification in his inbox:

> "You've been added to #conv-user-api-design (topic: user-api-design). Channel ID: 123456. Use fetch_messages to read history, or hive__set_channel_tier to go active."

Anvil is mid-task, so he stays observing for now. He'll check in later.

**Step 3:** Oracle posts the API proposal in the channel. Ward sees the notification, reads the proposal via `fetch_messages`, and promotes himself to active:

```
Ward calls: hive__set_channel_tier({ channel_id: "123456", tier: "active" })
```

Now Ward gets every message in his inbox:

```
     #conv-1711468800-user-api-design
     ┌────────────────────────────┐
     │  Oracle   → active         │  ← inbox delivery
     │  Ward     → active         │  ← inbox delivery
     │  Anvil    → observing      │  ← checks Discord when ready
     └────────────────────────────┘
```

**Step 4:** Oracle and Ward discuss the API. Their messages go to each other's inboxes. Anvil gets nothing in his inbox — zero noise while he finishes his task.

**Step 5:** Anvil finishes his task, checks the channel with `fetch_messages`, sees the discussion, and posts his feedback. **Posting auto-promotes him to active:**

```
     #conv-1711468800-user-api-design
     ┌────────────────────────────┐
     │  Oracle   → active         │
     │  Ward     → active         │
     │  Anvil    → active         │  ← auto-promoted by posting
     └────────────────────────────┘
```

**Step 6:** Ward finishes his review feedback and steps back:

```
Ward calls: hive__set_channel_tier({ channel_id: "123456", tier: "observing" })
```

He stops getting inbox messages but can still check Discord history later if needed.

---

## How Task Channels Fit In

Task channels (created automatically on TASK_ASSIGN) are just conversation channels with a task ID attached.

```
     Manager sends TASK_ASSIGN to Anvil for task-1
                    │
                    ▼
     Gateway creates #task-1-auth-refactor
     Anvil is auto-added as ACTIVE
                    │
                    ▼
     Manager posts updates in the task channel
     Anvil gets every message (he's active)
                    │
                    ▼
     Manager adds Ward for security review:
     hive__add_to_channel({ channel_id, agent: "ward" })
     Ward joins as OBSERVING
                    │
                    ▼
     Ward reads history, promotes to active, posts review
     Everyone active in the channel sees it
```

---

## The Manager's View

The manager is special — they see everything via role-based routing (Pass 1), regardless of channel membership. They are never added as a participant. This means:

- Manager sees all messages in all channels automatically
- Manager doesn't appear in participant lists
- Manager's inbox isn't flooded with conversation chatter (they get it through their existing routing)

---

## Smart Nudging

Not every message should interrupt an agent. The system respects agent status:

```
     Agent Status     │  Gets Nudged?
     ─────────────────┼──────────────────────────
     available        │  Yes
     focused          │  No (unless critical priority)
     blocked          │  No (unless critical priority)
```

Plus **debouncing**: max 1 nudge per 15 seconds per agent. If 10 messages arrive in 5 seconds, the agent gets nudged once and reads all 10 when they check inbox.

Messages always go to inbox (for active members) — the nudge is just the "hey, check your inbox" tap. Even without a nudge, agents find messages on their next `hive__check_inbox` call.

---

## New Tools Summary

| Tool | What It Does | When to Use |
|---|---|---|
| `hive__create_channel` | Creates a conversation channel | Starting a multi-party discussion |
| `hive__add_to_channel` | Adds an agent (as observing) | Bringing someone into a discussion |
| `hive__set_channel_tier` | Switch active ↔ observing | Controlling your inbox flow per channel |
| `hive__leave_channel` | Leave a channel entirely | Done with a discussion |
| `hive__my_channels` | List your channels + tier | After compaction, recovering channel IDs |
| `hive__team_status` | Check all agents' status | Before reaching out, see who's available |

**Existing tools unchanged:**
- `hive__send` — still the best for 1:1 direct messages (fast, no Discord channel)
- `hive__set_status` — still controls your overall availability
- `hive__check_inbox` — still how you read pending messages

---

## What Stays the Same

- **Agent channels** — still exist for STATUS and HEARTBEAT (monitoring feeds)
- **`hive__send`** — still works for 1:1 direct inbox messages
- **Protocol messages** — same format, same routing for TASK_ASSIGN, QUESTION, COMPLETE, etc.
- **Manager routing** — manager still gets everything via role-based routing
- **Worker status** — available/focused/blocked still controls nudge behavior

---

## Edge Cases Handled

| Situation | What Happens |
|---|---|
| Agent is torn down while in channels | Automatically removed from all participant lists |
| Agent crashes and restarts | Calls `hive__my_channels` on startup to recover |
| Human posts in a conversation channel | Delivered to all active participants |
| Agent posts STATUS in wrong channel | Protocol messages filtered out of Pass 3 (not fanned to participants) |
| Someone replies to a bot message | Scoped to the channel — doesn't broadcast to all workers |
| Agent added to channel they're already in | Idempotent — no duplicate notification |
| All participants leave | Channel stays in Discord for reference, no inbox delivery to anyone |
| Focused agent added to channel | Added as observing, not nudged — checks in on their schedule |
