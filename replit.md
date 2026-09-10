# Workspace

## Overview

MIZI is a full-stack platform for spinning up AI coding sessions. A session
provisions a lightweight **CPU-only** workspace (Eclipse Theia IDE) on a Fly.io
machine in the `mizi-workspace` app, and all model inference is routed to
**hosted NVIDIA NIM** (or any OpenAI-compatible endpoint) through an in-container
`nim-proxy.py`. There are no GPU machines, no vLLM/llama.cpp, and no local model
downloads.

Built as a pnpm workspace monorepo using TypeScript. Two distributions are
compiled from the same tree, gated by `MIZI_DISTRIBUTION`:

- **cloud** (default) — full PostgreSQL-backed feature set. Fly apps: `mizi-api`
  (API server), `mizicode` (dashboard), `mizi-workspace` (per-session machines).
- **local** — SQLite-backed subset (`~/.mizi/local.db`) with all cloud
  (vastai/fly/vLLM/NIM) imports tree-shaken out of the esbuild bundle at build
  time. Packaged as an Electron desktop app (`artifacts/electron-app`).

## Stack

- **Monorepo tool**: pnpm workspaces (`packageManager` `pnpm@10.26.1`)
- **Node.js**: 20 (Docker runtime images)
- **TypeScript**: `~6.0.3` (root `devDependencies`)
- **API framework**: Express 5 (`artifacts/api-server`)
- **Database (cloud)**: PostgreSQL + Drizzle ORM
- **Database (local / memory / safety)**: SQLite via better-sqlite3 + drizzle
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec in `lib/api-spec`)
- **Build**: esbuild (CJS bundle → `dist/index.mjs`)
- **Frontend**: React 19 + Vite + Tailwind 4 + TanStack Query (dashboard)
- **Workspace IDE**: Eclipse Theia (`docker/mizi-theia`, 27 MIZI extensions)
- **Model inference**: hosted NVIDIA NIM via `nim-proxy.py` (port 8081), or any
  OpenAI-compatible endpoint
- **Workspace orchestration**: Fly Machines API (`mizi-workspace` app)

## Structure

```text
mizi/
├── artifacts/                 # Deployable applications
│   ├── api-server/            # Express 5 API server (builds to dist/index.mjs)
│   ├── dashboard/             # React 19 + Vite + Tailwind 4 dashboard (mizicode)
│   ├── electron-app/          # Desktop wrapper for the local distribution
│   └── mockup-sandbox/        # UI mockups
├── docker/                    # CPU-only workspace image
│   ├── Dockerfile             # mizi-workspace image (theia, claw, nginx, nim-proxy)
│   ├── onstart.sh             # Boot script (phased status callbacks to dashboard)
│   ├── nim-proxy.py           # OpenAI-compatible pass-through proxy → hosted NIM
│   ├── claw-runner.js         # Claw task runner (port 5182, behind nginx on 5181)
│   ├── claw-bridge.mjs        # Outbound WebSocket bridge to the API server
│   ├── mizi-theia/            # Eclipse Theia IDE + 27 MIZI extensions
│   ├── claw-code-src/         # Vendored Rust claw runner (claw-code-main)
│   └── scripts/               # Repo-intelligence daemon (indexer, graph, shield)
├── lib/                       # Shared libraries
│   ├── api-spec/              # OpenAPI spec + Orval codegen config
│   ├── api-client-react/      # Generated React Query hooks
│   ├── api-zod/               # Generated Zod schemas from OpenAPI
│   ├── db/                    # Drizzle ORM schema + migrations (PG cloud / SQLite local)
│   └── integrations-openai-ai-server/  # OpenAI-compatible AI integration
├── local/                     # Local distribution service files (launchd/systemd)
├── scripts/                   # Build/package helpers (package-local.sh, install-local-deps.sh)
├── docs/                      # API reference, coordination, runbook, GitHub ops
├── pnpm-workspace.yaml        # pnpm workspace config
├── tsconfig.base.json         # Shared TS options (composite projects)
└── package.json               # Root scripts (build / build:local / package:local / typecheck)
```

## Database Schema

