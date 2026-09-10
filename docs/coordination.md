# Coordination System

The coordination API manages session lanes, resource claims, cross-lane handoffs, conflict analysis, and background jobs. Lane overlays are per-lane; the session core is the only prompt layer shared across lanes.

The implementation sources for this document are [`lane-policy.ts`](../artifacts/api-server/src/services/lane-policy.ts) and [`coordination.ts`](../artifacts/api-server/src/routes/coordination.ts).

## Lane Types And Policies

The built-in lane types are exactly:

`ux`, `debug`, `backend`, `review`, and `general`.

`resolveValidLaneType()` also accepts a name present in `custom_lane_types`. Unknown or missing names resolve to `general`. Custom policies inherit the `general` policy and may override their description, token mode, overlay skills, retrieval emphasis, design categories, `maxConcurrentClaims`, and `heavyJobSlots`. Custom names must match `[a-z][a-z0-9_-]{0,49}` and cannot use a built-in name.

The complete built-in `LANE_POLICIES` values are:

| Lane | Task mode | Token mode | Allowed claim types | Max claims | Heavy slots | Blast-radius files | Shared memory | Private memory | Conflict escalation | Design categories | Description |
|---|---|---|---|---:|---:|---:|---|---|---|---|---|
| `ux` | `build` | `core` | `file`, `module`, `symbol` | 20 | 1 | 30 | `repo_shared`, `session_core` | `lane_user` | `warn` | `palette`, `typography`, `chart_type`, `ux_guideline`, `ui_reasoning`, `anti_pattern`, `style` | UX/frontend lane; emphasises component and style context, warns on overlap with backend lanes. |
| `debug` | `debug` | `core` | `file`, `symbol`, `task` | 10 | 2 | 50 | `repo_shared`, `session_core` | `lane_user`, `task` | `warn` | none | Debug lane; structured debug workflow, compact output, warns on claim overlap. |
| `backend` | `build` | `full` | `file`, `module`, `symbol`, `task` | 30 | 3 | 100 | `repo_shared`, `session_core`, `user_operator` | `lane_user`, `task` | `warn` | `stack_convention` | Backend lane; fuller context budget, governance memory, shared API conventions. |
| `review` | `review` | `lean` | `file`, `module`, `task` | 15 | 1 | 40 | `repo_shared`, `session_core` | `lane_user` | `warn` | `ux_guideline`, `anti_pattern` | Review lane; lean token mode, terse output, focuses on conventions and test coverage. |
| `general` | `build` | `core` | `file`, `module`, `symbol`, `task` | 20 | 2 | 50 | `repo_shared`, `session_core` | `lane_user`, `task` | `warn` | `palette`, `typography`, `stack_convention`, `ux_guideline` | General-purpose lane; balanced defaults, no specific retrieval emphasis. |

The policies also define per-lane overlay skill IDs and retrieval emphasis. These are the exact values in `LANE_POLICIES`:

| Lane | Overlay skill IDs | Retrieval emphasis |
|---|---|---|
| `ux` | `karpathy-doctrine`, `flow-router`, `lean-compression`, `design-intelligence-core`, `ui-ux-reasoning` | `component`, `style`, `layout`, `ui`, `frontend`, `design`, `palette`, `typography` |
| `debug` | `debug-flow`, `checkpoints-lite`, `compact-response` | `error`, `stack`, `trace`, `exception`, `failure` |
| `backend` | `karpathy-doctrine`, `flow-router`, `memory-governance-core` | `api`, `service`, `database`, `schema`, `migration` |
| `review` | `karpathy-doctrine`, `one-line-review`, `focused-memory`, `frontend-design-review`, `design-handoff-discipline` | `pr`, `review`, `diff`, `convention`, `test` |
| `general` | `karpathy-doctrine`, `flow-router`, `memory-compact` | none |

`maxConcurrentClaims`, `heavyJobSlots`, and `maxBlastRadiusFiles` are policy values exposed with lane policy data. The coordination routes do not reject a claim or job based on those limits. `allowedClaimTypes` is likewise policy metadata; claim creation defaults to `file` but does not perform a route-level allowed-type check.

## Claim Lifecycle

### Constants And Expiry

| Constant | Exact value | Meaning |
|---|---:|---|
| `LANE_DEFAULT_TTL_SECONDS` | `3600` seconds (1 hour) | Default claim expiry and default heartbeat refresh TTL |
| `LANE_HEARTBEAT_WINDOW_SECONDS` | `300` seconds (5 minutes) | Maximum age of `lastHeartbeatAt` before a claim is stale |
| Claim sweeper interval | `30000` ms (30 seconds) | Background hard-delete interval in `claim-sweeper.ts` |

