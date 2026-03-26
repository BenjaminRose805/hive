# Hive Ecosystem Blueprint

> Comprehensive team designs for all hive instances, new role profiles, and prioritization.
> Generated 2025-03-25 via multi-agent analysis (4 Opus agents in parallel).

---

## Table of Contents

1. [New Role Profiles](#1-new-role-profiles)
2. [Hive Instance: `hive` (Self-Development)](#2-hive-instance-hive)
3. [Hive Instance: `vcb` (Voice Command Bridge)](#3-hive-instance-vcb)
4. [Hive Instance: `campfire` (Minecraft Server Platform)](#4-hive-instance-campfire)
5. [Hive Instance: `obsidian` (Knowledge Management)](#5-hive-instance-obsidian)
6. [Hive Instance: `homelab` (Home Automation & Infra)](#6-hive-instance-homelab)
7. [Hive Instance: `sentinel` (Cross-Project DevOps)](#7-hive-instance-sentinel)
8. [Hive Instance: `review` (Code Review Pipeline)](#8-hive-instance-review)
9. [Hive Instance: `scholar` (Research & Learning)](#9-hive-instance-scholar)
10. [Hive Instance: `chronicle` (Documentation & Content)](#10-hive-instance-chronicle)
11. [Hive Instance: `nexus` (Meta-Orchestration)](#11-hive-instance-nexus)
12. [Prioritization & Rollout Order](#12-prioritization)
13. [Open Questions](#13-open-questions)

---

## 1. New Role Profiles

### Currently Existing (8 roles)

| Role | Focus | Tools |
|------|-------|-------|
| `manager` | Coordination, task decomposition, integration | fetch |
| `developer` | Full-stack generalist | context7, fetch, github |
| `frontend-dev` | UI, components, accessibility | context7, fetch, puppeteer, github |
| `backend-dev` | APIs, databases, auth, performance | context7, fetch, github |
| `qa-engineer` | Test strategy, edge cases, regression | context7, fetch, puppeteer, github |
| `tech-lead` | Architecture, code quality, tech debt | context7, fetch, web-search, github |
| `security-reviewer` | OWASP, threat modeling, secrets | context7, fetch, web-search, github |
| `devops` | CI/CD, Docker, deployment, monitoring | context7, fetch, github |

### Proposed New Roles (Priority Tier 1 — implement first)

#### `tech-writer`
- **Purpose**: Documentation as primary deliverable — READMEs, API docs, ADRs, migration guides, user guides
- **Distinct from**: `developer` (who writes docs incidentally), `tech-lead` (who reviews architecture)
- **Prompt themes**: Documentation-as-code, audience awareness, style consistency, code example verification, ADR format
- **Tools**: `context7, fetch, github`
- **Used by**: All software hives, `chronicle`, `obsidian`

#### `api-designer`
- **Purpose**: Contract-first API design — OpenAPI specs, schema definitions, versioning strategy. Works upstream of backend-dev
- **Distinct from**: `backend-dev` (who implements APIs), `tech-lead` (who reviews architecture broadly)
- **Prompt themes**: RESTful conventions, schema design, breaking change detection, idempotency, backward compatibility
- **Tools**: `context7, fetch, github`
- **Used by**: API-heavy software hives (`campfire`, `hive`)

#### `research-analyst`
- **Purpose**: Technical research, library evaluation, comparison reports, feasibility studies
- **Distinct from**: All existing roles (none have research as primary mandate)
- **Prompt themes**: Research methodology, source evaluation, comparison matrices, bias awareness, structured output with citations
- **Tools**: `context7, fetch, web-search, github`
- **Used by**: `scholar`, software hives (tech evaluation phase)

#### `integration-tester`
- **Purpose**: E2E and integration test suites that exercise the system across component boundaries
- **Distinct from**: `qa-engineer` (who defines test strategy and unit-level methodology)
- **Prompt themes**: E2E frameworks (Playwright, Cypress), test environment setup, flaky test hardening, visual regression
- **Tools**: `context7, fetch, puppeteer, github`
- **Used by**: All software hives with UI or multi-component architecture

#### `performance-engineer`
- **Purpose**: Profiling, benchmarking, optimization. Deliverable is "this went from 200ms to 15ms"
- **Distinct from**: `qa-engineer` (correctness), `devops` (production monitoring)
- **Prompt themes**: Benchmark methodology, flame graphs, query optimization, bundle analysis, caching strategy
- **Tools**: `context7, fetch, puppeteer, github`
- **Used by**: Performance-critical software hives (`campfire`, `vcb`)

#### `data-engineer`
- **Purpose**: Data models, schemas, migrations, ETL, query optimization
- **Distinct from**: `backend-dev` (generalist who handles APIs + auth + logic)
- **Prompt themes**: Normalization trade-offs, migration safety, zero-downtime patterns, seed data
- **Tools**: `context7, fetch, github`
- **Used by**: Data-heavy software hives (`campfire`, `local-rag`)

#### `release-engineer`
- **Purpose**: Versioning, changelogs, release notes, tagging, release validation
- **Distinct from**: `devops` (who handles CI/CD pipeline infrastructure)
- **Prompt themes**: Semantic versioning, conventional commits, release checklists, rollback procedures
- **Tools**: `context7, fetch, github`
- **Used by**: All software hives, `sentinel`

#### `home-auto-engineer`
- **Purpose**: Smart home platforms (HA, MQTT, Zigbee), IoT device integration, automation rules
- **Distinct from**: `devops` (general infrastructure, not IoT-specific)
- **Prompt themes**: HA YAML configuration, MQTT topics, Zigbee2MQTT, automation triggers/conditions/actions, ESPHome
- **Tools**: `context7, fetch, web-search, github`
- **Used by**: `homelab`

### Proposed New Roles (Priority Tier 2 — add on demand)

#### `protocol-designer`
- **Purpose**: Message format design, specification rigor, parser/router synchronization, protocol versioning
- **Tools**: `context7, fetch, github`
- **Used by**: `hive`

#### `prompt-engineer`
- **Purpose**: LLM prompt design, testing, optimization. System prompts, role profiles, agent interaction patterns
- **Tools**: `fetch, web-search`
- **Used by**: `hive` (meta), `scholar`

#### `knowledge-curator`
- **Purpose**: Information architecture — taxonomy, cross-referencing, staleness detection, content lifecycle
- **Tools**: `fetch, web-search, github`
- **Used by**: `obsidian`, `chronicle`

#### `ux-designer`
- **Purpose**: Interaction flows, component specs, wireframes (as structured descriptions). Works upstream of frontend-dev
- **Tools**: `fetch, puppeteer, web-search`
- **Used by**: UI-heavy software hives

#### `content-creator`
- **Purpose**: User-facing content: blog posts, tutorials, marketing copy. Different audience than tech-writer
- **Tools**: `fetch, web-search`
- **Used by**: `chronicle`

#### `dependency-manager`
- **Purpose**: Dependency auditing, upgrades, conflict resolution, supply chain security
- **Tools**: `context7, fetch, web-search, github`
- **Used by**: `sentinel`, large software hives

### Proposed New Roles (Domain-Specific)

These are specialized for specific hives and would only be created when that hive is set up:

| Role | Purpose | Hive |
|------|---------|------|
| `forge-modder` | Forge 1.20.1 lifecycle, sided execution, ForgeGradle, Brigadier | `vcb` |
| `audio-engineer` | Java Sound API, WAV format, buffer management, audio thread safety | `vcb` |
| `vr-specialist` | Vivecraft API, VR frame budgets, haptic feedback, graceful degradation | `vcb` |
| `ml-engineer` | Prompt engineering, sidecar HTTP, STT/LLM integration, structured output | `vcb` |
| `infra-monitor` | Observability (metrics, logs, traces), SLI/SLO, alerting, dashboards | `homelab`, `sentinel` |

---

## 2. Hive Instance: `hive`

**Purpose**: Developing the Hive orchestrator itself (meta — building the tool with the tool)

### Team Roster (13 agents)

| # | Name | Role | Owns |
|---|------|------|------|
| 1 | `monarch` | `manager` | Coordination, task decomposition, integration |
| 2 | `gatekeeper` | `backend-dev` | Gateway — Discord.js multiplexer, HTTP API, thread lifecycle (1536 lines) |
| 3 | `synaptic` | `backend-dev` | Mind Daemon — delta processing, watches, concurrency, git snapshots (1066 lines) |
| 4 | `relay` | `backend-dev` | MCP servers — discord-relay, inbox-relay, tool proxying (~540 lines) |
| 5 | `scaffolder` | `devops` | Launch system, config generation, tmux orchestration, worktree management |
| 6 | `protocolist` | `developer` | Protocol parser, selective router, protocol spec (protocol-designer role when available) |
| 7 | `profiler` | `developer` | System prompts, role profiles, prompt composition (prompt-engineer role when available) |
| 8 | `sentinel` | `security-reviewer` | Token handling, admin auth, path traversal, scope hooks, secrets |
| 9 | `validator` | `qa-engineer` | Integration tests across subsystem boundaries |
| 10 | `stress` | `qa-engineer` | Reliability — crash recovery, concurrency, race conditions, Discord rate limits |
| 11 | `helmsman` | `developer` | CLI commands (up/down/status/attach), validation, subprocess management |
| 12 | `scribe` | `tech-writer` | docs/, README, CLAUDE.md, protocol docs, architecture docs |
| 13 | `pathfinder` | `tech-lead` | Cross-cutting architecture, type consistency, "unify manager as worker" oversight |

### Why This Size

- Gateway (1536 lines) and Mind Daemon (1066 lines) each justify a dedicated developer
- Two QA engineers because integration testing (happy paths) and reliability testing (crash/race conditions) are distinct disciplines
- Protocol is the system contract — needs its own owner separate from gateway implementation
- Active refactoring ("unify manager as worker") needs a tech-lead with full cross-subsystem visibility

### Config

```json
{
  "projects": {
    "hive": {
      "repo": "~/hive",
      "channel": "CHANNEL_ID",
      "agents": "monarch,gatekeeper,synaptic,relay,scaffolder,protocolist,profiler,sentinel,validator,stress,helmsman,scribe,pathfinder",
      "roles": "monarch:manager,gatekeeper:backend-dev,synaptic:backend-dev,relay:backend-dev,scaffolder:devops,protocolist:developer,profiler:developer,sentinel:security-reviewer,validator:qa-engineer,stress:qa-engineer,helmsman:developer,scribe:tech-writer,pathfinder:tech-lead"
    }
  }
}
```

---

## 3. Hive Instance: `vcb`

**Purpose**: Building VCB (Voice Command Bridge) for VR Minecraft from scratch — TDD-first

### Team Roster (12 agents)

| # | Name | Role | Owns |
|---|------|------|------|
| 1 | `hive` | `manager` | Coordination, dependency-graph-aware task decomposition |
| 2 | `sentinel` | `tech-lead` | Package structure, shared interfaces, Gradle config, contract reviews |
| 3 | `anvil` | `forge-modder` | Mod core (VCBMod, VCBCommands), Forge event hooks, config system |
| 4 | `echo` | `audio-engineer` | AudioCapture, AudioFeedback, WAV encoding, mic handling |
| 5 | `prism` | `vr-specialist` | VCBKeybind (VR controller), HapticFeedback, Vivecraft integration |
| 6 | `oracle` | `ml-engineer` | VoicePipeline, ResponseParser, SidecarManager, WhisperClient, LLMClient |
| 7 | `forge` | `backend-dev` | Operations subsystem — OperationRegistry, all operation handlers |
| 8 | `lens` | `frontend-dev` | VCBOverlay, HUD elements, pipeline state visualization |
| 9 | `bastion` | `qa-engineer` | Test infrastructure, unit test suites (works AHEAD of implementers in TDD flow) |
| 10 | `crucible` | `qa-engineer` | Integration tests, mock sidecar servers, E2E pipeline tests |
| 11 | `ward` | `security-reviewer` | Process spawning, HTTP client config, audio data handling, LLM output validation |
| 12 | `piston` | `devops` | ForgeGradle CI, sidecar Docker, GitHub Actions, release packaging |

### TDD Execution Phases

```
Phase 1 (Foundation):  sentinel (interfaces) + piston (CI) + bastion (test infra)
Phase 2 (Core):        anvil (mod core) + echo (audio) + oracle (sidecars) + crucible (integration framework)
Phase 3 (Pipeline):    oracle (pipeline) + prism (VR input) + forge (operations) + bastion (unit tests for Phase 2)
Phase 4 (UI+Polish):   lens (HUD) + forge (remaining ops) + crucible (E2E tests) + ward (security review)
Phase 5 (Integration): hive coordinates merges, ward final review, crucible full regression
```

### New Roles Required

4 domain-specific profiles: `forge-modder`, `audio-engineer`, `vr-specialist`, `ml-engineer`

### Config

```json
{
  "projects": {
    "vcb": {
      "repo": "~/projects/VCB",
      "channel": "CHANNEL_ID",
      "agents": "hive,sentinel,anvil,echo,prism,oracle,forge,lens,bastion,crucible,ward,piston",
      "roles": "hive:manager,sentinel:tech-lead,anvil:forge-modder,echo:audio-engineer,prism:vr-specialist,oracle:ml-engineer,forge:backend-dev,lens:frontend-dev,bastion:qa-engineer,crucible:qa-engineer,ward:security-reviewer,piston:devops"
    }
  }
}
```

---

## 4. Hive Instance: `campfire`

**Purpose**: Distributed Minecraft server platform — 9-package TypeScript monorepo

### Team Roster (10 agents)

| # | Name | Role | Owns |
|---|------|------|------|
| 1 | `forge` | `manager` | Architecture oversight, cross-package contracts, merge coordination |
| 2 | `ember` | `backend-dev` | `packages/auth-service`, `packages/relay`, `packages/node` — server-side services |
| 3 | `spark` | `backend-dev` | `packages/crypto`, `packages/shared` — shared libraries, types, utilities |
| 4 | `hearth` | `frontend-dev` | `packages/web`, `packages/ui` — browser dashboard, component library |
| 5 | `anvil` | `developer` | `packages/desktop` — Tauri desktop app, native platform integration |
| 6 | `flint` | `developer` | `packages/spark` — the Spark system |
| 7 | `sentinel` | `qa-engineer` | Cross-package integration testing, full suite regression |
| 8 | `watchtower` | `security-reviewer` | Auth flows, crypto review, API security audit |
| 9 | `pipeline` | `devops` | Build system, package publishing, Docker images, monorepo CI |
| 10 | `cartographer` | `tech-writer` | API docs per package, dependency maps, onboarding guides |

### Why This Works

- 9 packages map naturally to agent scopes — Hive's scope enforcement prevents cross-package accidents
- `shared` and `crypto` need a dedicated owner because changes ripple to all consumers
- Hive Mind contracts are perfect for declaring cross-package interfaces
- No new roles needed — existing roles cover the TypeScript monorepo well

### Config

```json
{
  "projects": {
    "campfire": {
      "repo": "~/projects/campfire",
      "channel": "CHANNEL_ID",
      "agents": "forge,ember,spark,hearth,anvil,flint,sentinel,watchtower,pipeline,cartographer",
      "roles": "forge:manager,ember:backend-dev,spark:backend-dev,hearth:frontend-dev,anvil:developer,flint:developer,sentinel:qa-engineer,watchtower:security-reviewer,pipeline:devops,cartographer:tech-writer"
    }
  }
}
```

---

## 5. Hive Instance: `obsidian`

**Purpose**: Personal knowledge management — capture, organize, interlink, and retrieve notes via Discord

### Team Roster (8 agents)

| # | Name | Role | Owns |
|---|------|------|------|
| 1 | `scribe` | `manager` | Captures raw Discord input into structured Obsidian notes with YAML frontmatter |
| 2 | `archivist` | `knowledge-curator` | Vault structure, folders, tags, naming conventions, MOC indexes |
| 3 | `weaver` | `developer` | Builds/maintains `[[wikilinks]]`, detects relationships, suggests missing links |
| 4 | `scout` | `research-analyst` | Fetches context for URLs/topics, creates reference notes with source attribution |
| 5 | `distiller` | `developer` | Daily/weekly digests, evergreen note synthesis from atomic notes |
| 6 | `librarian` | `developer` | Search queries from Discord — by content, tags, date, link proximity |
| 7 | `gardener` | `qa-engineer` | Orphaned notes, stale content, broken links, duplicate detection |
| 8 | `mirror` | `qa-engineer` | Vault health audits — missing frontmatter, empty notes, tag inconsistencies |

### Discord Workflow

- **Capture**: Type anything in Discord channel. `scribe` processes it into an Obsidian note.
- **Search**: `@librarian find notes about X` triggers search, returns excerpts.
- **Synthesis**: `@distiller weekly digest` produces a summary of recent notes.
- **Maintenance**: `gardener` and `mirror` run background health checks.

### Prerequisite

The hive repo must be the Obsidian vault itself (or contain it). Agents write `.md` files that Obsidian picks up immediately.

### Config

```json
{
  "projects": {
    "obsidian": {
      "repo": "~/obsidian-vault",
      "channel": "CHANNEL_ID",
      "agents": "scribe,archivist,weaver,scout,distiller,librarian,gardener,mirror",
      "roles": "scribe:manager,archivist:knowledge-curator,weaver:developer,scout:research-analyst,distiller:developer,librarian:developer,gardener:qa-engineer,mirror:qa-engineer"
    }
  }
}
```

---

## 6. Hive Instance: `homelab`

**Purpose**: Home Assistant, Minecraft server, Docker services, network — infrastructure-as-code

### Team Roster (8 agents)

| # | Name | Role | Owns |
|---|------|------|------|
| 1 | `central` | `manager` | Coordinates cross-domain changes |
| 2 | `habot` | `home-auto-engineer` | HA configuration.yaml, integrations, templates |
| 3 | `automate` | `home-auto-engineer` | Automation rules, scripts, scenes (natural-language to YAML) |
| 4 | `dash` | `frontend-dev` | Lovelace dashboards, cards, views, entity display |
| 5 | `minops` | `devops` | Minecraft server management, JVM tuning, mod configs, backups |
| 6 | `netwatch` | `devops` | Docker compose, service health, ports, DNS, reverse proxy |
| 7 | `vault-keeper` | `security-reviewer` | Secrets, firewall rules, exposed services, SSL certs |
| 8 | `docbot` | `tech-writer` | Runbooks, network diagrams (text), service inventory, recovery docs |

### Discord Workflow

- "Add a motion-activated light for the garage" → `automate` writes YAML, `habot` validates, `dash` adds dashboard card
- "Minecraft server lagging" → `minops` tunes JVM flags, `docbot` updates performance runbook
- Weekly: `vault-keeper` audits exposed ports/certs, `docbot` produces health report

### Config

```json
{
  "projects": {
    "homelab": {
      "repo": "~/homelab",
      "channel": "CHANNEL_ID",
      "agents": "central,habot,automate,dash,minops,netwatch,vault-keeper,docbot",
      "roles": "central:manager,habot:home-auto-engineer,automate:home-auto-engineer,dash:frontend-dev,minops:devops,netwatch:devops,vault-keeper:security-reviewer,docbot:tech-writer"
    }
  }
}
```

---

## 7. Hive Instance: `sentinel`

**Purpose**: Cross-project portfolio health — dependencies, CI, security, releases across all repos

### Team Roster (8 agents)

| # | Name | Role | Owns |
|---|------|------|------|
| 1 | `reporter` | `manager` | Weekly portfolio health reports, aggregation |
| 2 | `deps` | `dependency-manager` | Dependency auditing across all projects, update PRs |
| 3 | `ci-doc` | `devops` | CI/CD health monitoring, build status, flaky tests |
| 4 | `patcher` | `security-reviewer` | Vulnerability scanning, npm audit, CVE tracking |
| 5 | `compat` | `qa-engineer` | Cross-project compatibility (shared dep version alignment) |
| 6 | `releaser` | `release-engineer` | Unreleased changes tracking, changelog drafts, release notes |
| 7 | `health` | `developer` | Repo hygiene — README completeness, .gitignore, stale branches |
| 8 | `mirror` | `devops` | Backup verification, git remote sync, local-only branch detection |

### Discord Workflow

- Daily: `deps` + `patcher` scan all repos, post findings. `ci-doc` checks build status.
- Weekly: `reporter` produces unified portfolio summary with action items.
- On-demand: "Check if campfire and discord-claude-bot have compatible Discord.js versions" → `compat`

### Config

```json
{
  "projects": {
    "sentinel": {
      "repo": "~/sentinel",
      "channel": "CHANNEL_ID",
      "agents": "reporter,deps,ci-doc,patcher,compat,releaser,health,mirror",
      "roles": "reporter:manager,deps:dependency-manager,ci-doc:devops,patcher:security-reviewer,compat:qa-engineer,releaser:release-engineer,health:developer,mirror:devops"
    }
  }
}
```

---

## 8. Hive Instance: `review`

**Purpose**: Multi-perspective code review pipeline — 7 review angles synthesized into one report

### Team Roster (8 agents)

| # | Name | Role | Owns |
|---|------|------|------|
| 1 | `synthesis` | `manager` | Reads all findings, deduplicates, prioritizes, produces consolidated review |
| 2 | `logic` | `developer` | Correctness: off-by-one, null handling, race conditions, edge cases |
| 3 | `style` | `developer` | Conventions: naming, formatting, file organization, idiomatic patterns |
| 4 | `secure` | `security-reviewer` | Injection, auth bypass, secrets exposure, supply chain |
| 5 | `perf` | `performance-engineer` | Complexity, allocations, N+1 queries, bundle size, memory leaks |
| 6 | `api` | `api-designer` | Backward compatibility, versioning, error formats, docs accuracy |
| 7 | `test` | `qa-engineer` | Coverage gaps, missing edge case tests, flaky patterns, maintainability |
| 8 | `arch` | `tech-lead` | Architecture fit, coupling, decomposition, design pattern adherence |

### Discord Workflow

- Benjamin pushes branch, posts: "Review: campfire/feature/websocket-reconnect"
- All 7 review agents run in parallel on the diff
- `synthesis` produces one document: **Critical** (must fix), **Important** (should fix), **Minor** (nice to have), **Positive** (good patterns)

### Config

```json
{
  "projects": {
    "review": {
      "repo": "~/review-workspace",
      "channel": "CHANNEL_ID",
      "agents": "synthesis,logic,style,secure,perf,api,test,arch",
      "roles": "synthesis:manager,logic:developer,style:developer,secure:security-reviewer,perf:performance-engineer,api:api-designer,test:qa-engineer,arch:tech-lead"
    }
  }
}
```

---

## 9. Hive Instance: `scholar`

**Purpose**: Technical research, learning, and technology evaluation

### Team Roster (8 agents)

| # | Name | Role | Owns |
|---|------|------|------|
| 1 | `digest` | `manager` | Periodic digests, research coordination |
| 2 | `scout` | `research-analyst` | Fetch/summarize blog posts, release notes, changelogs for Benjamin's tech stack |
| 3 | `prof` | `tech-lead` | Deep-dive explainer — structured educational notes with examples and trade-offs |
| 4 | `lab` | `developer` | Proof-of-concept code snippets in `experiments/` |
| 5 | `bench` | `performance-engineer` | Benchmarks and evaluates alternatives with actual measurements |
| 6 | `critic` | `security-reviewer` | Evaluates new deps/tools for security, maintenance health, license compatibility |
| 7 | `archivist` | `knowledge-curator` | Organizes research output — topic folders, indexes, cross-references |
| 8 | `tutor` | `developer` | Interactive Q&A — answers grounded in research corpus + codebase context |

### Discord Workflow

- "Research: best approaches to real-time sync for distributed Minecraft" → `scout` gathers, `prof` analyzes, `lab` builds PoC, `bench` evaluates, `archivist` files
- Daily: `digest` posts tech news relevant to Benjamin's stack
- "Should I switch from X to Y?" → `critic` evaluates security, `bench` runs comparisons, `prof` summarizes

### Config

```json
{
  "projects": {
    "scholar": {
      "repo": "~/scholar",
      "channel": "CHANNEL_ID",
      "agents": "digest,scout,prof,lab,bench,critic,archivist,tutor",
      "roles": "digest:manager,scout:research-analyst,prof:tech-lead,lab:developer,bench:performance-engineer,critic:security-reviewer,archivist:knowledge-curator,tutor:developer"
    }
  }
}
```

---

## 10. Hive Instance: `chronicle`

**Purpose**: Documentation and content creation across all projects

### Team Roster (8 agents)

| # | Name | Role | Owns |
|---|------|------|------|
| 1 | `editor` | `manager` | Quality review, accuracy, clarity, broken links, coordination |
| 2 | `readme` | `tech-writer` | README maintenance across all projects |
| 3 | `guide` | `tech-writer` | Step-by-step tutorials, onboarding docs |
| 4 | `api-doc` | `tech-writer` | API reference docs from code (JSDoc, TypeDoc) |
| 5 | `changelog` | `release-engineer` | Git history → human-readable changelogs |
| 6 | `blogger` | `content-creator` | Blog posts, Twitter threads from technical work |
| 7 | `cross-ref` | `knowledge-curator` | Portfolio README, project comparison docs, "which project for X" guides |
| 8 | `showcase` | `frontend-dev` | Demo projects, GIFs, screenshots, visual demonstrations |

### Discord Workflow

- After feature ships: "Document WebSocket reconnection in campfire" → `api-doc` updates API docs, `guide` writes usage guide, `readme` updates README, `changelog` adds entry
- Weekly: `editor` audits all docs for staleness, `cross-ref` updates portfolio index
- On-demand: "Write a blog post about Hive Mind contracts" → `blogger` drafts, `editor` reviews, `showcase` creates diagrams

### Config

```json
{
  "projects": {
    "chronicle": {
      "repo": "~/chronicle",
      "channel": "CHANNEL_ID",
      "agents": "editor,readme,guide,api-doc,changelog,blogger,cross-ref,showcase",
      "roles": "editor:manager,readme:tech-writer,guide:tech-writer,api-doc:tech-writer,changelog:release-engineer,blogger:content-creator,cross-ref:knowledge-curator,showcase:frontend-dev"
    }
  }
}
```

---

## 11. Hive Instance: `nexus`

**Purpose**: Meta-orchestration — cross-hive coordination, unified dashboard, lifecycle management

### Team Roster (6 agents)

| # | Name | Role | Owns |
|---|------|------|------|
| 1 | `router` | `manager` | Monitors all hive channels, routes cross-hive findings |
| 2 | `status` | `devops` | Unified dashboard: active hives, agent counts, tasks, budget |
| 3 | `bridge` | `developer` | Cross-hive data transfer, formats findings as Hive Mind entries |
| 4 | `scheduler` | `developer` | Periodic tasks across hives ("run sentinel scan every Monday") |
| 5 | `budget` | `developer` | API spend tracking, threshold alerts, scale-down recommendations |
| 6 | `ops` | `devops` | Hive lifecycle: start/stop/restart instances, hung agent detection |

### Prerequisite

Requires Hive to support reading from multiple Discord channels — currently one channel per instance. This is a feature gap.

### Config

```json
{
  "projects": {
    "nexus": {
      "repo": "~/nexus",
      "channel": "CHANNEL_ID",
      "agents": "router,status,bridge,scheduler,budget,ops",
      "roles": "router:manager,status:devops,bridge:developer,scheduler:developer,budget:developer,ops:devops"
    }
  }
}
```

---

## 12. Prioritization

### Rollout Order

| Priority | Hive | Agents | New Roles Needed | Rationale |
|----------|------|--------|------------------|-----------|
| **P0** | `hive` | 13 | `tech-writer` | Meta — building the tool makes everything else possible. Active development. |
| **P0** | `campfire` | 10 | `tech-writer` | 9-package monorepo is the canonical Hive use case. Zero new domain roles. |
| **P1** | `vcb` | 12 | 4 domain roles | Greenfield + TDD-first = perfect for parallel agents. Needs domain profiles. |
| **P1** | `review` | 8 | `api-designer`, `performance-engineer` | Every project benefits. Immediate quality uplift across portfolio. |
| **P2** | `obsidian` | 8 | `knowledge-curator`, `research-analyst` | Daily personal productivity. Needs vault integration validation. |
| **P2** | `homelab` | 8 | `home-auto-engineer` | Reduces ops toil. Needs infra-as-code repo setup. |
| **P3** | `sentinel` | 8 | `dependency-manager`, `release-engineer` | Portfolio hygiene. Needs multi-repo scanning capability. |
| **P3** | `chronicle` | 8 | `content-creator`, `knowledge-curator` | Documentation debt is real but not urgent. |
| **P3** | `scholar` | 8 | `research-analyst`, `knowledge-curator` | Nice to have, not blocking. |
| **P4** | `nexus` | 6 | None | Only needed when running 4+ hives. Needs cross-channel architecture. |

### New Role Implementation Order

```
Batch 1 (needed for P0):  tech-writer
Batch 2 (needed for P1):  api-designer, performance-engineer, forge-modder, audio-engineer, vr-specialist, ml-engineer
Batch 3 (needed for P2):  knowledge-curator, research-analyst, home-auto-engineer
Batch 4 (needed for P3):  dependency-manager, release-engineer, content-creator
Batch 5 (on demand):      protocol-designer, prompt-engineer, ux-designer, infra-monitor
```

### Total Agent Count Across All Hives

| Hive | Agents |
|------|--------|
| hive | 13 |
| campfire | 10 |
| vcb | 12 |
| review | 8 |
| obsidian | 8 |
| homelab | 8 |
| sentinel | 8 |
| chronicle | 8 |
| scholar | 8 |
| nexus | 6 |
| **Total** | **89** |

Obviously not all running simultaneously — but the full ecosystem supports 89 specialized agent slots across 10 hive instances.

---

## 13. Open Questions

| Question | Impact | How to Validate |
|----------|--------|-----------------|
| Can agents write to an Obsidian vault via git worktree? | Blocks `obsidian` | Point hive repo at vault directory, test |
| Can a hive scan repos outside its own worktree? | Blocks `sentinel` | Test agent reading sibling directories |
| Does Hive support non-code repos (pure config/docs)? | Blocks `homelab`, `chronicle` | Run hive on a repo with no package.json |
| What is the budget ceiling for 4+ simultaneous hives? | Blocks `nexus` viability | Track costs for 1 week with 2 hives |
| Can Hive Mind entries be shared across instances? | Blocks `nexus` | Architecture decision needed |
| Should non-code roles skip branch/commit discipline? | Affects `obsidian`, `homelab` | Decide and update worker-system-prompt.md |
| Should the manager profile include a role catalog? | Affects all hives | Add role descriptions to manager prompt or agents.json |
| Can roles be composable (multi-role per agent)? | Reduces total roles needed | Currently single-role; would need code change |