### Cloud (PostgreSQL)

- **gpu_profiles** — profile tiers. Primary entry is `nim-workspace` (CPU-only,
  hosted NIM, `isNimWorkspace=true`); `kimi-k2-6-*` / `kimi-k2-5-*` GPU profiles
  are Vast.ai provider profiles kept for GPU-backed sessions.
- **sessions** — session records with Fly machine IDs, status tracking, workspace
  URLs, cost tracking, and `taskMode` / `tokenMode` / `activeBundleId` /
  `repoFingerprintJson`.
- **templates** — session templates with Docker image, on-start script, and env vars.
- **nim_catalog** — cached NVIDIA NIM model catalog (SWE-bench scores, types,
  partner providers), synced from the NIM API every 6h.
- **skills** / **skill_sources** / **skill_versions** / **skill_bundles** /
  **session_skills** / **skill_feedback** — skills system: trust tiers
  (`mizi_native|reviewed|user_approved|experimental`), install risk
  (`virtual|config|hooked|binary|networked`), review status, bundles, per-session
  activations, and helpful/unhelpful feedback.
- **repo_graph_jobs** / **session_repo_context** — repo indexing + per-session
  symbol-graph context (edges JSON used by blast-radius overlap).
- **session_lanes** / **lane_claims** / **lane_handoffs** / **lane_heavy_jobs** /
  **lane_events** / **lane_prompt_snapshots** / **custom_lane_types** — lane
  coordination: overlays, soft claims with TTL/heartbeat, handoff signals,
  weighted-fair heavy-job queue, event log.
- **eval_runs** / **eval_run_variants** / **skill_evals** / **bundle_evals** —
  async skills eval pipeline (baseline/treatment/ablated variants, lift scores).
- **api_keys** — scoped M2M API keys (SHA-256 hashed) for agent authentication.
- **operator_credentials** — encrypted third-party credentials (GitHub OAuth,
  provider keys) via `MIZI_ENCRYPTION_KEY`.
- Supporting tables: **project_plans** / **project_tasks** / **schema_templates** /
  **palette_intents** / **session_model_switches** / **provisioned_resources** /
  **orchestration_idempotency** / **scheduler_config** / **claim_purge_logs** /
  **design_intelligence_entries** / **design_intelligence_bookmarks** /
  **skill_design_categories**.

### SQLite

- `~/.mizi/local.db` — local distribution database (SQLite-backed subset).
- `${MEM_DATA_DIR}/mem.db` — memory store (SQLite FTS5, defaults to
  `~/mizi-memory/mem.db` — outside the workspace, not tracked by git).
- `${MEM_DATA_DIR}/ambient.db` — safety subsystem tables (see Ambient Mode below).

## Workspace image (docker/)

The `mizi-workspace` Fly app is provisioned **at runtime** by the API server via
the Fly Machines API — no GPU (`performance-1x`, 4096 MB RAM). Each machine runs:

| Service | Port | Notes |
|---------|------|-------|
| Eclipse Theia | 8080 | behind nginx basic auth |
| nginx | 5181 | auth-gated proxy → claw-runner (5182) |
| nginx (internal) | 8789 | no-auth proxy → Theia 8788; reachable only over Fly 6PN |
| nim-proxy.py | 8081 | OpenAI-compatible pass-through → hosted NIM |
| claw-runner | 5182 | Claw task runner (Node.js) |
| claw-bridge | — | outbound WebSocket → API `/api/bridge/:sessionId/:laneId` |
| bolt.diy | 5180 | coding UI |
| SSH | 22 | key-based auth |

The workspace proxy route (`/api/sessions/:id/workspace`, incl. WebSocket
upgrades) forwards directly to the correct machine over Fly's 6PN private network
(see `artifacts/api-server/src/services/fly.ts`).

## Intent Classification API

- `POST /api/intent/classify` — Classify user intent into `nim` | `gpu` | `choice`
  paths. Accepts `{ intentText, repoUrl }`. Returns `nimSuggestion`,
  `gpuSuggestion`, `repoSuggestion` based on scored NIM catalog models
  (SWE-bench weighted), configured provider latency, and task complexity. Repo
  path is triggered by github.com/gitlab.com URLs or keywords like "my repo",
  "working on", "existing project", etc.

