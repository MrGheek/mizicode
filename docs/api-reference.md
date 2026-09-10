# API Reference

Authentication flows, the full route catalog, MCP surface, and error semantics for the MIZI API server.

Base URL: `https://<api-domain>/api` (dev: `http://localhost:8080/api`).
All JSON. Errors are `{ "error": "...", "code": "..." }` (404s use `code: "NOT_FOUND"`).

---

## Authentication

MIZI uses four credential tiers. Resolution order is fixed.

### 1. No auth (dev mode)

When `MIZI_MEM_TOKEN` is **not set** and `NODE_ENV !== "production"`, endpoints without a
Bearer header pass through open. This is the local-development posture only.

### 2. MIZI_MEM_TOKEN (operator / internal)

The operator token (`openssl rand -hex 32`). Passed as `Authorization: Bearer <token>`.

```
Authorization: Bearer 9f2c4b7a...e6d1
```

It bypasses all scope checks and is required (in production) for:

- Key management: `POST|GET /auth/keys`, `DELETE /auth/keys/:id`
- GitHub OAuth status/disconnect: `GET|DELETE /auth/github`, `GET /auth/github/status`, `GET /auth/github/repos`
- Ambient + safety: `/ambient/*`, `/safety/*`
- Internal callbacks and telemetry: `POST /sessions/:id/status`, `POST /sessions/:id/plan-push`,
  `POST /sessions/:id/swarm-push`, `POST /sessions/:id/token-usage`, `POST /sessions/:id/routing-stats`
- MCP transport: `/api/mcp` (any valid operator or API key)

### 3. Agent API keys (scoped, M2M)

Created via `POST /auth/keys` with `MIZI_MEM_TOKEN`. Plaintext is returned once. Format:
`mizi_<64 hex>`. Stored as a SHA-256 hash. Keys carry scopes:

| Scope | Access |
|-------|--------|
| `sessions:read` | Read session state, files, resources, memory, tools, repo graph |
| `sessions:write` | Create sessions, orchestrate, provision resources, schema templates |
| `coordination:read` | Read lanes, claims, conflicts, heavy jobs, bridge status, coordination stream |
| `coordination:write` | Create/release claims, handoffs, heavy jobs, lane CRUD, bridge exec |

A key may hold multiple scopes. Scope enforcement is additive: an endpoint requiring
`coordination:read` is rejected with `403` unless the key carries that scope.

### 4. Session owner token / raw bearer

Session-scoped endpoints accept the session `ownerToken` (returned by `POST /sessions`) as a
Bearer token. The auth middleware stores unknown bearer values in `req.rawBearer`; handlers
compare it against `session.ownerToken` before acting.

### Auth resolution order (per request)

1. Dev bypass (no token configured, no bearer, not production) → open.
2. `MIZI_MEM_TOKEN` match → operator pass-through.
3. Valid API key with required scopes → `req.apiKey` populated.
4. Unknown bearer → stored in `req.rawBearer` (handler-level ownership check).
5. Missing bearer on a strict route → `401 { error: "Missing Bearer token" }`.

### MCP discovery manifest

`GET /.well-known/mcp` (no `/api` prefix) returns the MCP discovery document:

```json
{
  "schema_version": "2025-03-26",
  "name": "mizi",
  "mcp_url": "/api/mcp",
  "auth": { "type": "bearer", "hint": "Pass your MIZI API key as 'Authorization: Bearer <key>'" },
  "privilege_tiers": {
    "Read": "Safe, no side effects (list, get, search, status).",
    "Write": "Creates or modifies resources.",
    "Admin": "High-impact or irreversible actions — requires an API key with the `admin` scope."
  }
}
```

---

## Error responses

```json
{ "error": "Human-readable description", "code": "NOT_FOUND" }
```

### Common status codes

