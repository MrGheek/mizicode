# FLOATR Cloud Coding

A full-stack platform for spinning up GPU-powered AI coding sessions on Vast.ai.
The system provisions remote GPU machines running Bolt.diy, llama.cpp with GGUF models, code-server (VS Code), and an nginx preview proxy.

## Deploying to Fly.io

The API server and dashboard each have their own `fly.toml` and `Dockerfile`. Both use
the **monorepo root** as the Docker build context so shared libraries resolve correctly.

### Prerequisites

- [flyctl](https://fly.io/docs/hands-on/install-flyctl/) installed and authenticated
- A Fly.io account

---

### 1 — API Server

```bash
# Launch once (creates the Fly.io app; answer prompts to skip auto-deploy)
fly launch \
  --config artifacts/api-server/fly.toml \
  --dockerfile artifacts/api-server/Dockerfile \
  --name floatr-api \
  --no-deploy

# Provision a Postgres database and attach it (sets DATABASE_URL automatically)
fly postgres create --name floatr-db --region ord
fly postgres attach floatr-db --app floatr-api

# Create the persistent volume for the SQLite memory database
# (1 GB is sufficient to start; resize with `fly volumes extend` later)
fly volumes create floatr_memory --app floatr-api --region ord --size 1

# Set the remaining secrets
fly secrets set --app floatr-api \
  VASTAI_API_KEY="<your vastai key>" \
  AI_INTEGRATIONS_OPENAI_API_KEY="<your openai key>" \
  AI_INTEGRATIONS_OPENAI_BASE_URL="https://api.openai.com/v1" \
  NVIDIA_NIM_API_KEY="<your nim key>" \
  VULTR_INFERENCE_API_KEY="<optional>" \
  TOGETHER_API_KEY="<optional>" \
  DEEPINFRA_API_KEY="<optional>"

# Deploy (run from the monorepo root so the build context is correct)
fly deploy --config artifacts/api-server/fly.toml \
           --dockerfile artifacts/api-server/Dockerfile \
           --build-context .
```

After a successful deploy the API server is reachable at
`https://floatr-api.fly.dev`.

---

### 2 — Dashboard

```bash
# Launch once
fly launch \
  --config artifacts/dashboard/fly.toml \
  --dockerfile artifacts/dashboard/Dockerfile \
  --name floatr-dashboard \
  --no-deploy

# Deploy — pass the API server URL as a build arg
fly deploy --config artifacts/dashboard/fly.toml \
           --dockerfile artifacts/dashboard/Dockerfile \
           --build-context . \
           --build-arg VITE_API_BASE_URL=https://floatr-api.fly.dev
```

After a successful deploy the dashboard is reachable at
`https://floatr-dashboard.fly.dev`.

---

### Subsequent deploys

```bash
# API server
fly deploy --config artifacts/api-server/fly.toml \
           --dockerfile artifacts/api-server/Dockerfile \
           --build-context .

# Dashboard
fly deploy --config artifacts/dashboard/fly.toml \
           --dockerfile artifacts/dashboard/Dockerfile \
           --build-context . \
           --build-arg VITE_API_BASE_URL=https://floatr-api.fly.dev
```

### Checking logs

```bash
fly logs --app floatr-api
fly logs --app floatr-dashboard
```

---

## Local development

See individual artifact READMEs. The project uses pnpm workspaces:

```bash
pnpm install
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/dashboard run dev
```

## Secrets reference

See [`.env.example`](.env.example) for the full list of secrets and their descriptions.
