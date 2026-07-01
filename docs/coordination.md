# Coordination System

This document describes MIZI's agent coordination system: how multiple AI agents (lanes) claim files, resolve conflicts, hand off work, and schedule background jobs. The coordination system prevents two agents from editing the same file simultaneously while allowing safe parallel work.

---

## Architecture overview

```
Session (GPU instance)
    │
    ├── Lane "backend" (one per agent)
    │       ├── Claims (files/modules/symbols the agent is working on)
    │       ├── Handoffs (signals to other lanes)
    │       └── Heavy jobs (background work)
    │
    ├── Lane "frontend" (agent 2)
    │       ├── Claims
    │       ├── Handoffs
    │       └── Heavy jobs
    │
    └── ...
```

Each session can have multiple lanes (one per agent/team member). Each lane claims files it is working on, and the system detects overlaps between lanes' claims to prevent edit conflicts.

---

## Lane policies

### Built-in lane types

| Type | Max claims | Heavy slots | Task mode | Token mode | Intended use |
|------|-----------|-------------|-----------|------------|--------------|
| `ux` | 20 | 1 | build | core | UI/frontend changes |
| `debug` | 10 | 2 | debug | core | Debugging and investigation |
| `backend` | 30 | 3 | build | full | Server-side logic |
| `review` | 15 | 1 | review | lean | Code review |
| `general` | 20 | 2 | build | core | Default fallback |

Key policies per lane type:

- **`maxConcurrentClaims`** — how many files a lane can claim simultaneously
- **`heavyJobSlots`** — how many background jobs this lane can have running concurrently
- **`maxBlastRadiusFiles`** — blast-radius dependency analysis limit for conflict detection
- **`claimTtlSeconds`** — how long a claim lasts without a heartbeat (default 3600)

### Custom lane types

Custom lane types are stored in `customLaneTypesTable` (DB) and inherit the `general` overlay bundle. They can override:

- `maxConcurrentClaims`, `heavyJobSlots`
- `overlaySkillIdsJson`, `retrievalEmphasisJson`
- `policyTokenMode`, `designCategoriesJson`

Resolution order: `getLanePolicyAsync(laneType)` checks the DB first; falls back to the built-in map.

### Overlap detection

Two claims overlap when they target the same or adjacent files. MIZI uses three strategies:

#### 1. File-path overlap (`computeClaimOverlap`)

Direct path match = 1.0 weight; prefix/directory match = 0.5 weight. Score is `(directOverlap + prefixOverlap * 0.5) / setA.size`, capped at 1.0.

#### 2. Symbol-aware overlap (`computeSymbolAwareClaimOverlap`)

When both claims have symbols attached, only symbol-set intersection is considered (not file paths). If either claim lacks symbols, falls back to file-path overlap.

| Claim A symbols | Claim B symbols | Detection method |
|----------------|----------------|-----------------|
| `{auth, user}` | `{auth, billing}` | Conflict — `auth` intersects |
| `{auth}` | (none) | File-path fallback |
| (none) | `{auth}` | File-path fallback |

#### 3. Blast-radius overlap (`estimateBlastRadiusOverlap`)

Uses the repo's dependency graph to detect indirect conflicts. If file A imports file B and claim A claims file A while claim B claims file B, they conflict. Score is `blastHits / max(claimsA.size, claimsB.size)`.

### Conflict escalation

| Score | Severity | Effect |
|-------|----------|--------|
| ≥ 0.75 | `block` | Claim creation is rejected |
| ≥ 0.4 | `warn` | Claim is created but client is warned |
| < 0.4 | `no_conflict` | Normal operation |

---

## Claim lifecycle

```
          ┌──────────────────────────────────────────┐
          │                                          │
          v                                          │
    ┌─────────┐    heartbeat     ┌────────────┐     │
    │ Created ├─────────────────►│ Active      ├─────┘
    └────┬────┘                  └─────┬───────┘
         │                             │
         │ release                     │ expiry (no heartbeat)
         v                             v
    ┌─────────┐                  ┌──────────┐
    │ Released│                  │ Expired  │
    └─────────┘                  └──────────┘
```

### 1. Creating a claim

**Endpoint:** `POST /sessions/:id/lanes/:laneId/claim`

Request body:
```json
{
  "resourcePath": "src/services/auth.ts",
  "strength": 0.8,
  "ttlSeconds": 1800,
  "symbols": ["authenticateUser", "validateToken"]
}
```

The `strength` float (0.0–1.0) maps to a `claimStrength` enum:
- 0.0–0.39 → `watching`
- 0.4–0.74 → `editing`
- 0.75+ → `owner`

