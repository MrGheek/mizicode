# API Reference

Authentication flows, request/response examples, and error codes for the MIZI API.

Base URL: `https://<your-domain>` (dev: `http://localhost:8080`)

---

## Authentication

MIZI uses four auth mechanisms depending on the endpoint:

### 1. No auth (dashboard / public)

Most GET endpoints are unauthenticated (dev mode) or require no auth for basic reads:
- `GET /sessions` — list sessions
- `GET /profiles` — list GPU profiles
- `GET /skills` — list skills

In production, these may be behind a dashboard auth layer. In dev mode (no `MIZI_MEM_TOKEN` set), all endpoints are open.

### 2. MIZI_MEM_TOKEN (internal / operator)

Required for:
- Session status callbacks (`POST /sessions/:id/status`)
- Claw Runner callbacks (`POST /sessions/:id/plan-push`, `POST /sessions/:id/swarm-push`)
- Runtime telemetry (`POST /sessions/:id/token-usage`, `POST /sessions/:id/routing-stats`)
- Operator key management (`POST /auth/keys`, `GET /auth/keys`, `DELETE /auth/keys/:id`)
- Admin endpoints (`POST /admin/sweep-claims`)

```
Authorization: Bearer mizi_mem_abc123def456... (64 hex chars)
```

### 3. Agent auth scopes (per-endpoint)

Agent API keys are created via `POST /auth/keys` (requires operator token) and carry scopes:

| Scope | Access | Example endpoints |
|-------|--------|-------------------|
| `coordination:read` | Read lane/claim/handoff state | `GET /sessions/:id/lanes` |
| `coordination:write` | Create/release claims, handoffs | `POST /sessions/:id/lanes/:laneId/claim` |
| `sessions:read` | Read session state | `GET /sessions/:id/lanes/:laneId/prompt-snapshot` |
| `sessions:write` | Create sessions | `POST /sessions` |

Keys can have multiple scopes:
```json
{
  "scopes": ["coordination:read", "coordination:write", "sessions:read"]
}
```

### 4. Session owner token / member password

Required for sensitive session operations:
- `POST /sessions/:id/swarm/abort` — Bearer owner token
- `GET /sessions/:id/swarm-stream?token=` — owner token or member password in query param
- `PATCH /sessions/:id/phase` — Bearer owner token
- `PATCH /sessions/:id/model` — Bearer owner token
- `PUT /sessions/:id/files/content` — Bearer owner token

Auth resolution order:
1. Check `Authorization: Bearer <token>` against `MIZI_MEM_TOKEN` (internal bypass)
2. Check against agent API keys (scoped auth)
3. For session-specific endpoints: check against `ownerToken` or member passwords

---

## Error responses

All errors follow this shape:
```json
{
  "error": "Human-readable description of the problem"
}
```

### Common status codes

| Code | Meaning | When it occurs |
|------|---------|----------------|
| 200 | OK | Successful GET/PUT/PATCH |
| 201 | Created | Successful POST (resource created) |
| 204 | No Content | Successful DELETE |
| 400 | Bad Request | Missing required field, invalid value, already-expired expiry |
| 401 | Unauthorized | Missing or invalid Authorization header |
| 403 | Forbidden | Valid key but insufficient scope, read-only key on write endpoint |
| 404 | Not Found | Session/lane/claim/handoff ID doesn't exist |
| 409 | Conflict | Duplicate resource, lane busy, claim blocked by conflict |
| 413 | Payload Too Large | Upload exceeds size limit (default 200 MB) |
| 500 | Internal Server Error | Unexpected server failure |
| 502 | Bad Gateway | External API (Vast.ai, GitHub, NIM) returned error |
| 503 | Service Unavailable | Bridge not connected, dependency unavailable |
| 504 | Gateway Timeout | Bridge exec timed out |

---

## Session lifecycle

### Create a session

```http
POST /sessions
Content-Type: application/json

{
  "intentText": "Build user authentication system",
  "profileId": 42,
  "repoUrl": "https://github.com/org/repo.git",
  "teamMembers": [
    { "role": "backend" },
    { "role": "frontend" }
  ]
}
```

**Response** `201 Created`:
```json
{
  "sessionId": 1,
  "status": "pending",
  "statusMessage": null,
  "ownerToken": "ses_abc123...",
  "profileId": 42,
  "teamMembers": [
    { "id": "backend", "laneId": 1 },
    { "id": "frontend", "laneId": 2 }
  ],
  "createdAt": "2026-06-24T12:00:00Z"
}
```

