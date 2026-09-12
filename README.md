# MIZI — AI Coding Environment Platform

**Spin up on-demand AI coding workspaces and orchestrate autonomous coding agents with a built-in IDE, memory system, collaborative multi-agent lanes, and an MCP server.**

MIZI is a full-stack, self-hostable platform that provisions a lightweight
**CPU-only workspace** (Theia IDE) on demand. Model inference is decoupled from
the workspace and runs wherever it makes sense for the job:

- **Hosted inference** — route model requests to **NVIDIA NIM** (or any
  OpenAI-compatible endpoint) through an in-container proxy. No GPU rental, no
  local model downloads.
- **Self-hosted inference on orchestrated GPUs** — launch sessions on rented
  GPU instances (Vast.ai and others) with searchable GPU profiles (H100, A100,
  RTX 4090, …) for models you want to run in your own fleet via vLLM /
  llama-server, with per-product cost and budget controls.

Choice is per-session, not platform-wide. The workspace is always
CPU-only — the GPU (or hosted API) is attached at launch from the profile.

<div align="center">

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Language: TypeScript](https://img.shields.io/badge/TypeScript-~634%20files-3178c6?logo=typescript&logoColor=white)
![Language: Rust](https://img.shields.io/badge/Rust-~40%20files-000000?logo=rust&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)
![Express 5](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![Theia](https://img.shields.io/badge/Theia-IDE-000000?logo=theia&logoColor=white)
![Release](https://img.shields.io/github/v/release/MrGheek/mizicode?sort=semver)
![Tests](https://img.shields.io/badge/tests-985%20passing-2ea44f)
![CI](https://img.shields.io/github/actions/workflow/status/MrGheek/mizicode/ci-all.yml)
![Deploy](https://img.shields.io/github/actions/workflow/status/MrGheek/mizicode/deploy.yml)
![CodeQL](https://img.shields.io/github/actions/workflow/status/MrGheek/mizicode/codeql.yml?label=CodeQL&logo=github)

</div>

---

## Table of contents

- [Why MIZI](#why-mizi)
- [Key features](#key-features)
- [Architecture](#architecture)
- [Monorepo layout](#monorepo-layout)
- [Quickstart](#quickstart)
- [Deploying to Fly.io](#deploying-to-flyio)
- [Local development](#local-development)
- [Health endpoints](#health-endpoints)
- [Secrets reference](#secrets-reference)
- [Documentation](#documentation)
- [License](#license)

---

## Why MIZI

| Problem | MIZI's answer |
|---|---|
| GPUs are expensive and scarce | **Workspaces are CPU-only** — inference is decoupled: use hosted NIM / any OpenAI-compatible API, or self-host on orchestrated GPU instances when you need them |
| Coding agents are siloed and short-lived | **Collaborative lanes** — multiple agents coordinate on one repo with typed intent events, claims, circuit breakers, and a risk-sequenced merge queue |
| Agent systems forget everything | **A persistent memory layer** — semantic + hybrid search, learned skills with leaderboards, and a passive ambient agent that surfaces relevant context |
| Building agent UIs from scratch | **A full IDE** — 27 Theia extensions expose plans, phases, GPU cost, token budgets, and lane state right in the editor |
| Opaque agent cost | **Universal spend ledger** — per-session token accounting, tripwires, token modes, GPU budget profiles, and cost-per-work-order factory telemetry |

MIZI is MIT-licensed and compiles to two distributions from one codebase:

- **cloud** (default) — full PostgreSQL-backed feature set (sessions, lanes, factory, memory, MCP).
- **local** — SQLite-backed subset with all cloud imports tree-shaken out at build time.

---

## Key features

### Persistent memory & skills
Semantic + hybrid full-text search over code and observations, passive recall
surfaced during sessions, and a skill-eval loop that learns from usage.

### Flexible inference: hosted or GPU fleet
Workspaces are always CPU-only; the inference backend is chosen **per session**
at launch. Use hosted **NVIDIA NIM** (or any OpenAI-compatible API) via the
in-container proxy — zero GPU rental — or stand up self-hosted models on
**orchestrated GPU instances** (Vast.ai marketplace, GPU profile search, vLLM /
llama-server) with per-product budget caps.

### Multi-agent lane collaboration
Lanes claim files and symbols, publish durable **intent events**, signal
handoffs (`safe_to_merge`, `needs_review`), and land changes through a
**risk-sequenced, test-gated merge queue** — with per-lane permission profiles,
circuit breakers, reconcile passes, and evidence-based takeover.

### The Code Factory
Products group work orders into a WIP-bounded, topologically-scheduled
pipeline: **build → test → stage → ship**. Per-station quality gates, a defect →
rework loop with telemetry, per-product resource caps over a shared GPU pool,
and a factory-scale A/B eval harness.

### Living plan board
Gather intent, decompose into verified tasks, auto-advance, and stream plan
updates over SSE to Theia — with full user confirmation and rollback.

### Token budgets & cost controls
Universal spend ledger (RFC 0001), per-session tripwires, four token modes
(LEAN / CORE / FULL / ULTRA), token-aware model routing, and a factory
dashboard reporting **throughput, cycle time, defect rate, and cost per work
order**.

### 76 MCP tools
An MCP server (mounted at `/api/mcp`) exposes memory, repo graph, skills,
lanes, safety, planning, sessions, ambient, and factory tooling to any MCP
client.

### Safety & governance
Human-in-the-loop action approvals, per-lane permission profiles, ambient
agent kill switch, blast-radius checks, and snapshot-based rollback.

---

## Architecture

The system runs on three moving parts:

1. **API server** (`artifacts/api-server`) — Express 5 backend that orchestrates
   session lifecycle, workspace provisioning (Fly Machines API + Vast.ai GPU
   marketplace), NIM catalog sync, memory, skills, plan board, lane coordination,
   the Code Factory, ambient agent, and an MCP server.
2. **Dashboard** (`artifacts/dashboard`) — React 19 SPA for managing sessions,
   memory, skills, plans, and safety approvals.
3. **Workspace image** (`docker/`) — launch target for sessions: a Fly app
   (`mizi-workspace`) running Theia, a claw runner/bridge pair, an nginx auth
   proxy, and the inference proxy. Standalone but stackable with optional
   GPU-backed Vast.ai provisioning for self-hosted models (vLLM / llama-server).

```
┌──────────────┐        ┌──────────────┐      ┌──────────────────────────────┐
│   Dashboard  │ ─────▶ │  API server  │ ───▶ │  Workspace (Theia + claw)   │
│  (React 19)  │  HTTP  │  (Express 5) │      │  • nginx auth proxy          │
└──────────────┘        │  • memory    │      │  • NIM proxy (8081)         │
                        │  • skills    │      │  • claw runner/bridge       │
                        │  • lanes     │      └─────────────┬────────────────┘
                        │  • factory   │                    │
                        │  • MCP       │      ┌─────────────▼──────────────
                        │  • plan board│      │  Inference backend (chosen │
                        └──────┬───────┘      │  per session at launch):   │
                               │              │  • NVIDIA NIM / any        │
                 ┌─────────────┴─────────────┐│    OpenAI-compatible API   │
                 │ PostgreSQL (cloud)        ││  • GPU fleet (Vast.ai)     │
                 │         ·                 ││    with vLLM/llama-server   │
                 │ SQLite (local)            │└─────────────────────────────
                 └───────────────────────────┘
```

---

## Monorepo layout

```
artifacts/
  api-server/    Express 5 API server (pino, drizzle, ws, MCP SDK)
  dashboard/     React 19 + Vite + Tailwind 4 + TanStack Query SPA
  electron-app/  Desktop wrapper (local distribution)
docker/
  Dockerfile*    mizi-workspace image (theia, claw-runner, claw-bridge, nim-proxy, nginx)
  mizi-theia/    27 Theia extensions (@mizi/theia-extensions)
  claw-code-src/ Vendored Rust claw runner (mizi-cli etc.)
lib/
  api-zod/                  Shared zod schemas / API contracts
  api-client-react/         React hooks client
  db/                       Drizzle schema + migrations (PG cloud / SQLite local)
  integrations-openai-ai-server/  OpenAI-compatible AI integration
scripts/          Build/package helpers
docs/             Architecture, API reference, coordination, runbook, RFCs
```

---

## Quickstart

### Prerequisites

- [pnpm](https://pnpm.io/installation) 10+
- Node.js 20+
- An [NVIDIA NIM API key](https://build.nvidia.com) (free tier available) or any
  OpenAI-compatible endpoint

```bash
# Install
pnpm install

# Local distribution (SQLite, no cloud imports)
pnpm run build:local

# API server (serves dist/index.mjs on PORT, default 8080)
pnpm --filter @workspace/api-server run dev

# Dashboard (Vite dev server)
pnpm --filter @workspace/dashboard run dev
```

See [`docs/runbook.md`](docs/runbook.md) for day-to-day operations.

---

## Deploying to Fly.io

The API server, dashboard, and workspace image each have their own `fly.toml`
and `Dockerfile`. All use the **monorepo root** as the Docker build context so
shared libraries resolve correctly.

### Prerequisites

- [flyctl](https://fly.io/docs/hands-on/install-flyctl/) installed and authenticated
- A Fly.io account
- An NVIDIA NIM API key (free tier available) or any OpenAI-compatible endpoint
- *(Optional)* A [Vast.ai API key](https://vast.ai) + API client if you want
  self-hosted models on orchestrated GPU instances

### 1 — API Server (`mizi-api`)

```bash
# Launch once (answer prompts to skip auto-deploy)
fly launch \
  --config artifacts/api-server/fly.toml \
  --dockerfile artifacts/api-server/Dockerfile \
  --name mizi-api \
  --no-deploy

# Provision Postgres and attach it (sets DATABASE_URL automatically)
fly postgres create --name mizi-db --region ord
fly postgres attach mizi-db --app mizi-api

# Create the persistent volume for the SQLite memory database (1 GB to start)
fly volumes create mizi_memory --app mizi-api --region ord --size 1

# Set the required secrets
fly secrets set --app mizi-api \
  MIZI_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  MIZI_MEM_TOKEN="$(openssl rand -hex 32)" \
  FLY_API_TOKEN="$(fly tokens create deploy -x 999999h)" \
  FLY_WORKSPACE_APP_NAME="mizi-workspace" \
  NVIDIA_NIM_API_KEY="<your nvidia nim key>" \
  DASHBOARD_URL="https://mizicode.fly.dev"

# (Optional) GitHub OAuth for "Connect GitHub to work"
fly secrets set --app mizi-api \
  GITHUB_OAUTH_CLIENT_ID="<id>" \
  GITHUB_OAUTH_CLIENT_SECRET="<secret>"

# Deploy (run from the monorepo root so the build context is correct)
fly deploy --config artifacts/api-server/fly.toml \
           --dockerfile artifacts/api-server/Dockerfile \
           --build-context .
```

The release command runs DB migrations automatically (`node dist/migrate.mjs`).

### 2 — Dashboard (`mizicode`)

```bash
fly launch \
  --config artifacts/dashboard/fly.toml \
  --dockerfile artifacts/dashboard/Dockerfile \
  --name mizicode \
  --no-deploy

fly deploy --config artifacts/dashboard/fly.toml \
           --dockerfile artifacts/dashboard/Dockerfile \
           --build-context . \
           --build-arg VITE_API_BASE_URL=https://mizi-api.fly.dev
```

> **Naming convention:** `VITE_API_BASE_URL` follows
> `https://<api-app-name>.fly.dev` where `<api-app-name>` is the Fly.io app
> name you chose for the API server (default: `mizi-api`). When `VITE_API_BASE_URL`
> is absent (e.g. Replit/Electron dev), the dashboard falls back to same-origin
> relative paths automatically.

### 3 — Workspace app (`mizi-workspace`)

The workspace image is provisioned **at runtime** by the API server via the Fly
Machines API — it only needs to exist once:

```bash
fly apps create mizi-workspace
```

The API server creates a machine inside this app for each session. The image
runs Theia (8080, behind nginx auth), a claw runner/bridge pair, and the NIM
proxy (8081) which forwards model requests to NVIDIA NIM. Sessions launched on
a GPU profile instead provision a Vast.ai instance running vLLM / llama-server
with model weights downloaded at boot. See
[`docker/README.md`](docker/README.md) for the full runtime topology.

### Subsequent deploys

```bash
# API server
fly deploy --config artifacts/api-server/fly.toml \
           --dockerfile artifacts/api-server/Dockerfile \
           --build-context .

# Dashboard (replace "mizi-api" if your API app has a different name)
fly deploy --config artifacts/dashboard/fly.toml \
           --dockerfile artifacts/dashboard/Dockerfile \
           --build-context . \
           --build-arg VITE_API_BASE_URL=https://mizi-api.fly.dev
```

---

## Health endpoints

| Endpoint | What it checks |
|---|---|
| `GET /api/health` | Memory DB (SQLite) + Postgres (`SELECT 1`) — `200 ok` / `503 degraded` |
| `GET /api/healthz` | Production secret completeness + DB connectivity (Fly.io health check) |
| `GET /api/admin/status` | Memory disk health + claim sweeper status |

Checking logs:

```bash
fly logs --app mizi-api
fly logs --app mizicode
```

---

## Secrets reference

See [`.env.example`](.env.example) for the full list of secrets and their
descriptions. Required in production: `DATABASE_URL`, `MIZI_ENCRYPTION_KEY`,
`MIZI_MEM_TOKEN`, `FLY_API_TOKEN`, `FLY_WORKSPACE_APP_NAME`, and at least one
model provider key.

---

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/coordination.md`](docs/coordination.md) | Lane / safety / ambient policy model |
| [`docs/api-reference.md`](docs/api-reference.md) | Full API surface |
| [`docs/runbook.md`](docs/runbook.md) | Day-to-day operations |
| [`docs/github-ops.md`](docs/github-ops.md) | GitHub integration & ops |
| [`docs/rfc/`](docs/rfc/) | RFC specs — [token cost optimization](docs/rfc/0001-token-cost-optimization.md) (0001), [lane collaboration](docs/rfc/0002-lane-collaboration.md) (0002), [code factory](docs/rfc/0003-code-factory.md) (0003) |
| [`artifacts/api-server/README.md`](artifacts/api-server/README.md) | API server deep dive |

---

## Contributing

MIZI uses a conventional-commit, CI-gated workflow. Tests are expect-clean
(no skips):

```bash
# Run the API test suite (Postgres test DB required for cloud tests)
DATABASE_URL="postgresql://mizi:mizi@localhost:5433/mizi_test" pnpm vitest run
```

To add MIZI-specific documentation that agents will read, see
[`AGENTS.md`](AGENTS.md). For design proposals, add an RFC under [`docs/rfc/`](docs/rfc/).

## License

[MIT](LICENSE)