# Operational Runbook

Failure scenarios, incident response, and recovery procedures for MIZI.

MIZI provisions lightweight **CPU-only** workspace machines (Theia IDE) on
demand and routes all model inference to **hosted NVIDIA NIM** (or any
OpenAI-compatible provider) via an in-container proxy. There is **no GPU, no
vLLM, and no local model download** in the current architecture.

---

## Quick reference

| Service | Port | Health check | Startup critical |
|---------|------|--------------|------------------|
| API server (`mizi-api`) | 8080 internal / 443+80 public | `GET /api/healthz` (Fly http_check, 15s) | Yes |
| Dashboard (`mizicode`) | 80 internal / 443+80 public | `GET /` (Fly http_check, 30s) | Yes |
| PostgreSQL (`mizi-db`) | 5432 (direct) / 5433 (HAProxy leader) | `SELECT 1` via `/api/health` + migrate.ts | Yes (cloud) |
| Memory DB (SQLite, `mem.db`) | — | `GET /api/health` (memDb probe) | Yes (cloud) |
| Fly.io Machines | — | `fly machine list` | Depends |
| NVIDIA NIM API | hosted (`https://integrate.api.nvidia.com/v1`) | in-container nim-proxy `/health/liveliness` | Yes (per session) |

### Workspace machine services (one ephemeral Fly machine per NIM session, app `mizi-workspace`)

| Service | Port | Exposure |
|---------|------|----------|
| Theia | 8080 | Fly TLS/http, **nginx basic auth** (proxies loopback 8788) |
| claw-runner | 5182 (internal) / 5181 (proxied) | 5181 Fly TLS/http via nginx basic auth |
| nim-proxy (NIM pass-through) | 8081 | Fly TLS/http |
| bolt.diy | 5180 | Fly TLS/http |
| nginx (no-auth → Theia) | 8789 | Internal only (Fly 6PN, not a public service) |
| SSH (key-only) | 22 | Daemon runs in-container; not declared as a Fly service |

Workspace machines are created/destroyed **at runtime** by the API server via
the Fly Machines API. There is no standing Fly app deployment for workspace
content; the `mizi-workspace` app just needs to exist once
(`flyctl apps create mizi-workspace`).

---

## Incident response

### Severity levels

| Level | Definition | Response time |
|-------|------------|---------------|
| **SEV1** | All users unable to use the platform | Immediate |
| **SEV2** | Feature degraded for subset of users | < 1 hour |
| **SEV3** | Non-critical component failing | < 1 day |
| **SEV4** | Minor issue, no user impact | Next sprint |

### Incident workflow

1. **Detect** — Automated alert (Fly.io http_check on `/api/healthz`, log error rate spike) or user report
2. **Triage** — Check `GET /api/health`, `GET /api/healthz`, `GET /api/admin/status`, Fly.io logs
3. **Mitigate** — Apply fix or workaround (see scenarios below)
4. **Resolve** — Verify fix via health checks
5. **Post-mortem** — Document root cause, add monitoring, ticket any code changes

---

## Failure scenarios

### 1. Database connection lost (PostgreSQL)

**Symptoms:**
- API returns 500 errors on all DB queries
- Logs show `connect ETIMEDOUT` or `terminating connection due to administrator command`
- `GET /api/health` returns `503 { status: "degraded", db: "error" }`
- `GET /api/healthz` returns `503 { status: "degraded", error: "Database connectivity check failed" }`

**Root causes:**
- Fly.io Postgres restart or failover
- Network partition between api-server and database
- Connection pool exhaustion

**Immediate steps:**
```bash
# 1. Check Fly.io Postgres status
fly postgres list
fly status -a mizi-db

# 2. Confirm the database is accepting writes
fly ssh console -a mizi-db -C "psql -c 'SELECT 1;'"

# 3. Restart api-server to force new connections
fly apps restart mizi-api
```

**Recovery:**
- During deploy, the release command (`node dist/migrate.mjs`) waits for the
  primary to accept `BEGIN READ WRITE` (up to 90s) before running migrations —
  `waitForPrimary()` in `artifacts/api-server/src/migrate.ts`. It logs
  `pg_is_in_recovery()` for diagnostics but gates on writability, not that flag.