**Error responses:**
```json
// 400 — Missing required field
{ "error": "intentText is required" }

// 400 — Invalid profile
{ "error": "GPU profile not found: 42" }

// 500 — Provisioning failure
{ "error": "Provisioning failed: No suitable GPU offer found" }
```

### Check session status (polling)

```http
GET /sessions/1
```

**Response** `200 OK`:
```json
{
  "id": 1,
  "status": "ready",
  "statusMessage": "Theia IDE is ready",
  "intentText": "Build authentication system",
  "theiaUrl": "http://workspace:3000",
  "totalCost": 0.42,
  "createdAt": "2026-06-24T12:00:00Z",
  "readyAt": "2026-06-24T12:03:15Z"
}
```

Status transitions: `pending → provisioning → downloading → starting → ready | error`

### Session status callback (instance → API)

```http
POST /sessions/1/status
Authorization: Bearer mizi_mem_abc123... (64 hex chars)
Content-Type: application/json

{
  "status": "llm_ready",
  "theiaUrl": "http://10.0.0.1:3000",
  "phase": "starting_llm"
}
```

**Possible status values** (sent by workspace instance):

| Status | Meaning |
|--------|---------|
| `services_ready` | Container services initialized |
| `downloading` | Downloading model weights |
| `starting_llm` | Starting language model |
| `skills_compiling` | Compiling skill bundles |
| `skills_ready` | Skills compiled |
| `llm_ready` | LLM is ready |
| `theia_ready` | Theia IDE is ready — open your coding environment |
| `provisioning_failed` | Provisioning error |
| `download_failed` | Model download failed |
| `download_stalled` | Download stalled (no progress) |
| `vllm_warmup_failed` | vLLM warmup failed |
| `disk_full` | Workspace disk full |

### Delete session

```http
DELETE /sessions/1
```

**Response** `200 OK`:
```json
{
  "sessionId": 1,
  "status": "stopped",
  "totalCost": 1.23
}
```

---

## Coordination

### List lanes

```http
GET /sessions/1/lanes
Authorization: Bearer mizi_key_abc... (coordination:read scope)
```

**Response** `200 OK`:
```json
{
  "lanes": [
    {
      "id": 1,
      "laneType": "backend",
      "memberIdentifier": "agent-1",
      "status": "active",
      "taskMode": "build",
      "tokenMode": "full",
      "currentTask": "Implement auth middleware",
      "claims": [
        {
          "id": 10,
          "pathOrSymbol": "src/middleware/auth.ts",
          "claimStrength": "owner",
          "symbols": ["authenticateUser", "validateToken"],
          "active": true,
          "expiresAt": "2026-06-24T13:00:00Z"
        }
      ],
      "policy": {
        "maxConcurrentClaims": 30,
        "heavyJobSlots": 3
      }
    }
  ]
}
```

### Claim a file

```http
POST /sessions/1/lanes/1/claim
Authorization: Bearer mizi_key_abc... (coordination:write scope)
Content-Type: application/json

{
  "resourcePath": "src/services/auth.ts",
  "strength": 0.8,
  "ttlSeconds": 1800,
  "symbols": ["authenticateUser", "validateToken"]
}
```

**Response** `201 Created`:
```json
{
  "claim": {
    "id": 10,
    "laneId": 1,
    "pathOrSymbol": "src/services/auth.ts",
    "claimStrength": "owner",
    "active": true,
    "expiresAt": "2026-06-24T12:30:00Z"
  },
  "overlaps": [
    {
      "laneId": 2,
      "overlapScore": 0.1,
      "blastRadiusScore": 0.0,
      "effectiveScore": 0.1,
      "severity": "no_conflict"
    }
  ],
  "overallRecommendation": "no_conflict"
}
```

**Severity thresholds:**

| Score | Severity | Effect |
|-------|----------|--------|
| >= 0.75 | `block` | Claim rejected with 409 Conflict |
| >= 0.4 | `warn` | Claim created, client warned |
| < 0.4 | `no_conflict` | Normal |

**Error responses:**
```json
// 400 — Invalid strength
{ "error": "strength must be between 0 and 1" }

// 404 — Lane not found
{ "error": "Lane not found" }

// 409 — Blocked by conflict
{ "error": "Claim blocked: overlap score 0.85 with lane 2 (backend)" }
```

### Release a claim

```http
DELETE /sessions/1/lanes/1/claim/10
Authorization: Bearer mizi_key_abc... (coordination:write scope)
```

**Response** `204 No Content`

### Claim heartbeat (extend)

