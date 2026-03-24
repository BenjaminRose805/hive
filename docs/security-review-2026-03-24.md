# Security Review — 2026-03-24

**Scope:** Full Hive project post-restructure
**Risk Level:** HIGH — 1 Critical, 5 High, 5 Medium, 3 Low
**Note:** All findings are pre-existing architectural concerns, not regressions from the restructure.

---

## Critical (1)

### 1. Command Injection via Shell Variable Interpolation
- **Location:** `src/scripts/launch.sh:346-356,503`
- **Category:** OWASP A03:2021 — Injection
- **Issue:** `$agent_name` and `$agent_role` from `agents.json` are passed unsanitized into `sed` patterns and `tmux send-keys`. While `gen-config.ts` validates names with `/^[a-zA-Z0-9-]{1,32}$/`, `launch.sh` reads from `agents.json` (which could be manually edited) without re-validation. Sed metacharacters (`/`, `&`, `\`) or shell metacharacters in role values enable arbitrary content injection or command execution.
- **Remediation:**
```bash
validate_safe_name() {
  local val="$1"
  if [[ ! "$val" =~ ^[a-zA-Z0-9-]+$ ]]; then
    die "Invalid name/role: '$val' — must be alphanumeric + hyphens only"
  fi
}
validate_safe_name "$agent_name"
validate_safe_name "$agent_role"
```

---

## High (5)

### 2. Unix Domain Socket — No Authentication
- **Location:** `bin/hive-gateway.ts:43,1103-1107`
- **Category:** OWASP A01:2021 — Broken Access Control
- **Issue:** Gateway HTTP server listens on `/tmp/hive-gateway/gateway.sock` with default `0755` permissions and no authentication. Any local user can `POST /register` to inject workers, `POST /send` to send Discord messages as the bot, or intercept all traffic.
- **Remediation:**
```typescript
import { chmodSync } from 'fs'
mkdirSync(GATEWAY_DIR, { recursive: true, mode: 0o700 })
chmodSync(GATEWAY_DIR, 0o700)

// Add shared secret for socket auth
const SOCKET_AUTH = process.env.HIVE_GATEWAY_SECRET ?? crypto.randomUUID()
writeFileSync(join(HIVE_ROOT, 'state', 'gateway-secret'), SOCKET_AUTH, { mode: 0o600 })

// In HTTP handler:
if (req.headers.get('Authorization') !== `Bearer ${SOCKET_AUTH}`) {
  return jsonErr('unauthorized', 401)
}
```

### 3. Agents Spawned with bypassPermissions — No Authorization
- **Location:** `bin/hive-gateway.ts:595`, `src/scripts/launch.sh:434,491`
- **Category:** OWASP A01:2021 — Broken Access Control
- **Issue:** Both `launch.sh` and the `/spin-up` slash command spawn Claude Code with `--permission-mode bypassPermissions`. No Discord user authorization check — anyone with slash command access can spawn agents with full system permissions.
- **Remediation:**
```typescript
const ADMIN_USER_IDS = new Set((process.env.HIVE_ADMIN_IDS ?? '').split(',').filter(Boolean))

async function handleSlashSpinUp(interaction) {
  if (ADMIN_USER_IDS.size > 0 && !ADMIN_USER_IDS.has(interaction.user.id)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true })
    return
  }
}
```

### 4. /register Endpoint — Worker Impersonation
- **Location:** `bin/hive-gateway.ts:830-846`
- **Category:** OWASP A01:2021 — Broken Access Control
- **Issue:** `/register` accepts any `workerId` without validation or auth. Attacker can register as `"manager"`, replacing the legitimate registration and intercepting all manager-directed messages. `workers.set(workerId, ...)` silently overwrites.
- **Remediation:**
```typescript
if (workers.has(workerId)) {
  return jsonErr(`worker ${workerId} already registered`, 409)
}
if (!/^[a-zA-Z0-9-]{1,32}$/.test(workerId)) {
  return jsonErr('invalid workerId format', 400)
}
```

### 5. Bot Token Written to Disk in Config
- **Location:** `src/gen-config.ts:714-722`
- **Category:** OWASP A02:2021 — Sensitive Data Exposure
- **Issue:** Discord bot token written in plaintext to `state/gateway/config.json` with default permissions. While `state/` is gitignored, the token persists on disk.
- **Remediation:** Don't persist the token — reference env var instead:
```typescript
const gatewayConfig = { botToken: "(from DISCORD_BOT_TOKEN env var)", ... }
```

### 6. Bot Token Embedded in Launch Script
- **Location:** `src/scripts/launch.sh:298-301`
- **Category:** OWASP A02:2021 — Sensitive Data Exposure
- **Issue:** Launch script writes `DISCORD_BOT_TOKEN="$TOKEN"` into `state/.launch-gateway.sh` with `755` (world-readable) permissions.
- **Remediation:**
```bash
export DISCORD_BOT_TOKEN="$TOKEN"
cat > "$launch_script" << 'LAUNCH_EOF'
#!/usr/bin/env bash
bun run "$HIVE_DIR/bin/hive-gateway.ts" 2>&1
LAUNCH_EOF
chmod 700 "$launch_script"
```

---

## Medium (5)

### 7. Scope Enforcement Hook Bypass
- **Location:** `hooks/check-scope.mjs:43-55`
- **Category:** OWASP A01:2021 — Broken Access Control
- **Issue:** Bash write-detection uses simple regex (`>`, `sed -i`, `mv`, `cp`, `tee`). Trivially bypassed via `python3 -c`, `dd of=`, `install`, `ln -sf`, base64/eval. Only checks first write target.
- **Remediation:** Document as "soft" boundary. For hard isolation, use containers or `--permission-mode` allowlisting.

### 8. --no-verify on Daemon Git Commits
- **Location:** `src/mind/daemon.ts:790-795`
- **Category:** OWASP A05:2021 — Security Misconfiguration
- **Issue:** `runGitSnapshot` uses `git commit --no-verify`, bypassing pre-commit scope enforcement hooks.
- **Remediation:** Acceptable if daemon only commits its own managed dirs (contracts, decisions, agents, changelog). Add comment documenting why `--no-verify` is intentional.

### 9. ReDoS in Mention Pattern Matching
- **Location:** `bin/hive-gateway.ts:166-169`
- **Category:** OWASP A03:2021 — Injection
- **Issue:** User-configurable `mentionPatterns` compiled as regexes and tested against Discord message content. Catastrophic backtracking patterns could hang the gateway event loop.
- **Remediation:** Use literal string matching instead of regex:
```typescript
for (const pat of mentionPatterns) {
  if (msg.content.toLowerCase().includes(pat.toLowerCase())) return true
}
```

### 10. Attachment Download Path Traversal (Partial)
- **Location:** `bin/hive-gateway.ts:1071-1074`
- **Category:** OWASP A01:2021 — Broken Access Control
- **Issue:** Extension is sanitized (alphanumeric only) and filename uses Discord snowflake ID, so current code is safe but fragile.
- **Remediation:** Add defensive check:
```typescript
if (!safePath.startsWith(INBOX_DIR)) {
  return jsonErr('invalid attachment path', 400)
}
```

### 11. Shell Injection in integrate.sh
- **Location:** `src/scripts/integrate.sh:79-82`
- **Category:** OWASP A03:2021 — Injection
- **Issue:** `node -e "require('$root/package.json')"` — `$root` from `--repo` arg could contain shell metacharacters.
- **Remediation:**
```bash
node -e "
  const p = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  process.exit((p.scripts && p.scripts.test) ? 0 : 1);