- Connection pool exhaustion: scale up api-server instances or adjust the `Pool`
  max connections (currently node-postgres default = 10).
- Persistent failure: restore from backup using `fly postgres restore`.

**Post-mortem checks:**
- Is the Postgres app healthy (`fly status -a mizi-db`)?
- Were multiple replicas promoted during failover?

---

### 2. Memory SQLite corruption / memory volume full

**Symptoms:**
- `GET /api/health` returns `503 { status: "degraded", memDb: "error" }`
- Logs show `SqliteError: disk I/O error` or `SqliteError: database disk image is malformed`
- Memory features stop working (context recall, item save, semantic search)

**Root causes:**
- Disk full on the memory volume (fly.toml mount `mizi_memory` → `/data/memory`)
- Unexpected process termination during WAL checkpoint
- Filesystem-level corruption on the mounted volume

**Immediate steps:**
```bash
# 1. Check memDb health
curl https://mizi-api.fly.dev/api/health | jq

# 2. Check memory disk space
curl https://mizi-api.fly.dev/api/admin/status | jq '.memoryDisk'

# 3. SSH into the machine and check the DB file (path = $MEM_DATA_DIR/mem.db)
fly ssh console
cd /data/memory
sqlite3 mem.db "PRAGMA integrity_check;"
```

**Recovery:**
- If `integrity_check` reports corrupt pages:
  ```bash
  # Attempt recovery
  sqlite3 mem.db ".clone mem_recovered.db"
  sqlite3 mem_recovered.db "PRAGMA integrity_check;"
  # If recovered, replace
  mv mem.db mem.db.corrupt.$(date +%s)
  mv mem_recovered.db mem.db
  # Restart the app
  fly apps restart mizi-api
  ```
- If recovery fails, restore from the latest backup (see Backup and restore below).
- If the volume is full, clean up old data first, then extend the volume:
  `fly volumes extend mizi_memory --app mizi-api --size <gb>`.

**Prevention:**
- `startMemoryDiskMonitor()` runs every 5 minutes (`MEM_DISK_CHECK_INTERVAL_MS`)
  — check `GET /api/admin/status` for disk health
- Configure `MEM_DISK_WARN_MB` (default 200) and `MEM_DISK_CRITICAL_MB` (default 50)

---

### 3. Workspace provisioning failure (Fly Machines API)

**Symptoms:**
- New NIM sessions fail to create with `Provisioning failed: <error>` or
  `Fly Machines API error <status>: <body>`
- `GET /api/healthz` returns `503` with a `missingSecrets` array
- Logs show `FLY_API_TOKEN is not set` or `Fly Machines API returned no machine ID`

**Root causes:**
- `FLY_API_TOKEN` missing or expired (generate with `fly tokens create deploy -x 999999h`)
- `FLY_WORKSPACE_APP_NAME` missing (workspace machines would fall back to the API app)
- `mizi-workspace` app does not exist
- Workspace image pull failure / Fly region capacity
- Fly.io Machines API outage

**Immediate steps:**
```bash
# 1. Inspect the healthz missingSecrets payload
curl https://mizi-api.fly.dev/api/healthz | jq

# 2. Check the workspace app exists and list its machines
fly apps list | grep mizi-workspace
fly machine list -a mizi-workspace

# 3. Re-set the Fly secrets if missing
fly secrets set --app mizi-api \
  FLY_API_TOKEN="$(fly tokens create deploy -x 999999h)" \
  FLY_WORKSPACE_APP_NAME="mizi-workspace"
```

**Recovery:**
- Create the workspace app once: `flyctl apps create mizi-workspace`
- Rotate the token if 401/403 from the Machines API
- If the image (`registry.fly.io/mizi-workspace`) fails to pull, rebuild and
  re-push it (see "Workspace image updates" under Maintenance).