```http
DELETE /sessions/1/lanes/1/claim/10?heartbeat=true&ttlSeconds=3600
Authorization: Bearer mizi_key_abc... (coordination:write scope)
```

Refreshes `lastHeartbeatAt` and `expiresAt`. Must be called every 4-5 minutes to prevent expiry.

### Check conflicts

```http
GET /sessions/1/conflicts
Authorization: Bearer mizi_key_abc... (coordination:read scope)
```

**Response** `200 OK`:
```json
{
  "conflicts": [
    {
      "laneA": { "id": 1, "memberIdentifier": "agent-1" },
      "laneB": { "id": 2, "memberIdentifier": "agent-2" },
      "overlapScore": 0.6,
      "blastRadiusOverlap": 0.3,
      "effectiveScore": 0.6,
      "severity": "warn",
      "message": "Lane 'backend' overlaps with 'frontend' on src/services/auth.ts"
    }
  ],
  "totalConflicts": 1,
  "highSeverity": 0
}
```

### Send a handoff

```http
POST /sessions/1/lanes/1/handoff
Authorization: Bearer mizi_key_abc... (coordination:write scope)
Content-Type: application/json

{
  "handoffType": "needs_review",
  "notes": "Refactored auth middleware, please check src/middleware/auth.ts",
  "watchFiles": ["src/middleware/auth.ts"]
}
```

**Response** `201 Created`:
```json
{
  "handoff": {
    "id": 5,
    "handoffType": "needs_review",
    "status": "pending",
    "notes": "Refactored auth middleware...",
    "createdAt": "2026-06-24T12:05:00Z"
  }
}
```

Handoff types: `blocked`, `needs_review`, `safe_to_merge`, `watch_files`, `related_lane`

### Enqueue a heavy job

```http
POST /sessions/1/heavy-jobs
Authorization: Bearer mizi_key_abc... (coordination:write scope)
Content-Type: application/json

{
  "jobClass": "indexing",
  "priority": 8,
  "payload": {
    "paths": ["src/middleware/", "src/services/"]
  }
}
```

**Response** `201 Created`:
```json
{
  "job": {
    "id": 100,
    "jobClass": "indexing",
    "status": "queued",
    "priority": 8,
    "effectiveScore": 1.6,
    "createdAt": "2026-06-24T12:06:30Z"
  }
}
```

### Get next job (peek)

```http
GET /sessions/1/heavy-jobs/next
Authorization: Bearer mizi_key_abc... (coordination:read scope)
```

**Response** `200 OK`:
```json
{
  "id": 100,
  "jobClass": "blast_radius",
  "priority": 5,
  "effectiveScore": 2.3,
  "status": "queued"
}
```

Returns the queued job with the highest `effectiveScore`.

### Update job status

```http
PATCH /sessions/1/heavy-jobs/100
Authorization: Bearer mizi_key_abc... (coordination:write scope)
Content-Type: application/json

{
  "status": "running"
}
```

Valid status transitions: `queued → running → completed | failed` or `queued → deferred → queued`

---

## Orchestration

### One-call team provisioning

```http
POST /sessions/orchestrate
Content-Type: application/json

{
  "goal": "Build user authentication for a web app",
  "profileId": 42,
  "teamMembers": [
    { "role": "backend", "claimPaths": ["src/services/auth.ts", "src/middleware/auth.ts"] },
    { "role": "frontend", "claimPaths": ["src/components/Login.tsx"] }
  ],
  "repoUrl": "https://github.com/org/repo.git"
}
```

**Response** `202 Accepted`:
```json
{
  "sessionId": 1,
  "status": "provisioning",
  "estimatedWaitSeconds": 120
}
```

Poll progress:
```http
GET /sessions/1/orchestration-status
```

```json
{
  "status": "provisioning",
  "bootPhase": "launching_instance",
  "bootMessage": "Provisioning GPU instance on Vast.ai",
  "allLanesConnected": false,
  "lanes": [
    { "id": 1, "role": "backend", "connected": false },
    { "id": 2, "role": "frontend", "connected": false }
  ]
}
```

This is **idempotent**: calling twice with the same `(goal, profileId, teamMembers)` returns the same session. Key is SHA-256 hashed with a 5-minute TTL.

---

## Swarm

### Push swarm status (Claw Runner → API)

```http
POST /sessions/1/swarm-push
Authorization: Bearer mizi_mem_abc123...
Content-Type: application/json

{
  "phase": "active",
  "orchestratorReason": "Files are independent — no shared dependencies",
  "totalWorkers": 4,
  "doneCount": 2,
  "failedCount": 0,
  "workers": [
    { "id": "worker-1", "status": "done" },
    { "id": "worker-2", "status": "running" },
    { "id": "worker-3", "status": "running" },
    { "id": "worker-4", "status": "pending" }
  ],
  "timestamp": "2026-06-24T12:10:00Z"
}
```