## API Endpoints

Route groups (registered in `artifacts/api-server/src/routes/index.ts`, relative
to `/api`):

| Router | Paths |
|--------|-------|
| sessions (cloud `sessions.ts` / local `sessions-local.ts`) | `/sessions/*` — CRUD, memory, plan, swarm, messages, model, files, workspace proxy |
| offers / templates / orchestrate / bridge / nim / profiles (cloud only) | `/offers/*`, `/templates/*`, `/orchestrate/*`, `/bridge/*`, `/nim/*`, `/profiles/*` |
| auth | `/auth/*` — API keys, GitHub OAuth |
| health | `/health`, `/healthz`, `/admin/status` |
| dashboard | `/dashboard/*` — dashboard API proxy |
| scheduler | `/scheduler/*` — cron job scheduling |
| memory | `/mem/*` — memory CRUD, governance, passive recall, conflict management |
| skills | `/skills/*`, `/skill-bundles/*`, `/admin/*`, `/sessions/:id/skills/*` |
| repo | `/repo/*`, `/sessions/repo`, `/sessions/:id/repo` |
| coordination | `/coordination/*` — lanes, claims, handoffs, heavy jobs |
| design-intelligence | `/design-intelligence/*` — curated patterns |
| ambient | `/ambient/*`, `/safety/*`, `/dashboard/ambient/*`, `/dashboard/safety/*` |
| palette-intent | `/palette/intent` |
| intent | `/intent/*` |
| schema-templates | `/schema-templates/*` |
| plan | `/plan/*`, `/plans/*`, `/sessions/:id/plan`, `/sessions/:id/decompose` |
| tools | `/sessions/:id/tools/*` — web search, fetch |
| metrics | `/metrics/*` — GPU/token/latency/cost |
| snapshots | `/snapshots/*` — snapshot/rollback |
| session-shortcuts | `/session/*` |
| local (local only) | `/local/*` — hardware probe, Ollama, ACP |

MCP tools are served at `/api/mcp` (mounted in `app.ts`, outside the router
index) via `@modelcontextprotocol/sdk` — 53 tools across 13 tool files under
`artifacts/api-server/src/mcp/tools/`.

### Memory API (SQLite FTS5 — no external deps)

- `POST /api/mem/init` — Start a memory session (`sessionId`, `userId`, `projectPath`)
- `POST /api/mem/observation` — Record a tool observation (`sessionId`, `userId`, `toolName`, `inputSummary`, `outputSummary`)
- `POST /api/mem/summarize` — Store end-of-session summary (`sessionId`, `userId`, `summary`)
- `GET /api/mem/context/:userId` — Fetch past-session context string (FTS5 search, injected into system prompts)
- `GET /api/mem/observations?userId=` — List recent tool observations
- `GET /api/mem/sessions?userId=` — List past sessions with summaries

Memory is scoped per `userId` (default: `"operator"`, override via
`MIZI_MEM_USER_ID`). Optionally auth-gated via `MIZI_MEM_TOKEN` env var
(required in `NODE_ENV=production`; warned-but-open in development).

Dashboard accesses memory via session-scoped proxy routes (`GET
/api/sessions/:id/memory/sessions`, `/observations`, `/search?q=`) and global
proxy routes (`GET /api/memory/sessions`, `/api/memory/search?q=`) — no bearer
token required for dashboard access.

The `searchMemory(userId, query)` service function in
`artifacts/api-server/src/services/memory.ts` uses FTS5 full-text search on tool
observations and LIKE on session summaries, returning `{ observations, sessions }`.

### Coordination highlights

- **Lane types**: `ux`, `debug`, `backend`, `review`, `general` — each with its
  own policy (maxConcurrentClaims, heavyJobSlots, maxBlastRadiusFiles,
  claimTtlSeconds, allowed claim types, shared/private memory scopes). Defined in
  `services/lane-policy.ts`.