- Ambient reconcile (`services/ambient.ts`, every 2 min) marks sessions whose
  machine reports `destroyed` as `error` automatically — it does **not** retry
  provisioning, so re-create the session once the underlying cause is fixed.

**Post-mortem checks:**
- Was `FLY_API_TOKEN` close to expiry?
- Did the workspace image tag change but not get pushed?

---

### 4. NIM model provider failure

**Symptoms:**
- Inference returns errors or timeouts from the workspace (via nim-proxy)
- Logs show `[nim-catalog] Failed to sync NIM catalog` (older images) or
  `NIM catalog sync failed`
- Model routing (inference-router) degrades or returns lower-scoring fallbacks
- Theia/bolt show model API errors while the workspace itself is `ready`

**Root causes:**
- `NVIDIA_NIM_API_KEY` missing or expired (hosted `https://integrate.api.nvidia.com/v1`)
- NVIDIA NIM / partner provider (Vultr, Together, DeepInfra) API outage
- nim-proxy in the workspace failed to start or crashed (double-restart loop)

**Immediate steps:**
```bash
# 1. Check the API server's catalog sync status in logs
fly logs --app mizi-api | grep -i "nim catalog"

# 2. Check session status
curl https://mizi-api.fly.dev/api/sessions/ | jq '.[] | {id, status, statusMessage}'

# 3. If inference is down, verify the provider key
fly secrets list --app mizi-api | grep NIM
```

**Recovery:**
- **Missing/expired key**: `fly secrets set --app mizi-api NVIDIA_NIM_API_KEY=<key>`
- **Catalog sync failure**: Non-fatal — `syncNimCatalog()` wraps errors and the
  last successful sync stays cached in the DB. Re-sync runs every 6 hours.
- **nim-proxy dead in a workspace**: `onstart.sh` auto-restarts it every 30s and
  marks the session `ready` regardless once the probe window passes, so a cold
  proxy does not keep a session stuck.

---

### 5. Claim sweeper failure

**Symptoms:**
- `GET /api/admin/status` shows `sweeper.lastRunAt` more than 60 seconds ago
- Error log spam every 30 seconds: `Claim sweeper failed`
- Stale claims accumulate, leading to false `block` conflicts

**Root cause:**
- Database connection issue during sweeper execution
- Unexpected exception in the sweeper callback

**Recovery:**
```bash
# 1. Check sweeper health
curl https://mizi-api.fly.dev/api/admin/status | jq '.sweeper'

# 2. Manually trigger a sweep (requires agent auth / coordination:write scope)
curl -X POST https://mizi-api.fly.dev/api/admin/sweep-claims \
  -H "Authorization: Bearer $MIZI_MEM_TOKEN"

# 3. If DB is healthy but sweeper still failing, restart the app
fly apps restart mizi-api
```

**Prevention:**
- The sweeper interval callback has a try/catch and will retry on the next
  30-second tick (`SWEEP_INTERVAL_MS = 30_000`).
- No circuit breaker or back-off exists — consecutive failures will spam logs.

---

### 6. Session stuck in `provisioning` / `starting`

**Symptoms:**
- Session stays in `provisioning` or `starting` past the ~2 minute NIM fast-boot window
- No `theia_ready` callback received from the workspace machine
- Dashboard boot log stalls on a phase

**Root causes:**
- Workspace Fly machine failed to boot (image/init issue)
- Network issue preventing the machine from reaching the API callback
- nim-proxy or Theia crashed inside the container
- Boot failure phases (reported by onstart.sh): `provisioning_failed`,
  `download_failed`, `download_stalled`, `vllm_warmup_failed` (Vast.ai provider),
  `skills_compile_failed`, `disk_full`

**Immediate steps:**
```bash
# 1. Find stuck sessions
curl https://mizi-api.fly.dev/api/sessions/ | jq '.[] | select(.status == "provisioning" or .status == "starting") | .id'

# 2. Check the workspace machine state and its boot log
fly machine list -a mizi-workspace
fly logs -a mizi-workspace | tail -100
```

