# Operational Runbook

Failure scenarios, incident response, and recovery procedures for MIZI.

---

## Quick reference

| Service | Port | Health endpoint | Startup critical |
|---------|------|----------------|-----------------|
| API server | 8080 | `GET /api/healthz` | Yes |
| PostgreSQL | 5432 (direct) / 5433 (HAProxy) | `SELECT 1` via migrate.ts | Yes |
| Memory DB (SQLite) | — | `GET /api/health` | Yes (cloud) |
| Fly.io Machines | — | `fly machine list` | Depends |
| Vast.ai | — | `vastai show instances` | No |

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

1. **Detect** — Automated alert (Fly.io health check, log error rate spike) or user report
2. **Triage** — Check `GET /api/health`, `GET /api/admin/status`, Fly.io logs
3. **Mitigate** — Apply fix or workaround (see scenarios below)
4. **Resolve** — Verify fix via health checks
5. **Post-mortem** — Document root cause, add monitoring, ticket any code changes

---

## Failure scenarios

### 1. Database connection lost (PostgreSQL)

**Symptoms:**
- API returns 500 errors on all DB queries
- Logs show `connect ETIMEDOUT` or `terminating connection due to administrator command`
- `GET /api/healthz` may still return 200 (only checks Fly secrets, not DB)

**Root causes:**
- Fly.io Postgres restart or failover
- Network partition between api-server and database
- Connection pool exhaustion

**Immediate steps:**
```bash
# 1. Check Fly.io Postgres status
fly postgres list
fly status -a <postgres-app-name>

# 2. Check if Postgres is in recovery mode
fly ssh console -a <postgres-app-name> -C "psql -c 'SELECT pg_is_in_recovery();'"

# 3. Restart api-server to force new connections
fly apps restart mizi-api
```

**Recovery:**
- `pg_is_in_recovery()` = true: Postgres is a replica; wait for failover to complete (up to 90s). The `waitForPrimary` function in `migrate.ts` handles this during deploys.
- Connection pool exhaustion: scale up api-server instances or adjust `Pool` max connections (currently uses default = 10).
- Persistent failure: restore from backup using `fly postgres restore`.

**Post-mortem checks:**
- Is `MONITOR_DATABASE_URL` set for connection monitoring?
- Are Fly.io Postgres autostopped instances being restarted correctly?

---

### 2. Memory SQLite corruption

**Symptoms:**
- `GET /api/health` returns `503 { status: "degraded", memDb: "error" }`
- Logs show `SqliteError: disk I/O error` or `SqliteError: database disk image is malformed`
- Memory features stop working (context recall, item save, semantic search)

**Root causes:**
- Disk full on the memory volume
- Unexpected process termination during WAL checkpoint
- Filesystem-level corruption on the mounted volume

**Immediate steps:**
```bash
# 1. Check memDb health
curl https://mizi-api.fly.dev/api/health | jq

# 2. Check memory disk space
curl https://mizi-api.fly.dev/api/admin/status | jq '.memoryDisk'

# 3. SSH into the machine and check the DB file
fly ssh console
cd /data/memory
sqlite3 memory.db "PRAGMA integrity_check;"
```

**Recovery:**
- If `integrity_check` reports corrupt pages:
  ```bash
  # Attempt recovery
  sqlite3 memory.db ".clone memory_recovered.db"
  sqlite3 memory_recovered.db "PRAGMA integrity_check;"
  # If recovered, replace
  mv memory.db memory.db.corrupt.$(date +%s)
  mv memory_recovered.db memory.db
  # Restart the app
  fly apps restart mizi-api
  ```
- If recovery fails, restore from the latest backup (see Backup and restore below).
- If the volume is full, clean up old data first (remove old snapshots, logs).

**Prevention:**
- `startMemoryDiskMonitor()` runs every 5 minutes — check `GET /api/admin/status` for disk health
- Configure `MEM_DISK_WARN_MB` (default 200) and `MEM_DISK_CRITICAL_MB` (default 50)

---

### 3. Vast.ai API failure

**Symptoms:**
- Session provisioning fails with `Provisioning failed: <error>`
- Logs show `Vast.ai API error <status>: <body>`
- New sessions cannot be created

**Root causes:**
- Vast.ai API outage
- Insufficient GPU availability for the requested profile
- API key expired or invalid
- Rate limiting (Vast.ai returns 429)

