# MIZI Code — Platform Wiki

MIZI Code is a GPU cloud coding platform that provisions AI-powered development environments on demand. Users get a fully agentic workspace: a remote machine running a coding UI, VS Code, model inference, memory, coordination, and a skill overlay system — all accessible from the browser.

---

## Table of Contents

1. [Architecture overview](#1-architecture-overview)
2. [Session types](#2-session-types)
3. [GPU profiles](#3-gpu-profiles)
4. [The agentic stack](#4-the-agentic-stack)
5. [Smart Skills](#5-smart-skills)
6. [Session Memory](#6-session-memory)
7. [Team sessions & lane coordination](#7-team-sessions--lane-coordination)
8. [Orchestration API](#8-orchestration-api)
9. [Swarm system](#9-swarm-system)
10. [Ambient mode & Safety](#10-ambient-mode--safety)
11. [Repo intelligence](#11-repo-intelligence)
12. [Design intelligence](#12-design-intelligence)
13. [NIM catalog & hosted inference](#13-nim-catalog--hosted-inference)
14. [Test environment provisioning](#14-test-environment-provisioning)
15. [API key authentication](#15-api-key-authentication)
16. [Dashboard pages](#16-dashboard-pages)
17. [Environment variables & secrets](#17-environment-variables--secrets)
18. [Database schema reference](#18-database-schema-reference)
19. [API reference](#19-api-reference)

---

## 1. Architecture overview

```
Browser (dashboard)
       │
       ▼
  Express API server  ──►  PostgreSQL (Drizzle ORM)
       │                    SQLite FTS5 (memory)
       ├──► Vast.ai API  ──►  GPU Machine (Docker container)
       │                        ├── llama.cpp / vLLM  :8081
       │                        ├── Bolt.diy           :5173
       │                        ├── code-server        :8080
       │                        ├── nginx preview      :3000
       │                        ├── claw-runner        (agent process)
       │                        └── claw-bridge        (WS bridge)
       │
       └──► Fly.io Machines API  ──►  Fly Machine (NIM sessions)
                                        ├── code-server        :8080
                                        ├── litellm proxy      :5180
                                        ├── claw-runner        (agent process)
                                        └── claw-bridge        (WS bridge)
```

The monorepo is a pnpm workspace with TypeScript throughout:

| Package | Description |
|---|---|
| `artifacts/api-server` | Express 5 API server |
| `artifacts/dashboard` | React + Vite frontend |
| `lib/db` | Drizzle ORM schema + DB connection |
| `lib/api-spec` | OpenAPI 3.1 spec |
| `lib/api-client-react` | Generated React Query hooks |
| `lib/api-zod` | Generated Zod schemas |

---

## 2. Session types

MIZI supports two session types, chosen at launch time based on whether a NIM model is selected.

### GPU sessions (Vast.ai)

The default. A GPU instance is rented from the Vast.ai marketplace, the Docker container is started, and a local model (Kimi K2.6 GGUF) is loaded into VRAM. GPU sessions support:

- Full offline inference (model runs on the rented GPU)
- All four GPU tiers (Starter → Ultra)
- Swarm worker agents that can use the local vLLM server

**Lifecycle**: `pending → provisioning → downloading → starting → ready → stopped`

The `downloading` phase means the GGUF weights are being pulled; `starting` means the LLM server is loading the model. Total boot time: ~20–35 minutes on first launch.

### NIM sessions (Fly.io)

When a NIM model is selected, no GPU is rented. Instead, a lightweight Fly.io Machine (shared-CPU-1x) is provisioned to host the workspace tooling (code-server, claw-runner, claw-bridge, litellm proxy). Inference calls go to a hosted NIM API endpoint. This gives:

- Fast boot: ~2 minutes (no model download)
- Fixed estimated cost: ~$0.08/hr (Fly Machine only)
- Access to the full agentic stack without renting a GPU
- Supported providers: NVIDIA NIM, OpenAI-compatible endpoints

**Fly TCP services exposed**: 22 (SSH), 3000, 5180, 5181, 8080, 8081.

---

## 3. GPU profiles

Four built-in tiers for GPU sessions. The right tier depends on model size and team size.

| Profile | GPU | Count | VRAM | Model quant | Est. cost/hr |
|---|---|---|---|---|---|
| **Starter** | RTX 4090 | 1 | 24 GB | UD-TQ1_0 | $0.13–$0.20 |
| **Standard** | RTX 4090 | 4 | 96 GB | UD-TQ1_0 | $0.50–$0.80 |
| **Pro** | A100 80 GB | 4 | 320 GB | Q3_K_M | $2.00–$4.00 |
| **Ultra** | H100 80 GB | 8 | 640 GB | IQ4_XS | $8.00–$16.00 |

Profiles control: Docker image tag, GPU search params, llama.cpp context size, batch size, number of GPUs, swarm worker cap, and startup time estimate.

---

## 4. The agentic stack

Every MIZI session (GPU or NIM) runs the same agentic stack:

### claw-runner

The primary agent process. Receives tasks via the prompt bridge, executes tools (file read/write, shell, browser), and writes observations to the memory system. It reads its skill bundle from the `ACTIVE_BUNDLE_B64` env var on startup.

### claw-bridge (`docker/claw-bridge.mjs`)

A lightweight Node.js process that connects outbound to the API server via WebSocket (`/api/bridge/:sessionId/:laneId`). It spawns `claw prompt` for each incoming task, streams back frames, and reconnects with exponential backoff.

### litellm proxy (NIM sessions)

Routes inference calls from claw-runner to the configured NIM API endpoint, normalizing the OpenAI-compatible wire format.

### llama.cpp / vLLM (GPU sessions)

Runs on port 8081, serving the GGUF model. vLLM is used for high-throughput GPU profiles; llama.cpp for Starter.

### code-server

VS Code in the browser, running on port 8080. Accessible via the session detail page.

### nginx preview proxy

Port 3000. Proxies app preview traffic so users can see their running apps without port forwarding.

---

## 5. Smart Skills

Skills are versioned instruction overlays injected into the agent's system prompt at session start. They guide the agent's behavior for specific task types, repositories, or workflows.

### How skills work

1. Skills are imported from GitHub repos (YAML/JSON manifests).
2. They are reviewed and assigned a trust tier.
3. At session launch, the API server compiles a bundle: selects relevant skills based on task mode, token mode, repo fingerprint, and model family, then base64-encodes the payload into `ACTIVE_BUNDLE_B64`.
4. claw-runner reads this env var on boot and injects the skills into its context.

### Trust tiers

| Tier | Description |
|---|---|
| `mizi_native` | Built-in, always trusted |
| `reviewed` | Human-reviewed and approved |
| `user_approved` | Approved by the workspace operator |
| `experimental` | Imported but not yet reviewed |

### Install risk levels

| Level | What it means |
|---|---|
| `virtual` | Prompt-only, no filesystem side effects |
| `config` | Writes config files |
| `hooked` | Installs git hooks or similar |
| `binary` | Installs binaries |
| `networked` | Makes network calls |

### Default bundles

Four bundles are seeded at server startup:

- **baseline** — minimal set for general tasks
- **fullstack** — backend + frontend skills
- **team** — coordination and handoff-aware skills
- **research** — analysis and documentation skills

### Skill evals

Skills are evaluated asynchronously via the eval scheduler. Each eval run produces variants (baseline vs treatment) and computes lift scores. Results feed the skill leaderboard (`GET /api/skills/leaderboard`) and per-skill performance stats.

---

## 6. Session memory

Every session has access to a SQLite FTS5 memory store (no external deps). Memory is scoped per `userId` and persists across sessions.

### What gets stored

- **Observations**: tool call inputs and outputs (what the agent did and what it got back)
- **Summaries**: end-of-session narrative summaries written by the agent

### How it works

At the start of each session, claw-runner calls `GET /api/mem/context/:userId` to retrieve relevant past observations via full-text search. This context string is injected into the system prompt so the agent remembers past work.

### Memory API (selected)

| Endpoint | Description |
|---|---|
| `POST /api/mem/observation` | Record a tool observation |
| `POST /api/mem/summarize` | Store a session summary |
| `GET /api/mem/context/:userId` | Fetch injected context string |
| `GET /api/sessions/:id/memory/search?q=` | Per-session FTS search |

Memory is auth-gated by `MIZI_MEM_TOKEN` in production (open in development).

---

## 7. Team sessions & lane coordination

Team sessions allow multiple agents (or humans) to collaborate in the same session, each working in an isolated **lane** with its own skill overlay, file ownership claims, and task state.

### Lanes

A lane is a per-member workspace slot. Each lane has:

- **Type**: `ux`, `debug`, `backend`, `review`, `general` — or any custom type registered in `custom_lane_types`
- **Policy**: controls max concurrent file claims, heavy-job slots, blast-radius file limit, claim TTL, allowed claim types, and memory scopes
- **Overlay bundle**: a skill bundle compiled specifically for this lane's role
- **Bridge connection**: the claw-bridge process connects per-lane

### Custom lane types

Operators can register custom lane types beyond the five built-ins via `POST /api/sessions/:id/lanes/types`. Each custom type defines its own policy overrides (claim TTL, blast-radius limit, allowed claim types) and is stored in `custom_lane_types`. The system resolves the effective policy for any lane — built-in or custom — via `getLanePolicyAsync()`.

### File claims (soft ownership)

Agents claim files, modules, symbols, or task IDs before editing them. Claims are soft (advisory) and TTL-expiring. The coordination API detects overlapping claims and reports them as conflicts.

| Claim type | What it covers |
|---|---|
| `file` | A single file path |
| `module` | A directory or module boundary |
| `symbol` | A function, class, or export |
| `task` | An abstract task ID |

Claims refresh via heartbeat (`DELETE /claim/:id?heartbeat=true`) and expire automatically after the lane's configured TTL.

**Conflict detection** — upgraded to symbol-level precision. When both competing claims carry a `symbols` list, the system only reports a conflict when the symbol sets actually intersect. Same-file edits to different functions or classes no longer produce false-positive conflicts.

### Handoffs

Lanes signal state transitions to each other:

| Signal | Meaning |
|---|---|
| `task_complete` | Lane finished its subtask |
| `blocking` | Lane is blocked, needs input from another lane |
| `file_ready` | Lane finished editing a file another lane depends on |
| `review_ready` | Lane requests a review pass |
| `safe_to_merge` | Lane's work is ready; triggers automatic draft PR creation |
| `info` | General notification |

#### Auto-draft PR on `safe_to_merge`

When a lane sends a `safe_to_merge` handoff and the session has a `repoUrl` plus a GitHub OAuth token, the API server automatically calls the GitHub REST API to open a draft pull request. The PR's head branch is `mizi/session-{id}/{lane-slug}` (the per-member sub-branch that claw-bridge pushes to), and the base is the session's repo default branch. The resulting PR URL is stored on the `lane_handoffs` row as `pr_url` and surfaced in the Team tab as a "View draft PR" link.

#### Per-member git sub-branches

When a session has a GitHub token, `enableLaneBranches` defaults to `true`. Each lane's claw-bridge is configured to push to `mizi/session-{id}/{member-slug}` rather than the shared `mizi/session-{id}` branch. The env var `GITHUB_LANE_BRANCHES_ENABLED=1` is injected into the container so in-session tools can detect this mode.

### Lane event timeline

Every significant lane lifecycle event is recorded to the `lane_events` table and broadcast over SSE:

| Event type | Emitted when |
|---|---|
| `lane_created` | Lane registered |
| `lane_destroyed` | Lane deleted |
| `claim_created` | File/symbol claim opened |
| `claim_released` | Claim explicitly released |
| `claim_expired` | Claim expired via TTL sweep |
| `handoff_sent` | Handoff signal dispatched |
| `handoff_acknowledged` | Target lane acknowledged a handoff |
| `heavy_job_started` | GPU-expensive job began |
| `heavy_job_completed` | GPU-expensive job finished |

The dashboard Team tab has a **Timeline** sub-tab (`GET /sessions/:id/lanes/:laneId/timeline`) showing a cursor-paginated, newest-first list of events. Events stream in real time via SSE while the panel is open. Deleted lanes' history remains queryable.

### Heavy-job scheduler

GPU-expensive jobs (indexing, embedding, eval) are queued in a weighted fair scheduler. Score = `priority + ageWeight + laneFairnessWeight + jobClassFloor`.

Job class floors: `indexing` +0.5, `embedding` +0.3, `eval` +0.2.

---

## 8. Orchestration API

For automated multi-agent workflows, the orchestration API provisions a fully-configured team session in a single call.

### `POST /sessions/orchestrate`

Accepts a declarative team composition and provisions everything atomically:

1. GPU offer selection
2. Session row creation with `taskMode: team`
3. Per-member skill bundle upsert (from `teamMembers[].skills`)
4. Vast.ai instance creation
5. Lane compilation (`compileLaneBundles`) + lane row creation
6. Pre-registered file claims (`teamMembers[].claimPaths`)

Returns `202` immediately with the session ID. Callers then poll:

### `GET /sessions/:id/orchestration-status`

Returns:
- `status` / `bootPhase` / `bootMessage`
- `vastInstanceId`
- `allLanesConnected` — true only when every lane's bridge is connected
- Per-lane: `bridgeStatus`, `overlayBundleId`, `ideUrl`

**Auth required**: `sessions:write` scope.

**Idempotency**: duplicate calls with the same (goal + profileId + member roles) within 5 minutes return the existing session instead of creating a new one.

---

## 9. Swarm system

Swarm allows the primary agent to spawn sub-agents (workers) that tackle subtasks in parallel within the same session. Workers connect to the same lane coordination layer and share the session's memory.

The dashboard shows live swarm activity via SSE:
- `GET /api/sessions/:id/swarm-stream` — real-time swarm status
- `GET /api/sessions/swarm-status-batch?ids=` — batch swarm status for the sessions list

Swarm worker cap is set per GPU profile (`swarmWorkerCap`) and enforced server-side.

---

## 10. Ambient mode & Safety

Ambient mode is an always-on background agent that runs automated maintenance cycles (memory gardening, stale item sweeps, digest generation) outside of active sessions.

### How it works

- The ambient runner ticks every 15 seconds, checking which accounts have an elapsed `next_wake_at`.
- Per-account lock ensures only one process runs a cycle at a time (safe for multi-process deployments).
- Each cycle: **scout** → **garden** → **work**, with checkpoint calls between phases.
- Wake schedule is persisted to SQLite so restarts don't cause cycle drift.

### Safety subsystem

All ambient actions that could have side effects go through the safety subsystem before executing:

1. Agent calls `requestPermission(action, context)`.
2. Policy bundle (`local-only`, `team-coord`, `external-comm`) decides: `auto-approve`, `auto-deny`, or `require-human`.
3. If human review is needed, an approval request appears in the dashboard notification bell.
4. The operator approves or denies inline.

### Default policy bundles

| Bundle | Gates |
|---|---|
| `local-only` | External network calls, irreversible actions |
| `team-coord` | Cross-lane writes, handoff signals |
| `external-comm` | Email, webhooks, external API calls |

### Dashboard

`/ambient` page: kill switch, enable toggle, feature flag, budget progress bars (token / wall-clock / GPU-minute), pending approvals with approve/deny, activity timeline, policy editor.

---

## 11. Repo intelligence

Sessions can index their repository for context-aware skill ranking and conflict detection.

### Indexing pipeline

1. `POST /api/sessions/:id/repo/index` — enqueues an indexing job
2. The job runs: graph analysis → FTS indexing → vector embedding → summarization
3. Status tracked in `repo_graph_jobs` table

### What indexing enables

- **Repo fingerprint**: identifies the repo kind (frontend, backend, full-stack, etc.) and model family affinity — used to filter skills at bundle compilation time
- **Blast-radius analysis**: given a proposed file edit, returns the set of files most likely to be affected (used by the conflict detection system)
- **Symbol search**: `GET /api/sessions/:id/repo/symbol/:name` — find definitions and references across the codebase
- **FTS search**: `GET /api/sessions/:id/repo/search?q=` — full-text search across indexed files

---

## 12. Design intelligence

A curated library of design examples, patterns, and visual references that inform the agent's UI decisions.

- Seeded at server startup from a versioned source (SHA-pinned), re-synced every 6 hours.
- Bookmarkable entries for operator-curated collections.
- Powers the **Palette Intent** feature: `POST /api/palette-intent/generate` interprets a natural-language design intent and returns a structured palette, typography, and spacing spec that claw-runner can use when scaffolding UI.

---

## 13. NIM catalog & hosted inference

The NIM catalog lists available hosted inference models across configured providers.

### Providers

| Provider | Display name | Env key |
|---|---|---|
| `nvidia` | NVIDIA NIM | `NVIDIA_NIM_API_KEY` |
| `vultr` | Vultr Inference | `VULTR_INFERENCE_API_KEY` |
| `together` | Together AI | `TOGETHER_API_KEY` |
| `deepinfra` | DeepInfra | `DEEPINFRA_API_KEY` |

### Catalog API

| Endpoint | Description |
|---|---|
| `GET /api/nim/catalog` | List available models (filterable by `nimType`) |
| `GET /api/nim/providers` | List configured provider status |
| `GET /api/nim/health` | Live health check for all configured providers |
| `POST /api/nim/catalog/sync` | Force re-sync of the catalog |

The catalog is auto-synced at server startup and upserts model records into the `nim_catalog` table.

### Intent-driven model selection ("More models…")

The Home screen's intent classification card suggests a single best NIM model for the user's input. A **"More models…"** plaintext link expands an inline scrollable list of all catalog models directly inside the card. Clicking any row switches the active suggestion in place (name, provider label, `nimModelId`, estimated start time all update) and collapses the list without opening a dialog. The NIM catalog is fetched once at page load and passed down as a prop — no extra API call per classification.

---

## 14. Test environment provisioning

Agents running inside a session can request ephemeral Postgres databases (and Redis instances) on demand — no manual setup required. The API server provisions, tracks, and tears down these resources automatically when the session stops.

### How it works

1. The claw-runner calls `provision_test_db` (a registered claw tool) or `POST /api/sessions/:id/provision` directly.
2. The server selects a provisioning strategy:
   - **Ephemeral local Postgres** — runs `initdb` + `pg_ctl` via the claw-bridge to create a temporary cluster on the instance at `25432 + (sessionId % 10000)`. Connection string uses a Unix socket (`?host=/tmp`). `resourceId` stored as `local:<pgDir>:<pgPort>`.
   - **Neon branch** — creates a branch off a shared Neon project (when `NEON_API_KEY` is set). `resourceId` is the branch ID.
3. The resource is recorded in `provisioned_resources` with its encrypted connection string.
4. A `schema_templates` DDL can be applied at creation time by passing `templateId` in the request body.
5. When the session is destroyed, all resources are cleaned up: ephemeral Postgres clusters are stopped with `pg_ctl stop -m fast` and the data directory removed; Neon branches are deleted via the Neon API.

### Schema templates

Built-in SQL templates (`GET /api/schema-templates`) give the agent a starting schema without hand-writing DDL:

| Slug | Description |
|---|---|
| `standard-web-app` | `users`, `sessions`, `events` tables with indexes |
| *(more seeded at startup)* | |

### Security model

- `GET /sessions/:id/resources` — optional bearer; ownership enforced when a raw bearer is present
- `POST /sessions/:id/provision` — optional bearer; ownership enforced when a raw bearer is present
- `GET /sessions/:id/resources/:resourceId/connection-string` — **strict bearer required** (connection strings contain credentials)
- `GET /schema-templates` and `GET /schema-templates/:id` — open (DDL templates are non-sensitive)

---

## 15. API key authentication

Remote orchestration agents (claw-runner, external tools) authenticate via scoped API keys rather than the shared `MIZI_MEM_TOKEN` secret.

### Key properties

- **Scopes**: `sessions:write`, `coordination:read`, etc.
- **Storage**: SHA-256 hash stored in `api_keys` table — the plaintext is shown once on creation
- **Expiry**: optional, enforced on every request
- **Last-used tracking**: `last_used_at` updated asynchronously

### Key management

| Endpoint | Description |
|---|---|
| `POST /api/auth/keys` | Create a key — returns plaintext once |
| `GET /api/auth/keys` | List active (non-revoked) keys |
| `DELETE /api/auth/keys/:id` | Revoke a key |

### Dev mode bypass

When `MIZI_MEM_TOKEN` is not set (local development), agent auth is open. In production all protected routes require a valid bearer token.

### Protected routes

- `POST /api/sessions` — requires `sessions:write`
- `POST /api/sessions/orchestrate` — requires `sessions:write`
- `GET /api/sessions/:id/orchestration-status` — requires `sessions:write`
- `GET|POST|PUT /api/sessions/:id/lanes` — requires `coordination:read`

---

## 16. Dashboard pages

| Route | Page |
|---|---|
| `/` | Main dashboard (active session, quick launch, stats) |
| `/sessions` | Sessions list with status/hardware/cost table, filters, swarm pills |
| `/sessions/:id` | Session detail — Cockpit, Memory, Repo, Team, Swarm, Coordination tabs |
| `/skills` | Skills library — import, review, leaderboard |
| `/templates` | Vast.ai templates management |
| `/memory` | Global memory view — search across all sessions |
| `/ambient` | Ambient mode control panel |
| `/design-intelligence` | Design library and bookmarks |
| `/api-keys` | API key management |
| `/settings` | Platform settings |

### Session detail tabs

- **Cockpit**: live terminal output, soft-interrupt chat panel, boot timeline, GPU hardware info, relaunch button
- **Memory**: per-session observation log and summary, FTS search
- **Repo**: indexing status, blast-radius explorer, symbol search, FTS
- **Team**: lane status, claims, handoff signals, conflict report; **Overview** sub-tab shows current state, **Timeline** sub-tab shows paginated event history with live SSE append; draft PR links on `safe_to_merge` handoffs
- **Swarm**: live swarm activity, worker status, task breakdown
- **Coordination**: full coordination state — lanes, claims, heavy-job queue

---

## 17. Environment variables & secrets

| Variable | Required | Description |
|---|---|---|
| `VASTAI_API_KEY` | GPU sessions | Vast.ai API key for instance management |
| `DATABASE_URL` | Always | PostgreSQL connection string |
| `NVIDIA_NIM_API_KEY` | NIM sessions | NVIDIA NIM API key |
| `FLY_API_TOKEN` | NIM sessions | Fly.io personal access token |
| `FLY_APP_NAME` | NIM sessions | Fly.io app name to provision machines into |
| `MIZI_MEM_TOKEN` | Production | Bearer token for memory + ambient endpoints |
| `MIZI_MEM_USER_ID` | Optional | Override default memory user ID (default: `operator`) |
| `MEM_DATA_DIR` | Optional | SQLite storage path (default: `~/mizi-memory`) |
| `VULTR_INFERENCE_API_KEY` | Optional | Vultr Inference provider key for NIM sessions |
| `TOGETHER_API_KEY` | Optional | Together AI provider key for NIM sessions |
| `DEEPINFRA_API_KEY` | Optional | DeepInfra provider key for NIM sessions |
| `NEON_API_KEY` | Optional | Neon API key for cloud Postgres branch provisioning (test env) |
| `NEON_PROJECT_ID` | Optional | Neon project to branch from for test DB provisioning |
| `ADMIN_SWEEP_TOKEN` | Optional | Secret for `X-Admin-Token` header on admin endpoints |
| `PORT` | Auto | HTTP port (assigned by Replit) |

---

## 18. Database schema reference

| Table | Purpose |
|---|---|
| `gpu_profiles` | GPU tier definitions — search params, model quant, llama.cpp settings |
| `sessions` | Session records — status, URLs, cost, vastInstanceId, flyMachineId |
| `templates` | Vast.ai Docker template records |
| `api_keys` | Scoped M2M keys (SHA-256 hash stored) |
| `nim_catalog` | Available NIM hosted models |
| `skill_sources` | Imported GitHub repos |
| `skills` | Individual skills with trust/risk metadata |
| `skill_versions` | Versioned manifest snapshots |
| `skill_bundles` | Named skill sets |
| `session_skills` | Skills activated per session |
| `skill_feedback` | Helpful/unhelpful ratings per skill per session |
| `session_lanes` | Per-member lane overlays |
| `lane_claims` | Soft file/symbol ownership claims with TTL |
| `lane_handoffs` | Cross-lane handoff signals (includes `pr_url` for auto-opened draft PRs) |
| `lane_heavy_jobs` | GPU-expensive job queue |
| `custom_lane_types` | Operator-defined lane types extending the five built-ins |
| `lane_events` | Timestamped audit log of lane lifecycle events; backs the Timeline tab |
| `provisioned_resources` | Test Postgres/Redis resources created on demand per session |
| `schema_templates` | SQL DDL templates applied when provisioning a test database |
| `eval_runs` | Async skill eval run queue |
| `eval_run_variants` | Per-variant metrics within an eval run |
| `skill_evals` | Aggregated per-skill performance |
| `bundle_evals` | Aggregated per-bundle performance |
| `repo_graph_jobs` | Repo indexing job tracking |
| `palette_intents` | Saved palette/design intent specs |
| `design_intelligence_entries` | Curated design library |

Migrations live in `lib/db/migrations/`. Use `pnpm --filter @workspace/db run push` to apply schema changes in development (the `generate` command is blocked by a missing legacy snapshot).

---

## 19. API reference

### Sessions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions` | List all sessions |
| `POST` | `/api/sessions` | Create a session (GPU or NIM) |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Destroy session and underlying machine |
| `GET` | `/api/sessions/active` | Get the current active session |
| `POST` | `/api/sessions/:id/refresh` | Poll Vast.ai / Fly.io for status update |
| `POST` | `/api/sessions/orchestrate` | Single-call team provisioning |
| `GET` | `/api/sessions/:id/orchestration-status` | Poll team session boot progress |

### Profiles & offers

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/profiles` | List GPU profiles |
| `GET` | `/api/profiles/:id` | Get profile details |
| `GET` | `/api/offers` | Search Vast.ai GPU marketplace |

### Skills

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/skills` | List all skills |
| `POST` | `/api/skills/import` | Import from GitHub repo |
| `PUT` | `/api/skills/:id/review` | Approve / reject / disable |
| `GET` | `/api/skills/leaderboard` | Ranked skill performance |
| `POST` | `/api/skills/evals/run` | Schedule an eval run |
| `GET` | `/api/skills/evals/runs` | List eval runs |
| `GET` | `/api/skill-bundles` | List bundles |
| `POST` | `/api/skill-bundles` | Create a bundle |
| `POST` | `/api/skill-bundles/:id/activate` | Mark as active for next launch |

### Coordination

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions/:id/lanes` | List lanes |
| `POST` | `/api/sessions/:id/lanes` | Create a lane |
| `DELETE` | `/api/sessions/:id/lanes/:laneId` | Destroy a lane (events retained) |
| `POST` | `/api/sessions/:id/lanes/:laneId/claim` | Claim a file/symbol |
| `POST` | `/api/sessions/:id/lanes/:laneId/handoff` | Send a handoff signal |
| `GET` | `/api/sessions/:id/lanes/:laneId/timeline` | Paginated lane event history (newest first) |
| `GET` | `/api/sessions/:id/coordination` | Full coordination state |
| `GET` | `/api/sessions/:id/coordination/stream` | SSE stream of coordination updates |
| `GET` | `/api/sessions/:id/conflicts` | Conflict detection report |
| `POST` | `/api/sessions/:id/heavy-jobs` | Enqueue a GPU-expensive job |
| `GET` | `/api/sessions/:id/lanes/types` | List custom lane types for the session |
| `POST` | `/api/sessions/:id/lanes/types` | Register a custom lane type |

### Memory

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/mem/observation` | Record a tool observation |
| `POST` | `/api/mem/summarize` | Store a session summary |
| `GET` | `/api/mem/context/:userId` | Get injected context string |
| `GET` | `/api/sessions/:id/memory/search?q=` | Per-session FTS search |

### Bridge (claw-runner relay)

| Method | Path | Description |
|---|---|---|
| `WS` | `/api/bridge/:sessionId/:laneId` | claw-bridge outbound connection |
| `GET` | `/api/sessions/:id/lanes/:laneId/bridge/status` | Readiness check |
| `POST` | `/api/sessions/:id/lanes/:laneId/exec` | Send a prompt, receive SSE frames |

### Ambient & Safety

| Method | Path | Description |
|---|---|---|
| `GET/PUT` | `/api/ambient/config` | Get/set ambient configuration |
| `POST` | `/api/ambient/cycle` | Trigger a manual cycle |
| `POST` | `/api/ambient/kill` | Abort active cycle |
| `GET` | `/api/safety/pending` | List pending approval requests |
| `POST` | `/api/safety/actions/:id/approve` | Approve a safety action |
| `POST` | `/api/safety/actions/:id/deny` | Deny a safety action |

### Test environment provisioning

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/sessions/:id/provision` | Provision an ephemeral Postgres or Redis resource |
| `GET` | `/api/sessions/:id/resources` | List provisioned resources (connection strings masked) |
| `GET` | `/api/sessions/:id/resources/:resourceId/connection-string` | Reveal full connection string (strict auth required) |
| `GET` | `/api/schema-templates` | List SQL schema templates |
| `GET` | `/api/schema-templates/:id` | Get a schema template's DDL |

### NIM

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/nim/catalog` | List hosted models |
| `GET` | `/api/nim/providers` | Provider configuration status |
| `GET` | `/api/nim/health` | Live provider health check |

### Auth (API keys)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/keys` | Create an API key |
| `GET` | `/api/auth/keys` | List active keys |
| `DELETE` | `/api/auth/keys/:id` | Revoke a key |
