# MIZI Workspace Docker Image

Build and deployment guide for the `mizi-workspace` Fly.io app.

## Overview

NIM sessions run inside ephemeral Fly machines launched from the
`registry.fly.io/mizi-workspace:latest` image. The workspace image is
**separate from the API server** (`mizi-api`) — it is a CPU-only image with
no GPU, no vLLM, no llama.cpp, no litellm, and no code-server. Inference
routes to the NVIDIA NIM API (or any OpenAI-compatible endpoint) via
`nim-proxy.py`, a minimal OpenAI-compatible pass-through proxy on port 8081.

```
┌──────────────────────────────────────────────────┐
│  Fly app: mizi-api  (API server)                 │
│    — serves /api/* routes                        │
│    — creates/destroys workspace machines via     │
│      Fly Machines API using FLY_WORKSPACE_APP_NAME│
└──────────────────────────────────────────────────┘
                        │ Machines API
                        ▼
┌──────────────────────────────────────────────────┐
│  Fly app: mizi-workspace  (workspace machines)   │
│    — ephemeral machines, one per NIM session     │
│    — image: registry.fly.io/mizi-workspace:latest│
│    — CPU-only image: no GPU / vLLM / llama.cpp / │
│      litellm / code-server                       │
│    — services: theia (8080, nginx basic-auth),   │
│      nim-proxy (8081 → hosted NIM),              │
│      bolt.diy (5180), claw-runner (5181 → 5182), │
│      claw-bridge (outbound WS to API), nginx,    │
│      ssh (22)                                    │
└──────────────────────────────────────────────────┘
```

## One-time setup

```bash
# 1. Create the workspace Fly app (once per environment)
flyctl apps create mizi-workspace --org personal

# 2. Authenticate Docker with Fly's registry
flyctl auth docker

# 3. Build and push the workspace image (from workspace root)
docker build -t registry.fly.io/mizi-workspace:latest \
    -f docker/Dockerfile .
docker push registry.fly.io/mizi-workspace:latest

# 4. Tell the API server which Fly app to use for workspaces
fly secrets set --app mizi-api \
    FLY_WORKSPACE_APP_NAME=mizi-workspace \
    FLY_API_TOKEN=<your-fly-api-token>
#   Generate a long-lived token: fly tokens create deploy -x 999999h
```

## Building the image

Build context is the **workspace root** (not `docker/`), because the
Dockerfile copies files from `docker/` subdirectories.

```bash
# From workspace root:
docker build \
    -t registry.fly.io/mizi-workspace:latest \
    -f docker/Dockerfile \
    .

docker push registry.fly.io/mizi-workspace:latest
```

### Remote build via flyctl (no local Docker daemon needed)

```bash
flyctl deploy \
    --app mizi-workspace \
    --dockerfile docker/Dockerfile \
    --image-label latest \
    --strategy immediate \
    --no-public-ips
```

`--no-public-ips` prevents Fly from assigning a public IP to the app itself;
workspace machines declare their own ports per-machine when created by the API.

## Dockerfile layout

| File | Purpose |
|------|---------|
| `docker/Dockerfile` | **Workspace image** — Ubuntu 22.04, CPU-only (no GPU / vLLM / llama.cpp / litellm / code-server). Runs Theia + bolt.diy + nim-proxy.py + claw-runner + claw-bridge + nginx + SSH. Used by the `mizi-workspace` Fly app. |
| `docker/Dockerfile.nim-workspace` | Slim workspace build — same services, no litellm / bolt.diy layers. |
| `docker/Dockerfile.nim-patch` | Incremental patch layering `nim-proxy.py` and the Node-20-compatible `claw-bridge.mjs` onto an existing deployment image. |
| `docker/Dockerfile.nim-bolt-patch` | Incremental patch layering a pre-built bolt.diy production build onto an existing deployment image. |
| `docker/onstart.sh` | Boot script executed as the container's CMD. Starts Theia, claw-runner, claw-bridge, nginx, nim-proxy, and SSH. |
| `docker/claw-runner.js` | Node HTTP server (port 5182, proxied via nginx on 5181) — agent task runner with swarm orchestration. |
| `docker/claw-bridge.mjs` | Outbound WebSocket client connecting to `/api/bridge/:sessionId/:laneId` on the API server. |
| `docker/nim-proxy.py` | Minimal FastAPI / OpenAI-compatible pass-through proxy to hosted NIM (port 8081). |
| `docker/fly.workspace.toml` | Fly config for the `mizi-workspace` app. |
| `docker/mizi-theia/` | Theia app source built by CI; the Dockerfile downloads the built artifact via `THEIA_ARTIFACT_URL`. |
| `docker/claw-code-src/` | Bundled claw (Rust) source; the Dockerfile builds the `claw` binary from it in Stage 1. |

## Environment variables injected at machine creation

The API server (`fly.ts`) injects these into each workspace machine's env:

| Variable | Set by | Description |
|----------|--------|-------------|
| `MIZI_CALLBACK_URL` | API server | Endpoint for boot-phase status callbacks |
| `MIZI_MEM_AUTH_TOKEN` | API server | Auth token for the status callback |
| `MIZI_SESSION_ID` | API server | The session ID |
| `MIZI_BRIDGE_URL` | API server | WebSocket URL for the Claw Bridge (`wss://…/api/bridge/:sessionId/:laneId`) |
| `MIZI_LANE_ID` | API server | Lane this machine's claw-bridge connects to (default `0`) |
| `MIZI_MEM_TOKEN` | API server | Bridge auth token — sent as `Authorization: Bearer` or `?token=` query param |
| `NIM_MODEL_ID` | API server | Model ID for the `default` alias; enables hosted-inference mode |
| `NIM_API_BASE` | API server | Upstream API base URL (default `https://integrate.api.nvidia.com/v1`) |
| `NIM_API_KEY` | API server | Upstream NIM / OpenAI-compatible API key |
| `SWARM_API_BASE` / `SWARM_API_KEY` | API server | Optional upstream credentials for the `swarm` model alias |
| `NGINX_AUTH_PASS` | onstart.sh | Auto-generated on first boot; stored at `/workspace/.mizi-password` |

## Updating the image

1. Make changes to `docker/Dockerfile` or `docker/onstart.sh`
2. Rebuild and push:
   ```bash
   docker build -t registry.fly.io/mizi-workspace:latest -f docker/Dockerfile .
   docker push registry.fly.io/mizi-workspace:latest
   ```
3. New sessions will automatically pull the updated image (Fly always pulls
   `latest` at machine creation time).

## Troubleshooting

**Session never reaches `services_ready`**
- Check the machine boot log in the dashboard (boot log panel).
- SSH into a stopped machine: `flyctl ssh console --app mizi-workspace --select`
- Tail the onstart log: `cat /var/log/onstart.log`

**`FLY_WORKSPACE_APP_NAME is not set` warning in API logs**
- Set the secret: `fly secrets set --app mizi-api FLY_WORKSPACE_APP_NAME=mizi-workspace`
- Without it the API falls back to `FLY_APP_NAME` (the API server app) which
  mixes workspace machines into the API server's machine pool.

**Image pull fails at machine creation**
- Verify the image was pushed: `flyctl apps list | grep mizi-workspace`
- Re-authenticate: `flyctl auth docker && docker push registry.fly.io/mizi-workspace:latest`