**Immediate steps:**
```bash
# 1. Check Vast.ai API connectivity
curl -H "Authorization: Bearer $VASTAI_API_KEY" https://vast.ai/api/v0/instances/

# 2. Check GPU offer availability for the profile
# Search for offers matching the profile's GPU type
vastai search offers 'gpu_name=RTX_4090 num_gpus=1'
```

**Recovery:**
- If API returns 401/403: rotate the Vast.ai API key in Fly secrets
- If API returns 429: implement rate-limit backoff (currently no retry logic exists)
- If insufficient offers: the scheduler (`scheduler.ts`) fails gracefully — the session is marked as `error` with message `Provisioning failed: No suitable offer found`
- If Vast.ai is entirely down: no mitigation other than wait for Vast.ai recovery

**Workaround:**
- Create a session manually with a pre-provisioned GPU instance by calling `POST /sessions` with `existingBoltUrl` instead of a profile ID

**Post-mortem checks:**
- Consider adding retry logic with exponential backoff to `vastFetch()` in `vastai.ts`
- Consider adding Vast.ai connectivity to the health check endpoint

---

### 4. Claim sweeper failure

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

# 2. Manually trigger a sweep
curl -X POST https://mizi-api.fly.dev/api/admin/sweep-claims

# 3. If DB is healthy but sweeper still failing, restart the app
fly apps restart mizi-api
```

**Prevention:**
- The sweeper interval callback has a try/catch and will retry on the next 30-second tick
- No circuit breaker or back-off exists — consecutive failures will spam logs

---

### 5. NIM provider failure

**Symptoms:**
- NIM sessions stuck in `starting` state (never transition to `ready`)
- Logs show `[nim] Failed to create Fly machine: <error>`
- Logs show `[nim-catalog] Failed to sync NIM catalog`
- Inference routing returns degraded results

**Root causes:**
- Fly.io Machines API failure
- NIM provider (NVIDIA, Vultr, Together, DeepInfra) API outage
- NIM provider API key missing or expired
- Bolt.diy warmup timeout (720s container warmup + 900s watchdog)

**Immediate steps:**
```bash
# 1. Check Fly Machine state
fly machine list -a mizi-api

# 2. Check session status
curl https://mizi-api.fly.dev/api/sessions/ | jq '.[] | {id, status, statusMessage}'

# 3. If session is stuck "starting", check the session's lifecycle events
```

**Recovery:**
- **Missing API key**: Add the secret with `fly secrets set NVIDIA_NIM_API_KEY=<key>`
- **Fly Machine crashed**: The session refresher in `sessions.ts` checks for `"destroyed"` state and marks sessions as `error` automatically
- **Stuck in starting**: Sessions with NIM sessions that don't report `theia_ready` within timeout are handled by the watchdogs described in sessions.ts
- **Catalog sync failure**: Non-fatal — `syncNimCatalog()` wraps errors. Models from the last successful sync remain cached in the database.

---

### 6. Session provisioning timeout

**Symptoms:**
- Session stuck in `provisioning` or `downloading` for > 30 minutes
- No ready-callback received from the workspace instance

**Root causes:**
- Workspace instance failed to start (OS/image issue)
- Network issue preventing the workspace from reaching the API server
- NIM Theia warmup failure
- GPU instance actually ready but callback URL misconfigured

**Recovery:**
- The API server auto-marks sessions as `ready` after 30 minutes if `status_msg` starts with "success" (heuristic in sessions.ts)
- If the heuristic doesn't trigger, manually update the session:
  ```bash
  # 1. Find the session ID
  curl https://mizi-api.fly.dev/api/sessions/ | jq '.[] | select(.status == "provisioning") | .id'

  # 2. Force-mark as ready (if workspace is actually available)
  curl -X POST https://mizi-api.fly.dev/api/sessions/<id>/status \
    -H "Authorization: Bearer $MIZI_MEM_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"status": "theia_ready", "theiaUrl": "http://workspace:3000"}'
  ```

**Prevention:**
- Check Vast.ai image availability before creating sessions for custom Docker images
- Ensure `CALLBACK_URL` is correctly configured in the workspace environment

---

### 7. Background service startup crash

**Symptoms:**
- API server starts but immediately exits
- Logs show error from one of: `startScheduler`, `startEvalScheduler`, `startMemoryDiskMonitor`, `startPlanAutoAdvance`, `startPlanDecompose`

**Root causes:**
- These services have no try/catch at the `index.ts` call site. If any throws synchronously during startup, the process exits.

**Immediate steps:**
```bash
# Get recent logs to identify which service crashed
fly logs -a mizi-api | tail -50
```

**Recovery:**
- Fix the underlying issue (often a missing env var or DB schema mismatch)
- Restart the app: `fly apps restart mizi-api`
- If the service is non-essential, temporarily patch `index.ts` to wrap the call in try/catch

**Known affected services:**
| Service | Started by | Risk |
|---------|-----------|------|
| `startScheduler()` | `index.ts:304` | **No try/catch** |
| `startEvalScheduler(60)` | `index.ts:335` | **No try/catch** |
| `startMemoryDiskMonitor()` | `index.ts:340` | **No try/catch** |
| `startPlanAutoAdvance()` | `index.ts:347` | **No try/catch** |
| `startPlanDecompose()` | `index.ts:355` | **No try/catch** |

---

### 8. Fly.io machine crash / OOM

**Symptoms:**
- API server becomes unresponsive
- Fly.io dashboard shows machine restarts
- Logs show `Out of memory` or `Exit code 137`

**Root causes:**
- Memory leak in the API server
- Traffic spike exceeding machine memory limits
- Inefficient query causing memory spike

**Immediate steps:**
```bash
# 1. Check machine status
fly machine list -a mizi-api