**Recovery:**
- Workspace machines report phases to the API via
  `POST /api/sessions/:sessionId/status` (Bearer `MIZI_MEM_TOKEN`; URL set via
  `MIZI_CALLBACK_URL`). The dashboard boot log surfaces a structured cause
  (`boot_failure:<cause>: <human message>`) for each phase.
- NIM sessions are marked `ready` only when `theia_ready` is received — `llm_ready`
  keeps the session in `starting` until Theia is serving (`sessions-crud.ts`).
- If the machine exists but the session is wedged, destroy and re-create the
  session (the ambient reconcile only clears destroyed machines; it does not retry).
- The old Vast.ai 30-minute "success" heuristic still exists in
  `syncSessionFromVastai()` but applies only to Vast.ai-backed sessions.

---

### 7. Background service startup crash

**Symptoms:**
- API server starts but immediately exits
- Logs show a startup guard failure from one of: `PORT`, memory data dir
  validation, `MIZI_ENCRYPTION_KEY`, `MIZI_MEM_TOKEN`, `FLY_API_TOKEN`,
  `FLY_WORKSPACE_APP_NAME`

**Root causes:**
- Missing/empty production secrets in `NODE_ENV=production` (see `index.ts`
  startup guards — each calls `process.exit(1)` with a clear log line)
- `MEM_DATA_DIR` not writable (volume mount missing → `validateMemoryDataDir()`)

**Immediate steps:**
```bash
# Get recent logs to identify which guard failed
fly logs --app mizi-api | tail -50
```

**Recovery:**
- Fix the underlying issue (almost always a missing secret or volume mount)
- Restart the app: `fly apps restart mizi-api`
- Note: the cloud startup **jobs** (scheduler, eval scheduler, memory disk
  monitor, plan auto-advance, plan decompose, NIM catalog sync, ambient runner)
  are all wrapped in try/catch in `index.ts` — a failing background job logs
  "non-fatal" and does **not** crash the process. Only the startup guards above
  are fatal.

**Known affected startup guards (all in `artifacts/api-server/src/index.ts`):**
| Guard | Behavior when missing |
|-------|----------------------|
| `PORT` | Throws — process exits |
| `CLAIM_RETENTION_DAYS` / `CLAIM_CLEANUP_INTERVAL_MS` | Throws on invalid values |
| memory data dir writability (cloud) | `process.exit(1)` |
| `MIZI_ENCRYPTION_KEY` (prod) | `process.exit(1)` |
| `MIZI_MEM_TOKEN` (prod) | `process.exit(1)` |
| `FLY_API_TOKEN` (prod) | `process.exit(1)` |
| `FLY_WORKSPACE_APP_NAME` (prod) | `process.exit(1)` |

---

### 8. Fly.io machine crash / OOM

**Symptoms:**
- API server or a workspace machine becomes unresponsive
- Fly.io dashboard shows machine restarts
- Logs show `Out of memory` or `Exit code 137`

**Root causes:**
- Memory leak in the API server
- Traffic spike exceeding machine memory limits
- Inefficient query causing memory spike

**Immediate steps:**
```bash
# 1. Check API server machine status
fly machine list -a mizi-api

# 2. Restart the machine
fly machine restart <machine-id> -a mizi-api

# 3. If restart doesn't work, force a new deploy
fly deploy --config artifacts/api-server/fly.toml \
  --dockerfile artifacts/api-server/Dockerfile \
  --build-context . \
  --strategy immediate
```

**Recovery:**
- Scale up the API machine: update `artifacts/api-server/fly.toml` `[[vm]]`
  size/memory and redeploy.
- Workspace machines are created with `restart: { policy: "no" }` — a crashed
  workspace machine is not restarted; the session should be destroyed and
  re-created (the ambient reconcile marks it `error` first).
- Add memory monitoring: `fly logs --app mizi-api | grep -i memory`

---

### 9. Bridge WebSocket disconnection

**Symptoms:**
- Agent lane shows "disconnected" in dashboard
- Exec commands return `Bridge disconnected before exec completed`
- Lane cannot claim files or execute commands

**Root causes:**
- Workspace machine network issue / restart
- API server restart
- Idle timeout on the WebSocket (no traffic)

