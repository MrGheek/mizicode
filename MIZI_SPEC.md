# MIZI — Product Specification

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
17. [Design Intelligence](#17-design-intelligence)
18. [Swarm Orchestration](#18-swarm-orchestration)
19. [Repo Intelligence](#19-repo-intelligence)
20. [Lane Coordination](#20-lane-coordination)
21. [GitHub CI/CD](#21-github-cicd)

---

## 1. Product Overview

MIZI lets you rent raw GPU compute from [Vast.ai](https://vast.ai), boot a pre-configured AI coding environment on it, and access everything through a hosted dashboard — without managing servers, Kubernetes, or cloud accounts yourself.

Each **session** is a rented GPU machine running:
- A frontier open-source LLM (Kimi K2.6, Qwen3-Coder-Next, DeepSeek V3.2, etc.)
- **vLLM** for high-throughput GPU inference
- **litellm proxy** for Anthropic-compatible API (so claw-code CLI works out of the box)
- **code-server** — VS Code in the browser with the LLM wired in
- **Bolt.diy** — React app generator that talks to the local LLM
- **nginx** — routes traffic, handles basic auth, provides preview proxy
- **SSH** — key-based access for terminal use or port forwarding

The hosted dashboard (this app) handles instance provisioning, status tracking, cost tracking, memory persistence, scheduled auto-launch/stop, repo intelligence indexing, and team lane coordination.

### Key properties

- **No shared API** — the LLM runs entirely on your rented GPU. Zero per-token cost beyond the GPU hourly rate.
- **Ephemeral by default** — sessions are destroyed when you stop them; `/workspace` is local to the machine.
- **Persistent memory** — the dashboard maintains a SQLite FTS5 memory store that records what the AI agent did across sessions, injectable into future sessions as context.
- **Team-capable** — one session can host multiple isolated IDEs for team members + a shared workspace, all proxied through nginx with per-user credentials.
- **Swarm-aware** — each GPU profile carries a `swarmWorkerCap` limiting the number of concurrent vLLM requests the Claw Runner can schedule, preventing KV-cache exhaustion.
- **Repo Intelligence** — sessions can index a Git repository on-instance, producing symbol graphs, embeddings, blast-radius maps, and natural-language summaries searchable from the dashboard.
- **Design Intelligence** — curated UI/UX patterns and design guidelines are ingested from GitHub and surfaced via a queryable API linked to the skill system.
- **Lane Coordination** — team sessions get per-member work lanes with claim-based file ownership, conflict detection, handoffs, and a weighted heavy-job scheduler.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MIZI Dashboard                                    │
│                    (React + Vite, hosted on Replit)                          │
│                                                                              │
│  Pages: Dashboard / Sessions / Cockpit / Templates / Memory /                │
│         Design Intelligence / Coordination / Skills                          │
└────────────────────────────┬───────────────────────────────────────────────┘
                             │ HTTP (React Query, Orval-generated hooks)
┌────────────────────────────▼───────────────────────────────────────────────┐
│                          API Server                                          │
│                   (Express 5, hosted on Replit)                              │
│                                                                              │
│  Routes: /sessions  /profiles  /scheduler  /memory  /offers                 │
│          /design-intelligence  /repo  /coordination  /skills  /evals        │
│  Services: vastai · profiles · scheduler · memory · curated-sources         │
│            skills-bundler · lane-policy · heavy-job-scheduler               │
│            claim-sweeper  (via coordination route)                           │
│  DB: PostgreSQL + Drizzle ORM                                                │
│  Memory: SQLite FTS5 (configurable via MEM_DATA_DIR)                        │
└──────────┬───────────────────────────────┬────────────────────────────────┘
           │ Vast.ai REST API               │ Status/phase callbacks
           │                               │ (POST /sessions/:id/status)
           │                               │ (POST /sessions/:id/repo/sync)
┌──────────▼───────────────────────────────▼────────────────────────────────┐
│                       Vast.ai GPU Instance                                   │
│              (rented bare-metal, your Docker image)                          │
│                                                                              │
│  onstart.sh runs at boot:                                                    │
│    Phase 1 (immediate): code-server · Bolt.diy · nginx · SSH                │
│      → Compiles Smart Skills bundle                                          │
│      → Starts Repo Intelligence indexer                                      │
│      → POSTs services_ready callback                                         │
│    Phase 2 (background): model download · vLLM · litellm                    │
│      → POSTs phase callbacks (downloading / starting_llm / llm_ready)       │
│                                                                              │
│  Exposed ports (Vast.ai maps to random external ports):                      │
│    8080 → code-server (or nginx team router)                                 │
│    8081 → litellm proxy (OpenAI + Anthropic API)                             │
│    5180 → Bolt.diy (through nginx auth)                                      │
│    3000 → preview proxy (through nginx auth)                                 │
│    5181 → Claw Runner                                                        │
│    22   → SSH                                                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19.1.0, Vite 7, Tailwind CSS, shadcn/ui, Wouter, TanStack Query |
| API server | Express 5, Node.js 24, TypeScript 5.9 |
| Database | PostgreSQL (Drizzle ORM), SQLite FTS5 (memory) |
| Build | esbuild (API), Vite (frontend) |
| Validation | Zod v3.25.x, drizzle-zod |
| API contract | OpenAPI 3.1 → Orval codegen → React Query hooks + Zod schemas |
| Monorepo | pnpm workspaces |
| GPU compute | Vast.ai REST API |
| LLM inference | vLLM (pinned ==0.19.0) + litellm proxy |
| IDE | code-server (VS Code in browser) |
| Coding UI | Bolt.diy |
| Proxy | nginx (basic auth + path-based team routing) |

---

## 3. Monorepo Structure

```
mizi/
├── artifacts/
│   ├── api-server/               # Express API server
│   │   └── src/
│   │       ├── index.ts          # Entry point, port binding, profile seeding
│   │       ├── routes/
│   │       │   ├── sessions.ts         # Session CRUD, sync, status callback, swarm
│   │       │   ├── profiles.ts         # GPU profile listing
│   │       │   ├── templates.ts        # Vast.ai template management
│   │       │   ├── offers.ts           # Live GPU marketplace search
│   │       │   ├── scheduler.ts        # Scheduler config CRUD
│   │       │   ├── dashboard.ts        # Summary stats
│   │       │   ├── memory.ts           # Memory proxy routes
│   │       │   ├── design-intelligence.ts  # Design Intelligence CRUD + sync
│   │       │   ├── repo.ts             # Repo Intelligence (per-session + batch)
│   │       │   ├── coordination.ts     # Lane coordination, claims, handoffs, heavy jobs
│   │       │   ├── skills.ts           # Skill management + bundles
│   │       │   └── evals.ts            # Eval run management
│   │       └── services/
│   │           ├── vastai.ts           # Vast.ai API client
│   │           ├── profiles.ts         # Profile seeding & lookup (K2.6 + legacy)
│   │           ├── scheduler.ts        # Auto-launch/stop + design sync scheduler
│   │           ├── memory.ts           # SQLite FTS5 memory service (backup/restore)
│   │           ├── curated-sources.ts  # Design Intelligence ingest from GitHub
│   │           ├── skills-bundler.ts   # Smart Skills bundle compiler
│   │           ├── skills-types.ts     # Shared skill types
│   │           ├── lane-policy.ts      # Lane type policies + claim overlap math
│   │           └── heavy-job-scheduler.ts  # Weighted queue for indexing/eval jobs
│   └── dashboard/
│       └── src/
│           ├── pages/
│           │   ├── dashboard.tsx           # Home — active session + stats
│           │   ├── sessions/
│           │   │   ├── index.tsx           # All sessions list (swarm pills)
│           │   │   └── [id].tsx            # Session cockpit
│           │   ├── templates.tsx           # Template management
│           │   ├── memory.tsx              # Global memory search
│           │   ├── design-intelligence.tsx # Design patterns explorer
│           │   └── skills/                 # Skill browser + bundle management
│           └── components/
│               ├── session-status-badge.tsx
│               ├── swarm-status-pill.tsx
│               └── repo-intelligence-panel.tsx
├── docker/
│   ├── Dockerfile               # CUDA 12.4 runtime, vLLM==0.19.0 pinned
│   ├── onstart.sh               # Parameterized startup script
│   ├── claw-runner.js           # Claw Runner (Node.js)
│   └── scripts/                 # Repo Intelligence indexer scripts
├── lib/
│   ├── api-spec/openapi.yaml    # Single source of truth for API contract
│   ├── api-zod/                 # Generated Zod schemas (from openapi.yaml)
│   ├── api-client-react/        # Generated React Query hooks
│   └── db/src/schema/           # Drizzle table definitions
│       ├── sessions.ts          # sessions table
│       ├── gpu-profiles.ts      # gpu_profiles table (+ swarmWorkerCap)
│       ├── scheduler.ts         # scheduler_config table (+ secondReminderTime)
│       ├── templates.ts         # templates table
│       ├── coordination.ts      # session_lanes, lane_claims, lane_handoffs, lane_heavy_jobs
│       └── skills.ts            # skills, skill_sources, skill_bundles, design_intelligence_entries,
│                                #   skill_design_categories, session_repo_context, repo_graph_jobs,
│                                #   eval_runs, eval_run_variants, skill_evals, bundle_evals
└── .github/workflows/           # GitHub Actions CI/CD (see Section 21)
```

---

## 4. Database Schema

### `gpu_profiles`
Defines what GPU tier to rent and which model to run. Seeded automatically at API server startup.

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | |
| `name` | text unique | Slug (e.g. `kimi-k2-6-standard`, `qwen3-coder-pro`) |
| `displayName` | text | Human label shown in dashboard |
| `gpuName` | text | e.g. `RTX 4090`, `A100 80GB`, `H100 80GB`, `H200 141GB` |
| `numGpus` | integer | Number of GPUs to request |
| `totalVram` | integer | Total VRAM in GB |
| `dockerImageTag` | text | Docker image to boot on the instance |
| `modelRepo` | text | HuggingFace repo to download |
| `defaultQuant` | text | Cache subdirectory under `/workspace/models/` |
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
| `swarmWorkerCap` | integer | **New** — max concurrent swarm workers this profile supports. Injected as `SWARM_MAX_WORKERS` into the container. `null` = swarm not configured. |

### `sessions`
One row per instance launched.

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | |
| `profileId` | integer FK → gpu_profiles | |
| `vastInstanceId` | integer | Vast.ai contract/instance ID |
| `vastOfferId` | integer | Offer selected at launch |
| `templateHash` | text | Vast.ai template hash used |
| `status` | text | `pending` → `provisioning` → `downloading` → `starting` → `ready` → `stopped` / `error` |
| `statusMessage` | text | Human-readable current state |
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
| `taskMode` | text | **New** — `build`, `review`, `debug`, etc. (set at launch) |
| `tokenMode` | text | **New** — `core`, `full`, or `extended` (controls skill bundle size) |
| `activeBundleId` | integer FK → skill_bundles | **New** — the Smart Skills bundle compiled for this session |
| `repoFingerprintJson` | jsonb | **New** — repo fingerprint provided at launch (languages, frameworks, URL hash) |
| `routingStatsJson` | jsonb | **New** — `SessionRoutingStats` (bytes avoided/shielded by the skill router) |
| `swarmSnapshotJson` | jsonb | **New** — latest swarm worker snapshot pushed from the Claw Runner |
| `ownerToken` | text | **New** — bearer secret issued at session creation; required for destructive owner actions (e.g. swarm abort). Redacted from list/active endpoints; exposed only on `GET /sessions/:id`. |
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
| `stopTime` | HH:MM for primary auto-stop |
| `secondReminderTime` | **New** — optional second stop trigger (HH:MM); fires 2 minutes after this time |
| `daysOfWeek` | Array of `"mon"` / `"tue"` / etc. |
| `timezone` | IANA timezone (e.g. `Europe/London`) |
| `profileId` | FK → gpu_profiles to launch |
| `safetyNetEnabled` | If true, stops any running session at `stopTime` |

### `skill_sources`
External repositories from which skill data is imported.

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | |
| `repoUrl` | text | GitHub repo URL |
| `sourceType` | text | `"curated"` (auto-ingested) or `"github"` (manually added) |
| `defaultBranch` | text | e.g. `"main"` |
| `pinnedCommitSha` | text | Last successfully ingested HEAD SHA (SHA-aware idempotence) |
| `license` | text | SPDX license identifier |
| `trustLevel` | text | `"reviewed"` (curated) or `"user_approved"` (user-added) |
| `importedAt` | timestamp | When first imported |

### `design_intelligence_entries`
Individual entries ingested from curated design sources. Unique on `(source_id, category, name)`.

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | |
| `sourceId` | integer FK → skill_sources | |
| `category` | text | 7 canonical values: `style`, `palette`, `typography`, `chart_type`, `ux_guideline`, `stack_convention`, `ui_reasoning`. Type also includes `anti_pattern` (schema-valid, not auto-ingested). |
| `name` | text | Primary key name from the CSV row (name/label/title/id field) |
| `dataJson` | jsonb | Full raw CSV row as a key/value object |
| `tags` | jsonb | String array: `[category, normalised-name]` |
| `createdAt` | timestamp | |

### `skill_design_categories`
Join table linking skills to design intelligence categories, for the skill-map endpoint.

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | |
| `skillId` | integer FK → skills (cascade delete) | |
| `category` | text | Design category name |
| `matchMethod` | text | `"keyword"` (auto-matched) or `"manual"` (admin-linked) |
| `createdAt` | timestamp | |

Unique index on `(skillId, category)`.

### `session_repo_context`
Stores the result of a repo intelligence indexing run for a session.

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | |
| `sessionId` | integer | References sessions |
| `repoPath` | text | Absolute path on the instance (default `/workspace/projects`) |
| `repoUrl` | text | Source URL if known |
| `fingerprintJson` | jsonb | Repo fingerprint (language list, framework markers, URL hash) |
| `fingerprintHash` | text | SHA256 of fingerprint for change detection |
| `summaryJson` | jsonb | Natural-language summary of the repo |
| `symbolsJson` | jsonb | Array of `RepoSymbol` (name, kind, path, line, lang, signature, docstring, callers, callees) |
| `filesJson` | jsonb | Array of `RepoFile` (path, lang, size) |
| `edgesJson` | jsonb | Array of dependency edges (from, to, type) |
| `chunksJson` | jsonb | Text chunks for RAG retrieval |
| `embeddingsJson` | jsonb | Float32 embedding vectors (optional) |
| `hasEmbeddings` | boolean | Whether embeddings are populated |
| `embeddingDim` | integer | Embedding dimension (e.g. 768, 1536) |
| `indexStatus` | text | `queued` → `scanning` → `fingerprinting` → `indexing_graph` → `indexing_fts` → `indexing_vectors` → `summarizing` → `ready` / `error` |
| `isStale` | boolean | True if a new index job was enqueued while a previous result exists |
| `confidenceLevel` | text | `none` → `fingerprint` → `partial` → `full` (computed from sync payload; see §19) |
| `indexedAt` | timestamp | When indexing completed |

### `repo_graph_jobs`
One row per indexing job enqueued for a session. Deduplicated by active status per `(sessionId, repoPath)`.

| Column | Type | Description |
|--------|------|-------------|
| `id` | serial PK | |
| `sessionId` | integer | |
| `repoPath` | text | |
| `status` | text | `queued` / `scanning` / `fingerprinting` / `indexing_graph` / `indexing_fts` / `indexing_vectors` / `summarizing` / `completed` / `error` |
| `indexVersion` | integer | Monotonically increasing per session |
| `indexedSymbols` | integer | Symbol count after completion |
| `edgeCount` | integer | Edge count after completion |
| `embeddingsStatus` | text | Embeddings sub-phase status |
| `contentHashSeed` | text | Hash used for change detection |
| `durationMs` | integer | Total job duration |
| `errorDetails` | text | Error message if failed |

### `session_lanes`, `lane_claims`, `lane_handoffs`, `lane_heavy_jobs`, `custom_lane_types`, `lane_events`
See [Section 20 — Lane Coordination](#20-lane-coordination).

`lane_handoffs` includes a `pr_url` column populated automatically when a `safe_to_merge` handoff triggers a GitHub draft PR.

`custom_lane_types` stores operator-defined lane types that extend the five built-ins (`ux`, `debug`, `backend`, `review`, `general`). Each row carries policy overrides (claim TTL, blast-radius limit, allowed claim types).

`lane_events` is an append-only audit log. Rows reference `session_id` (FK) and `lane_id` (no FK so history outlives deleted lanes). Contains: `eventType`, `laneId`, `actorId`, `metadata` (jsonb), `createdAt`.

### `provisioned_resources`
One row per test Postgres/Redis resource created on demand for a session.

| Column | Description |
|--------|-------------|
| `id` | serial PK |
| `sessionId` | FK → sessions |
| `resourceType` | `postgres` or `redis` |
| `resourceId` | Strategy-specific identifier (`local:<dir>:<port>`, Neon branch ID, etc.) |
| `connectionStringEnc` | AES-encrypted connection string |
| `createdAt` | Timestamp |
| `deletedAt` | Set when cleaned up |

### `schema_templates`
SQL DDL templates available for test database provisioning.

| Column | Description |
|--------|-------------|
| `id` | serial PK |
| `slug` | Unique short name (e.g. `standard-web-app`) |
| `displayName` | Human label |
| `ddl` | Full SQL DDL string |
| `isBuiltin` | Whether seeded at startup |
| `createdAt` | Timestamp |

### Skills-related tables (`skills`, `skill_versions`, `skill_bundles`, `session_skills`, `skill_feedback`, `eval_runs`, `eval_run_variants`, `skill_evals`, `bundle_evals`)
Managed by the Smart Skills system. Seeded via skill import; bundles are compiled per session at launch time and per lane at lane creation time. Eval system tracks per-skill and per-bundle performance via A/B lift scoring.

---

## 5. GPU Profiles & Models

Profiles are seeded at server startup from `services/profiles.ts`. Stale profiles (removed from code) are auto-deleted. All profiles carry a `swarmWorkerCap` that limits concurrent Claw Runner workers to prevent KV-cache exhaustion.

### Kimi K2.6 (unsloth/Kimi-K2.6-GGUF) — **Primary / Recommended**
Mixture-of-experts GGUF. 2T total / 32B active parameters.

| Profile | GPU | Count | VRAM | ctx | tok/s | $/hr est | swarmWorkerCap |
|---------|-----|-------|------|-----|-------|---------|----------------|
| Starter · K2.6 | RTX 4090 | 1 | 24 GB | 8 192 | 5–10 | $0.13–0.20 | 16 |
| Standard · K2.6 | RTX 4090 | 4 | 96 GB | 32 768 | 20–35 | $0.50–0.80 | 48 |
| Pro · K2.6 | A100 80GB | 4 | 320 GB | 65 536 | 40–65 | $2.00–4.00 | 100 |
| Ultra · K2.6 | H100 80GB | 8 | 640 GB | 131 072 | 80–130 | $8.00–16.00 | 200 |

**K2.6 vLLM flags:**
- Standard: `--enable-expert-parallel`, `llamaBatchSize=768` (raised from 512 for swarm headroom)
- Pro: `--enable-expert-parallel --kv-cache-dtype fp8` + chunked-prefill + priority scheduling
- Ultra: same as Pro + `--gpu-memory-utilization 0.95` (raised from default 0.92)

### Kimi K2.5 (unsloth/Kimi-K2.5-GGUF) — Legacy (kept for existing sessions)

| Profile | GPU | Count | VRAM | ctx | tok/s | $/hr est | swarmWorkerCap |
|---------|-----|-------|------|-----|-------|---------|----------------|
| Starter · K2.5 | RTX 4090 | 1 | 24 GB | 8 192 | 5–10 | $0.13–0.20 | 16 |
| Standard · K2.5 | RTX 4090 | 4 | 96 GB | 32 768 | 20–35 | $0.50–0.80 | 48 |
| Pro · K2.5 | A100 80GB | 4 | 320 GB | 65 536 | 40–65 | $2.00–4.00 | 100 |
| Ultra · K2.5 | H100 80GB | 8 | 640 GB | 131 072 | 80–130 | $8.00–16.00 | 200 |

### Qwen3-Coder-Next (Qwen/Qwen3-Coder-Next)
80B total / 3B active. Very fast per-worker inference — favoured for swarm-intensive tasks.

| Profile | GPU | Count | ctx | tok/s | $/hr est | swarmWorkerCap |
|---------|-----|-------|-----|-------|---------|----------------|
| Qwen3 Standard | A100 80GB | 4 | 65 536 | 55–90 | $2.00–4.00 | 120 |
| Qwen3 Pro | A100 80GB | 8 | 131 072 | 120–200 | $4.00–8.00 | 250 |

Qwen3 Pro raises `--gpu-memory-utilization 0.95` and applies chunked-prefill for swarm workloads.

### MiniMax M2.5 (MiniMaxAI/MiniMax-M2.5)
229B total / 10B active. Compact active layer gives moderate swarm headroom.

| Profile | GPU | Count | ctx | tok/s | $/hr est | swarmWorkerCap |
|---------|-----|-------|-----|-------|---------|----------------|
| MiniMax Ultra | H100 80GB | 8 | 131 072 | 60–100 | $8.00–16.00 | 80 |

### GLM-5.1 FP8 (zai-org/GLM-5.1-FP8)
754B total / 40B active. Speculative decoding (MTP), FP8 KV cache. Requires vLLM ≥ 0.19.0.

| Profile | GPU | Count | ctx | tok/s | $/hr est | swarmWorkerCap |
|---------|-----|-------|-----|-------|---------|----------------|
| GLM-5.1 Ultra | H100 80GB | 8 | 32 768 | 25–45 | $8.00–16.00 | 4 |
| GLM-5.1 H200 | H200 141GB | 8 | 131 072 | 40–70 | $15.00–25.00 | 16 |

> ⚠️ GLM-5.1 Ultra runs at `--gpu-memory-utilization 0.98` (VRAM fully committed). Swarm is extremely constrained — use H200 tier for any swarm workload.

> ⚠️ GLM-5.1 H200 does **not** use `--enable-chunked-prefill` (incompatible with `--speculative-config.method mtp` on vLLM 0.6.x). Will be added when the pinned image moves to vLLM ≥ 0.7.0.

### DeepSeek V3.2 (deepseek-ai/DeepSeek-V3.2)
671B total (MoE), MIT license.

| Profile | GPU | Count | ctx | tok/s | $/hr est | swarmWorkerCap |
|---------|-----|-------|-----|-------|---------|----------------|
| DeepSeek V3.2 | H200 141GB | 8 | 131 072 | 45–75 | $15.00–25.00 | 32 |

### Chunked-prefill shared flags (`CHUNKED_PREFILL_PRO`)
Applied to Pro/Ultra MoE profiles (vLLM ≥ 0.19.0):
```
--enable-chunked-prefill --max-num-batched-tokens 8192
--max-num-partial-prefills 2 --max-long-partial-prefills 0
--long-prefill-token-threshold 2048 --scheduling-policy priority
```

---

## 6. Session Lifecycle

```
[User clicks Launch]
        │
        ▼
  status: pending
  (session row created, ownerToken generated, activeBundleId compiled)
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
  ├── nginx
  └── (optional) Repo Intelligence indexer triggered if repoUrl provided
        │
  Instance POSTs /api/sessions/:id/status  {status: "services_ready"}
        ▼
  status: starting
  statusMessage: "Tools ready — LLM model loading in background..."
        │
  Instance POSTs {status: "skills_compiling"}
  → "Compiling Smart Skills bundle..."
  Instance POSTs {status: "skills_ready"}
  → "Smart Skills loaded — LLM loading in background..."
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

**Fallback for old/offline instances**: If the instance callback never arrives, the sync checks `Vast.ai actual_status === "running"` + `status_msg` starts with `"success"` + instance has been running for >30 minutes → auto-marks as `ready`.

**Dashboard polling**: The cockpit page calls `GET /api/sessions/:id` every 5 seconds while active. Each call triggers a Vast.ai API sync.

### POST /sessions — extended request body

```json
{
  "profileId": 2,
  "offerId": null,
  "teamMembers": ["alice", "bob"],
  "taskMode": "build",
  "tokenMode": "core",
  "bundleId": null,
  "repoUrl": "https://github.com/acme/myrepo",
  "repoBranch": "main",
  "repoFingerprint": null
}
```

- `teamMembers` — array of name strings (not objects); API generates passwords automatically
- `taskMode` — `build`, `review`, `debug`, etc. Used to select the appropriate skill bundle
- `tokenMode` — `core` (default, compact prompt injection), `full`, or `extended`
- `bundleId` — explicit bundle override; null = auto-select default bundle for context
- `repoUrl` — if provided, a repo fingerprint is derived via GitHub public API (language/framework detection) and stored on the session
- `repoFingerprint` — override object if caller has already computed the fingerprint

---

## 7. What Runs on the Instance

### Port layout (container-internal → Vast.ai maps to random external ports)

| Internal port | Service | Notes |
|---------------|---------|-------|
| 22 | SSH | Key-based auth only |
| 8080 | code-server OR nginx team router | Solo: code-server direct. Team: nginx routes `/` |
| 8081 | litellm proxy | OpenAI + Anthropic API. Used by claw-code and Bolt.diy |
| 8082 | vLLM (internal) | OpenAI format only, not exposed externally |
| 8090 | code-server owner (team) | Internal only, nginx proxies to `/` |
| 8093-8096 | code-server per team member | Internal, nginx proxies to `/ide/<name>/` |
| 8097 | code-server shared workspace | Internal, nginx proxies to `/shared/` |
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
- `onstart.sh` performs runtime flag-gating: probes `python3 -m vllm.entrypoints.openai.api_server --help` and strips any unrecognised flags from `VLLM_EXTRA_ARGS`, keeping the image forward-compatible

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
- Enforces `SWARM_MAX_WORKERS` concurrency limit set from `gpu_profiles.swarmWorkerCap`
- Accessed via nginx on port 5181 with basic auth

**nginx**
- Handles basic auth for Bolt.diy, Claw Runner, and the preview proxy
- For team sessions: routes `/`, `/ide/<name>/`, `/shared/` to the correct code-server instance
- Preview proxy on port 3000 proxies `localhost:5174`

---

## 8. Team Sessions

When launching a session with team members, an array of name strings is passed. The API generates paths and passwords automatically and stores `TeamMemberRecord[]` in `sessions.teamMembers`.

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
- Names sanitized to `[a-z0-9][a-z0-9_-]{0,30}`, reserved words (`admin`, `root`, `owner`, `shared`) are rejected

### ownerToken
A bearer secret (`sessions.ownerToken`) is generated at session creation time and stored on the session. It is exposed only via `GET /api/sessions/:id` — never on list or active endpoints. The dashboard reads it from the cockpit to authorize destructive owner-only controls (e.g. swarm abort).

### taskMode and tokenMode
Set at launch and stored on `sessions.taskMode` / `sessions.tokenMode`. Control which Smart Skills bundle is selected and how aggressively context is injected into the LLM system prompt.

### Smart Skills bundle
`activeBundleId` references the `skill_bundles` row compiled for this session. Bundle selection is based on `taskMode`, `tokenMode`, session type, repo languages, and model profile. Per-lane overlay bundles are compiled when lanes are created (see Section 20).

### nginx routing (port 8080 on team sessions)

```nginx
server {
  listen 8080;

  location / {
    auth_basic "MIZI";
    auth_basic_user_file /etc/nginx/.htpasswd;       # owner credentials
    proxy_pass http://localhost:8090;                 # owner code-server
  }

  location /ide/alice/ {
    auth_basic "MIZI - alice";
    auth_basic_user_file /etc/nginx/.htpasswd-alice;  # alice's own creds
    proxy_pass http://localhost:8093;
  }

  location /shared/ {
    auth_basic "MIZI Shared";
    auth_basic_user_file /etc/nginx/.htpasswd-shared; # all members combined
    proxy_pass http://localhost:8097;                 # shared code-server
  }
}
```

### Workspaces
- Owner: `/workspace/projects`
- Alice: `/workspace/users/alice`
- Shared: `/workspace/shared`

### Dashboard credential exposure
- `GET /api/sessions` (list) — passwords **redacted**, `ownerToken` **redacted**
- `GET /api/sessions/active` — passwords **redacted**, `ownerToken` **redacted**
- `GET /api/sessions/:id` (detail) — passwords **included**, `ownerToken` **included**

---

## 9. Memory Persistence System

The API server runs an embedded SQLite FTS5 memory store. No external service required.

### Startup validation (`validateMemoryDataDir`)
`validateMemoryDataDir()` runs **before** `app.listen()` at server startup. It is a fatal guard: if it throws, the process exits without accepting any requests.

Steps:
1. `fs.mkdirSync(DATA_DIR, { recursive: true })` — creates the data directory if missing. Failure is fatal.
2. Write + delete a per-process probe file (`.write-probe-<pid>-<ts>`) to verify actual write access (a read-only volume mount will pass `mkdirSync` but fail this step). Failure is fatal.

The `DATA_DIR` is resolved from `MEM_DATA_DIR` env var (default: `~/mizi-memory/`). The SQLite DB lives at `DATA_DIR/mem.db`. On fatal failure, a structured error is logged with `DATA_DIR`, the source of the path (`MEM_DATA_DIR env var` or `"default (~mizi-memory)"`), and the underlying OS error.

### Storage
- Location: controlled by `MEM_DATA_DIR` env var (default: `~/mizi-memory/mem.db`)
- Auth: optional Bearer token via `MIZI_MEM_TOKEN`

### Token modes (memory budget profiles)
Memory retrieval respects the session's `tokenMode`:

| Mode | Description |
|------|-------------|
| `core` | Default — compact context injection, prioritises recent high-signal items |
| `full` | Broader retrieval window, more items injected |
| `extended` | Maximum retrieval budget, including stale items |

### Backup and restore
`memory.ts` exposes `backupDb()` and `restoreDb(buf)` for operator-initiated SQLite hot-backup. The backup produces a binary SQLite file. Restore accepts a `Buffer` and atomically replaces the live database.

### Instance-side integration

| Variable | Value |
|----------|-------|
| `MIZI_MEM_PROXY_URL` | Base URL of this API server |
| `MIZI_MEM_AUTH_TOKEN` | Bearer token (or empty in dev) |
| `MIZI_MEM_USER_ID` | User ID scope (default: `"operator"`) |

### Memory API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/mem/init` | Start a new memory session |
| POST | `/api/mem/observation` | Record a tool call (toolName, inputSummary, outputSummary) |
| POST | `/api/mem/summarize` | Write an end-of-session summary |
| GET | `/api/mem/context/:userId` | FTS5 search → context string for system prompt injection |
| GET | `/api/mem/observations` | List recent observations |
| GET | `/api/mem/sessions` | List past sessions with summaries |

### Dashboard memory routes

| Route | Description |
|-------|-------------|
| `GET /api/sessions/:id/memory/sessions` | Past sessions list (supports `?projectPath=` filter, `?limit=` and `?offset=` pagination) |
| `GET /api/sessions/:id/memory/observations` | Tool observations (supports `?limit=` and `?offset=` pagination) |
| `GET /api/sessions/:id/memory/search?q=` | Full-text search; reconnects automatically on SSE drop |
| `GET /api/sessions/:id/memory/stream` | SSE stream of live observations; client reconnects on connection loss |
| `GET /api/memory/sessions` | Global memory (all users) |
| `GET /api/memory/search?q=` | Global full-text search |

#### Memory SSE reconnect flow
The dashboard implements exponential-backoff reconnect for the memory observation stream:

```
RETRY_DELAYS = [3000, 10000, 30000]   // ms; MAX_RETRIES = 3
```

On SSE error:
1. Close the existing `EventSource`, set `memStreaming = false`
2. If `retryCount >= MAX_RETRIES` → `setMemGaveUp(true)` (no further attempts)
3. Otherwise, set `memReconnecting = true`, schedule reconnect after `RETRY_DELAYS[retryCount]`, increment `retryCount`
4. On successful reconnect → `retryCount` resets to 0, `memReconnecting = false`, `memStreaming = true`

The UI shows a "Reconnecting…" banner while `memReconnecting && !memStreaming`, and a permanent "gave up" notice when `memGaveUp`. While reconnecting but no observations have loaded yet, the panel still renders the live-status indicator.

### Memory backup / restore

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/memory/backup` | Download the full SQLite memory DB as a binary attachment (`mem-backup-<date>.db`) |
| POST | `/api/memory/restore` | Upload a SQLite DB file to replace the in-memory store; server responds with `{ok, message}` |

Both endpoints are unprotected in development (no `MIZI_MEM_TOKEN`); in production the token gate applies.

---

## 10. Scheduler

Runs in the API server process, checks every 30 seconds.

### Session scheduler

1. **Auto-launch**: At the configured `launchTime` on enabled days, if no session is currently active, launches a new session.
2. **Safety-net stop**: 2 minutes after the configured `stopTime`, destroys any running session.
3. **Second reminder stop**: If `secondReminderTime` is configured and differs from `stopTime`, a second stop fires 2 minutes after that time.
4. **Dedup**: An in-memory `recentActions` Set keyed by `launch|stop-<dateKey>-<time>` prevents double-firing within the same 30-second interval.

### Design Sync Scheduler

Runs alongside the session scheduler in the same process.

**6-hour safety-net sync**: Full re-ingest of all curated design sources, unconditionally.

**15-minute SHA-check poll**: Fetches the HEAD commit SHA from GitHub (`GET /repos/{owner}/{repo}/commits?per_page=1`). If the SHA has changed since the last recorded `pinnedCommitSha`, triggers an immediate full sync. Skipped if a full sync is already running.

**On-demand sync**: `POST /api/design-intelligence/sync` triggers a background sync outside the schedule. The endpoint returns **immediately** with:

| Condition | Status | Body |
|-----------|--------|------|
| Sync queued | 200 | `{ ok: true, message: "Sync started" }` |
| Already running | 409 | `{ error: "Sync already in progress" }` |

The sync itself runs asynchronously. Progress is reflected in the state tracked by `GET /api/design-intelligence/sources` (see below).

**State tracked in memory** (exposed via `GET /api/design-intelligence/sources`):
- `lastSyncedAt` — timestamp of last successful sync
- `lastAttemptedAt` — timestamp of last attempt (success or fail)
- `lastError` — error message if last sync failed
- `nextSyncAt` — scheduled next full sync time
- `intervalMs` — configured interval (default 6 hours; override with `DESIGN_SYNC_INTERVAL_MS`)
- `isRunning` — whether a sync is currently in progress

---

## 11. API Reference

Base path: `/api`

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sessions` | List all sessions (passwords + ownerToken redacted) |
| POST | `/sessions` | Launch a new session (accepts taskMode, tokenMode, bundleId, repoUrl, repoBranch, repoFingerprint) |
| GET | `/sessions/active` | Get the currently active session (ownerToken redacted) |
| GET | `/sessions/swarm-status-batch?ids=1,2,3` | **New** — batch swarm status for the sessions list (returns map of id → `{availability, snapshot}`) |
| GET | `/sessions/:id` | Get session detail (includes team passwords and ownerToken) |
| DELETE | `/sessions/:id` | Destroy session and Vast.ai instance |
| POST | `/sessions/:id/sync` | Force a Vast.ai API sync |
| POST | `/sessions/:id/status` | **Instance callback** — update status from onstart.sh (authenticated via Bearer token) |

#### Instance callback status values

| `status` field | DB status → | statusMessage |
|----------------|-------------|---------------|
| `services_ready` | `starting` | "Tools ready — LLM model loading in background..." |
| `downloading` | `downloading` | "Downloading model weights..." |
| `starting_llm` | `starting` | "Loading model into GPU memory..." |
| `skills_compiling` | `starting` | "Compiling Smart Skills bundle..." |
| `skills_ready` | `starting` | "Smart Skills loaded — LLM loading in background..." |
| `llm_ready` | `ready` | "Session is ready — vLLM online" |

### GPU Profiles

| Method | Path | Description |
|--------|------|-------------|
| GET | `/profiles` | List all profiles (includes swarmWorkerCap) |
| GET | `/profiles/:id` | Get single profile |

### Offers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/offers` | Search live Vast.ai marketplace |

### Templates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/templates` | List templates |
| POST | `/templates` | Create template |
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

### Design Intelligence

| Method | Path | Description |
|--------|------|-------------|
| GET | `/design-intelligence` | List entries. Query params: `category`, `q` (ILIKE search), `limit` (max 100), `offset` |
| GET | `/design-intelligence/categories` | Distinct categories with entry counts |
| GET | `/design-intelligence/skill-map` | Map of category → related approved skills (explicit links + keyword matching) |
| GET | `/design-intelligence/sources` | Curated sources with pinnedCommitSha + live sync status |
| POST | `/design-intelligence/sync` | Trigger on-demand re-sync. Returns `{ ok: true, message: "Sync started" }` immediately; sync runs async. Returns 409 if already running. |

### Skills

| Method | Path | Description |
|--------|------|-------------|
| GET | `/skills` | List all skills (imported + builtins) |
| GET | `/skills/:skillId` | Skill detail: returns `{ skill, latestManifest, designCategories[] }`. `designCategories` is a deduplicated union of explicit links (`skill_design_categories`) and keyword-matched categories. |
| POST | `/skills/import` | Import skill from a GitHub repo URL |
| GET | `/skills/:skillId/feedback` | List feedback for a skill |
| POST | `/skills/:skillId/feedback` | Submit helpful/unhelpful feedback |
| GET | `/skills/:skillId/performance` | Per-skill eval stats |
| GET | `/skills/leaderboard` | Skill leaderboard (liftOverBaseline, regressionRisk, byRepoKind, byModelFamily) |
| GET | `/skills/evals/runs` | List eval runs (filterable by status, runType, targetSkillId, targetBundleId, taskMode) |
| GET | `/skills/evals/:runId` | Eval run + all variants |
| POST | `/skills/evals/run` | Schedule async eval run |
| POST | `/skills/evals/process-next` | Process next queued eval run (also triggered by scheduler every 60s) |
| GET | `/skills/evals/scoring-presets` | Per-taskMode scoring weight presets and budget config |
| GET | `/sessions/:id/skills` | Skill activations for a session |

### Repo Intelligence

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sessions/repo/status?ids=1,2,3` | **Batch** — `{statuses: {[id]: {indexStatus, isStale, confidenceLevel}}}` |
| POST | `/sessions/:id/repo/index` | Enqueue a repo index job (deduplicates by active status) |
| GET | `/sessions/:id/repo/fingerprint` | Current fingerprint + index status |
| GET | `/sessions/:id/repo/summary` | Repo summary + counts (symbols, chunks, files) |
| GET | `/sessions/:id/repo/search?q=` | Approximate search over symbols/files/chunks/embeddings. Params: `type`, `lang`, `pathPrefix`, `limit`, `offset` |
| GET | `/sessions/:id/repo/blast-radius?file=` | Direct/indirect dependents + affected tests for a file |
| GET | `/sessions/:id/repo/symbol` | Filter symbols by `name`, `path`, `lang`, `kind` |
| GET | `/sessions/:id/repo/jobs/:jobId` | Get a specific index job |
| GET | `/sessions/:id/repo/jobs/pending` | **Auth required** — next queued job for the instance to pick up |
| POST | `/sessions/:id/repo/sync` | **Auth required** — instance pushes index results back |

### Lane Coordination

See [Section 20](#20-lane-coordination) for full endpoint reference.

Key additions from recent tasks:

| Method | Path | Description |
|--------|------|-------------|
| DELETE | `/sessions/:id/lanes/:laneId` | Destroy a lane; emits `lane_destroyed` event; history preserved |
| GET | `/sessions/:id/lanes/:laneId/timeline` | Cursor-paginated lane event history (newest first) |
| GET | `/sessions/:id/lanes/types` | List custom lane types |
| POST | `/sessions/:id/lanes/types` | Register a custom lane type |

### Test Environment Provisioning

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions/:id/provision` | Provision an ephemeral Postgres (or Redis) resource for the session |
| GET | `/sessions/:id/resources` | List provisioned resources (connection strings masked) |
| GET | `/sessions/:id/resources/:resourceId/connection-string` | Reveal full connection string (strict bearer auth required) |
| GET | `/schema-templates` | List SQL DDL templates |
| GET | `/schema-templates/:id` | Get a specific template's DDL |

### Memory

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mem/init` | Start memory session |
| POST | `/mem/observation` | Record tool call |
| POST | `/mem/summarize` | Write session summary |
| GET | `/mem/context/:userId` | Context string for prompt injection |
| GET | `/mem/observations` | List observations |
| GET | `/mem/sessions` | List memory sessions |
| GET | `/memory/sessions` | Global memory sessions |
| GET | `/memory/search?q=` | Global FTS5 search |
| GET | `/memory/backup` | Download full SQLite memory DB as binary attachment |
| POST | `/memory/restore` | Upload a SQLite DB file to replace the memory store |

### Swarm (API server endpoints)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sessions/swarm-status-batch?ids=1,2,3` | Batch swarm status for the sessions list |
| POST | `/sessions/:id/swarm-push` | Claw Runner pushes a new `SwarmSnapshot`; broadcasts to SSE |
| GET | `/sessions/:id/swarm-status` | Dashboard poll (every 3 s); returns `{availability, snapshot}` (hyphenated path) |
| GET | `/sessions/:id/swarm-stream` | SSE stream of live swarm updates; dashboard falls back to polling on error (hyphenated path) |
| POST | `/sessions/:id/swarm/abort` | **Owner-only** — set swarm phase to `aborted`; requires `Authorization: Bearer <ownerToken>` |

### Admin

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/sweep-claims` | Manually trigger `sweepExpiredClaims()`; returns `{deactivated, sweptAt}`. Protected by `X-Admin-Token: <ADMIN_SWEEP_TOKEN>` header equality check when `ADMIN_SWEEP_TOKEN` is set |

### Claw Runner internal HTTP server (port 8080, instance-local)

The Claw Runner exposes a small local HTTP server for in-process tooling:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/swarm/status` | Current `swarmState` snapshot (phase, workers, progress) |
| POST | `/swarm/abort` | Emergency abort — sets `abortRequested=true`, kills in-flight workers |

These are **not** proxied through the API server. The dashboard reaches them via code-server's proxy or the session's direct IP.

---

## 12. Dashboard UI Pages

### `/` — Dashboard
- Active session card with status badge, GPU, cost/hr, and statusMessage
- Swarm pill showing live/stale/unavailable worker status
- "View Cockpit →" button
- Summary stats: total sessions, total spend, scheduler status

### `/sessions` — All Sessions
- Table of all sessions (running + historical)
- **Team / Solo / All filter** — client-side `TeamFilter` toggle (`"all"` | `"team"` | `"solo"`). `"team"` shows only sessions where `teamMembers` is non-empty; `"solo"` the inverse; `"all"` disables the filter. The active option is highlighted; empty-state messages are filter-aware.
- Status badge (`SessionStatusBadge`) and team badge (`TeamSessionBadge`, violet, shows team icon + member tooltips when `teamMembers` is present)
- **Swarm status pills** — refreshed via `/sessions/swarm-status-batch`; show `live`, `stale`, or `unavailable`
- Cost column
- Click → cockpit

### `/sessions/:id` — Cockpit

**Boot log panel** — live status updates (5-second polling).

**Overview tab:**
- "Your coding environment is ready" panel with "Open Coding Environment" button
- Hardware & Access card: GPU, Public IP, SSH command
- Cost & Timing card
- Repo Intelligence panel: index status, symbol count, confidence level, search

**Team tab** (team sessions only):
- Credential table per member with copy-invite button
- Lane coordination panel: per-lane status, active claims, conflict warnings, handoffs; "View draft PR" link on `safe_to_merge` handoffs
- **Overview sub-tab** — current lane state snapshot
- **Timeline sub-tab** — cursor-paginated event history with live SSE append; "Load More" for older events
- Heavy job queue viewer

**Memory tab:**
- Per-session tool observation log (paginated; SSE stream reconnects automatically on disconnect)
- Session summary block
- Full-text search with debounced input

**Skills tab:**
- Active bundle details, skill list, token usage stats

### `/templates` — Templates
- List and manage Vast.ai Docker templates

### `/memory` — Memory
- Global searchable log across all sessions
- Session summaries as styled note blocks
- FTS5 search (debounced, 350ms)
- **Project-path filter** — badge chips for unique project paths; clicking a chip filters the view; clicking again clears it
- Paginated observation list; reconnects automatically to the SSE observation stream on connection loss
- **Backup / Restore** buttons — trigger `GET /api/memory/backup` (file download) and `POST /api/memory/restore` (file upload)

### `/design-intelligence` — Design Intelligence
- Browse 7 canonical categories: `style`, `palette`, `typography`, `chart_type`, `ux_guideline`, `stack_convention`, `ui_reasoning`
- Category list loaded from `GET /api/design-intelligence/categories` (dynamic, DB-driven)
- Search entries with keyword filter (ILIKE, debounced)
- Paginated entry list per selected category
- Skill map: `GET /api/design-intelligence/skill-map` — category → linked approved skills (explicit rows + keyword inference)
- Sync status panel: last sync time, next sync, error state

---

## 13. Environment Variables

### API server

| Variable | Required | Description |
|----------|----------|-------------|
| `VASTAI_API_KEY` | Yes | Vast.ai API key for all instance operations |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PORT` | No | API server port (default: 8080) |
| `MIZI_MEM_TOKEN` | No | Bearer token for memory API (open in dev if not set). Also used to authenticate instance callbacks on `/sessions/:id/status` and `/sessions/:id/repo/*` |
| `MIZI_MEM_PROXY_URL` | No | Public URL of this API server. Defaults to `https://$REPLIT_DEV_DOMAIN` |
| `MIZI_MEM_USER_ID` | No | Memory user scope (default: `operator`) |
| `MEM_DATA_DIR` | No | **New** — Override for SQLite memory DB directory (default: `~/mizi-memory`) |
| `REPLIT_DEV_DOMAIN` | Auto | Set by Replit. Used to construct callback and memory proxy URLs |
| `DESIGN_SYNC_INTERVAL_MS` | No | **New** — Design Intelligence full-sync interval (default: 6 hours = 21 600 000 ms) |
| `ADMIN_SWEEP_TOKEN` | No | **New** — Secret value checked via `X-Admin-Token` request header (header equality, not Bearer) to protect the `/admin/sweep-claims` endpoint |
| `GITHUB_TOKEN` | No | Optional GitHub PAT to increase API rate limits during design intelligence ingest |
| `VULTR_INFERENCE_API_KEY` | No | Vultr Inference provider key; enables the `vultr` NIM provider |
| `TOGETHER_API_KEY` | No | Together AI provider key; enables the `together` NIM provider |
| `DEEPINFRA_API_KEY` | No | DeepInfra provider key; enables the `deepinfra` NIM provider |
| `NEON_API_KEY` | No | Neon API key; enables cloud Postgres branch provisioning for test environments |
| `NEON_PROJECT_ID` | No | Neon project ID to branch from when creating test databases |

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
| `SWARM_MAX_WORKERS` | **New** — Max concurrent Claw Runner workers (from `gpu_profiles.swarmWorkerCap`) |
| `VLLM_API_KEY` | **New** — Optional key for the vLLM server's built-in auth (when set, all litellm → vLLM calls must include it) |
| `MIZI_MEM_PROXY_URL` | Memory API base URL |
| `MIZI_MEM_AUTH_TOKEN` | Memory API bearer token |
| `MIZI_MEM_USER_ID` | Memory user scope |
| `MIZI_SESSION_ID` | Session ID for status callbacks |
| `MIZI_CALLBACK_URL` | Full URL for status callbacks |
| `TEAM_MEMBERS_JSON` | JSON array of team members (team sessions only) |
| `GITHUB_LANE_BRANCHES_ENABLED` | `1` when `enableLaneBranches` is true; signals to in-session tooling that per-member branches are active |

---

## 14. Vast.ai Integration

All interaction goes through `artifacts/api-server/src/services/vastai.ts`.

### Key operations

**Search offers** (`POST /bundles/`)
- Filters: `gpu_name`, `num_gpus`, `gpu_ram` (gte), `disk_space`, `dph_total` (lte)
- Orders by `dph_total asc` (cheapest first)
- Returns `VastOffer[]`

**Create instance** (`PUT /asks/:offerId/`)
- Passes: Docker image, env dict (port mappings + model env + `SWARM_MAX_WORKERS` + `VLLM_API_KEY`), onstart script, disk size, template hash
- Returns: `{ new_contract: instanceId, expected_price }`

**Get instance** (`GET /instances/:id/`)
- Returns: `actual_status`, `status_msg`, `public_ipaddr`, `ports`, `dph_total`, `cost_run_time`
- `actual_status`: `loading` → `creating` → `running` → `exited` / `error`

**Destroy instance** (`DELETE /instances/:id/`)

**Create/update template** (`POST /templates/` and `PUT /templates/:id/`)

### Port mapping
```typescript
"-p 8080:8080": "1",   // code-server
"-p 8081:8081": "1",   // litellm proxy
"-p 5180:5180": "1",   // nginx → Bolt.diy
"-p 5181:5181": "1",   // nginx → Claw Runner
"-p 3000:3000": "1",   // nginx preview
```

### Cost fields
- `dph_total` — actual running $/hr
- `cost_run_time` — cumulative cost (preferred; fall back to `dph_total × hours` if null)
- `expected_price` — estimate at creation (often 0)

---

## 15. Docker Image

`gheeklabs/coding-env:latest` (CUDA 12.4 cudnn-runtime base)

### What's pre-installed

- CUDA 12.4 + cuDNN (cudnn-runtime base)
- Python 3 + pip
- **vLLM == 0.19.0** (exact pin; CUDA 12.4 wheels from PyPI `--extra-index-url https://download.pytorch.org/whl/cu124`)
- **transformers >= 5.3.0** (required by GLM-5.1 FP8 tokeniser and GLM-4 tool-call parser; also benefits Qwen3 and MiniMax M2.5)
- **DeepGEMM** (optional FP8 GEMM kernel from `deepseek-ai/DeepGEMM` at pinned SHA via build arg `DEEPGEMM_SHA`; installed with `pip install --no-cache-dir git+https://github.com/deepseek-ai/DeepGEMM@<SHA>`. Falls back gracefully if CUDA compilation fails — vLLM's built-in triton FP8 kernels remain fully functional)
- litellm
- huggingface-cli
- code-server
- Node.js 20 + pnpm 9
- Bolt.diy (`/opt/bolt-diy`)
- claw-code binary (`/usr/local/bin/claw`) — built from bundled Rust source in a separate builder stage
- Claw Runner (`/opt/claw-runner.js`)
- Repo Intelligence scripts (`/opt/repo-intelligence/`) — Node.js + better-sqlite3
- nginx + apache2-utils
- SSH server (openssh-server)
- jq, tmux, htop, vim, nano

### Build stages
The Dockerfile uses a two-stage build:
1. **`claw-builder`** (`ubuntu:22.04`) — installs Rust toolchain, compiles `claw` from `docker/claw-code-src/` into `/usr/local/bin/claw`
2. **Runtime** (`nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04`) — installs all services and copies `claw` from the builder

### Build args
- `UBUNTU_VERSION` (default `22.04`)
- `CUDA_VERSION` (default `12.4.1`)
- `DEEPGEMM_SHA` (default `a7b3d1e`) — pin to a specific DeepGEMM commit for reproducible FP8 kernel builds

### Model weights
Not included in the image — downloaded at runtime by `huggingface-cli` into `/workspace/models/$MODEL_QUANT/`.

---

## 16. Boot Script (onstart.sh)

The `buildOnStartScript()` function in `vastai.ts` generates a wrapper that sets environment variables (including the new `SWARM_MAX_WORKERS` and optionally `VLLM_API_KEY`) and then calls `/opt/onstart.sh`.

### Generated wrapper structure

```bash
#!/bin/bash
export MODEL_REPO="unsloth/Kimi-K2.6-GGUF"
export MODEL_QUANT="kimi-k2.6"
export SERVED_MODEL_NAME="kimi-k2-6"
export VLLM_MAX_MODEL_LEN="32768"
export VLLM_MAX_NUM_SEQS="768"
export VLLM_EXTRA_ARGS="--enable-expert-parallel"
export NUM_GPUS="4"
export SWARM_MAX_WORKERS="48"         # from gpu_profiles.swarmWorkerCap
# export VLLM_API_KEY="..."           # optional, omitted if not set
export MIZI_MEM_PROXY_URL="https://your-api.replit.dev"
export MIZI_MEM_AUTH_TOKEN=""
export MIZI_MEM_USER_ID="operator"
export MIZI_SESSION_ID="42"
export MIZI_CALLBACK_URL="https://your-api.replit.dev/api/sessions/42/status"
# (team sessions only):
export TEAM_MEMBERS_JSON='[{"name":"__shared__","password":"abc","path":"/shared/"},{"name":"alice","password":"xyz","path":"/ide/alice/"}]'
/opt/onstart.sh
```

### onstart.sh phases

**Phase 1** (sequential, completes in ~30 seconds):
1. Generate code-server password
2. Start SSH server
3. Start code-server (owner, port 8080 solo or 8090 team)
4. Start Claw Runner (port 5182; picks up `SWARM_MAX_WORKERS` to enforce concurrency limit)
5. Start Bolt.diy (port 5173)
6. Configure nginx htpasswd + server blocks
7. Start nginx
8. (Team only) Build per-member nginx config, start per-member code-server instances
9. Compile Smart Skills bundle → `report_status skills_compiling` / `skills_ready`
10. (If `repoUrl` provided) Kick off Repo Intelligence indexer → `report_status services_ready`
11. `report_status services_ready` → POSTs to `MIZI_CALLBACK_URL`

**Phase 2** (background subshell, takes 10–45 min):
1. Check model cache at `/workspace/models/$MODEL_QUANT/`
2. If not cached: `report_status downloading` → `huggingface-cli download`
3. `report_status starting_llm` → start vLLM on port 8082 (with runtime flag-gating)
4. Start litellm proxy on port 8081
5. Wait for `/health` on vLLM (polls every 5s, up to 600s)
6. Configure `/etc/environment` + `/root/.bashrc` with `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`
7. `report_status llm_ready`
8. Watchdog loop: restart vLLM if it dies (checks every 30s)

### `report_status` helper
Calls `MIZI_CALLBACK_URL` with `Authorization: Bearer $MIZI_MEM_AUTH_TOKEN`. Safe no-op if URL is not set. On failure it logs a warning but does not abort the boot sequence.

### Runtime flag-gating
`onstart.sh` probes `python3 -m vllm.entrypoints.openai.api_server --help` before starting and removes any `VLLM_EXTRA_ARGS` flags not present in the help output. This keeps the image forward-compatible with future vLLM versions that may rename or remove flags.

---

## 17. Design Intelligence

Design Intelligence is a system for ingesting, storing, and querying curated UI/UX design patterns, making them available both via API and linked to the Smart Skills catalogue.

### Data source
The primary source is `nextlevelbuilder/ui-ux-pro-max-skill` on GitHub. Data is auto-discovered from all CSV files under `src/ui-ux-pro-max/` (root CSVs + `stacks/` subdirectory). Scripts and CLI directories are excluded.

### Ingest pipeline (`curated-sources.ts`)

1. **HEAD SHA fetch** — `GET /repos/{owner}/{repo}/commits?per_page=1`
2. **SHA-aware idempotence** — if `pinnedCommitSha` matches AND entries already exist → skip; if entries are missing despite SHA match → re-ingest
3. **Tree discovery** — `GET /repos/{owner}/{repo}/git/trees/HEAD?recursive=1` to list all `.csv` files
4. **Deterministic fetch** — all CSV raw file URLs are pinned to the resolved `headSha` (`https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}`)
5. **Category mapping** — filename stem is mapped to a canonical category; `stacks/` subdirectory always maps to `stack_convention`
6. **Upsert** — `INSERT ... ON CONFLICT (source_id, category, name) DO UPDATE SET data_json = EXCLUDED.data_json`
7. **SHA pin update** — `pinnedCommitSha` is updated only after a successful ingest

### Categories

The **7 canonical `DesignCategory` values** auto-populated by the default ingest pipeline:

| Category | Description |
|----------|-------------|
| `style` | Visual style entries (components, icons, interfaces) |
| `palette` | Colour palettes |
| `typography` | Font pairings, scales |
| `chart_type` | Chart type recommendations |
| `ux_guideline` | UX rules and heuristics |
| `stack_convention` | Framework and library conventions (from `stacks/`) |
| `ui_reasoning` | AI-assisted UI reasoning patterns |

> **Implementation note:** The `DesignCategory` TypeScript union type also includes `anti_pattern` as a defined value. It is schema-valid, but no default CSV file maps to it (not auto-ingested). It can be populated via custom source ingestion if needed.

### Derived skills (seeded at startup)
Six design-intelligence skills are derived from the `nextlevelbuilder/ui-ux-pro-max-skill` source and seeded as default skills:

| Skill ID | Class | Triggers | Token overhead |
|----------|-------|----------|----------------|
| `design-intelligence-core` | doctrine | build, review, refactor | 200 |
| `ui-ux-reasoning` | workflow | build, refactor | 190 |
| `design-system-scaffold` | workflow | build, refactor | 210 |
| `frontend-design-review` | workflow | review | 170 |
| `dashboard-viz-guidance` | context | build, refactor | 190 |
| `design-handoff-discipline` | workflow | build, review | 195 |

All six are compatible with `kimi`, `qwen`, `glm`, `deepseek`, `minimax` models and `claw`/`vscode` interfaces. They have `shellExecution: none` and `networkAccess: none`.

### Lane policy wiring
The **UX lane** (`compileLaneBundles` / `lane-policy.ts`) includes `design-intelligence-core` and `ui-ux-reasoning` in its `defaultOverlaySkillIds`, ensuring every UX lane starts with design doctrine active. The `dashboard-viz-guidance` skill is conditionally injected for general lanes whose repo contains frontend languages.

### Live context injection (bundle compilation)
When compiling a session bundle, `skills-bundler.ts` queries `design_intelligence_entries` and injects top-N entries into the active prompt context:

| Token mode | Entries injected |
|------------|-----------------|
| `full` | Up to 10 |
| `core` | Up to 5 |
| `lean` | 0 (skipped — token budget constraint) |
| `ultra` | 0 (skipped — token budget constraint) |

Scoring: each candidate entry is scored by `tagOverlap × 2 + categoryBoost`. High-priority categories (`ux_guideline`, `ui_reasoning`, `palette`, `typography`) receive a +1 categoryBoost. Entries are filtered to those whose tags overlap with the repo's detected languages + frameworks; falls back to all entries when no stack-tagged entries exist. Up to `MAX_CANDIDATE_ROWS = 200` candidate rows are fetched before top-N selection.

### Trust model
Legacy `skill_sources` records with incorrect `sourceType` or `trustLevel` are automatically corrected to `sourceType="curated"` / `trustLevel="reviewed"` on next ingest.

### Skill-map endpoint
`GET /api/design-intelligence/skill-map` returns a map of `category → SkillSummary[]` using two resolution strategies:
1. **Explicit links** — rows in `skill_design_categories` (`matchMethod="manual"`)
2. **Keyword matching** — keyword tokens from the category name are matched against the skill's `name`, `description`, `class`, and `slug` fields (min 3-character tokens)

Only `reviewStatus="approved"` skills appear in the skill map.

---

## 18. Swarm Orchestration

Swarm Orchestration lets the Claw Runner spawn multiple concurrent LLM sub-agents (workers) for parallelised agentic tasks, while enforcing per-profile concurrency limits to prevent KV-cache exhaustion.

### swarmWorkerCap
Each `gpu_profiles` row carries `swarmWorkerCap` (integer, nullable). This value is injected into the container as `SWARM_MAX_WORKERS`. The Claw Runner reads `SWARM_MAX_WORKERS` at startup and uses it as a hard ceiling on concurrent worker goroutines — no model-awareness required on the instance side.

### Per-profile guidance

| Profile tier | swarmWorkerCap | Notes |
|---|---|---|
| Starter (1× 4090) | 16 | Marginal — prefer Standard+ for swarm |
| Standard (4× 4090) | 48 | Comfortable for moderate swarm |
| Pro (4× A100) | 100 | Strong headroom |
| Ultra (8× H100) | 200 | Near-full swarm capability |
| Qwen3 Pro (8× A100) | 250 | Highest: 3B active params = tiny per-worker footprint |
| GLM-5.1 Ultra | 4 | Severely constrained: 0.98 GPU memory utilisation |

### Swarm snapshot
The API server push handler is:

```
POST /sessions/:sessionId/swarm-push
```

The Claw Runner determines its push target at startup by applying a regex substitution to `MIZI_CALLBACK_URL`:

```js
const swarmCallbackUrl = MIZI_CALLBACK_URL.replace(/\/status$/, '/swarm-status');
```

**Important:** The Claw Runner sends snapshots to the path ending in `/swarm-status`; the API server handler is at `/swarm-push`. These suffixes differ because the derivation regex targets `/status` (the regular status-callback suffix). For swarm push to function, `MIZI_CALLBACK_URL` must be configured to **not end in `/status`** so the regex is a no-op, or an HTTP alias must forward `/swarm-status` requests to the `/swarm-push` handler. This is a known discrepancy in the current implementation.

Snapshots are stored in `sessions.swarmSnapshotJson` and cached in-memory. The server broadcasts each incoming snapshot to all open SSE connections on that session.

### Per-session swarm endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | `/sessions/:id/swarm-push` | Claw Runner pushes a new `SwarmSnapshot`; broadcasts to SSE subscribers |
| GET | `/sessions/:id/swarm-status` | Dashboard polls every 3 s; returns `{availability, snapshot}` from cache or DB |
| GET | `/sessions/:id/swarm-stream` | SSE stream — server sends snapshot events in real time; dashboard falls back to polling on error |

### Batch swarm status
`GET /api/sessions/swarm-status-batch?ids=1,2,3` returns:
```json
{
  "1": { "availability": "live",        "snapshot": { ... } },
  "2": { "availability": "stale",       "snapshot": { ... } },
  "3": { "availability": "unavailable", "snapshot": null }
}
```
`availability` values: `starting` | `live` | `stale` | `unavailable`

The dashboard sessions list uses this batch endpoint to refresh all swarm pills in a single request.

### Concurrency model
Two constants control parallelism:
- `SWARM_MAX_WORKERS` — hard ceiling injected from `gpu_profiles.swarmWorkerCap` (env var); default `4` if unset.
- `SWARM_CONCURRENCY` — effective fan-out: `min(parseInt(SWARM_CONCURRENCY env, 10), SWARM_MAX_WORKERS)`. Defaults to `SWARM_MAX_WORKERS`. Allows temporary over-subscription without exceeding the profile cap.

### Orchestrator decompose-block protocol
The orchestrator LLM is invited to emit a structured decomposition block. The block must use exact sentinel markers:

```
@@DECOMPOSE_START@@
[ { "id": "...", "task": "...", "goal": "...", "inputs": "...", "expected_output": "...", "priority": 1 } ]
@@DECOMPOSE_END@@
```

**The block content MUST be a JSON array directly** (not an object with a `subtasks` key). If `JSON.parse()` produces a non-array, `parseDecomposition()` returns `error: 'decomposition block is not a JSON array'` which causes `gate_rejected`. Malformed JSON is also treated as `gate_rejected`.

`priority` is an optional positive integer (1 = highest priority; default `5`). The remaining fields — `id`, `task`, `goal`, `inputs`, `expected_output` — are all **required** per subtask.

If the orchestrator explicitly chooses sequential execution, it may optionally emit a `@@SEQUENTIAL_REASON@@:` marker instead; `parseSequentialReason()` extracts the reason text and the run is recorded as `swarm_skipped`.

### Gate validation
After parsing, the decomposition is validated by `validateDecomposition()` before workers are launched. Any of the following causes a `gate_rejected` event and triggers single-agent fallback:

- Subtask count < 2 or > `SWARM_MAX_WORKERS`
- Any subtask entry is not a plain object
- Subtask contains unknown fields. Allowed set (strict): `{ id, task, goal, inputs, expected_output, priority }`
- Any of the **five required** fields missing or empty: `id` (string), `task` (non-empty string), `goal` (non-empty string), `inputs` (non-empty), `expected_output` (non-empty string). All five must be present.
- Duplicate `id` values across subtasks
- `task` description is fewer than 10 characters (lacks specificity)
- `priority` field is present but is not a positive integer
- **Near-duplicate detection** — Levenshtein similarity between any two subtasks' `task` strings (both lowercased) exceeds `0.85`. `levenshteinSimilarity(a, b)` returns a normalized score in `[0, 1]`.
- **Sequential markers** — `task` text contains any of these exact phrases (case-insensitive): `"after worker"`, `"depends on worker"`, `"once worker"`, `"wait for worker"`

### Worker priority and execution order
Workers are sorted ascending by `priority` (1 = highest) before dispatch. Workers with equal priority share a concurrency slot; the scheduler dispatches up to `SWARM_CONCURRENCY` workers simultaneously from the sorted queue. Each worker runs in its own tmux session, receives shared context from the orchestrator output (up to 3000 chars preceding the decompose block), and writes its result to a dedicated output file.

### Shell-token sanitization
`sanitizeShellToken(str)` strips or escapes shell-unsafe characters from subtask IDs before they are interpolated into shell commands. Workers receive a `shellId` (sanitized) which is used for all file paths and tmux session names. The raw model-emitted `id` is never used directly in shell.

### Worker retry
Each worker gets one automatic retry (`SWARM_WORKER_RETRY = 1`) on transient failure, provided `abortRequested` is not set. A `worker_retry` event is emitted before the retry attempt.

### Single-agent fallback
When the gate rejects a decomposition (`gate_rejected`), a single-agent fallback (`runSingleAgentFallback`) is triggered immediately. The fallback runs the original task directly via claw in a fresh tmux session (without swarm prompt injection) so the task always completes. The orchestrator output already written to `OUTPUT_FILE` is not discarded — the fallback overwrites it only on success.

### Abort flow
Two abort paths exist:

**API server (dashboard-initiated):** `POST /api/sessions/:id/swarm/abort` — requires `Authorization: Bearer <ownerToken>`. The API server validates the token, updates `sessions.swarmSnapshotJson` to phase `aborted`, clears the in-memory cache, and returns the aborted snapshot. The Claw Runner picks up the abort when it next polls `swarm-status`.

**Claw Runner local HTTP (in-process):** `POST /swarm/abort` on port 8080 — sets `swarmState.abortRequested = true` directly. In-flight workers finish their current inference call but are not retried. After all in-flight calls complete, the swarm phase is set to `aborted` and a `swarm_aborted` event is emitted.

The dashboard reads `ownerToken` from `GET /api/sessions/:id` (the only endpoint that exposes it) and sends it as `Authorization: Bearer <ownerToken>` on the API server abort call.

### Event taxonomy
All swarm events carry `{ event_type, payload, timestamp }` and are streamed via the push-callback mechanism:

| Event type | Emitted when |
|------------|-------------|
| `task_start` | Task begins processing |
| `swarm_start` | Gate passes; workers about to be dispatched |
| `swarm_skipped` | Orchestrator chose sequential execution |
| `gate_rejected` | Gate validation failed; fallback triggered |
| `worker_start` | Individual worker begins |
| `worker_retry` | Worker retrying after transient failure |
| `worker_done` | Worker completed successfully |
| `worker_failed` | Worker failed (after retries exhausted) |
| `swarm_synthesis_start` | Synthesis LLM call begins |
| `swarm_synthesis_done` | Synthesis complete |
| `swarm_synthesis_error` | Synthesis LLM call failed |
| `swarm_aborted` | Emergency abort completed |
| `swarm_error` | Unexpected orchestration error |
| `single_agent_fallback_start` | Fallback execution begins |
| `single_agent_fallback_done` | Fallback completed |
| `single_agent_fallback_error` | Fallback failed |
| `task_complete` | Task finished |
| `task_stopped` | Task stopped externally |
| `swarm_abort_requested` | Abort signal received |
| `user_ask` | Model emitted an interactive question |
| `tool_use` / `tool_result` | Tool call / result during execution |

---

## 19. Repo Intelligence

Repo Intelligence indexes a Git repository on the instance and exposes the result via the API for code-aware features: symbol lookup, blast-radius analysis, natural-language search, and file embedding.

### Architecture
The Repo Intelligence indexer runs as a Node.js script (`/opt/repo-intelligence/`) on the instance, using `better-sqlite3` as a local scratch store. When indexing completes, it POSTs the full result (symbols, files, edges, chunks, optional embeddings) back to `POST /api/sessions/:id/repo/sync`.

### Index lifecycle

```
POST /api/sessions/:id/repo/index
  → Creates repo_graph_jobs row (status: "queued")
  → Updates/creates session_repo_context (indexStatus: "queued", isStale: true if re-index)
  → Deduplicates: if an active job already exists for (sessionId, repoPath), returns the existing job

Instance picks up job via GET /api/sessions/:id/repo/jobs/pending (auth required)
  → Runs phases: scanning → fingerprinting → indexing_graph → indexing_fts → indexing_vectors → summarizing
  → POSTs result to POST /api/sessions/:id/repo/sync
  → API stores result in session_repo_context

GET /api/sessions/:id/repo/summary  → index status + counts
GET /api/sessions/:id/repo/search?q=  → approximate symbol/chunk/embedding search
GET /api/sessions/:id/repo/blast-radius?file=  → direct dependents + affected tests
GET /api/sessions/:id/repo/symbol  → filtered symbol list
```

### Confidence levels

Computed by `computeConfidenceLevel()` in `routes/repo.ts` from the content of the incoming sync payload:

| Level | Meaning |
|-------|---------|
| `none` | No index exists |
| `fingerprint` | Repo fingerprint only (no symbols or summary) |
| `partial` | Symbols + dependency edges present, or summary present, but no embeddings |
| `full` | Symbols + edges + embeddings all present |

### Hybrid retrieval: BM25 + n-gram semantic + graph centrality
`GET /api/sessions/:id/repo/search` runs `hybridRepoSearch()` which fuses three retrieval signals:

1. **BM25 lexical** — SQLite FTS5 full-text search over symbol names, file paths, and chunk text
2. **N-gram semantic** — Character n-gram TF-IDF at **512 dimensions** (`NGRAM_DIM = 512` / `NGRAM_DIM_SEARCH = 512`). Vectors are computed both at index time (`SYNC_NGRAM_DIM = 512` in `repo-indexer.mjs`) and at query time (on the API server). Cosine similarity is used. A result only enters the semantic ranking list if its cosine score exceeds `SEMANTIC_ADMISSION_THRESHOLD = 0.15`. If stored embeddings have a different dimension than 512, the server re-computes n-gram vectors on the fly (cross-dim cosine avoided).
3. **Graph centrality** — Symbol dependency edge count used to boost highly-connected nodes

If a ONNX model produces non-512 embeddings (e.g. 768-dim MiniLM or 1536-dim OpenAI), those are stored as-is; the semantic pass on the API server always queries in 512-dim n-gram space and falls back to re-encoding if the stored dim differs.

### Stale flag
When a new index job is enqueued for a session that already has a `ready` index, `isStale` is set to `true`. Existing results remain queryable while the new job runs.

### Batch status
`GET /api/sessions/repo/status?ids=1,2,3` returns `{statuses: {[sessionId]: {indexStatus, isStale, confidenceLevel}}}` — used by the sessions list to show repo intelligence indicators per row.

### Authentication
`GET /sessions/:id/repo/jobs/pending` and `POST /sessions/:id/repo/sync` require `Authorization: Bearer <MIZI_MEM_TOKEN>`. In development (`NODE_ENV=development`) with no token configured, requests are allowed (fail-closed in production).

### Repo fingerprint at session launch
When `repoUrl` is passed to `POST /sessions`, the API fetches the repo's language breakdown and common marker files (package.json, requirements.txt, go.mod, etc.) from the GitHub API and stores the derived fingerprint in `sessions.repoFingerprintJson`. This lets the skill bundler pre-select languages before the on-instance indexer runs.

---

## 20. Lane Coordination

Lane Coordination gives team sessions per-member work lanes with claim-based file ownership, conflict detection, handoffs between lanes, a weighted heavy-job scheduler for compute-intensive tasks, per-member git sub-branches, automatic draft PR creation, and a full event timeline.

### Database tables

**`session_lanes`** — one row per team member's active work context.

| Column | Description |
|--------|-------------|
| `sessionId` | Parent session |
| `memberIdentifier` | Team member name |
| `laneType` | `ux` / `debug` / `backend` / `review` / `general` — or any slug from `custom_lane_types` |
| `taskMode` | `build`, `review`, etc. |
| `status` | `active` / `blocked` / `review-needed` / `ready-to-merge` |
| `overlayBundleId` | Per-lane Smart Skills overlay bundle (compiled asynchronously on lane create) |
| `tokenMode` | `core` / `full` / `extended` |
| `currentTask` | Free-text description of current task |

**`custom_lane_types`** — operator-defined extensions to the five built-in lane types.

| Column | Description |
|--------|-------------|
| `slug` | Unique identifier for the custom type |
| `displayName` | Human label |
| `policyOverrides` | jsonb: subset of `LanePolicy` fields (claimTtlSec, blastRadiusLimit, allowedClaimTypes) |
| `sessionId` | Optional: scoped to a session (null = global) |

The effective policy for any lane — built-in or custom — is resolved via `getLanePolicyAsync()`, which looks up `custom_lane_types` for unknown slugs and falls back to the nearest built-in policy.

**`lane_claims`** — file/symbol ownership assertions per lane.

| Column | Description |
|--------|-------------|
| `laneId` | Parent lane |
| `claimType` | `file` / `module` / `symbol` / `task` |
| `pathOrSymbol` | File path or symbol name |
| `symbols` | jsonb: optional list of specific symbol names within the file |
| `claimStrength` | `watching` / `editing` / `owner` |
| `expiresAt` | Claim TTL (default 5 minutes; refreshed via heartbeat) |
| `lastHeartbeatAt` | Last keepalive time |
| `active` | Boolean; partial unique index on `(laneId, pathOrSymbol) WHERE active=true` |

**`lane_handoffs`** — signals between lanes.

| Column | Description |
|--------|-------------|
| `laneId` | Originating lane |
| `handoffType` | `blocked` / `needs_review` / `safe_to_merge` / `watch_files` / `related_lane` |
| `notes` | Free-text message |
| `watchFiles` | JSON: `{toLaneIds, resourcePaths}` |
| `status` | `pending` / `acknowledged` / `dismissed` / `expired` |
| `acknowledgedAt` | When recipient acknowledged |
| `prUrl` | Auto-populated when a `safe_to_merge` handoff triggers a GitHub draft PR |

**`lane_events`** — append-only audit log for the Timeline tab.

| Column | Description |
|--------|-------------|
| `sessionId` | FK → sessions (lane history accessible even after lane deletion) |
| `laneId` | Lane ID (no FK constraint — history outlives deleted lanes) |
| `eventType` | `lane_created` / `lane_destroyed` / `claim_created` / `claim_released` / `claim_expired` / `handoff_sent` / `handoff_acknowledged` / `heavy_job_started` / `heavy_job_completed` |
| `actorId` | Member or system identifier |
| `metadata` | jsonb: event-specific payload |
| `createdAt` | Timestamp |

**`lane_heavy_jobs`** — compute-intensive tasks queued from lanes.

| Column | Description |
|--------|-------------|
| `sessionId` | Parent session |
| `laneId` | Originating lane (nullable) |
| `jobClass` | `indexing` / `embedding` / `eval` / `blast_radius` / `compile` / `other` |
| `status` | `queued` / `running` / `deferred` / `completed` / `failed` |
| `priority` | Integer; lower = higher priority (5 = normal, 3 = eval) |
| `ageWeight` | Increases over time to prevent starvation |
| `laneWeight` | Fairness weight across lanes (default 1.0) |
| `effectiveScore` | Computed: `priority × ageWeight × laneWeight` |

### Claim strength mapping

| API float | DB enum | Meaning |
|-----------|---------|---------|
| 0.0–0.39 | `watching` (→ 0.3) | Read-only interest |
| 0.40–0.74 | `editing` (→ 0.6) | Actively editing |
| 0.75–1.0 | `owner` (→ 0.9) | Exclusive ownership |

### Conflict detection
On `POST .../claim`, the API:
1. Upserts the claim (atomic `ON CONFLICT DO UPDATE` on the partial unique index)
2. Loads all active claims from other lanes in the same session
3. Computes `overlapScore` between the new resource path and each other lane's paths
4. Returns `overlaps[]` with `conflictingLaneId`, `conflictingMember`, `overlapScore`, and `recommendation` (`no_conflict` / `warn` / `block`)
5. Returns `overallRecommendation` (most severe overlap across all other lanes)

**Symbol-level precision:** When both the incoming claim and a competing claim carry a non-empty `symbols` list, the overlap check compares the symbol sets instead of the file path. If the symbol sets do not intersect, the score contribution is 0 (no conflict). This eliminates false positives when two lanes edit different functions within the same file.

Overlap scoring: path-prefix and exact-match heuristics. Score ≥ 0.75 → `block`, ≥ 0.4 → `warn`.

### Claim heartbeat and expiry
Claims expire if `expiresAt` is past or if `lastHeartbeatAt` is older than `LANE_HEARTBEAT_WINDOW_SECONDS`. The claim endpoint supports `?heartbeat=true` to refresh both fields without releasing the claim.

### Claim sweeper
`sweepExpiredClaims()` (in `services/claim-sweeper.ts`) performs a bulk `UPDATE lane_claims SET active=false WHERE (expiresAt < now OR lastHeartbeatAt < cutoff) AND active=true`. It runs as a background job on a **30-second** interval via `startClaimSweeper()` at startup. Claims are deactivated (not deleted) to preserve audit history.

A separate **purge** job (`startClaimPurger()`) runs **hourly** and permanently deletes inactive claims whose `expiresAt` is older than the 7-day retention window. This keeps the `lane_claims` table lean without affecting in-flight operations.

Admin manual trigger: `POST /api/admin/sweep-claims` — calls `sweepExpiredClaims()` immediately and returns `{deactivated, sweptAt}`. Protected when `ADMIN_SWEEP_TOKEN` is set: request must include header `X-Admin-Token: <token>` (checked by string equality, not Bearer scheme).

### Lane overlay bundles
When a lane is created, `compileLaneBundles()` is called asynchronously (fire-and-forget) to compile per-lane Smart Skills overlays. Each overlay adapts the base session bundle for the lane's `laneType`, `taskMode`, and `tokenMode`. The resulting `overlayBundleId` is stored on `session_lanes`.

### Per-member git sub-branches

When a session is created with a GitHub token and `enableLaneBranches` is not explicitly set to `false`, each lane's claw-bridge is configured to push to `mizi/session-{id}/{member-slug}` instead of the shared `mizi/session-{id}` branch. Branch names are derived via `getLaneBranchName(sessionId, memberIdentifier)` in `services/lane-branch.ts`. The env var `GITHUB_LANE_BRANCHES_ENABLED=1` is injected into the container so in-session tooling can detect this mode.

### Auto-draft PR on `safe_to_merge`

When a lane sends a `safe_to_merge` handoff signal, the coordination route fires `createDraftPullRequest()` (from `services/github-pr.ts`) as a non-blocking async operation. The PR is opened on GitHub with:
- **Head branch**: `mizi/session-{id}/{lane-slug}`
- **Base branch**: the session's repo default branch
- **Title**: auto-generated from lane metadata
- **Body**: identifies the lane and session, links back to MIZI

The resulting `prUrl` is stored on the `lane_handoffs` row and broadcast via `coordination_update` so the Team tab picks it up on the next poll. The operation is non-fatal — PR creation failure is logged as a warning but does not block the handoff.

### Lane event timeline

`lane-event-emitter.ts` is the unified write path: every coordinator action that should be auditable calls `emitLaneEvent({ sessionId, laneId, eventType, metadata })`, which:
1. Inserts a row into `lane_events`
2. Broadcasts the event via `lane-sse-broadcaster.ts` to any open SSE connections on that lane

`GET /sessions/:id/lanes/:laneId/timeline` returns cursor-paginated events (newest first). Deleted lanes' history remains queryable via `sessionId` scoping. The dashboard Timeline sub-tab auto-appends new events via SSE while open and shows a "Load More" button for pagination.

### SSE broadcaster
`GET /api/sessions/:id/coordination/stream` streams real-time coordination updates via SSE. Triggered on lane create/update, claim create/release, and handoff create.

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sessions/:id/lanes` | List lanes with active claims + policies. Expires stale claims first. |
| POST | `/sessions/:id/lanes` | Create lane. Async overlay bundle compilation. |
| PUT | `/sessions/:id/lanes/:laneId` | Update lane (laneType, status, tokenMode, currentTask) |
| DELETE | `/sessions/:id/lanes/:laneId` | Destroy a lane. Emits `lane_destroyed` event. |
| POST | `/sessions/:id/lanes/:laneId/claim` | Create/refresh claim. Returns overlaps + recommendation. |
| DELETE | `/sessions/:id/lanes/:laneId/claim/:claimId` | Release claim. `?heartbeat=true` refreshes instead. |
| POST | `/sessions/:id/lanes/:laneId/handoff` | Create handoff signal. `safe_to_merge` triggers async PR creation. |
| GET | `/sessions/:id/lanes/:laneId/timeline` | Paginated lane event history (newest first; `?cursor=` for pagination) |
| GET | `/sessions/:id/lanes/:laneId/conflicts` | Active conflicts for a lane |
| GET | `/sessions/:id/lanes/types` | List custom lane types |
| POST | `/sessions/:id/lanes/types` | Register a custom lane type |
| POST | `/sessions/:id/heavy-jobs` | Enqueue a heavy job |
| GET | `/sessions/:id/heavy-jobs` | List heavy jobs (filterable by status/class) |
| POST | `/sessions/:id/heavy-jobs/:jobId/running` | Mark job running |
| POST | `/sessions/:id/heavy-jobs/:jobId/completed` | Mark job completed with result |
| POST | `/sessions/:id/heavy-jobs/:jobId/failed` | Mark job failed |
| POST | `/sessions/:id/heavy-jobs/:jobId/deferred` | Defer job until timestamp |
| GET | `/sessions/:id/heavy-jobs/next` | Peek next job by effective score |
| GET | `/sessions/:id/coordination/stream` | SSE stream of real-time coordination updates |

#### Coordination stream — visibility-trigger reconnect
The `useCoordinationStream` hook skips opening the SSE connection when the browser tab is hidden:

```js
if (document.visibilityState !== "visible") return;  // early return — do not open stream
```

When the tab regains visibility (`visibilitychange` event), the hook re-runs and opens a fresh `EventSource`. This prevents unnecessary SSE connections for background tabs.

---

## 21. GitHub CI/CD

All CI/CD is defined in `.github/workflows/`. Supporting GitHub config lives in `.github/` (CODEOWNERS, Dependabot, issue/PR templates, labels).

### `ci-all.yml` — Main CI trigger
Fires on `pull_request`, `push` to `main`, and `merge_group` events.

- **Concurrency**: cancels in-progress runs for the same PR branch; push-to-main and merge_group runs are never cancelled.
- **`detect-changes` job**: uses `dorny/paths-filter` to determine which packages changed (`api` and/or `dashboard`). Shared config changes (workspace root, tsconfig, lib/) trigger a full build.
- **`ci` job**: calls the reusable `ci.yml` workflow with `api_changed` and `dashboard_changed` boolean inputs.

### `ci.yml` — Reusable CI
Called by `ci-all.yml`. Runs on `ubuntu-latest`.

**`typecheck` job** (always runs):
- `pnpm install --frozen-lockfile`
- `pnpm run typecheck` — TypeScript type-check across all packages

**Build/lint jobs** (only when affected package changed):
- API: esbuild compilation check
- Dashboard: Vite build check

### `commitlint.yml`
Enforces Conventional Commits format on PR title + commits.

### `codeql.yml`
GitHub CodeQL static analysis for JavaScript/TypeScript. Triggers:
- `pull_request` (all PRs) — PR scans are cancellable
- `push` to `main`
- Weekly schedule (Mondays 07:00 UTC, `cron: "0 7 * * 1"`)

Push-to-main and scheduled scans use a unique `run_id` concurrency key so they are never cancelled.

### `docker-build.yml`
Builds and pushes `docker/Dockerfile` to Docker Hub automatically on every push to `main` that touches `docker/**`, and on `workflow_dispatch`. Additionally, any pull request that touches `docker/**` triggers a build-only validation job so broken Dockerfiles are caught before merge.

**PR validation**: on `pull_request` events the workflow runs the full build (no push) without logging in to Docker Hub and without writing to the registry cache. This ensures the Dockerfile compiles correctly before the PR is merged, without publishing any image or polluting the build cache.

**Publish gate**: the Docker Hub login, image push (`push: true`), registry cache writes, and SLSA attestation steps are all conditioned on `github.event_name != 'pull_request'`, so they only execute on `push` to `main` or `workflow_dispatch`.

**Tags published on each run**: `gheeklabs/coding-env:cuda12.4`, `:a100`, `:h100`, `:latest` (all pointing to the same image digest). Registry-based layer caching (`gheeklabs/coding-env:buildcache`) is used instead of the GHA cache to avoid the 10 GB GHA cache limit.

**SLSA provenance**: on every non-PR workflow run (both `push` to `main` and `workflow_dispatch`) the workflow attests build provenance via `actions/attest-build-provenance` (OIDC token), producing a signed SLSA Level 2 attestation attached to the registry image. Verify with:
```
gh attestation verify oci://docker.io/gheeklabs/coding-env:latest --owner gheeklabs
```

Docker Hub credentials are supplied via `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets. All `uses:` references are commit-SHA pinned (supply-chain hardening).

### `pr-labeler.yml`
Auto-labels PRs based on file paths changed, using `.github/labeler.yml` rules (e.g. `area: api-server`, `area: dashboard`, `area: docker`, `area: db`).

### `sync-labels.yml`
Syncs label definitions from `.github/labels.yml` to the GitHub repository labels.

### `release.yml`
Creates GitHub releases when a version tag (`v*`) is pushed. Generates a changelog from conventional commits since the last tag.

### `preview-dashboard.yml`
Deploys a Vite-built static preview of the dashboard for every PR that touches `artifacts/dashboard/**`.

- Runs in a `preview` GitHub Environment (requires `deployments: write` permission).
- Default provider: Vercel (configurable by swapping the deploy step).
- Posts a sticky PR comment with the preview URL; subsequent commits to the same PR update the same comment.
- Concurrency key cancels in-progress preview runs for the same PR when a new commit is pushed.

### `workflow-hygiene.yml`
Validates that workflow files use pinned action SHAs (prevents supply-chain attacks via mutable tags).

### Pin policy
All `uses:` references in workflows use commit-SHA pins (e.g. `actions/checkout@de0fac2e4500...`) rather than mutable tag references. The SHA is annotated with a comment showing the semantic version for human readability.

### CODEOWNERS (`.github/CODEOWNERS`)
Broad-to-specific ordering (GitHub evaluates bottom-up):
- `*` → `@gheeklabs/core` (all files default)
- `lib/db/**`, `lib/api-spec/**`, `lib/api-client-react/**` → shared-lib owners
- `artifacts/api-server/**` → `@gheeklabs/backend`
- `artifacts/dashboard/**` → `@gheeklabs/frontend`
- `docker/**` → `@gheeklabs/infra`
- `.github/**` and `.github/workflows/**` → `@gheeklabs/core`

### Dependabot (`.github/dependabot.yml`)
- **npm (root workspace)**: weekly on Mondays 08:00 UTC. Groups minor+patch production deps into one PR; dev deps into another. Major bumps for `react`, `react-dom`, `typescript`, `vite`, `drizzle-orm` are ignored (require manual assessment). Per-subdirectory pnpm entries are intentionally omitted until frozen-lockfile compatibility is validated.
- **GitHub Actions**: weekly on Mondays 08:00 UTC. All action updates bundled into a single PR for consolidated SHA-pin review.

### Issue / PR templates (`.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`)
Standardised templates ensure consistent bug reports, feature requests, and PR checklists.

---

*End of MIZI_SPEC.md*