# 2. Restart the machine
fly machine restart <machine-id> -a mizi-api

# 3. If restart doesn't work, force a new deploy
fly deploy --strategy immediate
```

**Recovery:**
- Scale up the machine type: update `fly.toml` with a larger `size` and redeploy
- Add memory monitoring: `fly logs -a mizi-api | grep -i memory`
- Consider adding a `restart` policy: currently Fly Machines have `restart: no` — switch to `restart: on-fail` for the API server

---

### 9. Bridge WebSocket disconnection

**Symptoms:**
- Agent lane shows "disconnected" in dashboard
- Exec commands return `Bridge disconnected before exec completed`
- Lane cannot claim files or execute commands

**Root causes:**
- Workspace instance network issue
- Workspace machine restart
- API server restart
- Idle timeout on the WebSocket

**Recovery:**
- **Server-side**: No automatic reconnection exists. The workspace machine's `onstart.sh` must reconnect on the client side.
- **Manual**: Restart the workspace instance or wait for the lane agent to re-establish the WebSocket
- The `registerBridge()` function handles reconnection by closing the old connection with code `1001` ("Superseded") and accepting the new one

**Prevention:**
- The bridge registry supports exactly one connection per `sessionId:laneId`. Old connections are automatically superseded by new ones.

---

### 10. Scheduled session launch failure

**Symptoms:**
- `scheduler.ts` fails to launch a scheduled session
- Logs show `[scheduler] Launch failed`
- Session expected at `launchTime` never appears

**Root causes:**
- Missing `VASTAI_API_KEY`
- Insufficient GPU offers
- Invalid `profileId` (profile was deleted after schedule was created)
- `launchScheduledSession` only runs when `MIZI_DISTRIBUTION !== "local"`

**Immediate steps:**
```bash
# 1. Check if scheduler is running
curl https://mizi-api.fly.dev/api/sessions/schedule

# 2. Check Vast.ai API key
fly secrets list -a mizi-api | grep VASTAI
```

**Recovery:**
- Manually launch: `POST /sessions` with the expected profile
- The scheduler retries on the next 30-second tick only for different launch times, not for failed launches of the same time slot
- `recentActions` set prevents double-launching within the same day

---

## Maintenance procedures

### Database migrations

```bash
# Migrations run automatically:
#   - On deploy: release command `node dist/migrate.mjs` (Fly.io)
#   - On startup: Drizzle migrate() with pg_advisory_lock (dev mode)
#   - On local startup: local-migrate.ts (SQLite)

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

**Memory database (SQLite):**
```bash
# Backup
fly ssh console -a mizi-api
cp /data/memory/memory.db /data/memory/backups/memory.db.$(date +%Y%m%d_%H%M%S)

# Restore from backup
cp /data/memory/backups/memory.db.20260101_120000 /data/memory/memory.db
fly apps restart mizi-api
```