**Recovery:**
- **Automatic**: the Claw Bridge client (`docker/claw-bridge.mjs`) reconnects
  with exponential backoff (1s → 2s → 4s …, capped at 60s). It is started once
  by `onstart.sh` and self-heals; no manual action is normally needed.
- **Server-side**: the bridge registry allows exactly one connection per
  `sessionId:laneId`. A new connection supersedes the old one
  (`registerBridge` closes the old socket with code `1001`).
- Keep-alive pings are sent every 30s (`bridge.ts`) so idle lanes don't drop.

**Post-mortem checks:**
- If lanes stay disconnected, check the machine's bridge log:
  `fly logs -a mizi-workspace | grep -i bridge`

---

### 10. Scheduled session launch failure

**Symptoms:**
- `scheduler.ts` fails to launch a scheduled session
- Logs show `[scheduler] Launch failed`
- Session expected at `launchTime` never appears

**Root causes:**
- The scheduler's launch path (`launchScheduledSession` in `services/scheduler.ts`)
  provisions through the **Vast.ai GPU path** (`vastai.searchOffers`
  → `vastai.createInstance`) — it does not use the hosted-inference (Fly
  Machines) fast-boot path.
  It therefore requires `VASTAI_API_KEY` and a matching GPU offer.
- Invalid `profileId` (profile was deleted after the schedule was created)
- `launchScheduledSession` only runs when `MIZI_DISTRIBUTION !== "local"`

**Immediate steps:**
```bash
# 1. Check if scheduler is running
fly logs --app mizi-api | grep -i scheduler

# 2. Check Vast.ai API key (scheduler path requires the Vast.ai provisioner)
fly secrets list --app mizi-api | grep VASTAI
```

**Recovery:**
- Manually launch the session via the normal hosted-inference flow instead
- The scheduler retries on the next 30-second tick only for different launch
  times, not for failed launches of the same time slot
- `recentActions` set prevents double-launching within the same day

> **Gap:** the scheduler has not been migrated to the NIM/Fly fast-boot path.
> Prefer on-demand session creation for NIM workloads.

---

## Maintenance procedures

### Database migrations

```bash
# Migrations run automatically:
#   - Cloud deploys: release command `node dist/migrate.mjs` (Fly.io) — a custom
#     runner (artifacts/api-server/src/migrate.ts) that boots fresh DBs from
#     lib/db/migrations/_bootstrap.sql, repairs zombie journal entries, and
#     applies journal-tracked incremental SQL with BEGIN READ WRITE.
#   - Dev startup: Drizzle migrate() under a pg advisory lock (non-fatal).
#   - Local startup: services/local-migrate.ts (SQLite).

# Manual migration (if automatic fails):
fly ssh console -a mizi-api
export DATABASE_URL="postgres://..."
node dist/migrate.mjs
```

### Secret rotation

```bash
# Rotate a secret without downtime
fly secrets set MIZI_MEM_TOKEN=<new-token> -a mizi-api
# This triggers a rolling restart

# Verify the new secret
fly ssh console -a mizi-api -C "echo \$MIZI_MEM_TOKEN"
```

### Backup and restore

**Memory database (SQLite, `$MEM_DATA_DIR/mem.db`):**
```bash
# Backup
fly ssh console -a mizi-api
cp /data/memory/mem.db /data/memory/backups/mem.db.$(date +%Y%m%d_%H%M%S)

# Restore from backup
cp /data/memory/backups/mem.db.20260101_120000 /data/memory/mem.db
fly apps restart mizi-api
```

**PostgreSQL (automated by Fly.io):**
```bash
# List backups
fly postgres backup list -a mizi-db

# Restore
fly postgres restore <backup-id> -a mizi-db
```

### Deploy procedure

```bash
# Standard API deploy (run from the monorepo root — build context is `.`)
fly deploy --config artifacts/api-server/fly.toml \
  --dockerfile artifacts/api-server/Dockerfile \
  --build-context .

# Dashboard (VITE_API_BASE_URL is a build arg)
fly deploy --config artifacts/dashboard/fly.toml \
  --dockerfile artifacts/dashboard/Dockerfile \
  --build-context . \
  --build-arg VITE_API_BASE_URL=https://mizi-api.fly.dev
```