A claim is stale when either `expiresAt < now` or `lastHeartbeatAt < now - 300 seconds`. Lane-list and coordination-summary reads soft-expire stale active claims by setting `active = false`. The background sweeper atomically hard-deletes stale active claims. Expiry emits `claim_expired`.

### Create

**Endpoint:** `POST /api/sessions/:id/lanes/:laneId/claim`

Relevant request fields:

```json
{
  "claimType": "file",
  "resourcePath": "src/services/auth.ts",
  "claimSymbols": ["authenticateUser", "validateToken"],
  "strength": 0.8,
  "ttlSeconds": 1800,
  "preserveHistory": false
}
```

`resourcePath` is required. `claimType` defaults to `file`; `strength` is clamped to `0..1` and defaults to `0.3`; `ttlSeconds` uses the supplied positive number or the 3600-second default. Strength maps to the database enum as follows:

| API strength | Stored strength |
|---|---|
| `< 0.4` | `watching` |
| `0.4` to `< 0.75` | `editing` |
| `>= 0.75` | `owner` |

The default path atomically upserts the active claim for `(laneId, resourcePath)`, refreshing its heartbeat, expiry, strength, and symbols. With `preserveHistory=true`, the existing active row is deactivated and a new row is inserted in a transaction. Claims are therefore unique per resource within a lane, not globally across a session.

The endpoint checks active claims in other lanes and returns `overlaps`, `overallRecommendation`, and the newly created claim. A `block` recommendation does **not** reject the request; the claim has already been created.

### Heartbeat And Release

**Heartbeat:** `DELETE /api/sessions/:id/lanes/:laneId/claim/:claimId?heartbeat=true`

This refreshes `lastHeartbeatAt` and sets `expiresAt` to the current time plus `ttlSeconds` from the query string, or 3600 seconds when that value is absent or parses as false. It keeps the claim active.

**Release:** `DELETE /api/sessions/:id/lanes/:laneId/claim/:claimId`

Without `heartbeat=true`, the row is deleted and a `claim_released` event is emitted. Expiry is the history-preserving path; explicit release is not.

## Conflict Detection

Conflict checks compare active claims from different lanes. They use both resource overlap and repository dependency edges when repository context is available.

1. **Symbol-aware resource overlap:** exact resource matches conflict when both sides have symbols only if their symbol sets intersect. If either side lacks symbols, the match falls back to file/resource overlap. Directory-prefix overlap contributes half weight.
2. **Blast-radius overlap:** a repository edge connecting a resource claimed by one lane to a resource claimed by the other contributes a hit. The score is `blastHits / max(number of claims in each lane)`, capped at `1`.
3. **Effective score:** `max(overlapScore, blastRadiusOverlap * 0.75)`.

The recommendation thresholds are:

| Effective score | Recommendation | Behavior |
|---:|---|---|
| `>= 0.75` | `block` | Returned as a high-severity coordination warning; claim creation is not rejected |
| `>= 0.4` and `< 0.75` | `warn` | Claim is created and warning data is returned |
| `< 0.4` | `no_conflict` | No escalation recommendation |

When both claims target the same file with distinct symbol sets, symbol-aware detection avoids a false file-level conflict. Graph data is optional; if it is unavailable, path and symbol analysis still runs.

`GET /api/sessions/:id/conflicts` recomputes the same analysis for lane pairs and returns `conflicts`, `totalConflicts`, and `highSeverity`. `highSeverity` counts `block` recommendations.

## Handoffs

**Create:** `POST /api/sessions/:id/lanes/:laneId/handoff`

The request uses `handoffType`, `toLaneIds`, `resourcePaths`, and `message`. Valid handoff types are:

| Type | Lane status change | Additional behavior |
|---|---|---|
| `blocked` | `blocked` | Signals that the lane is blocked |
| `needs_review` | `review-needed` | Requests review |
| `safe_to_merge` | `ready-to-merge` | Asynchronously attempts to open a draft PR |
| `watch_files` | none | Shares files to watch |
| `related_lane` | none | Relates lanes without changing status |

New handoffs start with `pending`. `PATCH /api/sessions/:id/lanes/:laneId/handoff/:handoffId` accepts only `acknowledged` or `dismissed` and records `acknowledgedAt` for either update. The response serializer can represent `expired`, but this route does not provide an expired transition.