**PostgreSQL (automated by Fly.io):**
```bash
# List backups
fly postgres backup list -a <postgres-app>

# Restore
fly postgres restore <backup-id> -a <postgres-app>
```

### Deploy procedure

```bash
# Standard deploy (migrations run automatically)
fly deploy

# Deploy without running migrations (emergency)
# Set MIGRATE_DATABASE_URL to empty string
fly deploy --env MIGRATE_DATABASE_URL=""
```

---

## Monitoring

### Health endpoints

| Endpoint | What it checks | Expected |
|----------|---------------|----------|
| `GET /api/health` | Memory DB liveness | `200 { status: "ok", memDb: "ok" }` |
| `GET /api/healthz` | Production secrets | `200 { status: "ok" }` |
| `GET /api/admin/status` | Sweeper + memory disk | See below |

### Key metrics to monitor

| Metric | Source | Warning | Critical |
|--------|--------|---------|----------|
| Memory disk free | `/api/admin/status` | < 200 MB | < 50 MB |
| Claim sweeper lastRunAt | `/api/admin/status` | > 60s ago | > 180s ago |
| DB connection success | Health logs | — | Any failure |
| Vast.ai API errors | Error log count | > 5/min | > 20/min |
| Session provisioning failures | Session status count | > 3 in 1 hour | > 10 in 1 hour |

### Log queries

```bash
# View recent errors
fly logs -a mizi-api | grep error

# View claim sweeper activity
fly logs -a mizi-api | grep sweeper

# View session lifecycle
fly logs -a mizi-api | grep "session.*status"

# View NIM provider activity
fly logs -a mizi-api | grep "\[nim\]"

# View Vast.ai API calls
fly logs -a mizi-api | grep vastai
```

---

## Configuration reference

### Required environment variables

| Variable | Required in | Notes |
|----------|-------------|-------|
| `PORT` | All | Startup guard exits if missing |
| `DATABASE_URL` | Cloud | Warns if missing (non-fatal at startup) |
| `MIZI_ENCRYPTION_KEY` | Cloud production | 64 hex chars; exits if missing |
| `MIZI_MEM_TOKEN` | Cloud production | 64 hex chars; exits if missing |
| `FLY_API_TOKEN` | Cloud production | Exits if missing |
| `FLY_WORKSPACE_APP_NAME` | Cloud production | Exits if missing |
| `VASTAI_API_KEY` | Cloud | Throws on use, not at startup |

### Optional variables with defaults

| Variable | Default | Purpose |
|----------|---------|---------|
| `LOG_LEVEL` | `"info"` | Pino log level |
| `MEM_DATA_DIR` | `~/mizi-memory` | Memory SQLite directory |
| `MEM_DISK_WARN_MB` | `200` | Warning threshold |
| `MEM_DISK_CRITICAL_MB` | `50` | Critical threshold |
| `CLAIM_RETENTION_DAYS` | `7` | Purge retention for inactive claims |
| `CLAIM_CLEANUP_INTERVAL_MS` | `3600000` | Purge interval (1 hour) |

---

## Gaps and known improvements

| Area | Current state | Recommended improvement |
|------|--------------|------------------------|
| Error handling | No global error middleware, no standard envelope | Add Express error middleware and standard `{ error, code }` response shape |
| Retry logic | No retry on any external API | Add exponential backoff to `vastFetch`, Fly API calls, NIM provider calls |
| Circuit breakers | None | Add circuit breakers for Vast.ai, Fly.io, and NIM providers |
| DB health checking | `healthz` only checks secrets | Add DB connectivity probe to `/api/healthz` |
| Prometheus metrics | None | Add request latency, error rate, and queue depth metrics |
| Crash-only services | 5 startup services lack try/catch | Wrap all startup service calls in `index.ts` |
| Scheduler double-fire | `recentActions` dedup (in-memory set) | Migrate to DB-backed dedup for crash resilience |
| Claim sweeper alerting | Log-only | Add Prometheus gauge for `lastRunAt` staleness |
| Bridge reconnect | No server-initiated reconnect | Add heartbeat monitoring and auto-reconnect |
| Migration failure | Dev migrations are silently non-fatal | Add explicit `logger.fatal` if migrations fail in production |