| Code | Meaning | When it occurs |
|------|---------|----------------|
| 200 | OK | Successful GET/PUT/PATCH |
| 201 | Created | Resource created (`POST /sessions`, `POST /auth/keys`, claims, handoffs, jobs) |
| 204 | No Content | Successful DELETE |
| 400 | Bad Request | Missing/invalid field, invalid expiresAt, invalid ID |
| 401 | Unauthorized | Missing/invalid Bearer token, revoked or expired API key |
| 403 | Forbidden | Valid key, insufficient scope; plan ownership mismatch |
| 404 | Not Found | Unknown ID (`code: "NOT_FOUND"`) |
| 409 | Conflict | Duplicate resource, lane busy with another exec, already-revoked key |
| 503 | Service Unavailable | Bridge not connected; NIM provider key not configured; key management unconfigured in prod |
| 500 | Internal Server Error | Unexpected server failure |

---

## Route catalog

All paths below are relative to `/api`. `cloud` = cloud distribution only (removed from local
builds by esbuild); `local` = local distribution only.

### Health

| Method | Path | Notes |
|--------|------|-------|
| GET | `/health` | Memory DB (SQLite) probe + Postgres `SELECT 1`. `200 ok` / `503 degraded` |
| GET | `/healthz` | Production secret completeness (`FLY_API_TOKEN`, `FLY_WORKSPACE_APP_NAME`) + DB. Fly.io http_check target |
| GET | `/admin/status` | Memory disk health + claim sweeper health |

### Auth

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/auth/keys` | MIZI_MEM_TOKEN | Create key. Body: `{ label, scopes?, expiresAt? }` → `201 { id, key, ... }` |
| GET | `/auth/keys` | MIZI_MEM_TOKEN | List active keys (values never returned) |
| DELETE | `/auth/keys/:id` | MIZI_MEM_TOKEN | Revoke key |
| GET | `/auth/github` | none (browser) | Initiate OAuth flow, redirects to GitHub |
| GET | `/auth/github/callback` | none (browser) | OAuth callback, redirects to dashboard with `?github_oauth=connected|denied|error` |
| GET | `/auth/github/status` | MIZI_MEM_TOKEN | `{ connected, login, avatarUrl }` |
| GET | `/auth/github/repos` | MIZI_MEM_TOKEN | Browse/search operator repos (`?q=`, `?page=`) |
| DELETE | `/auth/github` | MIZI_MEM_TOKEN | Disconnect, delete stored token |

### Sessions — CRUD & lifecycle (`sessions.ts` + `sessions-crud.ts`)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/sessions` | permitBearer optional | Create session. Cloud: `profileId` or `nimModelId` + provider key required. Local: `localModelId` or default `qwen2.5-coder:7b`. Returns `ownerToken` (cloud) |
| GET | `/sessions` | permitBearer optional | List sessions |
| GET | `/sessions/active` | — | Active sessions |
| GET | `/sessions/:sessionId` | — | Session detail |
| GET | `/sessions/:sessionId/clone` | — | Clone session |
| PATCH | `/sessions/:sessionId` | — | Update session (name, etc.) |
| DELETE | `/sessions/:sessionId` | — | Stop session + cleanup workspace machine |
| POST | `/sessions/:sessionId/status` | MIZI_MEM_TOKEN | Workspace callback — status transitions |
| POST | `/sessions/:sessionId/refresh` | — | Re-sync state from provider |
| GET | `/sessions/:id/workspace/...` | — | Reverse proxy to the session's Theia workspace via Fly machine (requires `FLY_WORKSPACE_APP_NAME`) |

### Sessions — memory

| Method | Path |
|--------|------|
| GET | `/sessions/:sessionId/memory/observations` |
| GET | `/sessions/:sessionId/memory/sessions` |
| GET | `/sessions/:sessionId/memory/stream` (SSE) |
| GET | `/sessions/:sessionId/memory/search` |
| PATCH | `/sessions/:sessionId/memory/sessions/:memSessionId/summary` |

### Sessions — messages, telemetry

| Method | Path | Notes |
|--------|------|-------|
| POST | `/sessions/:sessionId/messages` | Push a message |
| GET | `/sessions/:sessionId/messages` | List messages |
| POST | `/sessions/:sessionId/messages/:msgId/injected` | Mark injected |
| GET | `/sessions/:sessionId/messages/stream` (SSE) | Stream |
| POST | `/sessions/:sessionId/telemetry/soft-interrupts` | Soft interrupt telemetry |
| POST | `/sessions/:sessionId/routing-stats` | Push routing stats |
| GET | `/sessions/:sessionId/routing-stats` | Read routing stats |
| POST | `/sessions/:sessionId/token-usage` | Push token usage |