- **Heavy-job scheduler** (`services/heavy-job-scheduler.ts`): weighted-fair
  queue scoring `priority + ageWeight + laneFairnessWeight + jobClassFloor` —
  `indexing` class gets +0.5 floor, `embedding` +0.3, `eval` +0.2, others 0.0.

## Environment Secrets

See [`.env.example`](.env.example) for the full commented list. This section is
the documentation home for environment variables — the PR checklist requires new
env vars or secrets to be documented here.

### Required in production (cloud)

- `DATABASE_URL` — PostgreSQL connection string (auto-provisioned by
  `fly postgres attach`)
- `MIZI_ENCRYPTION_KEY` — 64-hex-char key encrypting stored operator credentials.
  Generate: `openssl rand -hex 32`
- `MIZI_MEM_TOKEN` — bearer token for memory/ambient/safety routes + the instance
  status callback; also derives the GitHub OAuth token encryption key.
  Generate: `openssl rand -hex 32`
- `FLY_API_TOKEN` — Fly.io token used to create/destroy workspace machines.
  Generate: `fly tokens create deploy -x 999999h`
- `FLY_WORKSPACE_APP_NAME` — name of the workspace Fly app (e.g. `mizi-workspace`).
  Falls back to `FLY_APP_NAME` (deprecated).
- At least one model provider key: `NVIDIA_NIM_API_KEY` (recommended) or
  `AI_INTEGRATIONS_OPENAI_API_KEY` / `VULTR_INFERENCE_API_KEY` /
  `TOGETHER_API_KEY` / `DEEPINFRA_API_KEY`.

### Optional

- `PORT` — Express port (default 8080 on Fly; required — no silent default)
- `DASHBOARD_URL` — full dashboard origin (e.g. `https://mizicode.fly.dev`);
  required for cross-origin GitHub OAuth redirects
- `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` — GitHub OAuth app
- `BRAVE_SEARCH_API_KEY` / `SERPER_API_KEY` — web-search for swarm agents (at
  least one required for `/sessions/:id/tools/web-search`)
- `SAFETY_EMAIL_TO` / `SAFETY_EMAIL_WEBHOOK_URL` / `SAFETY_EMAIL_WEBHOOK_AUTH` —
  safety approval email channel (webhook-based)
- `MEM_DATA_DIR` — directory for the SQLite memory DBs (default `~/mizi-memory`).
  Must match the Fly volume mount destination on cloud
- `MIZI_MEM_USER_ID` — operator user id for memory observations (default `operator`)
- `AMBIENT_ACCOUNT_ID` — account id used by the ambient scheduler (default `default`)
- `CLAIM_RETENTION_DAYS` (default 7) / `CLAIM_CLEANUP_INTERVAL_MS`
  (default `3600000`) — inactive lane-claim purge tuning
- `MIZI_DISTRIBUTION` — `local` or `cloud` (default). Gated at esbuild time

### Local distribution

Local mode skips all cloud secret checks. See `config.env.template` for the
local config template (`~/.mizi/config.env`): `PORT`, `API_PORT`, `MIZI_LOCAL_DB_PATH`
(default `~/.mizi/local.db`), `MIZI_LOCAL_WORKSPACE`, `ACP_PORT`, `OLLAMA_BASE_URL`,
`LOG_LEVEL`. Zero cloud API keys required.

## M2M API Key Auth

Remote orchestration agents authenticate via scoped API keys rather than the
shared `MIZI_MEM_TOKEN` secret.

- **Schema**: `api_keys` table (`lib/db/src/schema/api-keys.ts`) — stores SHA-256
  key hash, label, scopes (JSONB), expiry, last-used, revoked timestamps.
- **Migration**: `lib/db/migrations/0019_api_keys.sql`
- **Key management routes** (`artifacts/api-server/src/routes/auth.ts`):
  - `POST /api/auth/keys` — create key; plaintext returned once, hash stored
  - `GET /api/auth/keys` — list active (non-revoked) keys; values never returned
  - `DELETE /api/auth/keys/:id` — revoke a key
