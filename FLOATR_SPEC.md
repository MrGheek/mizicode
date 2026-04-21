# FLOATR — Product Specification

> GPU-powered cloud coding platform. Spin up a private AI coding environment on rented GPUs in minutes — open-source model running locally on your instance, full VS Code in the browser, no API costs.

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Architecture](#2-architecture)
3. [Monorepo Structure](#3-monorepo-structure)
4. [Database Schema](#4-database-schema)
5. [GPU Profiles & Models](#5-gpu-profiles--models)
6. [Session Lifecycle](#6-session-lifecycle)
7. [What Runs on the Instance](#7-what-runs-on-the-instance)
8. [Team Sessions](#8-team-sessions)
9. [Memory Persistence System](#9-memory-persistence-system)
10. [Scheduler](#10-scheduler)
11. [API Reference](#11-api-reference)
12. [Dashboard UI Pages](#12-dashboard-ui-pages)
13. [Environment Variables](#13-environment-variables)
14. [Vast.ai Integration](#14-vastai-integration)
15. [Docker Image](#15-docker-image)
16. [Boot Script (onstart.sh)](#16-boot-script-onstartsh)

---

## 1. Product Overview

FLOATR lets you rent raw GPU compute from [Vast.ai](https://vast.ai), boot a pre-configured AI coding environment on it, and access everything through a hosted dashboard — without managing servers, Kubernetes, or cloud accounts yourself.

Each **session** is a rented GPU machine running:
- A frontier open-source LLM (Kimi K2.5, Qwen3-Coder, DeepSeek V3.2, etc.)
- **vLLM** for high-throughput GPU inference
- **litellm proxy** for Anthropic-compatible API (so claw-code CLI works out of the box)
- **code-server** — VS Code in the browser with the LLM wired in
- **Bolt.diy** — React app generator that talks to the local LLM
- **nginx** — routes traffic, handles basic auth, provides preview proxy
- **SSH** — key-based access for terminal use or port forwarding

The hosted dashboard (this app) handles instance provisioning, status tracking, cost tracking, memory persistence, and scheduled auto-launch/stop.

### Key properties

- **No shared API** — the LLM runs entirely on your rented GPU. Zero per-token cost beyond the GPU hourly rate.
- **Ephemeral by default** — sessions are destroyed when you stop them; `/workspace` is local to the machine.
- **Persistent memory** — the dashboard maintains a SQLite FTS5 memory store that records what the AI agent did across sessions, injectable into future sessions as context.
- **Team-capable** — one session can host multiple isolated IDEs for team members + a shared workspace, all proxied through nginx with per-user credentials.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    FLOATR Dashboard                          │
│               (React + Vite, hosted on Replit)               │
│                                                              │
│  Pages: Dashboard / Sessions / Cockpit / Templates / Memory  │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP (React Query)
┌────────────────────────▼────────────────────────────────────┐
│                    API Server                                │
│             (Express 5, hosted on Replit)                    │
│                                                              │
│  Routes: /sessions  /profiles  /scheduler  /memory  /offers  │
│  Services: vastai.ts  profiles.ts  scheduler.ts  memory.ts   │
│  DB: PostgreSQL + Drizzle ORM                                │
│  Memory: SQLite FTS5 (~/omniql-memory/mem.db)                │
└──────────┬──────────────────────────┬───────────────────────┘
           │ Vast.ai REST API          │ Status callbacks
           │                          │ (POST /sessions/:id/status)
┌──────────▼──────────────────────────▼───────────────────────┐
│                    Vast.ai GPU Instance                      │
│         (rented bare-metal, your Docker image)               │
│                                                              │
│  onstart.sh runs at boot:                                    │
│    Phase 1 (immediate): code-server · Bolt.diy · nginx · SSH │
│    Phase 2 (background): model download · vLLM · litellm     │
│                                                              │
│  Exposed ports (Vast.ai maps to random external ports):      │
│    8080 → code-server (or nginx team router)                 │
│    8081 → litellm proxy (OpenAI + Anthropic API)             │
│    5180 → Bolt.diy (through nginx auth)                      │
│    3000 → preview proxy (through nginx auth)                 │
│    5181 → Claw Runner                                        │
│    22   → SSH                                                │
└─────────────────────────────────────────────────────────────┘
```

### Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite 7, Tailwind CSS, shadcn/ui, Wouter, TanStack Query |
| API server | Express 5, Node.js 24, TypeScript 5.9 |
| Database | PostgreSQL (Drizzle ORM), SQLite FTS5 (memory) |
| Build | esbuild (API), Vite (frontend) |
| Validation | Zod v4, drizzle-zod |
| API contract | OpenAPI 3.1 → Orval codegen → React Query hooks + Zod schemas |
| Monorepo | pnpm workspaces |
| GPU compute | Vast.ai REST API |
| LLM inference | vLLM + litellm proxy |
| IDE | code-server (VS Code in browser) |
| Coding UI | Bolt.diy |
| Proxy | nginx (basic auth + path-based team routing) |

---

## 3. Monorepo Structure

```
floatr/
├── artifacts/
│   ├── api-server/               # Express API server
│   │   └── src/
│   │       ├── index.ts          # Entry point, port binding, profile seeding
│   │       ├── routes/
│   │       │   ├── sessions.ts   # Session CRUD, sync, status callback
│   │       │   ├── profiles.ts   # GPU profile listing
│   │       │   ├── templates.ts  # Vast.ai template management
│   │       │   ├── offers.ts     # Live GPU marketplace search
│   │       │   ├── scheduler.ts  # Scheduler config CRUD
│   │       │   ├── dashboard.ts  # Summary stats
│   │       │   └── memory.ts     # Memory proxy routes
│   │       └── services/
│   │           ├── vastai.ts     # Vast.ai API client
│   │           ├── profiles.ts   # Profile seeding & lookup
│   │           ├── scheduler.ts  # Auto-launch/stop logic (runs every 30s)
│   │           └── memory.ts     # SQLite FTS5 memory service
│   └── dashboard/
│       └── src/
│           ├── pages/
│           │   ├── dashboard.tsx         # Home — active session + stats
│           │   ├── sessions/
│           │   │   ├── index.tsx         # All sessions list
│           │   │   └── [id].tsx          # Session cockpit (boot log, links)
│           │   ├── templates.tsx         # Template management
│           │   └── memory.tsx            # Global memory search
│           └── components/
│               └── session-status-badge.tsx  # Status + team badges
├── docker/
│   ├── Dockerfile               # CUDA 12.4 runtime image
│   └── onstart.sh               # Parameterized startup script
├── lib/
│   ├── api-spec/openapi.yaml    # Single source of truth for API contract
│   ├── api-zod/                 # Generated Zod schemas (from openapi.yaml)
│   ├── api-client-react/        # Generated React Query hooks
│   └── db/src/schema/           # Drizzle table definitions
└── scripts/
    └── post-merge.sh            # Runs pnpm install + drizzle push after merges
```

---

## 4. Database Schema

### `gpu_profiles`
Defines what GPU tier to rent and which model to run. Seeded automatically at API server startup; any changes to `services/profiles.ts` are applied on next restart.

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | |
| `name` | text | Unique slug (e.g. `standard`, `qwen3-coder-pro`) |
| `displayName` | text | Human label shown in dashboard |
| `gpuName` | text | e.g. `RTX 4090`, `A100 80GB`, `H100 80GB`, `H200 141GB` |
| `numGpus` | integer | Number of GPUs to request |
| `totalVram` | integer | Total VRAM in GB |
| `dockerImageTag` | text | Docker image to boot on the instance |
| `modelRepo` | text | HuggingFace repo to download (e.g. `moonshotai/Kimi-K2.5`) |
| `defaultQuant` | text | Cache subdirectory name under `/workspace/models/` |
| `servedModelName` | text | `--served-model-name` alias for vLLM and litellm |
| `modelDisplayName` | text | Human label for the model |
| `quantSizeGb` | integer | Model weight size on disk |
| `diskSizeGb` | integer | Total disk to request from Vast.ai |
| `llamaCtxSize` | integer | `--max-model-len` for vLLM |
| `llamaBatchSize` | integer | `--max-num-seqs` for vLLM |
| `llamaExtraArgs` | text | Extra flags appended to vLLM start command |
| `searchParams` | jsonb | Passed to Vast.ai offer search (gpu_name, num_gpus, min_gpu_ram) |
| `estimatedCostMin/Max` | real | $/hr range shown in the profile picker |
| `estimatedSpeedMin/Max` | integer | tok/s range estimate |
| `startupTimeMin` | integer | Expected boot time in minutes |

### `sessions`
One row per instance launched. Status updates happen via Vast.ai sync (every 5s poll) and via instance callbacks.

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | |
| `profileId` | integer FK → gpu_profiles | |
| `vastInstanceId` | integer | Vast.ai contract/instance ID |
| `vastOfferId` | integer | Offer selected at launch |
| `templateHash` | text | Vast.ai template hash used |
| `status` | text | `pending` → `provisioning` → `downloading` → `starting` → `ready` → `stopped` / `error` |
| `statusMessage` | text | Human-readable current state (shown in boot log) |
| `boltDiyUrl` | text | Public URL for Bolt.diy |
| `codeServerUrl` | text | Public URL for code-server |
| `previewUrl` | text | Public URL for nginx preview proxy |
| `sshHost` | text | Public IP |
| `sshPort` | integer | Mapped SSH port |
| `publicIp` | text | Instance public IP |
| `costPerHour` | real | Actual $/hr from Vast.ai (`dph_total`) |
| `totalCost` | real | Running total spend in $ |
| `gpuName` | text | Denormalized GPU label |
| `numGpus` | integer | Denormalized GPU count |
| `teamMembers` | jsonb | `TeamMemberRecord[]` — `{name, password, path, ideUrl}` |
| `startedAt` | timestamp | When instance was provisioned |
| `stoppedAt` | timestamp | When session was destroyed |

### `templates`
Vast.ai Docker template records. The default template is auto-registered at startup.

| Column | Description |
|--------|-------------|
| `id` | serial PK |
| `templateHash` | Vast.ai hash ID |
| `name` | Display name |
| `dockerImage` | Image tag |
| `isDefault` | Boolean — scheduler uses the default template |

### `scheduler_config`
One row, updated via the dashboard Scheduler settings panel.

| Column | Description |
|--------|-------------|
| `id` | serial PK |
| `enabled` | Whether auto-launch is active |
| `launchTime` | HH:MM string in the configured timezone |
| `stopTime` | HH:MM for auto-stop (safety net) |
| `daysOfWeek` | Array of `"mon"` / `"tue"` / etc. |
| `timezone` | IANA timezone (e.g. `Europe/London`) |
| `profileId` | FK → gpu_profiles to launch |
| `safetyNetEnabled` | If true, stops any running session at `stopTime` |

---

## 5. GPU Profiles & Models

### Kimi K2.5 (moonshotai/Kimi-K2.5)
Mixture-of-experts, 2T total / 32B active parameters. Optimised for coding and agentic tasks.

| Profile | GPU | Count | VRAM | ctx | tok/s | $/hr est |
|---------|-----|-------|------|-----|-------|---------|
| Starter | RTX 4090 | 1 | 24 GB | 8 192 | 5–10 | $0.13–0.20 |
| Standard | RTX 4090 | 4 | 96 GB | 32 768 | 20–35 | $0.50–0.80 |
| Pro | A100 80GB | 4 | 320 GB | 65 536 | 40–65 | $2.00–4.00 |
| Ultra | H100 80GB | 8 | 640 GB | 131 072 | 80–130 | $8.00–16.00 |

### Qwen3-Coder-Next (Qwen/Qwen3-Coder-Next)
80B total / 3B active. Fast and cheap for coding tasks.

| Profile | GPU | Count | ctx | tok/s | $/hr est |
|---------|-----|-------|-----|-------|---------|
| Qwen3 Standard | A100 80GB | 4 | 65 536 | 55–90 | $2.00–4.00 |
| Qwen3 Pro | A100 80GB | 8 | 131 072 | 120–200 | $4.00–8.00 |

### MiniMax M2.5 (MiniMaxAI/MiniMax-M2.5)
229B total / 10B active.

| Profile | GPU | Count | ctx | tok/s | $/hr est |
|---------|-----|-------|-----|-------|---------|
| MiniMax Ultra | H100 80GB | 8 | 131 072 | 60–100 | $8.00–16.00 |

### GLM-5.1 FP8 (zai-org/GLM-5.1-FP8)
754B total / 40B active. Speculative decoding via MTP, FP8 KV cache.

| Profile | GPU | Count | ctx | tok/s | $/hr est |
|---------|-----|-------|-----|-------|---------|
| GLM-5.1 Ultra | H100 80GB | 8 | 32 768 | 25–45 | $8.00–16.00 |
| GLM-5.1 H200 | H200 141GB | 8 | 131 072 | 40–70 | $15.00–25.00 |

### DeepSeek V3.2 (deepseek-ai/DeepSeek-V3.2)
671B total, MIT license.

| Profile | GPU | Count | ctx | tok/s | $/hr est |
|---------|-----|-------|-----|-------|---------|
| DeepSeek V3.2 | H200 141GB | 8 | 131 072 | 45–75 | $15.00–25.00 |

---

## 6. Session Lifecycle

```
[User clicks Launch]
        │
        ▼
  status: pending
  (session row created in DB)
        │
  POST /bundles/ → Vast.ai
  Select cheapest matching offer
        │
        ▼
  status: provisioning
  (Vast.ai creates instance, boots Docker image)
        │
  Vast.ai actual_status: "loading" / "creating"
        │
        ▼ (Vast.ai: "running" → instance booted)
  onstart.sh Phase 1 starts
  ├── SSH server
  ├── code-server
  ├── Claw Runner
  ├── Bolt.diy
  └── nginx
        │
  Instance POSTs /api/sessions/:id/status  {status: "services_ready"}
        ▼
  status: starting
  statusMessage: "Tools ready — LLM model loading in background..."
        │
  onstart.sh Phase 2 starts (background subshell)
  ├── [if model not cached] huggingface-cli download
  │     └── Instance POSTs {status: "downloading"}
  │           ▼ status: downloading
  ├── vLLM server starts (internal port 8082)
  │     └── Instance POSTs {status: "starting_llm"}
  │           ▼ status: starting
  ├── litellm proxy starts (port 8081)
  └── waits for /health on vLLM
        │
  Instance POSTs /api/sessions/:id/status  {status: "llm_ready"}
        ▼
  status: ready
  statusMessage: "Session is ready — vLLM online"
        │
  [User uses IDE / Bolt.diy / claw-code CLI]
        │
  [User clicks Destroy or scheduler stops it]
        ▼
  vastai.destroyInstance(vastInstanceId)
  status: stopped
```

**Fallback for old/offline instances**: If the instance callback never arrives (e.g. instance was launched before callbacks were wired up), the sync checks `Vast.ai actual_status === "running"` + `status_msg` starts with `"success"` + instance has been running for >30 minutes → auto-marks as `ready`.

**Dashboard polling**: The cockpit page calls `GET /api/sessions/:id` every 5 seconds while the session is active. Each call triggers a Vast.ai API sync to fetch the latest `actual_status`, `dph_total`, and service URLs.

---

## 7. What Runs on the Instance

### Port layout (container-internal → Vast.ai maps to random external ports)

| Internal port | Service | Notes |
|---------------|---------|-------|
| 22 | SSH | Key-based auth only |
| 8080 | code-server OR nginx team router | Solo: code-server direct. Team: nginx routes / |
| 8081 | litellm proxy | OpenAI + Anthropic API. Used by claw-code and Bolt.diy |
| 8082 | vLLM (internal) | OpenAI format only, not exposed externally |
| 8090 | code-server owner (team) | Internal only, nginx proxies to / |
| 8093-8096 | code-server per team member | Internal, nginx proxies to /ide/<name>/ |
| 8097 | code-server shared workspace | Internal, nginx proxies to /shared/ |
| 3000 | nginx preview proxy | Proxies localhost:5174 (dev server) |
| 5173 | Bolt.diy (internal) | |
| 5180 | nginx → Bolt.diy | Exposed with basic auth |
| 5181 | nginx → Claw Runner | |
| 5182 | Claw Runner (Node.js) | |

### Services

**vLLM** (`python3 -m vllm.entrypoints.openai.api_server`)
- Serves the model in OpenAI format on port 8082
- Tensor-parallel across all GPUs (`--tensor-parallel-size $NUM_GPUS`)
- Expert-parallel enabled for MoE models
- FP8 KV cache on H100/H200 profiles
- Speculative decoding (MTP) on GLM-5.1
- Auto-restarts if the process dies

**litellm proxy** (port 8081)
- Wraps vLLM's OpenAI endpoint
- Exposes both OpenAI `/v1/chat/completions` and Anthropic `/v1/messages`
- Lets claw-code (Claude-compatible CLI) talk to local vLLM without code changes

**code-server** (VS Code in browser)
- Password-protected (auto-generated or team-assigned)
- `/workspace/projects` as the root folder (solo) or per-user folder (team)
- Env vars injected: `ANTHROPIC_BASE_URL=http://localhost:8081`, `ANTHROPIC_API_KEY=not-needed`

**Bolt.diy**
- React full-stack app generator
- Configured to use local litellm proxy as its AI backend
- Accessed via nginx on port 5180 with basic auth

**Claw Runner** (Node.js, port 5182)
- Background task execution engine for long-running agentic workflows
- Accessed via nginx on port 5181 with basic auth

**nginx**
- Handles basic auth for Bolt.diy, Claw Runner, and the preview proxy
- For team sessions: routes `/`, `/ide/<name>/`, `/shared/` to the correct code-server instance
- preview proxy on port 3000 proxies `localhost:5174` (useful for dev server outputs)

---

## 8. Team Sessions

When launching a session with team members, an array of `{name, password}` objects is passed. The API generates paths automatically and injects the members as `TEAM_MEMBERS_JSON` into the startup script.

### JSON structure stored in DB (`sessions.teamMembers`)

```json
[
  { "name": "__shared__", "password": "abc123", "path": "/shared/",      "ideUrl": "http://<ip>:<port>/shared/" },
  { "name": "alice",      "password": "xyz789", "path": "/ide/alice/",   "ideUrl": "http://<ip>:<port>/ide/alice/" },
  { "name": "bob",        "password": "def456", "path": "/ide/bob/",     "ideUrl": "http://<ip>:<port>/ide/bob/" }
]
```

- `__shared__` is always element 0; its path is `/shared/`
- Named members get `/ide/<name>/` paths
- Max 4 named members per session
- Names are sanitized to `[a-z0-9][a-z0-9_-]{0,30}`, reserved words (`admin`, `root`, etc.) are rejected

### nginx routing (port 8080 on team sessions)

```nginx
server {
  listen 8080;

  location / {
    auth_basic "OmniQL";
    auth_basic_user_file /etc/nginx/.htpasswd;       # owner credentials
    proxy_pass http://localhost:8090;                 # owner code-server
  }

  location /ide/alice/ {
    auth_basic "OmniQL - alice";
    auth_basic_user_file /etc/nginx/.htpasswd-alice;  # alice's own creds
    proxy_pass http://localhost:8093;
  }

  location /shared/ {
    auth_basic "OmniQL Shared";
    auth_basic_user_file /etc/nginx/.htpasswd-shared; # all members combined
    proxy_pass http://localhost:8097;                 # shared code-server (--auth none)
  }
}
```

### Workspaces
- Owner: `/workspace/projects`
- Alice: `/workspace/users/alice`
- Shared: `/workspace/shared`
- Each workspace gets a `.env` with `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` pre-set

### Dashboard — credential exposure
- `GET /api/sessions` (list) — passwords are **redacted**
- `GET /api/sessions/:id` (detail) — passwords are **included** (cockpit shows them with copy buttons)
- Team badge shown on session cards and in the active session panel
- "Copy invite" button on each member card: copies `"Your IDE: <url> | Password: <pw>"`

---

## 9. Memory Persistence System

The API server runs an embedded SQLite FTS5 memory store that lets the AI agent remember what it did across sessions. No external service required.

### Storage
- Location: `~/omniql-memory/mem.db` (outside the workspace, not tracked by git)
- Auth: optional Bearer token via `OMNIQL_MEM_TOKEN` env var

### Instance-side integration
Three environment variables are injected into every instance's onstart script:

| Variable | Value |
|----------|-------|
| `OMNIQL_MEM_PROXY_URL` | Base URL of this API server |
| `OMNIQL_MEM_AUTH_TOKEN` | Bearer token (or empty in dev) |
| `OMNIQL_MEM_USER_ID` | User ID scope (default: `"operator"`) |

The claw-code Rust CLI reads these and calls the memory API after each tool use.

### Memory API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/mem/init` | Start a new memory session |
| POST | `/api/mem/observation` | Record a tool call (toolName, inputSummary, outputSummary) |
| POST | `/api/mem/summarize` | Write an end-of-session summary |
| GET | `/api/mem/context/:userId` | FTS5 search → context string for system prompt injection |
| GET | `/api/mem/observations` | List recent observations |
| GET | `/api/mem/sessions` | List past sessions with summaries |

### Dashboard access (no Bearer token needed)
The dashboard proxies memory through session-scoped routes:

| Route | Description |
|-------|-------------|
| `GET /api/sessions/:id/memory/sessions` | Past sessions list |
| `GET /api/sessions/:id/memory/observations` | Tool observations |
| `GET /api/sessions/:id/memory/search?q=` | Full-text search |
| `GET /api/sessions/:id/memory/stream` | SSE stream of live observations |
| `GET /api/memory/sessions` | Global memory (all users) |
| `GET /api/memory/search?q=` | Global full-text search |

### Memory page
`/memory` in the dashboard shows a searchable global log of all sessions with summaries displayed as note blocks. Per-session memory is also accessible via the Memory tab inside any cockpit.

---

## 10. Scheduler

Runs in the API server process, checks every 30 seconds.

### What it does

1. **Auto-launch**: At the configured `launchTime` on enabled days, if no session is currently active, launches a new session using the configured GPU profile.

2. **Safety-net stop**: At the configured `stopTime`, destroys any running session (regardless of how it was started). Prevents runaway costs if you forget to stop.

3. **Reminder window**: Configurable lead-time warning shown in the dashboard before auto-launch.

### Configuration (via dashboard Settings panel)

| Field | Description |
|-------|-------------|
| `enabled` | Master switch |
| `profileId` | Which GPU profile to launch |
| `launchTime` | HH:MM in `timezone` |
| `stopTime` | HH:MM safety-net cutoff |
| `daysOfWeek` | Which days are active (`["mon","tue","wed","thu","fri"]`) |
| `timezone` | IANA timezone (e.g. `America/New_York`) |
| `safetyNetEnabled` | Whether stopTime auto-kills the session |

### API
- `GET /api/scheduler` — get current config
- `PUT /api/scheduler` — update config

---

## 11. API Reference

Base path: `/api`

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sessions` | List all sessions (passwords redacted) |
| POST | `/sessions` | Launch a new session |
| GET | `/sessions/active` | Get the currently active session |
| GET | `/sessions/:id` | Get session detail (includes team passwords) |
| DELETE | `/sessions/:id` | Destroy session and Vast.ai instance |
| POST | `/sessions/:id/sync` | Force a Vast.ai API sync |
| POST | `/sessions/:id/status` | **Instance callback** — update status from onstart.sh |

#### POST /sessions — request body

```json
{
  "profileId": 2,
  "teamMembers": [
    { "name": "alice" },
    { "name": "bob" }
  ]
}
```

- `profileId` — required, references gpu_profiles
- `teamMembers` — optional; if provided, enables team session mode; passwords are auto-generated

#### POST /sessions/:id/status — instance callback

Called by `onstart.sh` via curl at each boot phase.

```json
{ "status": "services_ready" }
{ "status": "downloading" }
{ "status": "starting_llm" }
{ "status": "llm_ready" }
```

Authenticated via `Authorization: Bearer <OMNIQL_MEM_AUTH_TOKEN>`. If `OMNIQL_MEM_TOKEN` is not set (dev mode), the endpoint is open.

### GPU Profiles

| Method | Path | Description |
|--------|------|-------------|
| GET | `/profiles` | List all profiles |
| GET | `/profiles/:id` | Get single profile |

### Offers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/offers` | Search live Vast.ai marketplace |

Query params: `gpuName`, `numGpus`, `minGpuRam`, `maxPrice`, `limit`

### Templates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/templates` | List templates |
| POST | `/templates` | Create template on Vast.ai |
| PUT | `/templates/:id` | Update template |
| DELETE | `/templates/:id` | Delete template |

### Scheduler

| Method | Path | Description |
|--------|------|-------------|
| GET | `/scheduler` | Get scheduler config |
| PUT | `/scheduler` | Update scheduler config |

### Dashboard

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard/summary` | `{ activeSessions, totalSessions, totalCost, schedulerEnabled }` |

---

## 12. Dashboard UI Pages

### `/` — Dashboard
- Active session card with status badge, GPU, cost/hr, and statusMessage
- "View Cockpit →" button
- Summary stats: total sessions, total spend, scheduler status
- Recent sessions list

### `/sessions` — All Sessions
- Table of all sessions (running + historical)
- Status badge, team badge (violet, shows team icon when `teamMembers` is present)
- Cost column
- Click → cockpit

### `/sessions/:id` — Cockpit

**Boot log panel** — live status updates as the instance boots, driven by 5-second polling. Shows current `statusMessage`.

**Overview tab:**
- "Your coding environment is ready" panel with "Open Coding Environment" button (links to Bolt.diy URL)
- Hardware & Access card: GPU, Public IP, SSH command, SSH tunnel command (for VPN users)
- Cost & Timing card: started time, $/hr, total spend

**Team Access card** (team sessions only):
- Credential table per member: IDE URL, username, password
- "Copy invite" button — copies `"Your IDE: <url> | Password: <pw>"` to clipboard

**Memory tab:**
- Per-session tool observation log
- Session summary block (if AI wrote one)
- Full-text search within this session

### `/templates` — Templates
- List and manage Vast.ai Docker templates
- Set default template (used by scheduler and new sessions)

### `/memory` — Memory
- Global searchable log across all sessions
- Session summaries as styled note blocks
- FTS5 search (debounced, 350ms)

---

## 13. Environment Variables

### API server

| Variable | Required | Description |
|----------|----------|-------------|
| `VASTAI_API_KEY` | Yes | Vast.ai API key for all instance operations |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | API server port (default: 8080) |
| `OMNIQL_MEM_TOKEN` | No | Bearer token for memory API (open in dev if not set) |
| `OMNIQL_MEM_PROXY_URL` | No | Public URL of this API server (injected into instances for memory callbacks). Defaults to `https://$REPLIT_DEV_DOMAIN` |
| `OMNIQL_MEM_USER_ID` | No | Memory user scope (default: `operator`) |
| `REPLIT_DEV_DOMAIN` | Auto | Set by Replit. Used to construct callback and memory proxy URLs |

### Injected into each Vast.ai instance via onstart script

| Variable | Description |
|----------|-------------|
| `MODEL_REPO` | HuggingFace repo to download |
| `MODEL_QUANT` | Cache directory name |
| `SERVED_MODEL_NAME` | vLLM and litellm model alias |
| `VLLM_MAX_MODEL_LEN` | Max context length |
| `VLLM_MAX_NUM_SEQS` | Max concurrent sequences |
| `VLLM_EXTRA_ARGS` | Extra vLLM flags |
| `NUM_GPUS` | GPU count |
| `OMNIQL_MEM_PROXY_URL` | Memory API base URL |
| `OMNIQL_MEM_AUTH_TOKEN` | Memory API bearer token |
| `OMNIQL_MEM_USER_ID` | Memory user scope |
| `OMNIQL_SESSION_ID` | Session ID for status callbacks |
| `OMNIQL_CALLBACK_URL` | Full URL for status callbacks |
| `TEAM_MEMBERS_JSON` | JSON array of team members (team sessions only) |

---

## 14. Vast.ai Integration

All interaction goes through `artifacts/api-server/src/services/vastai.ts`.

### Key operations

**Search offers** (`POST /bundles/`)
- Filters: `gpu_name`, `num_gpus`, `gpu_ram` (gte), `disk_space`, `dph_total` (lte)
- Orders by `dph_total asc` (cheapest first)
- Returns `VastOffer[]`

**Create instance** (`PUT /asks/:offerId/`)
- Passes: Docker image, env dict (port mappings + model env), onstart script, disk size, template hash
- Returns: `{ new_contract: instanceId, expected_price }`
- Note: do **not** pass `template_hash_id` — causes 400

**Get instance** (`GET /instances/:id/`)
- Returns: `actual_status`, `status_msg`, `public_ipaddr`, `ports`, `dph_total`, `cost_run_time`
- `actual_status`: `loading` → `creating` → `running` → `exited` / `error`
- `status_msg`: set by Vast.ai (e.g. `"success, running <image>"`); not controlled by our script

**Destroy instance** (`DELETE /instances/:id/`)

**Create/update template** (`POST /templates/` and `PUT /templates/:id/`)

### Port mapping
Ports are declared in the env dict with Docker `-p` flag syntax:

```typescript
"-p 8080:8080": "1",   // code-server
"-p 8081:8081": "1",   // litellm proxy
"-p 5180:5180": "1",   // nginx → Bolt.diy
"-p 5181:5181": "1",   // nginx → Claw Runner
"-p 3000:3000": "1",   // nginx preview
```

Vast.ai maps these to random high ports on the public IP. The dashboard reads the mappings from `instance.ports["8080/tcp"][0].HostPort` etc.

### Cost fields
- `dph_total` — actual running $/hr (updates in real time as instance runs)
- `cost_run_time` — cumulative cost since instance started (null on some hosts)
- `expected_price` — estimate returned at creation time (often 0 — use `dph_total` instead)

---

## 15. Docker Image

`gheeklabs/coding-env:latest` (CUDA 12.4 runtime base)

### What's pre-installed

- CUDA 12.4 + cuDNN
- Python 3 + pip
- vLLM (latest)
- litellm
- huggingface-cli
- code-server
- Node.js + pnpm
- Bolt.diy (`/opt/bolt-diy`)
- Claw Runner (`/opt/claw-runner.js`)
- nginx + apache2-utils (for htpasswd)
- SSH server (openssh-server)
- jq (for JSON parsing in bash)
- `/opt/onstart.sh` — the startup script

### Build
See `docker/Dockerfile`. The image is pre-built and pushed to Docker Hub. It does not contain model weights — those are downloaded at runtime by `huggingface-cli` into `/workspace/models/`.

---

## 16. Boot Script (onstart.sh)

The `buildOnStartScript()` function in `vastai.ts` generates a wrapper that sets environment variables and then calls `/opt/onstart.sh` (which is baked into the Docker image).

### Generated wrapper structure

```bash
#!/bin/bash
export MODEL_REPO="moonshotai/Kimi-K2.5"
export MODEL_QUANT="kimi-k2.5"
export SERVED_MODEL_NAME="kimi-k2"
export VLLM_MAX_MODEL_LEN="32768"
export VLLM_MAX_NUM_SEQS="512"
export VLLM_EXTRA_ARGS="--enable-expert-parallel"
export NUM_GPUS="4"
export OMNIQL_MEM_PROXY_URL="https://your-api.replit.dev"
export OMNIQL_MEM_AUTH_TOKEN=""
export OMNIQL_MEM_USER_ID="operator"
export OMNIQL_SESSION_ID="42"
export OMNIQL_CALLBACK_URL="https://your-api.replit.dev/api/sessions/42/status"
# (team sessions only):
export TEAM_MEMBERS_JSON='[{"name":"__shared__","password":"abc","path":"/shared/"},{"name":"alice","password":"xyz","path":"/ide/alice/"}]'
/opt/onstart.sh
```

### onstart.sh phases

**Phase 1** (sequential, completes in ~30 seconds):
1. Generate code-server password (stored at `/workspace/.code-server-password`)
2. Start SSH server (key-based auth only)
3. Start code-server (owner, port 8080 solo or 8090 team)
4. Start Claw Runner (port 5182)
5. Start Bolt.diy (port 5173)
6. Configure nginx htpasswd + server blocks
7. Start nginx
8. (Team only) Build per-member nginx config, start per-member code-server instances
9. `report_status services_ready` → POSTs to `OMNIQL_CALLBACK_URL`

**Phase 2** (background subshell, takes 10–45 min depending on model):
1. Check if model already cached at `/workspace/models/$MODEL_QUANT/`
2. If not: `report_status downloading` → download with `huggingface-cli`
3. `report_status starting_llm` → start vLLM on port 8082
4. Start litellm proxy on port 8081 (wraps vLLM)
5. Wait for `/health` on vLLM (polls every 5s, up to 600s)
6. Configure `/etc/environment` + `/root/.bashrc` with `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`
7. `report_status llm_ready`
8. Watchdog loop: restart vLLM if it dies (checks every 30s)

### `report_status` helper
Defined in `onstart.sh`. Uses `curl` to call `OMNIQL_CALLBACK_URL` with `Authorization: Bearer $OMNIQL_MEM_AUTH_TOKEN`. Safe no-op if `OMNIQL_CALLBACK_URL` is not set (older instances). On failure it logs a warning but does not abort the boot sequence.

---

*End of FLOATR_SPEC.md*