Conflict detection runs **before** the claim is created:
1. Load all other active claims in the session
2. Load repo dependency graph edges
3. Compute `computeSymbolAwareClaimOverlap` and `estimateBlastRadiusOverlapAnnotated`
4. Compute `effectiveScore = max(overlapScore, blastRadiusOverlap * 0.75)`
5. Return overlaps with `block` / `warn` / `no_conflict` severity

Two write paths:

- **`preserveHistory=true`**: Transaction — deactivates old active claim for this path, then inserts new row. Prevents race on the partial unique index.
- **Default**: Atomic upsert using the partial unique index on `(lane_id, path_or_symbol) WHERE active = true`.

Partial unique index prevents duplicate active claims for the same path within a lane. This index is the **primary guard against race conditions** — it enforces uniqueness at the database level even when concurrent requests arrive simultaneously.

### 2. Heartbeat (extend claim)

**Endpoint:** `DELETE /sessions/:id/lanes/:laneId/claim/:claimId?heartbeat=true`

Refreshes `lastHeartbeatAt` and `expiresAt` (new TTL from query param or config default). Does NOT deactivate the claim.

Lanes should heartbeat their claims every 4–5 minutes (within the 5-minute heartbeat window) while actively working.

### 3. Releasing a claim

**Endpoint:** `DELETE /sessions/:id/lanes/:laneId/claim/:claimId`

Sets `active = false`. The row is preserved for history. Emits a `claim_released` lane event.

### 4. Claim expiry (background)

Two expiry conditions (runs on every lane list read AND on a 30-second sweeper interval):

1. **TTL expiry**: `expiresAt < now`
2. **Heartbeat timeout**: `lastHeartbeatAt < now - 300s`

Expired claims are soft-deleted (set `active = false`) on session read paths. The background sweeper (`sweepExpiredClaims`) hard-deletes expired rows atomically every 30 seconds.

### 5. Claim purge (daily)

**Endpoint:** `POST /admin/sweep-claims` (manual trigger)

Runs `startClaimSweeper()` on a configurable interval (default 30 seconds). Tracks statistics in `claimPurgeLogsTable`.

---

## Handoffs

Handoffs signal other lanes about work that needs attention. Five types:

| Type | Effect on lane status | Notes |
|------|----------------------|-------|
| `blocked` | → `blocked` | Lane is stuck, needs unblocking |
| `needs_review` | → `review-needed` | Code is ready for review |
| `safe_to_merge` | → `ready-to-merge` | Auto-opens a draft PR |
| `watch_files` | (no change) | Notification only |
| `related_lane` | (no change) | Cross-lane coordination |

**Endpoint:** `POST /sessions/:id/lanes/:laneId/handoff`

```json
{
  "handoffType": "needs_review",
  "notes": "Refactored auth middleware, please check",
  "watchFiles": ["src/middleware/auth.ts"],
  "relatedLaneId": 3
}
```

Handoffs have a lifecycle: `pending → acknowledged | dismissed | expired`.

For `safe_to_merge` handoffs, the system opens a draft PR via GitHub API using the lane's branch naming convention. The PR URL is stored in the handoff row.

---

## Heavy job scheduling

Heavy jobs are background tasks (indexing, embedding, evaluation, compilation) that run asynchronously within lanes.

### Job lifecycle

`queued → running → completed | failed`
`queued → deferred → queued` (when deferUntil passes)

### Scheduling formula

```
effectiveScore = priorityNorm + ageWeight + laneWeight + classFloor
```

| Component | Range | Description |
|-----------|-------|-------------|
| `priorityNorm` | 0.1–1.0 | `priority / 10` |
| `ageWeight` | 0.0–2.0 | Minutes since creation × 0.05, capped at 2.0 |
| `laneWeight` | 0.5–2.0 | Fairness weight from `computeLaneFairnessWeights` |
| `classFloor` | 0.1–0.5 | Per-class minimum boost |

### Class floors

| Class | Floor | Why |
|-------|-------|-----|
| `indexing` | 0.5 | Code indexing is high-priority for editor UX |
| `blast_radius` | 0.4 | Dep graph analysis is time-sensitive |
| `compile` | 0.35 | Compilation validates correctness |
| `embedding` | 0.3 | Vector embedding is important but can wait |
| `eval` | 0.2 | Evaluations are low-priority background work |
| `other` | 0.1 | Catch-all |

### Fairness system

Uses a sliding 60-minute window tracking completed + running jobs per lane:

```
fairShare = totalJobs / numLanes
laneWeight = clamp(2.0 - shareRatio, 0.5, 2.0)
```

Underrepresented lanes get a boost (up to 2x), overrepresented lanes get a penalty (down to 0.5x).

### API endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/sessions/:id/heavy-jobs` | Enqueue a job |
| GET | `/sessions/:id/heavy-jobs` | List jobs, optional `?status=` filter |
| GET | `/sessions/:id/heavy-jobs/next` | Peek at highest-scored queued job |
| PATCH | `/sessions/:id/heavy-jobs/:jobId` | Update job status |