- **Middleware** (`artifacts/api-server/src/middlewares/agent-auth.ts`):
  `requireAgentAuth(scopes[])` — validates `Authorization: Bearer <key>`, checks
  expiry/revocation, enforces required scopes, records `last_used_at` async.
  Dev-mode bypass (no `MIZI_MEM_TOKEN` set) mirrors memory/ambient posture.
  `MIZI_MEM_TOKEN` bearer accepted as pass-through for internal callers.
- **Protected routes**: `POST /api/sessions` (requires `sessions:write`),
  `GET|POST|PUT /api/sessions/:id/lanes` (requires `coordination:read`).
- **Tests**: `artifacts/api-server/src/tests/agent-auth.test.ts`

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root
`tsconfig.json` lists all packages as project references.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages
- `pnpm run build:local` — typecheck + build with `MIZI_DISTRIBUTION=local`
- `pnpm run package:local` — `scripts/package-local.sh`; produces
  `mizi-local-<os>-<arch>-<version>.tar.gz` for linux/darwin x64+arm64
- `pnpm run build:electron` — local distribution build + Electron packaging
- `pnpm run typecheck` — `tsc --build` for libs, then per-package typecheck

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server (Express 5, pino, drizzle-orm, better-sqlite3, ws,
@modelcontextprotocol/sdk). esbuild bundle → `dist/index.mjs`.

- Entry: `src/index.ts` — validates `PORT`, production secret guards
  (`MIZI_ENCRYPTION_KEY`, `MIZI_MEM_TOKEN`, `FLY_API_TOKEN`,
  `FLY_WORKSPACE_APP_NAME`), validates `MEM_DATA_DIR`, runs local SQLite
  migrations, mounts the HTTP server + WebSocket bridge, and starts cloud
  startup jobs (profile/template/bundle seeding, NIM catalog sync, claim
  sweeper + purger, eval scheduler, memory disk monitor, plan auto-advance,
  plan decompose, ambient runner).
- Routes in `src/routes/` (see API Endpoints table), services in `src/services/`.
- Run: `pnpm --filter @workspace/api-server run dev` (builds + serves on `PORT`).

### `artifacts/dashboard` (`@workspace/dashboard`)

React 19 + Vite + Tailwind 4 SPA. Pages under `src/pages/`: sessions (incl.
cockpit + boot timeline), memory, skills, ambient, design-intelligence,
intelligence, schema-templates, settings, api-keys, templates. The memory page
provides a global searchable notes view across all AI sessions (FTS5,
debounced 350ms); the session detail cockpit has a per-session memory tab.

### `artifacts/electron-app` (`@workspace/electron-app`)

Desktop wrapper (Electron + electron-builder) for the local distribution.

### `lib/db` (`@workspace/db`)

Database layer with Drizzle ORM. PG cloud schema + SQLite local schema;
migrations under `lib/db/migrations/`. Run migrations: `pnpm --filter @workspace/db migrate`.

### `lib/api-spec` (`@workspace/api-spec`)