Migrations run automatically via the release command on every API deploy; there
is no supported "skip migrations" path (setting `MIGRATE_DATABASE_URL` to an
empty value makes `migrate.mjs` exit 1 and abort the deploy).

### Workspace image updates

The workspace image is not deployed like a normal app — machines pull it at
creation time, so updating it only affects new sessions.

```bash
# Build and push (from workspace root)
flyctl auth docker
docker build -t registry.fly.io/mizi-workspace:latest -f docker/Dockerfile .
docker push registry.fly.io/mizi-workspace:latest

# Or build remotely without a local Docker daemon
flyctl deploy --app mizi-workspace \
  --dockerfile docker/Dockerfile \
  --image-label latest \
  --strategy immediate \
  --no-public-ips
```

Patch-level fixes (e.g. nim-proxy.py) can be shipped without a new image: the
API server embeds the current nim-proxy.py as an inline heredoc in the generated
onstart script (`services/vastai.ts` → `buildOnStartScript`), so **redeploying
only `mizi-api`** applies the fix to every new session. See
`.agents/memory/nim-proxy-deploy-strategy.md`.

---

## Monitoring

### Health endpoints

| Endpoint | What it checks | Expected |
|----------|---------------|----------|
| `GET /api/health` | SQLite memory probe + Postgres `SELECT 1` | `200 { status: "ok", memDb: "ok", db: "ok", dbPath }` else `503 { status: "degraded", ... }` |
| `GET /api/healthz` | Prod secrets (`FLY_API_TOKEN`, `FLY_WORKSPACE_APP_NAME`) + Postgres `SELECT 1` | `200 { status: "ok" }` else `503` with `missingSecrets` / `db: "error"` |
| `GET /api/admin/status` | Claim sweeper + memory disk | `{ status, sweeper, memoryDisk }` |

`/api/healthz` is the Fly.io http_check path (15s interval, 30s grace).

### Key metrics to monitor

| Metric | Source | Warning | Critical |
|--------|--------|---------|----------|
| Memory disk free | `/api/admin/status` | < 200 MB | < 50 MB |
| Claim sweeper `lastRunAt` | `/api/admin/status` | > 60s ago | > 180s ago |
| DB connection success | `/api/health` / `/api/healthz` | — | Any failure |
| Workspace machine count | `fly machine list -a mizi-workspace` | Spikes in destroyed machines | 0 during active load |
| Session provisioning failures | Session status count | > 3 in 1 hour | > 10 in 1 hour |
| NIM catalog sync | API logs | Sync failed once | Repeated failures |

### Log queries

```bash
# View recent errors
fly logs --app mizi-api | grep error

# View claim sweeper activity
fly logs --app mizi-api | grep -i sweeper

# View session lifecycle
fly logs --app mizi-api | grep -i "session"

# View Fly machine provisioning activity
fly logs --app mizi-api | grep -i "fly machine"

# View NIM catalog / inference activity
fly logs --app mizi-api | grep -i "nim catalog"

# View bridge (claw) connections
fly logs --app mizi-api | grep -i bridge

# View a workspace machine's boot log
fly logs --app mizi-workspace | tail -100
```

---

## Configuration reference

### Required environment variables

| Variable | Required in | Notes |
|----------|-------------|-------|
| `PORT` | All | Startup guard exits if missing (8080 in fly.toml) |
| `DATABASE_URL` | Cloud | Set by `fly postgres attach`; healthz returns 503 if unreachable |
| `MIZI_ENCRYPTION_KEY` | Cloud production | 64 hex chars (`openssl rand -hex 32`); exits if missing |
| `MIZI_MEM_TOKEN` | Cloud production | 64 hex chars (`openssl rand -hex 32`); guards status/bridge/memory/ambient callbacks; exits if missing |
| `FLY_API_TOKEN` | Cloud production | Fly Machines API token (`fly tokens create deploy -x 999999h`); exits if missing |
| `FLY_WORKSPACE_APP_NAME` | Cloud production | `mizi-workspace`; exits if missing |
| `NVIDIA_NIM_API_KEY` | Cloud (NIM features) | Hosted NIM key (nvapi-…); not a startup guard, but NIM catalog + inference depend on it |