### Sessions — model & phase

| Method | Path | Notes |
|--------|------|-------|
| PATCH | `/sessions/:sessionId/phase` | Change phase |
| PATCH | `/sessions/:sessionId/model` | Change model (owner token) |
| GET | `/sessions/:sessionId/model-history` | Model switch history |
| GET | `/sessions/:sessionId/swarm-model` | Swarm's active model |
| PATCH | `/sessions/:sessionId/routing-mode` | `auto` \| `pinned` |
| GET | `/sessions/:sessionId/inference-ranking` | Inference ranking |

### Sessions — files & resources

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/sessions/:sessionId/resources` | sessions:read (optional) | Provisioned resource list |
| GET | `/sessions/:sessionId/resources/:resourceId/connection-string` | sessions:read | Reveal connection string |
| POST | `/sessions/:sessionId/provision` | sessions:write (optional) | Provision a resource |
| GET | `/sessions/:id/files` | — | File tree |
| GET | `/sessions/:id/files/content` | — | Read file |
| PUT | `/sessions/:id/files/content` | — | Write file (owner token) |
| GET | `/sessions/:id/files/tree` | — | Full file tree |

### Sessions — plan & swarm

| Method | Path | Notes |
|--------|------|-------|
| POST | `/sessions/:sessionId/plan-push` | Claw Runner → API (MIZI_MEM_TOKEN) |
| POST | `/sessions/:sessionId/plan-status` | Alias of plan-push |
| GET | `/sessions/:sessionId/plan-status` | Poll plan status |
| GET | `/sessions/:sessionId/plan-stream` (SSE) | Live plan updates |
| POST | `/sessions/:sessionId/swarm-push` | Claw Runner → API (MIZI_MEM_TOKEN) |
| POST | `/sessions/:sessionId/swarm-status` | Alias of swarm-push |
| GET | `/sessions/:sessionId/swarm-status` | Poll swarm status |
| GET | `/sessions/:sessionId/swarm-stream` (SSE) | Live swarm updates (`?token=` owner token) |
| POST | `/sessions/:sessionId/swarm/abort` | Abort swarm (owner token) |
| GET | `/sessions/swarm-status-batch` | Batch status for multiple sessions |

### Coordination (lanes, claims, conflicts, heavy jobs)

All endpoints under `/sessions/:id/...` require `coordination:read` or `coordination:write`.

| Method | Path | Scope |
|--------|------|-------|
| GET | `/sessions/:id/lanes` | coordination:read |
| GET | `/sessions/:id/lanes/:laneId` | coordination:read |
| POST | `/sessions/:id/lanes` | coordination:write |
| PUT | `/sessions/:id/lanes/:laneId` | coordination:write |
| DELETE | `/sessions/:id/lanes/:laneId` | coordination:write |
| POST | `/sessions/:id/lanes/:laneId/claim` | coordination:write |
| DELETE | `/sessions/:id/lanes/:laneId/claim/:claimId` | coordination:write |
| POST | `/sessions/:id/lanes/:laneId/handoff` | coordination:write |
| PATCH | `/sessions/:id/lanes/:laneId/handoff/:handoffId` | coordination:write |
| GET | `/sessions/:id/coordination` | coordination:read |
| GET | `/sessions/:id/coordination/stream` (SSE) | coordination:read |
| GET | `/sessions/:id/conflicts` | coordination:read |
| GET | `/sessions/:id/lanes/:laneId/timeline` | coordination:read |
| POST | `/sessions/:id/heavy-jobs` | coordination:write |
| GET | `/sessions/:id/heavy-jobs` | coordination:read |
| GET | `/sessions/:id/heavy-jobs/next` | coordination:read |
| PATCH | `/sessions/:id/heavy-jobs/:jobId` | coordination:write |
| GET | `/admin/claim-cleanup-stats` | coordination:read |
| POST | `/admin/sweep-claims` | coordination:write |
| POST | `/coordination/lane-types` | coordination:write |
| PATCH | `/coordination/lane-types/:id` | coordination:write |
| DELETE | `/coordination/lane-types/:id` | coordination:write |
| GET | `/coordination/lane-types` | — |

Claim conflict severity is computed from overlap + blast-radius scores — see
[`coordination.md`](coordination.md) for thresholds.

### Plan board

| Method | Path | Auth |
|--------|------|------|
| POST | `/plan/generate` | optionalAgentAuth |
| POST | `/plan/reassess` | requireAgentAuth |
| GET | `/plans` | optionalAgentAuth |
| GET | `/plans/:planId` | optionalAgentAuth |
| POST | `/plan/:planId/approve` | optionalAgentAuth |
| GET | `/plans/:planId/export` | optionalAgentAuth |
| POST | `/plans/:planId/tasks` | optionalAgentAuth |
| PATCH | `/plans/:planId/tasks/:taskId` | optionalAgentAuth |
| DELETE | `/plans/:planId` | optionalAgentAuth |
| DELETE | `/plans/:planId/tasks/:taskId` | optionalAgentAuth |
| GET | `/sessions/:sessionId/plan` | optionalAgentAuth |
| POST | `/sessions/:sessionId/decompose` | requireAgentAuth |
| PATCH | `/sessions/:sessionId/plan` | requireAgentAuth |

### Memory core (`/mem/*`)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/mem/init` | Initialize a user memory |
| POST | `/mem/observation` | Record an observation |
| POST | `/mem/summarize` | Summarize a memory session |
| GET | `/mem/context/:userId` | Build context index for a user |
| GET | `/mem/observations` | List observations |
| GET | `/mem/sessions` | List memory sessions |
| GET | `/mem/observations/stream` (SSE) | Stream observations |
| GET | `/mem/index` | System memory shortlist |
| GET | `/mem/search` | Semantic search (`?q=`, `?userId=`, `?scope=`, `?limit=`) |
| GET | `/mem/item/:itemId` | Get item |
| POST | `/mem/item` | Save item |
| POST | `/mem/injected` | Mark item injected |
| POST | `/mem/symbol-stale` | Mark symbol stale |
| GET | `/mem/conflicts` | Memory conflicts |
| PATCH | `/mem/conflicts/:groupId` | Resolve a conflict group |
| GET | `/mem/stale` | Stale items |
| GET | `/mem/promotions` | Promotion candidates |
| PATCH | `/mem/item/:itemId/promote` | Promote item |
| GET | `/mem/stats` | Memory stats |
| GET | `/mem/items` | List items |
| POST | `/mem/turn` | Record a turn |
| GET | `/mem/recall` | Passive recall |
| POST | `/mem/recall/inject` | Inject recall |
| POST | `/mem/edges` | Create memory edge |
| GET | `/mem/edges/:itemId` | Edges for item |
| POST | `/mem/passive-config` | Update passive recall config |
| GET | `/mem/recall/audit` | Recall audit |
| GET | `/mem/recall/metrics` | Recall metrics |

Additional memory routes on `/memory/*`: `search`, `sessions`, `governance-stats`, `backup`,
`review-count`, `sweep`, `stale`, `recall-audit`, `recall-metrics`, `passive-config` (GET/POST),
`governance/conflicts`, `stale/bulk` (PATCH), `restore`.

### Skills & skill bundles

| Method | Path | Notes |
|--------|------|-------|
| GET | `/skills` | List skills |
| GET | `/skills/sources` | Skill sources |
| POST | `/skills/discover` | Run discovery |
| GET | `/skills/leaderboard` | Leaderboard |
| GET | `/skills/feedback-scores` | Feedback scores |
| GET | `/skills/evals` | Eval runs |
| POST | `/skills/evals/run` | Start an eval |
| POST | `/skills/evals/process-next` | Process next eval |
| GET | `/skills/evals/scoring-presets` | Scoring presets |
| GET | `/skills/evals/:runId` | Eval detail |
| POST | `/skills/evals/:runId/variants` | Add variant |
| POST | `/skills/evals/:runId/finalize` | Finalize eval |
| PATCH | `/skills/evals/:runId/status` | Update eval status |
| GET | `/skills/:skillId` | Skill detail |
| GET | `/skills/:skillId/feedback` | Feedback list |
| POST | `/skills/:skillId/feedback` | Submit feedback |
| DELETE | `/skills/:skillId/feedback` | Clear feedback |
| DELETE | `/skills/:skillId/feedback/:feedbackId` | Delete one feedback |
| GET | `/skills/:skillId/performance` | Performance |
| POST | `/skills/:skillId/review` | Review skill |
| POST | `/skills/:skillId/enable` | Enable |
| POST | `/skills/:skillId/disable` | Disable |
| GET | `/skills/:skillId/design-categories` | Design categories |
| POST | `/skills/:skillId/design-categories` | Assign categories |
| DELETE | `/skills/:skillId/design-categories/:category` | Remove category |
| POST | `/skills/import` | Import skill |
| POST | `/skills/compile-preview` | Compile preview |
| POST | `/admin/seed-ecc` | Seed ECC skills |
| GET | `/skill-bundles/leaderboard` | Bundle leaderboard |
| GET | `/skill-bundles` | List bundles |
| POST | `/skill-bundles/seed` | Seed bundles |
| POST | `/skill-bundles/compile` | Compile a bundle |
| GET | `/skill-bundles/:bundleId` | Bundle detail |
| GET | `/skill-bundles/:bundleId/performance` | Bundle performance |
| POST | `/skill-bundles/:bundleId/activate` | Activate bundle |
| POST | `/skill-bundles` | Create bundle |
| PUT | `/skill-bundles/:bundleId` | Update bundle |
| GET | `/sessions/:sessionId/skills` | Session skills |
| POST | `/sessions/:sessionId/skills/feedback` | Session skill feedback |
| POST | `/sessions/:sessionId/skills/complete-feedback` | Complete feedback cycle |

### Repo graph & intelligence

Per-session repo router mounted at `/sessions/:sessionId/repo`; standalone graph at `/repo`;
batch status at `/sessions/repo`.

| Method | Path (per-session) | Notes |
|--------|------|-------|
| POST | `/index` | Trigger/await repo indexing |
| GET | `/fingerprint` | Repo fingerprint |
| GET | `/summary` | Repo summary (languages, frameworks) |
| GET | `/search` | Symbol search |
| GET | `/blast-radius` | Blast-radius analysis |
| GET | `/symbol` | Symbol detail |
| GET | `/jobs/pending` | Pending indexing jobs |
| GET | `/jobs/:jobId` | Job status |
| POST | `/sync` | Sync repo graph |

### Tools (agent research)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/sessions/:id/tools/web-search` | sessions:read | Brave/Serper search (503 if neither key set) |
| POST | `/sessions/:id/tools/fetch-url` | sessions:read | SSRF-protected fetch |
| POST | `/sessions/:id/tools/screenshot-url` | sessions:read | Playwright screenshot |
| GET | `/sessions/:id/tools/status` | sessions:read | Tool status |
| POST | `/sessions/:id/tools/...` | sessions:read | Other tool calls |

### Snapshot & rollback

| Method | Path | Notes |
|--------|------|-------|
| GET | `/sessions/:id/snapshots` | List snapshots (`?laneId=`) |
| POST | `/sessions/:id/snapshots/:sha/rollback` | Rollback (`?laneId=`) |

### Bridge (remote CLI)

| Method | Path | Scope | Notes |
|--------|------|-------|-------|
| GET | `/sessions/:id/lanes/:laneId/bridge/status` | coordination:read | Bridge readiness |
| POST | `/sessions/:id/lanes/:laneId/exec` | coordination:write | Send prompt, relay claw output over SSE |
| WS | `/bridge/:sessionId/:laneId` | MIZI_MEM_TOKEN | Persistent bridge socket (Bearer or `?token=`). Wired in `src/index.ts`, not Express. |

Bridge exec: creates a git snapshot checkpoint first (fail-open, 8s bound), enforces a
single-active-exec lock per lane (`409` if busy), and streams frames until a `done`/`error`
frame. `503` if no bridge is connected.

### Ambient & safety (operator-only)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/ambient/status` | Ambient cycle status |
| GET | `/ambient/config` | Ambient config |
| PUT | `/ambient/config` | Update ambient config |
| POST | `/ambient/kill` | Kill switch |
| POST | `/ambient/cycle` | Trigger a cycle |
| GET | `/ambient/timeline` | Cycle history |
| GET | `/ambient/metrics` | Ambient metrics |
| GET | `/safety/pending` | Pending approvals |
| GET | `/safety/actions` | Safety actions |
| GET | `/safety/actions/:id` | Action detail |
| POST | `/safety/actions/:id/approve` | Approve |
| POST | `/safety/actions/:id/deny` | Deny |
| GET | `/safety/transcript` | Safety transcript |
| GET | `/safety/policies` | Policy bundles |
| PUT | `/safety/policies/:bundle` | Update a policy bundle |

Also `/dashboard/ambient/*` and `/dashboard/safety/*` (dashboard proxy variants).

### NIM model catalog

| Method | Path | Notes |
|--------|------|-------|
| GET | `/nim/catalog` | Model catalog snapshot |
| GET | `/nim/providers` | Provider config (nvidia/vultr/together/deepinfra) |
| GET | `/nim/health` | NIM connectivity health |
| POST | `/nim/catalog/sync` | Sync catalog |

### Profiles, offers, templates (cloud)

| Method | Path |
|--------|------|
| GET | `/profiles` |
| GET | `/profiles/:profileId` |
| GET | `/offers` (cloud) |
| GET | `/templates` (cloud) |
| GET | `/templates/:templateId` (cloud) |
| POST | `/templates` (cloud) |
| PUT | `/templates/:templateId` (cloud) |
| DELETE | `/templates/:templateId` (cloud) |

### Orchestrate (cloud)

| Method | Path | Scope |
|--------|------|-------|
| POST | `/sessions/orchestrate` | sessions:write |
| GET | `/sessions/:sessionId/orchestration-status` | sessions:write |

### Design intelligence

| Method | Path |
|--------|------|
| GET | `/design-intelligence` |
| GET | `/design-intelligence/categories` |
| GET | `/design-intelligence/skill-map` |
| GET | `/design-intelligence/sources` |
| GET | `/design-intelligence/lane-config` |
| POST | `/design-intelligence/sync` |
| GET | `/design-intelligence/bookmarks` |
| POST | `/design-intelligence/bookmarks/:entryId` |
| DELETE | `/design-intelligence/bookmarks/:entryId` |
| GET | `/design-intelligence/bookmarks/ids` |

### Intent, palette, schema templates, shortcuts

| Method | Path |
|--------|------|
| POST | `/palette/intent` |
| POST | `/intent/classify` |
| GET | `/schema-templates` (sessions:read optional) |
| GET | `/schema-templates/:id` (sessions:read optional) |
| POST | `/schema-templates` (sessions:write) |
| DELETE | `/schema-templates/:id` (sessions:write) |
| GET | `/session/id` |
| GET | `/session/health` |
| PATCH | `/session/model` |
| PATCH | `/session/routing-mode` |
| PATCH | `/session/phase` |
| GET | `/session/inference-ranking` |
| GET | `/session/swarm-model` |
| GET | `/session/model-history` |

### Dashboard, scheduler, metrics

| Method | Path | Notes |
|--------|------|-------|
| GET | `/dashboard/summary` | Dashboard aggregate |
| GET | `/scheduler` | Cron job list |
| PUT | `/scheduler` | Update cron schedule |
| GET | `/metrics` | Prometheus-format GPU/token/latency/cost metrics |

### Local distribution (`/local/*`, local only)

| Method | Path |
|--------|------|
| GET | `/local/hardware` |
| POST | `/local/hardware/refresh` |
| GET | `/local/recommendations` |
| GET | `/local/ollama/health` |
| GET | `/local/ollama/models` |
| POST | `/local/ollama/pull` |
| DELETE | `/local/ollama/models/:modelId` |
| POST | `/local/ollama/chat` |
| GET | `/local/hf-models` |
| POST | `/local/hf-pull` |
| GET | `/local/acp/health` |
| POST | `/local/acp/run` |
| GET | `/local/acp/status/:taskId` |
| POST | `/local/acp/abort/:taskId` |
| GET | `/local/templates` |
| GET | `/local/chat` |

---

## MCP server

Mounted at `/api/mcp` behind `requireAgentAuth([])` (any operator token or API key). Streaming
SSE/HTTP transport via `@modelcontextprotocol/sdk`. Discovery at `/.well-known/mcp`.

### Tools (53)

| Group | Tools |
|-------|-------|
| Sessions | `list_sessions`, `get_session`, `create_session`, `delete_session`, `classify_intent` |
| Memory | `memory_index`, `memory_search`, `memory_get_item`, `memory_init`, `memory_save_item` |
| Skills | `list_skills`, `get_skills_leaderboard`, `run_skill_eval` |
| Lanes | `list_lanes`, `create_lane`, `claim_resource`, `lane_handoff` |
| Bridge | `bridge_status`, `bridge_exec` |
| Safety | `list_pending_approvals`, `get_safety_transcript`, `get_safety_policies`, `approve_action`, `deny_action`, `update_safety_policy` |
| Planning | `list_plans`, `get_plan`, `get_session_plan`, `generate_plan`, `update_task`, `add_task`, `reassess_plan` |
| Repo | `get_repo_status`, `repo_search`, `get_blast_radius`, `trigger_repo_index` |
| Agent tools | `web_search`, `fetch_url`, `screenshot_url` |
| Design | `query_design_patterns`, `list_design_categories`, `get_design_lane_config` |
| Model catalog | `list_nim_catalog`, `get_nim_health`, `list_gpu_offers`, `list_profiles` |
| Ambient | `get_ambient_status`, `get_ambient_timeline`, `get_ambient_metrics`, `get_ambient_config`, `update_ambient_config`, `trigger_ambient_cycle` |
| Dashboard | `get_dashboard_summary` |

### Resources

| URI | Contents |
|-----|----------|
| `mizi://sessions` | Live session list (max 100) |
| `mizi://memory/index` | System-level memory shortlist + disk health |
| `mizi://plans` | 50 most recent project plans |
| `mizi://nim/catalog` | NIM model catalog snapshot |
| `mizi://profiles` | Hardware profile list |
| `mizi://safety/pending` | Pending approval queue |
| `mizi://ambient/status` | Ambient cycle state |

---

## WebSocket bridge

```
GET /api/bridge/:sessionId/:laneId
Authorization: Bearer <MIZI_MEM_TOKEN>
```

Auth: `MIZI_MEM_TOKEN` in `Authorization` header or `?token=` query param (query form is used
by `onstart.sh`). After connecting the server sends a `{ "type": "registered", sessionId, laneId }`
welcome frame, then pings every 30s. Message frames relay between caller and claw process:
`{ type: "exec", prompt }` and streamed `{ type, ... }` frames until `done`/`error`.

---

## Session status transitions

Workspace instances report status via `POST /sessions/:id/status`:

`pending → provisioning → ready | error`

Additional internal statuses reported by the instance lifecycle include `downloading`,
`starting_llm`, `skills_compiling`, `skills_ready`, `llm_ready`, `theia_ready`, and failure
statuses (`provisioning_failed`, `download_failed`, `download_stalled`, `vllm_warmup_failed`,
`disk_full`). On the current CPU-only/NIM architecture no model weights are downloaded in the
workspace, so the download-family statuses are vestigial.

---

## Configuration

Production-required secrets (see `fly.toml` and `.env.example`):

- `DATABASE_URL` — PostgreSQL (auto-set by `fly postgres attach`)
- `MIZI_ENCRYPTION_KEY` — 64 hex chars (`openssl rand -hex 32`); encrypts stored connection strings
- `MIZI_MEM_TOKEN` — 64 hex chars (`openssl rand -hex 32`); operator token + OAuth token key derivation
- `FLY_API_TOKEN` — deploy token (`fly tokens create deploy -x 999999h`)
- `FLY_WORKSPACE_APP_NAME` — workspace Fly app (default `mizi-workspace`)
- `NVIDIA_NIM_API_KEY` (or another provider key) — model inference
- `GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET` + `DASHBOARD_URL` — optional GitHub connect
- `VASTAI_API_KEY` — optional Vast.ai provider