### Poll swarm status (dashboard → API)

```http
GET /sessions/1/swarm-status
```

**Response** `200 OK`:
```json
{
  "availability": "live",
  "snapshot": {
    "phase": "active",
    "totalWorkers": 4,
    "doneCount": 2,
    "failedCount": 0,
    "workers": [
      { "id": "worker-1", "status": "done" },
      { "id": "worker-2", "status": "running" }
    ]
  }
}
```

Availability states:
- `live` — in-memory cache is fresh (< 5 min old)
- `stale` — snapshot exists but cache is old
- `starting` — session not ready yet
- `unavailable` — no snapshot ever received

### SSE live stream

```http
GET /sessions/1/swarm-stream?token=ses_abc123...
```

Server-Sent Events format:
```
event: swarm_update
data: {"phase":"active","doneCount":2,"totalWorkers":4}

event: swarm_update
data: {"phase":"synthesising","doneCount":4,"totalWorkers":4}
```

Keep-alive pings every 20 seconds:
```
: keep-alive
```

### Emergency abort

```http
POST /sessions/1/swarm/abort
Authorization: Bearer ses_abc123... (owner token)
```

**Response** `200 OK`:
```json
{
  "ok": true,
  "message": "Abort signal sent to workers"
}
```

---

## Health checks

```http
GET /api/health
```

**Response** `200 OK`:
```json
{
  "status": "ok",
  "memDb": "ok",
  "dbPath": "/data/memory/memory.db"
}
```

```http
GET /api/healthz
```

Fly.io load-balancer health check. Returns 503 if production secrets are missing.

```http
GET /api/admin/status
```

**Response** `200 OK`:
```json
{
  "status": "ok",
  "sweeper": {
    "lastRunAt": "2026-06-24T12:15:00Z",
    "lastCleared": 3,
    "totalCleared": 142,
    "intervalMs": 30000
  },
  "memoryDisk": {
    "status": "ok",
    "freeBytes": 1073741824
  }
}
```

---

## Agent memory operations

### Record an observation

```http
POST /sessions/1/memory/observe
Authorization: Bearer mizi_key_abc... (sessions:read scope)
Content-Type: application/json

{
  "type": "tool_call",
  "content": "Refactored auth middleware to use JWT",
  "scope": "session_core",
  "category": "code_change",
  "tags": ["auth", "middleware"]
}
```

### Search relevant memories

```http
GET /sessions/1/memory/relevant?q=JWT%20authentication&limit=5
Authorization: Bearer mizi_key_abc... (sessions:read scope)
```

**Response** `200 OK`:
```json
{
  "results": [
    {
      "id": 42,
      "content": "Refactored auth middleware to use JWT",
      "category": "code_change",
      "similarity": 0.89,
      "createdAt": "2026-06-24T12:00:00Z"
    }
  ]
}
```

---

## Agent tool calls

### Web search

```http
POST /sessions/1/tools/web-search
Authorization: Bearer mizi_key_abc... (sessions:read scope)
Content-Type: application/json

{
  "query": "latest TypeScript best practices 2026"
}
```

### Fetch URL

```http
POST /sessions/1/tools/fetch-url
Authorization: Bearer mizi_key_abc... (sessions:read scope)
Content-Type: application/json

{
  "url": "https://www.typescriptlang.org/docs/"
}
```

Protected against SSRF via `SsrfBlockedError`. Respects `robots.txt`.

---

## Snapshot and rollback

### List snapshots

```http
GET /sessions/1/snapshots?laneId=1
```

**Response** `200 OK`:
```json
{
  "snapshots": [
    { "sha": "abc123def456", "tool": "refactor", "timestamp": "2026-06-24T12:30:00Z" },
    { "sha": "def789abc012", "tool": "fix_bug", "timestamp": "2026-06-24T11:00:00Z" }
  ],
  "laneBusy": false
}
```

```json
// 409 — Lane busy with another exec
{ "error": "Lane 1 is busy. Cannot list snapshots during active exec" }
```

### Rollback

```http
POST /sessions/1/snapshots/abc123def456/rollback?laneId=1
```

**Response** `200 OK`:
```json
{
  "sha": "abc123def456",
  "success": true
}
```

```json
// 504 — Bridge exec timeout
{ "error": "Rollback command timed out after 15000ms" }
```