### Optional variables with defaults

| Variable | Default | Purpose |
|----------|---------|---------|
| `DASHBOARD_URL` | — | OAuth redirect origin (e.g. `https://mizicode.fly.dev`); warn-only |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | — | "Connect GitHub to work" |
| `AI_INTEGRATIONS_OPENAI_API_KEY` / `_BASE_URL` | — | OpenAI-compatible endpoint for ambient/embeddings |
| `VULTR_INFERENCE_API_KEY` | — | Vultr model provider |
| `TOGETHER_API_KEY` | — | Together.xyz model provider |
| `DEEPINFRA_API_KEY` | — | DeepInfra model provider |
| `BRAVE_SEARCH_API_KEY` / `SERPER_API_KEY` | — | Web-search skill (at least one required for search tool) |
| `SAFETY_EMAIL_TO` / `SAFETY_EMAIL_WEBHOOK_URL` / `SAFETY_EMAIL_WEBHOOK_AUTH` | — | Safety alert notifications |
| `VASTAI_API_KEY` | — | Vast.ai API key for the Vast.ai provider path (scheduler) |
| `LOG_LEVEL` | `"info"` | Pino log level |
| `MEM_DATA_DIR` | `~/mizi-memory` | Memory SQLite directory (fly.toml: `/data/memory`) |
| `MEM_DISK_WARN_MB` | `200` | Warning threshold |
| `MEM_DISK_CRITICAL_MB` | `50` | Critical threshold |
| `MEM_DISK_CHECK_INTERVAL_MS` | `300000` | Disk monitor interval (5 min) |
| `CLAIM_RETENTION_DAYS` | `7` | Purge retention for inactive claims |
| `CLAIM_CLEANUP_INTERVAL_MS` | `3600000` | Purge interval (1 hour) |

### Env vars injected into each workspace machine at creation

| Variable | Description |
|----------|-------------|
| `MIZI_CALLBACK_URL` | Boot-phase status callback (`POST /api/sessions/:id/status`) |
| `MIZI_MEM_AUTH_TOKEN` | Bearer token for the callback (== `MIZI_MEM_TOKEN`) |
| `MIZI_SESSION_ID` | Session ID |
| `MIZI_BRIDGE_URL` | Claw bridge WebSocket URL (`wss://<api>/api/bridge/:sessionId/:laneId`) |
| `NIM_MODEL_ID` / `NIM_API_BASE` / `NIM_API_KEY` | Hosted inference config for nim-proxy |
| `NGINX_AUTH_USER` / `NGINX_AUTH_PASS` | Theia/claw basic-auth credentials |

---

## Gaps and known improvements

| Area | Current state | Recommended improvement |
|------|--------------|------------------------|
| Error handling | No global error middleware, no standard envelope | Add Express error middleware and standard `{ error, code }` response shape |
| Retry logic | No retry on Fly Machines API / NIM provider calls | Add exponential backoff |
| Circuit breakers | None | Add circuit breakers for Fly.io and NIM providers |
| Prometheus metrics | None | Add request latency, error rate, and queue depth metrics |
| Scheduler | Uses Vast.ai GPU provider path (`scheduler.ts`) | Migrate scheduled launches to NIM fast-boot / Fly Machines |
| Scheduler double-fire | `recentActions` dedup (in-memory set) | Migrate to DB-backed dedup for crash resilience |
| Claim sweeper alerting | Log-only | Add Prometheus gauge for `lastRunAt` staleness |
| Migration failure | Dev migrations are silently non-fatal | Add explicit `logger.fatal` if migrations fail in production |
| Vast.ai provider code | `vastai.ts` / Vast.ai session path — now a first-class peer provider | Ensure parity with NIM/fly provider features |