---

## Real-time updates

### SSE stream

**Endpoint:** `GET /sessions/:id/coordination/stream`

Pushes coordination events to connected clients:
- `coordination_update` — claim or handoff changed
- `lane_event` — any lane lifecycle event
- `plan_tasks_appended` — new plan tasks

Keep-alive pings every 20 seconds. Dead clients are cleaned up on write failure or `req.close`.

### Lane events

All state changes emit events asynchronously. Events are persisted in `laneEventsTable` for replay:

| Event type | When it fires |
|------------|---------------|
| `claim_created` | Claim inserted |
| `claim_released` | Claim deactivated |
| `claim_expired` | Sweeper or path-read expiry |
| `handoff_sent` | Handoff created |
| `handoff_acknowledged` | Handoff accepted/dismissed |
| `heavy_job_started` | Job status → running |
| `heavy_job_completed` | Job status → completed/failed |
| `lane_created` | Lane inserted |
| `lane_destroyed` | Lane deleted |

---

## Bridge connections

Each active lane maintains a WebSocket connection via the bridge registry. The bridge is used for:

- Executing shell commands (`execShell` via `shell` frame type)
- Taking git snapshots
- Checking lane health

One WebSocket per `sessionId:laneId` pair. If a lane reconnects, the old connection is closed with "Superseded" status code.

Exec lock on each bridge: serializes concurrent `exec` frame sends to prevent interleaved responses.

---

## Known race conditions & protections

| Race | Protection |
|------|-----------|
| Two agents claim the same file simultaneously | Partial unique index `(lane_id, path_or_symbol) WHERE active = true` |
| Orchestrate called twice with same inputs | DB-backed idempotency ring (SHA-256 key, 5-min TTL, 60s stale crash timeout) |
| Sweeper runs while claims are being created | Atomic `DELETE ... WHERE still-expired-at-execution-time` |
| SSE client disconnects mid-stream | Dead client cleanup on write error + `req.close` |
| Lane deletion while claims exist | CASCADE delete on FK (claims, handoffs, heavy jobs, prompt snapshots) |
| Bridge reconnection during exec | Old connection closed, exec fails — caller retries |
| Design sync runs twice | `isRunning` flag check before each sync iteration |
| Scheduled session double-fire | `recentActions` set keyed by date+time (prevents duplicate within same day) |
| Swarm snapshot stale cache | 5-minute staleness threshold; DB persistence survives server restart |

---

## Database tables

Main tables in the coordination schema (`lib/db/src/schema/coordination.ts`):

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `session_lanes` | Per-agent lane | `sessionId`, `laneType`, `memberIdentifier`, `status` |
| `lane_claims` | File-level locks | `laneId`, `pathOrSymbol`, `claimStrength`, `active`, `expiresAt` |
| `lane_handoffs` | Cross-lane signals | `laneId`, `handoffType`, `status`, `prUrl` |
| `lane_heavy_jobs` | Background work queue | `sessionId`, `laneId`, `jobClass`, `status`, `effectiveScore` |
| `lane_events` | Audit trail | `sessionId`, `laneId`, `eventType`, `payload` |
| `lane_prompt_snapshots` | Prompt state | `sessionId`, `laneId`, `promptHash`, `systemPromptFragment` |
| `claim_purge_logs` | Cleanup audit | `purgedAt`, `rowsDeleted`, `retentionDays` |
| `custom_lane_types` | User-defined types | `name`, `maxConcurrentClaims`, `heavyJobSlots` |

Scheduler tables (`lib/db/src/schema/scheduler.ts`):

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `scheduler_config` | Session schedule | `enabled`, `launchTime`, `stopTime`, `profileId`, `teamMemberNames`, `repoUrl` |

---

## Key configuration constants

| Constant | Default | Location | Purpose |
|----------|---------|----------|---------|
| `LANE_DEFAULT_TTL_SECONDS` | 3600 | lane-policy.ts | Claim TTL |
| `LANE_HEARTBEAT_WINDOW_SECONDS` | 300 | lane-policy.ts | Heartbeat timeout |
| `CLAIM_RETENTION_DAYS` | 7 | index.ts | Purge retention |
| `CLAIM_CLEANUP_INTERVAL_MS` | 3600000 | index.ts | Purge interval |
| `MAX_AGE_WEIGHT` | 2.0 | heavy-job-scheduler.ts | Max age boost |
| `SWEEPER_INTERVAL_MS` | 30000 | claim-sweeper.ts | Sweeper loop interval |
| `STALE_THRESHOLD_MS` | 300000 | sessions.ts | Swarm cache staleness |