OpenAPI 3.1 spec + Orval codegen config. Run codegen:
`pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client.

### Remote CLI Bridge

Enables agents to send prompts to `claw` processes running on workspace
machines over WebSocket.

- **Registry**: `artifacts/api-server/src/services/bridge-registry.ts` — in-memory
  Map keyed by `sessionId:laneId`
- **Routes**: `artifacts/api-server/src/routes/bridge.ts`
  - `WS /api/bridge/:sessionId/:laneId` — claw instance connects outbound; upgrade
    handled in `src/index.ts`
  - `GET /api/sessions/:id/lanes/:laneId/bridge/status` — readiness check (`connected`/`disconnected`)
  - `POST /api/sessions/:id/lanes/:laneId/exec` — accept `{ prompt }`, relay frames
    from bridge as SSE (`observation`/`done`/`error`)
- **Auth**: `MIZI_MEM_TOKEN` Bearer OR `?token=` query param on WS upgrade; dev
  bypass when token not set
- **claw-side client**: `docker/claw-bridge.mjs` — outbound WS with
  exponential-backoff reconnect, spawns `claw prompt`, streams back frames
- **Startup**: `docker/onstart.sh` starts bridge client when `MIZI_BRIDGE_URL` is set
- **Tests**: `artifacts/api-server/src/tests/bridge.test.ts` — registry, status,
  exec dispatch, SSE relay, 400/503 error paths
- **Key gotcha**: use `res.on("close")` (not `req.on("close")`) to detect caller
  disconnect in SSE handlers — `req` close fires when the HTTP client half-closes
  the request body, prematurely removing the message listener.

### Ambient Mode + Safety Subsystem

Always-on background agent with reusable safety/approval rails.

- `artifacts/api-server/src/services/safety.ts` — standalone safety subsystem.
  Separate sqlite db at `${MEM_DATA_DIR}/ambient.db`. Tables: `safety_actions`,
  `safety_transcript`, `safety_policies`, `safety_notifications`,
  `ambient_config` (with persisted `next_wake_at`), `ambient_cycles` (with
  `gpu_minutes_used`), `ambient_lock` (PRIMARY KEY = `account_id` for per-account
  singleton semantics). Three default policy bundles: `local-only` (default;
  auto-allow local/sandbox scopes, gate external surface + irreversible),
  `team-coord` (also auto-allows team scope + `coord_handoff_post` /
  `coord_lane_note` kinds), `external-comm` (permissive; auto-allows external
  scope, still gates irreversible). Pluggable notification channels via
  `registerNotificationChannel(name, fn)` — built-ins: `dashboard` (no-op,
  polled), `log`, `email` (delivers via `SAFETY_EMAIL_WEBHOOK_URL`; explicit
  failure if `SAFETY_EMAIL_TO` set without a webhook). Core API:
  `requestPermission`, `classifyAction`, `decideAction`, `awaitDecision`,
  `markExecuted`, `drainApprovedActions`, `listPendingApprovals`,
  `listTranscript`, `listPolicies`/`setPolicy`. Lightweight migrations for
  upgrades from earlier prototypes via `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`.
- `artifacts/api-server/src/services/ambient.ts` — ambient runner & agent. The
  runner ticks every 15s, iterates `listAllConfigs()`, and for every enabled
  account whose persisted `next_wake_at` has elapsed it acquires the per-account
  lock and runs a cycle. Multiple processes coexist safely (lock is keyed by
  account_id). Wake schedule survives restarts because every cycle calls
  `persistNextWake` to write the next due time into `ambient_config`. Each cycle
  does scout → garden → work with mid-cycle `checkpoint()` calls between every
  phase (and inside garden) so an interactive session causes the runner to abort
  within seconds. Per-cycle wall-clock cap (≤25% of remaining budget) is also
  enforced inside `checkpoint`. Token, GPU-minute, and wall-clock budgets are all
  enforced via `isBudgetExhausted` over the rolling window. Adaptive backoff per
  account on errors.
- `artifacts/api-server/src/routes/ambient.ts` — endpoints:
  `GET/PUT /api/ambient/config`, `GET /api/ambient/status|timeline|metrics`,
  `POST /api/ambient/cycle|kill`, `GET /api/safety/pending|actions|transcript|policies`,
  `POST /api/safety/actions/:id/approve|deny`, `PUT /api/safety/policies/:bundle`.
- Wired into `src/index.ts` (cloud distribution) via `initSafetySubsystem()`,
  `registerAmbientExecutors()`, `drainApprovedActions()`, `startAmbientRunner()`.
  Defaults are dark-launched (`enabled=0`, `featureFlag=0`); cycles only run when
  both are true (or `force: true`).
- Dashboard surface at `/ambient` (`artifacts/dashboard/src/pages/ambient.tsx`):
  kill switch + enable + feature flag toggles, budget panel with token /
  wall-clock / GPU-minute progress bars, 24h metrics, pending approvals with
  approve/deny inline, expandable activity timeline, budget/policy editor.
- Notification bell integration: `notification-store.ts` has an `approval_request`
  type and `notification-watchers.tsx` mounts an `ApprovalRequestWatcher` that
  polls `/api/safety/pending` every 10s and emits a notification for any
  newly-seen pending action so it surfaces globally (not only on the Ambient
  page). Sidebar entry in `app-layout.tsx` shows a badge with pending-approval count.
