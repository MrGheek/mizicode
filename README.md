# MIZI

A full-stack platform for spinning up AI coding sessions. MIZI provisions a
lightweight **CPU-only** workspace (Theia IDE) on demand, and routes all model
inference to **hosted NVIDIA NIM** (or any OpenAI-compatible endpoint) via an
in-container proxy — no GPU machines, no local model downloads.

The system is built on three moving parts:

1. **API server** (`artifacts/api-server`) — Express 5 backend that orchestrates
   session lifecycle, workspace provisioning (Fly Machines API), memory,
   skills, plan board, lane coordination, ambient agent, and an MCP server.
2. **Dashboard** (`artifacts/dashboard`) — React 19 SPA for managing sessions,
   memory, skills, plans, and safety approvals.
3. **Workspace image** (`docker/`) — a Fly app (`mizi-workspace`) that runs
   Theia, a claw runner/bridge pair, an nginx auth proxy, and the NIM proxy.

Two distributions are compiled from the same tree, gated by `MIZI_DISTRIBUTION`:

- **cloud** (default) — full PostgreSQL-backed feature set.
- **local** — SQLite-backed subset (`sessions-local.ts`) with all cloud
  (vastai/fly/vLLM/NIM) imports tree-shaken out at build time.

## Monorepo layout

```
artifacts/
  api-server/    Express 5 API server (Express, pino, drizzle, ws, MCP SDK)
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
docs/             Architecture, API reference, coordination, runbook, GitHub ops
```

## Deploying to Fly.io

The API server, dashboard, and workspace image each have their own `fly.toml`
and `Dockerfile`. All use the **monorepo root** as the Docker build context so
shared libraries resolve correctly.

### Prerequisites

- [flyctl](https://fly.io/docs/hands-on/install-flyctl/) installed and authenticated
- A Fly.io account
- An [NVIDIA NIM API key](https://build.nvidia.com) (free tier available) or any
  OpenAI-compatible endpoint

---

### 1 — API Server (`mizi-api`)

```bash
# Launch once (creates the Fly.io app; answer prompts to skip auto-deploy)
fly launch \
  --config artifacts/api-server/fly.toml \
  --dockerfile artifacts/api-server/Dockerfile \
  --name mizi-api \
  --no-deploy

# Provision a Postgres database and attach it (sets DATABASE_URL automatically)
fly postgres create --name mizi-db --region ord
fly postgres attach mizi-db --app mizi-api

# Create the persistent volume for the SQLite memory database
# (1 GB is sufficient to start; resize with `fly volumes extend` later)
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

After a successful deploy the API server is reachable at
`https://mizi-api.fly.dev`. The release command runs DB migrations automatically
(`node dist/migrate.mjs`).

---

### 2 — Dashboard (`mizicode`)

```bash
# Launch once
fly launch \
  --config artifacts/dashboard/fly.toml \
  --dockerfile artifacts/dashboard/Dockerfile \
  --name mizicode \
  --no-deploy

# Deploy — pass the API server URL as a build arg
fly deploy --config artifacts/dashboard/fly.toml \
           --dockerfile artifacts/dashboard/Dockerfile \
           --build-context . \
           --build-arg VITE_API_BASE_URL=https://mizi-api.fly.dev
```

> **Naming convention:** `VITE_API_BASE_URL` follows the pattern
> `https://<api-app-name>.fly.dev` where `<api-app-name>` is the Fly.io app
> name you chose when running `fly launch` for the API server (default:
> `mizi-api`). If you used a different name (e.g. `mizi-api-staging`), pass
> `--build-arg VITE_API_BASE_URL=https://mizi-api-staging.fly.dev` at deploy
> time — no `fly.toml` edits needed.
>
> When `VITE_API_BASE_URL` is absent (e.g. Replit/Electron dev), the dashboard
> falls back to same-origin relative paths automatically.

After a successful deploy the dashboard is reachable at `https://mizicode.fly.dev`.

---

### 3 — Workspace app (`mizi-workspace`)

The workspace image is provisioned **at runtime** by the API server via the Fly
Machines API — you don't deploy it like a normal app. It only needs to exist once:

```bash
fly apps create mizi-workspace
```

The API server creates a machine inside this app for each session. The image
runs Theia (8080, behind nginx auth), a claw runner/bridge pair, and the NIM
proxy (8081) which forwards model requests to NVIDIA NIM. See
[`docker/README.md`](docker/README.md) for the full runtime topology.

---

### Subsequent deploys

Replace `mizi-api` with your actual API app name if you chose a different one.

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

### Health endpoints

| Endpoint         | What it checks                                                    |
|------------------|-------------------------------------------------------------------|
| `GET /api/health`  | Memory DB (SQLite) + Postgres (`SELECT 1`) — `200 ok` / `503 degraded` |
| `GET /api/healthz` | Production secret completeness + DB connectivity (Fly.io health check) |
| `GET /api/admin/status` | Memory disk health + claim sweeper status                      |

### Checking logs

```bash
fly logs --app mizi-api
fly logs --app mizicode
```

---

## Local development

```bash
pnpm install

# Local distribution build (SQLite, no cloud imports)
pnpm run build:local

# API server (builds then serves dist/index.mjs on PORT, default 8080)
pnpm --filter @workspace/api-server run dev

# Dashboard (Vite dev server)
pnpm --filter @workspace/dashboard run dev
```

See `docs/runbook.md` for day-to-day operations, `docs/coordination.md` for the
lane/safety/ambient policy model, and `docs/api-reference.md` for the full API
surface. `artifacts/api-server/README.md` and `artifacts/dashboard/README.md`
cover the individual services.

## Secrets reference

See [`.env.example`](.env.example) for the full list of secrets and their
descriptions. Required in production: `DATABASE_URL`, `MIZI_ENCRYPTION_KEY`,
`MIZI_MEM_TOKEN`, `FLY_API_TOKEN`, `FLY_WORKSPACE_APP_NAME`, and at least one
model provider key.
