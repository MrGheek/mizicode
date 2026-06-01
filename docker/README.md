# MIZI Workspace Docker Image

Build and deployment guide for the `mizi-workspace` Fly.io app.

## Overview

NIM sessions run inside ephemeral Fly machines launched from the
`registry.fly.io/mizi-workspace:latest` image. The workspace image is
**separate from the API server** (`mizi-api`) — it has no GPU, no vLLM, and
no CUDA stack. Inference routes to the NVIDIA NIM API (or any
OpenAI-compatible endpoint) via a LiteLLM proxy inside the container.

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
│    — services: code-server (8080), bolt.diy      │
│      (5180), litellm (8081), claw-runner (5181)  │
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
| `docker/Dockerfile` | **Workspace image** — Ubuntu 22.04 + code-server + bolt.diy + litellm. Used by `mizi-workspace` Fly app. |
| `docker/Dockerfile.nim-workspace` | Alternate workspace build kept for reference (same content, older path). |
| `docker/fly.workspace.toml` | Fly config for the `mizi-workspace` app. |
| `docker/onstart.sh` | Boot script executed as the container's CMD. Starts all services. |

## Environment variables injected at machine creation

The API server (`fly.ts`) injects these into each workspace machine's env:

| Variable | Set by | Description |
|----------|--------|-------------|
| `MIZI_CALLBACK_URL` | API server | Endpoint for boot-phase status callbacks |
| `MIZI_MEM_AUTH_TOKEN` | API server | Auth token for the callback |
| `MIZI_SESSION_ID` | API server | The session ID |
| `MIZI_BRIDGE_URL` | API server | WebSocket URL for the Claw Bridge |
| `CODE_SERVER_PASSWORD` | onstart.sh | Auto-generated on first boot |
| `NVIDIA_NIM_API_KEY` | API server | Forwarded from API server secrets |

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
