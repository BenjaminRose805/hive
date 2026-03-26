# Hive

Multi-session Claude Code orchestrator. Launches a team of AI agents that coordinate via Discord, each running in a tmux window with a dedicated git worktree.

```
tmux session (hive-myapp)
├── window 0: gateway         ← Discord bot
├── window 1: mind            ← Shared memory daemon
├── window 2: manager         ← Coordinator
├── window 3: alice           ← claude --bypassPermissions
├── window 4: bob             ← claude --bypassPermissions
└── window 5: carol           ← claude --bypassPermissions
```

## Setup

```bash
bun install

echo 'alias hive="$HOME/hive/bin/hive"' >> ~/.bashrc
source ~/.bashrc

hive register-commands   # register Discord slash commands
```

**Requirements:** Bun, tmux, Claude Code CLI, a Discord bot token.

## Configuration

```bash
hive init    # creates ~/.config/hive/config.json
hive edit    # open in $EDITOR
```

```json
{
  "defaults": {
    "agents": "worker-01,worker-02,worker-03",
    "token": "Bot YOUR_BOT_TOKEN"
  },
  "projects": {
    "myapp": {
      "repo": "~/projects/my-app",
      "channel": "1234567890123456789",
      "agents": "alice,bob,carol",
      "roles": "alice:developer,bob:backend-dev,carol:qa-engineer"
    },
    "api": {
      "repo": "~/projects/api-service",
      "channel": "9876543210987654321",
      "agents": "dave,eve",
      "token": "Bot DIFFERENT_BOT_TOKEN"
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `repo` | Yes | Path to git repository |
| `channel` | Yes | Discord channel ID |
| `agents` | No | Comma-separated agent names |
| `roles` | No | `name:role` pairs (e.g. `alice:developer,bob:qa-engineer`) |
| `token` | No | Discord bot token (falls back to `defaults` or `DISCORD_BOT_TOKEN` env) |
| `tools` | No | Per-agent tool overrides (e.g. `alice:+puppeteer`) |
| `admin_ids` | No | Discord user IDs allowed to use `/spin-up` and `/tear-down` |

Any field in `defaults` applies to all projects unless overridden.

## Usage

```bash
hive up myapp              # launch from config
hive down myapp            # stop all agents + tmux
hive fresh myapp           # clean slate, relaunch
hive status                # show running hives
hive attach myapp          # reattach tmux session
hive ls                    # list configured projects
```

### Direct mode (no config)

```bash
hive launch \
  --project-repo ~/my-project \
  --channel-id 1234567890 \
  --agents alice,bob,carol \
  --roles alice:developer,bob:qa-engineer \
  --token "Bot YOUR_TOKEN"

hive teardown
hive teardown --clean      # also removes worktrees
```

### Integrating work

```bash
hive integrate \
  --repo ~/my-project \
  --workers alice,bob \
  --target main \
  --test-cmd "bun test"    # optional
```

Options: `--dry-run`, `--auto-resolve`, `--test-cmd CMD`

## How it works

1. **Config** — resolves project settings, generates MCP configs
2. **Worktrees** — `git worktree add` per agent on branch `hive/<name>`
3. **Gateway** — starts Discord bot in tmux, waits for health check
4. **Mind** — starts shared memory daemon
5. **Manager** — coordinator agent that decomposes tasks
6. **Workers** — each in a tmux window with its own git worktree

### tmux

```
Window 0: gateway      Window 3: alice
Window 1: mind         Window 4: bob
Window 2: manager      Window 5: carol
```

`Ctrl-b n` next, `Ctrl-b p` prev, `Ctrl-b 0-9` jump, `Ctrl-b d` detach.

### Multi-instance

Run multiple projects simultaneously — each gets its own tmux session and gateway socket:

```bash
hive up myapp    # session: hive-myapp
hive up api      # session: hive-api
hive status      # shows both
```

## Discord slash commands

| Command | Description |
|---------|-------------|
| `/status` | Gateway and agent status |
| `/agents` | List registered agents |
| `/assign` | Assign a task to an agent |
| `/ask` | Message a specific agent |
| `/broadcast` | Message all agents |
| `/memory` | View agent's persistent memory |
| `/spin-up` | Start a new agent (admin-gated) |
| `/tear-down` | Stop an agent (admin-gated) |
| `/threads` | Show active task threads |

## Project structure

```
bin/
  hive                  CLI entry point
  hive-gateway.ts       Discord gateway server
  hive-mind.ts          Shared memory daemon
src/
  scripts/              launch.ts, status.ts, integrate.ts
  shared/               paths, subprocess, validation, project-config, agent-types
  gateway/              Protocol parsing, routing, thread management
  mind/                 Daemon, filesystem utilities
  gen-config.ts         Per-worker config generation
config/
  prompts/              System prompts + role profiles
  tools/                MCP tool definitions
  tool-profiles/        Role-to-tool mappings
  protocol.md           Inter-agent message protocol
```

## Message protocol

See `config/protocol.md` for the structured message format agents use to communicate.