For `safe_to_merge`, draft-PR creation is fire-and-forget and non-blocking. It runs only when the session has a GitHub token and a repository URL in its fingerprint. If a PR is created, its URL is stored on the handoff. Failure does not fail the handoff response.

## Heavy Jobs

Heavy jobs are coordination background work; they do not allocate model-serving or accelerator resources. Valid job classes are `indexing`, `embedding`, `eval`, `blast_radius`, `compile`, and `other`.

**Endpoints:**

| Method | Endpoint | Semantics |
|---|---|---|
| `POST` | `/api/sessions/:id/heavy-jobs` | Enqueue a `queued` job; default priority is `5`, default lane weight is `1.0` |
| `GET` | `/api/sessions/:id/heavy-jobs` | Refresh queued scores, then list jobs; optional comma-separated status filter |
| `GET` | `/api/sessions/:id/heavy-jobs/next` | Refresh scores and return the highest-scored queued job without dequeuing; `204` when empty |
| `PATCH` | `/api/sessions/:id/heavy-jobs/:jobId` | Transition to `running`, `completed`, `failed`, or `deferred` |

The scheduler score is:

```text
effectiveScore = priorityNorm + ageWeight + laneWeight + classFloor
```

`priorityNorm` is `priority / 10`, clamped to `0.1..1.0`. Age accrues at `0.05` per minute and is capped at `2.0`. Class floors are `indexing: 0.5`, `blast_radius: 0.4`, `compile: 0.35`, `embedding: 0.3`, `eval: 0.2`, and `other: 0.1`.

For lane-associated jobs, `laneWeight` is refreshed from a 60-minute sliding window of running and completed jobs. It is clamped to `0.5..2.0`, boosting underrepresented lanes and applying backpressure to overrepresented lanes. `deferred` records `deferredUntil`; the route does not itself perform a later transition back to `queued`.

## Authentication

Coordination routes use `requireAgentAuth`:

- `GET` lane, coordination, conflict, heavy-job, timeline, stream, and cleanup-stat endpoints require `coordination:read`.
- `POST`, `PUT`, `PATCH`, and `DELETE` coordination mutations require `coordination:write`.
- `GET /api/coordination/lane-types` is public.
- `POST`, `PATCH`, and `DELETE /api/coordination/lane-types/:id` require `coordination:write`.
- `POST /api/admin/sweep-claims` requires `coordination:write`; `GET /api/admin/claim-cleanup-stats` requires `coordination:read`.

An API key must be a valid, non-revoked, non-expired bearer token with the required scope. The configured `MIZI_MEM_TOKEN` is accepted as an operator/internal pass-through. In non-production development, when `MIZI_MEM_TOKEN` is unset and no bearer is supplied, `requireAgentAuth` allows the request through. Production does not have that no-credential bypass.

## Safety And Ambient Relationship

Coordination authentication and safety approval are separate concerns. Coordination routes do not call the safety approval service before creating claims, handoffs, or heavy jobs. They record lane state, recommendations, and events.

Ambient mode consumes coordination state as workspace signals, including active lanes, pending handoffs, queued/running heavy jobs, and review/conflict information. Ambient actions are governed by the safety policy bundle in [`safety.ts`](../artifacts/api-server/src/services/safety.ts), not by `LANE_POLICIES`.

The relevant default safety bundles are:

- `local-only`: auto-allows `local` and `sandbox`; external-surface and irreversible actions require approval.
- `team-coord`: also auto-allows `team` actions and the coordination kinds `coord_handoff_post` and `coord_lane_note`; external communication remains gated and irreversible actions require approval.
- `external-comm`: allows the `external` scope but still gates irreversible actions.

Ambient/safety control endpoints have their own operator-token posture in [`ambient.ts`](../artifacts/api-server/src/routes/ambient.ts): `/api/ambient/*` and `/api/safety/*` are token-gated by `MIZI_MEM_TOKEN`, while `/api/dashboard/ambient/*` and `/api/dashboard/safety/*` expose read-only browser-safe views. The ambient kill switch and approval/denial actions are not coordination endpoints.

## Live Updates

`GET /api/sessions/:id/coordination/stream` is an authenticated SSE stream. It emits coordination updates for lane, claim, conflict, handoff, and heavy-job changes, and sends a `ping` event every 20 seconds. The connection is removed when the request closes.

Lane lifecycle events include `lane_created`, `lane_destroyed`, `claim_created`, `claim_released`, `claim_expired`, `handoff_sent`, `handoff_acknowledged`, `heavy_job_started`, and `heavy_job_completed`.