" "$root/package.json" 2>/dev/null
```

---

## Low (3)

### 12. Dependency Vulnerabilities (undici)
- **Location:** Transitive via discord.js
- **Issue:** 6 vulnerabilities in undici (3 high, 3 moderate) — HTTP smuggling, WebSocket memory exhaustion, decompression chain attacks. Low contextual risk since gateway only talks to Discord's trusted API.
- **Remediation:** `bun update`

### 13. secrets.env Coverage in .gitignore
- **Location:** `.gitignore`
- **Issue:** Covered by `*.env` glob but no explicit `config/secrets.env` entry.
- **Remediation:** Add `config/secrets.env` to `.gitignore`

### 14. Error Messages Leak Internal Paths
- **Location:** `bin/hive-gateway.ts:765` and others
- **Issue:** Raw error messages sent to Discord interactions may contain filesystem paths.
- **Remediation:** Return generic errors to Discord; log details server-side only.

---

## Containerization Strategy

Running each worker in its own container is the **single highest-leverage security improvement** — it turns soft boundaries into hard ones and addresses 8 of 14 findings at the infrastructure level.

### Architecture

```
┌─────────────────────────────────┐
│  Host                           │
│  ├── bin/hive-gateway.ts        │  ← runs on host (single process)
│  ├── gateway.sock (chmod 700)   │  ← host-only
│  │                              │
│  ├── worker-1 container         │  ← bind: worktrees/worker-1 (rw), config/ (ro)
│  │   └── claude --bypassPermissions
│  ├── worker-2 container         │
│  │   └── claude --bypassPermissions
│  └── manager container          │
│      └── claude --bypassPermissions
└─────────────────────────────────┘
```

Each container gets:
- Its worktree directory (read-write bind mount)
- `config/` (read-only bind mount)
- A per-worker gateway auth token (env var)
- Network access only to the gateway socket (`--network=none` + forwarded socket)
- No access to `state/`, other worktrees, or host filesystem

### What Containers Fix

| # | Finding | How Containers Fix It |
|---|---------|----------------------|
| 1 | Shell injection in launch.sh | Contained — even if exploited, attacker is trapped in minimal container with only one worktree |
| 2 | Unauthenticated socket | Each container sees only a forwarded socket endpoint; combine with per-worker auth token |
| 3 | bypassPermissions blast radius | Agent has full permissions *inside* the container, but container limits blast radius (no host FS, no host network) |
| 4 | Worker impersonation via /register | Per-worker auth token injected as env var; token required on /register |
| 7 | Scope enforcement hook bypass | Hard enforcement via bind mounts — worker literally cannot see files outside its worktree |
| 8 | --no-verify bypassing hooks | Irrelevant — container can only commit to its own worktree |
| 11 | Shell injection in integrate.sh | Contained — even if `$root` is malicious, damage limited to container |
| 14 | Error messages leak paths | Container paths are meaningless outside the container |

### What Containers Do NOT Fix (still need remediation)

| # | Finding | Why Containers Don't Help | Remediation |
|---|---------|--------------------------|-------------|
| 3 | No Discord user auth on /spin-up | Gateway runs on host, not in container | Add admin user ID allowlist via `HIVE_ADMIN_IDS` env var |
| 5 | Bot token in state/gateway/config.json | Gateway runs on host; token still written to disk | Don't persist token — reference env var instead |
| 6 | Bot token in state/.launch-gateway.sh | Same — host-side launch script | `export` token, use heredoc with single quotes, `chmod 700` |
| 9 | ReDoS in mention pattern matching | Gateway runs on host | Use literal string matching instead of regex compilation |
| 10 | Attachment path traversal | Gateway runs on host | Add `startsWith(INBOX_DIR)` defensive check |
| 12 | undici vulnerabilities | Transitive dependency | `bun update` |
| 13 | secrets.env gitignore coverage | Config management | Add explicit `config/secrets.env` to `.gitignore` |

### Implementation Notes

- `launch.sh` would use `docker run` instead of `tmux send-keys`
- Need a container image with `bun` + `claude` CLI installed
- Gateway socket forwarded into each container via bind-mount or socat
- Per-worker auth tokens generated by gateway at startup, written to `state/worker-N-token` with `0600` perms, bind-mounted into container as env var
- `integrate.sh` runs on host (merges branches from worktrees) — no container needed

### Tradeoffs

| Aspect | Without Containers | With Containers |
|--------|-------------------|-----------------|
| Security boundary | Soft (regex hooks, tmux isolation) | Hard (kernel namespaces, bind mounts) |
| Setup complexity | Low (tmux + bun) | Medium (Docker + image build) |
| Resource overhead | Minimal | ~50-100MB per container |
| Debugging | Direct tmux attach | `docker exec` or log forwarding |
| Startup time | Fast (~1s per worker) | Slower (~3-5s per worker) |

---

## Revised Priority Remediation Order

### If implementing containers (recommended):

1. **Containerize workers** — fixes #1, #2, #3 (partial), #4, #7, #8, #11, #14
2. **Discord user auth on /spin-up** (#3) — admin allowlist on gateway (host-side)
3. **Stop persisting bot token to disk** (#5, #6) — env inheritance + chmod 700
4. **Literal string matching for mentions** (#9) — replace regex compilation
5. **`bun update`** (#12) — undici CVEs
6. **Minor fixes** (#10 path check, #13 gitignore)

### If NOT implementing containers:

1. **Socket auth + dir permissions** (fixes #2, #4) — highest impact, easiest win
2. **Re-validate agents.json values in shell** (fixes #1) — critical injection vector
3. **Discord user auth on slash commands** (fixes #3) — admin allowlist
4. **Stop persisting bot token to disk** (fixes #5, #6) — env inheritance + chmod 700
5. **`bun update`** (#12) for undici CVEs

## Checklist Summary

- [x] No hardcoded secrets in source (tokens from env vars, secrets.env gitignored)
- [ ] All inputs validated — FAIL (shell scripts don't re-validate; /register accepts anything; regex compilation from config)
- [ ] Injection prevention — FAIL (sed interpolation; node -e interpolation)
- [ ] Authentication/authorization — FAIL (socket unauthenticated; no admin gating on slash commands)
- [x] Dependencies audited — 6 transitive vulns in undici, low contextual risk
- [ ] Sensitive data at rest — FAIL (bot token in config.json and launch script)
