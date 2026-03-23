# Hive — Discord Multi-Session Claude Code Orchestrator

Hive coordinates multiple Claude Code sessions via Discord. A **manager** session decomposes a project into features and assigns each to a **worker** session. Each worker has its own 1M context window, full OMC stack, and operates autonomously on a git worktree branch.

## Architecture

```
You ←→ Manager Session (Claude Code + OMC)
              │
           Discord
              │
   ┌──────────┼──────────┐
   │          │          │
Worker A   Worker B   Worker C
(auth)     (frontend)  (API)
```

## Prerequisites

1. **Discord Bot Applications**: Create N+1 bots in the [Discord Developer Portal](https://discord.com/developers/applications) (1 manager + N workers). Each needs:
   - MESSAGE CONTENT privileged intent enabled
   - Bot scope with permissions: Send Messages, Read Message History, View Channel, Add Reactions
   - Invite all bots to your Discord guild

2. **Discord Server**: Create channels for communication (e.g., `#hive` or per-worker channels)

3. **Bot Token File**: Create a file (e.g., `~/.hive-tokens`) with one token per line — manager first, then workers. Never commit this file.

4. **Project Repository**: Must be a git repo with at least one commit

5. **Runtime Dependencies**: `claude` CLI (v2.1+), `bun`, `git`

## Quick Start

```bash
# 1. Apply the bot filter patch (allows bot-to-bot Discord messaging)
bash patches/apply-patch.sh

# 2. Install dependencies
bun install

# 3. Launch a hive (3 workers)
bin/hive-launch.sh \
  --project-repo /path/to/your/project \
  --channel-id YOUR_CHANNEL_ID \
  --manager-bot-id MANAGER_BOT_USER_ID \
  --worker-bot-ids WORKER1_ID,WORKER2_ID,WORKER3_ID \
  --tokens-file ~/.hive-tokens \
  --workers 3 \
  --budget 5

# 4. Check status
bin/hive-status.sh

# 5. Integrate completed work
bin/hive-integrate.sh \
  --repo /path/to/your/project \
  --workers worker-01,worker-02,worker-03 \
  --target main

# 6. Tear down
bin/hive-launch.sh --teardown
```

## Commands

| Command | Description |
|---------|-------------|
| `bin/hive-launch.sh` | Launch manager + N workers |
| `bin/hive-launch.sh --teardown` | Stop all sessions |
| `bin/hive-status.sh` | Check process and branch status |
| `bin/hive-integrate.sh` | Merge worker branches |
| `bin/hive-gen-config.ts` | Generate per-worker configs |
| `patches/apply-patch.sh` | Apply bot filter patch |

## How It Works

1. **Launch**: `hive-launch.sh` generates configs, applies the bot filter patch, and starts 1 manager + N worker Claude Code sessions
2. **Decompose**: The manager reads the project and breaks it into independent features
3. **Assign**: Tasks are sent to workers via Discord using a structured protocol
4. **Execute**: Each worker runs autonomously (teams, subagents, ultrawork) on its own git worktree branch
5. **Report**: Workers send status updates and heartbeats via Discord
6. **Integrate**: When workers complete, `hive-integrate.sh` merges branches and runs tests

## Message Protocol

See `config/protocol.md` for the full inter-session communication protocol.

## Configuration

- `config/manager-system-prompt.md` — Manager behavior and coordination logic
- `config/worker-system-prompt.md` — Worker behavior and reporting cadence
- `config/protocol.md` — Message format specification
- `config/example-access.json` — Example Discord access configuration
