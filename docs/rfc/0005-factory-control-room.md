# RFC 0005 — Factory Control Room: Flow-First, Live, Governance-Oriented Factory UX

| | |
|---|---|
| **Status** | Draft for review |
| **Author** | MIZI Intelligence Layer |
| **Created** | 2026-09-13 |
| **Area** | Dashboard UX, factory observability, human-in-the-loop governance, real-time surfaces |
| **Depends on** | RFC 0001 (ledger, tripwires, cost), RFC 0003 (code factory: products, work orders, stations, pipeline, telemetry) |

## Summary

RFC 0003 built the **factory** as a backend: products, work orders, stations,
WIP-bounded dispatch, a deliverable contract, a rework loop, a continuous
build → test → stage → ship pipeline, and a telemetry surface. Every one of
those mechanisms is live on the API (`routes/factory.ts`) and reachable over
MCP (`mcp/tools/factory.ts`) — but **none of it has a human interface**. The
"factory dashboard" named in RFC 0003 §13 does not exist in the product.

This RFC specifies that interface: a **Factory Control Room** in the MIZI
dashboard. It is deliberately *not* a CRUD admin panel. It is a control room
built on three convictions:

1. **Render flow, not status.** The primary object on screen is work moving
   through the line (`queued → dispatched → build → test → stage → ship`),
   with WIP limits drawn on the columns that enforce them — not a table of
   records behind a dropdown.
2. **Manage rates, not snapshots.** Throughput, cycle time, defect rate, and
   cost per work order are time series. A factory is steered by watching their
   trend, not by reading a single number.
3. **The human governs; agents execute.** The operator's levers are policy and
   admission — WIP limits, resource caps, merge admission, eval A/B — not
   per-row "complete/rework" buttons. Per-work-order mutations belong to
   agents through MCP.

The result is an event-driven, portfolio → control-room experience that makes
the factory legible in the same visual language as the rest of MIZI.

## Motivation

### The gap

`routes/factory.ts` exposes 22 endpoints; `factory-telemetry.ts` computes a
complete `FactoryDashboard` aggregate (`completedThisPeriod`, `completedTotal`,
`avgCycleTimeMs`, `medianCycleTimeMs`, `defectRate`, `reworkRate`,
`meanCyclesToClear`, `productWip`, `stationUtilization[]`, `pipelineStages`,
`totalSpendUsd`, `costPerWorkOrder`, `snapshotTime`). `factory-pipeline.ts`
drives stages; `factory-resource-pool.ts` tracks per-product caps;
`factory-eval.ts` runs A/B scenarios. All of this is **invisible in the
dashboard**: there is no `pages/factory.tsx`, no `/factory` route, no nav
entry, no dashboard component that references the word "factory."

So today the factory can only be operated by an agent or by hand with `curl`.
That contradicts the factory's own thesis (RFC 0003): a factory is managed on
telemetry. A telemetry system with no surface is not management.

### Why not "just build a dashboard"

The obvious plan — product picker, KPI cards, work-order table, dialogs — was
considered and rejected. It fails the factory on several counts:

- **It reports state; a factory is flow.** A work-order table and a WIP
  progress bar are records management. The thing a factory operator must see
  is *work moving through stations*, and *where it is stuck*. That is a board,
  with the WIP constraints painted on it.
- **It optimizes the wrong actor.** "Complete / rework / skip" are **station
  (agent)** actions. Surfacing them to the human invites micromanagement of
  work the dispatcher already schedules. The human's high-leverage actions are
  **policy changes** — raise a WIP limit, lift a station's effective capacity,
  admit or reject a merge, run an eval comparing two configurations.
- **It polls.** The dashboard already streams (`coordination.ts` SSE,
  `bridge.ts`); a control room that refreshes on a 15 s interval is a
  screenshot of a livestream. Factory state changes are *events*.
- **It hides the reason.** "Station review at 100%" is a number. "Station
  **review** effective WIP clamped 4 → 1 by a 62% defect rate" is a decision.
  Signals must be explained and actionable.
- **It ignores the roadmap.** `products.roadmapJson` is the product's backlog.
  A factory UX that only hand-creates goals one at a time ignores the plan the
  product already carries.

### What "best in class" looks like

The reference mental model is a manufacturing control room / andon board, not a
ticketing system:

- an **andon** (the flow board) that shows the line and lights up at the
  constraint;
- **SPC-style trend readouts** (rates over time, not gauges);
- a **governance console** where the manager changes the *rules*, and the line
  re-schedules itself;
- an **event log** you can watch move.

## Existing assets (what the backend already provides)

| Asset | What it gives the UI |
|---|---|
| `GET /factory/products` | Product list (name, repoUrl, wipLimit, roadmap, configs) |
| `GET /factory/products/:id/dashboard` | The full `FactoryDashboard` aggregate (flow metrics + utilization + pipeline) |
| `GET /factory/products/:id/work-orders?status=` | Work orders with status, priority, dependencies, rework, station, timestamps |
| `GET /factory/products/:id/stations` | Stations with role, capacity, wipLimit, defectCount, reworkCycles |
| `GET /factory/products/:id/pipeline` | Latest pipeline snapshot + run history |
| `GET /factory/products/:id/metrics?limit=` | Persisted `factory_metrics` snapshots (trend source) |
| `GET /factory/products/:id/telemetry` | Per-station + product telemetry |
| `GET /factory/resource` | Shared resource pool status + per-product caps |
| `POST /factory/products/:id/dispatch` | Run the WIP-bounded dispatcher |
| `POST /factory/admission/check` | Admission decision (WIP + capacity) |
| `POST /factory/resources/caps` | Set/raise per-product caps, reset pool |
| `POST /factory/evals/run` | A/B factory eval on a scenario + two configs |
| `services/factory-telemetry.ts` | `computeDashboard`, `snapshotMetrics`, `getMetricsHistory` |
| `services/lane-sse-broadcaster.ts` | The SSE client-registry + broadcast pattern to mirror |
| `use-coordination-stream.ts` | The dashboard's existing SSE hook pattern |
| `recharts` (already a dashboard dependency) | Trend charts |

Auth note: `/factory/*` is guarded by `requireAgentAuth(["coordination:read"
|"coordination:write"])`. In dev (no `MIZI_MEM_TOKEN`, not production) requests
pass through; in production the page must send `Authorization: Bearer
<operatorToken>`, matching the existing pattern in `ambient.tsx`.

## Design

### Information architecture

Two surfaces, because a product **is** a factory — not a filter on a page:

- **`/factory` — Factory Portfolio.** All products as mini-factories:
  health light (flowing / constrained / stalled), throughput (24 h), WIP
  occupancy, cost/day, and the top active signal. One screen to answer *which
  factory needs me right now?*
- **`/factory/:productId` — Control Room.** One product's floor: flow board,
  trends, signals, governance, roadmap.

Nav placement: **main group**, alongside Home / Sessions / Intelligence, using
the lucide `Factory` icon. The portfolio carries a badge when any product has a
critical signal.

### Control Room composition

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Product header  ·  repo chip  ·  WIP 3/4  ·  cost/hr  ·  [Run dispatch]  │
├────────────────────────────────────────────┬─────────────────────────────┤
│  FLOW BOARD  (primary, full width minus    │  SIGNAL RAIL (right)        │
│  the rail)                                  │   ● review saturated 4→1    │
│                                             │     defect rate 62% · [Fix] │
│  queued │ dispatched │ build │ test │ stage │ ship │
│  [card] │  [card]    │ [···] │ [ ]  │ [ ]   │ [ ]  │   ● N blocked on deps │
│         │            │       │      │       │      │   ● cost over $X/day  │
│         column headers show WIP used/limit  │      │                     │
│         and defect-adjusted effective limit │      │                     │
├────────────────────────────────────────────┴─────────────────────────────┤
│  TRENDS BAND  (recharts)                                                  │
│  throughput/24h │ cycle time (p50/p95) │ defect rate │ $ / work order      │
├──────────────────────────────────────────────────────────────────────────┤
│  GOVERNANCE          WIP & caps · Admission · Eval A/B                    │
│  ROADMAP → WORK      roadmapJson items → decompose to work orders         │
└──────────────────────────────────────────────────────────────────────────┘
```

**1. Product header.** Name, repo chip, live WIP occupancy, current cost rate,
and a single primary action: **Run dispatch** (`POST /dispatch`). Dispatch is
the one routine operator action that is not per-row.

**2. Flow board (primary).** Columns are the real stages: `queued`,
`dispatched`, `build`, `test`, `stage`, `ship`. Work orders render as cards
(goal, priority, station role, rework badge, blocked-on-deps chip). The board
is **derived from the same data the dispatcher uses** (`work-orders` +
`dashboard.stationUtilization` + `pipelineStages`) so what is on screen
matches what the scheduler sees.

- Column headers show **WIP used / limit** and, for stations, the
  **defect-adjusted effective limit** — the exact value the dispatcher clamps
  to. The constraint is drawn where it binds.
- Card colour encodes **flow state**, not status alone: healthy (moving),
  blocked (dependency or admission hold), in-rework (rejected, cycling), and
  stalled (dispatched but no progress beyond a threshold).
- Work that is *held* by the dispatcher is shown **as held, with the reason**
  (WIP saturated / dependency unmet), reusing the `DispatchResult.held[]`
  shape (`{ workOrderId, reason }`). The board doubles as an explanation of
  the dispatcher's decisions.

**3. Signal rail.** In-app computations over the same payloads, each with a
rationale and a one-click **policy fix**:

| Signal | Source | Fix |
|---|---|---|
| Station saturated / defect-clamped | `stationUtilization[].effectiveLimit` vs `wipLimit` | Raise station WIP or investigate defect class |
| Admission blocked | `POST /admission/check` result | Review blocker / raise product WIP |
| Blocked on dependencies | work-order `dependenciesJson` + statuses | View dependency chain |
| Cost trending up | `totalSpendUsd`, `costPerWorkOrder` over `metrics` history | Adjust product cap (`/resources/caps`) |
| Rework spike | `reworkRate`, `meanCyclesToClear` | Open rework items for the offending station |

The rail is the product's answer to "what is wrong and what do I do" without
the operator reading a single raw metric.

**4. Trends band.** `recharts` line/area charts sourced from
`GET /factory/products/:id/metrics` (persisted snapshots) plus the live
`dashboard` point: throughput/24 h, cycle time (p50 and p95 where available),
defect rate, and cost per work order. Range selector (24 h / 7 d / 30 d). If
snapshot history is sparse, the band shows a "collecting metrics" state and
offers **Take snapshot** (`POST /metrics/snapshot`).

**5. Governance console.** The human's real levers, grouped:

- **WIP & caps** — product WIP limit; per-station capacity/WIP; shared resource
  pool caps (`GET/POST /factory/resources`, `/factory/resources/caps`).
- **Admission** — run `POST /factory/admission/check` for a repo/session/fan-in
  and present the decision with its reasoning before a merge is admitted.
- **Eval A/B** — configure a scenario + `configA`/`configB` and run
  `POST /factory/evals/run`; render the report (throughput, cycle time, defect
  rate, cost deltas, winner) as a comparison, not a JSON dump.

**6. Roadmap → Work.** Render `products.roadmapJson` as backlog cards and
support decomposing an item into a work order (via the existing plan/board
decomposition path), so the product's own roadmap is the entry point to work —
complementing agent-side `create_work_order`.

**7. Event log (footer, collapsible).** A live feed of factory events (see
below): dispatched, completed, defect recorded, stage advanced. This is the
"watch the line" surface and the debug view when the board looks wrong.

### Live layer — factory events over SSE

Factory mutations happen in services, often triggered by agents. To make the
board live without polling, mirror the existing broadcaster pattern
(`lane-sse-broadcaster.ts`) with a **factory event emitter + broadcaster**:

- `services/factory-event-emitter.ts` (new): a registry keyed by `productId`
  plus `addFactoryClient` / `removeFactoryClient` / `broadcastFactoryEvent`,
  exactly like the coordination broadcaster.
- `GET /factory/products/:id/stream` (new route): SSE endpoint; writes
  `event: ping` heartbeats (same as `coordination.ts`), registers the client,
  cleans up on close.
- **Emit points** (no behavior change, additive): after `dispatchWorkOrders`,
  `completeWorkOrder`, `rejectToRework`/`submitDeliverable`, and
  `advancePipeline`. Events are `factory_event` with a discriminated `type`:

```ts
type FactoryEvent =
  | { type: "order_dispatched"; workOrderId: number; stationId: number }
  | { type: "order_completed"; workOrderId: number; status: "done" | "skipped" }
  | { type: "defect_recorded"; workOrderId: number; stationId: number; defectClass: string; cycle: number }
  | { type: "stage_advanced"; pipelineRunId: number; stage: PipelineStage; status: PipelineStatus }
  | { type: "wip_changed"; productWip: { used: number; limit: number } };
```

- The dashboard hook `use-factory-stream.ts` (new) mirrors
  `use-coordination-stream.ts` (EventSource + `useVisibilityReconnect`), and on
  `factory_event` invalidates the `["factory", productId, ...]` query keys.
  Polling is used only as the reconnect fallback, never as the steady state.

### Data-access layer

Factory is **not** in `lib/api-spec/openapi.yaml`, so there is no generated
client. Follow the established dashboard convention for un-generated endpoints
(as `schema-templates.tsx` and `intelligence.tsx` do): a single typed hook
module.

- `hooks/use-factory.ts` (new): typed `useQuery`/`useMutation` wrappers for
  every endpoint above, keys namespaced `["factory", "products"]`,
  `["factory", productId, "dashboard"]`, etc. An `authHeaders()` helper
  supplies the operator bearer token.
- Rationale: keeps codegen out of scope for this RFC; if factory endpoints are
  later added to the OpenAPI spec, the hook module is a thin seam to swap.

### Design-system integration

The page must be indistinguishable in craft from the rest of the dashboard:

- **Tokens:** `--bg-base`, `--accent-cyan`, `--accent-violet`,
  `--accent-success`, `--accent-danger`, `--text-primary/secondary/muted`.
- **Chrome:** the `glass-card` surface, `glass-emerge` entry animation,
  `shimmer` skeletons, `rounded-xl`, `Geist`/`Geist Mono`.
- **Primitives:** `components/ui/*` (card, badge, button, dialog, select, table,
  tooltip, skeleton, sheet, separator).
- **Icons:** lucide (`Factory`, `Workflow`, `Gauge`, `TriangleAlert`, …).
- **New components** (`components/factory/`): `flow-board.tsx`,
  `work-order-card.tsx`, `wip-column-header.tsx`, `signal-rail.tsx`,
  `signal-item.tsx`, `trends-band.tsx`, `governance-panel.tsx`,
  `eval-compare.tsx`, `roadmap-panel.tsx`, `event-log.tsx`,
  `product-health-light.tsx`. Portfolio page reuses `product-health-light` +
  compact metric tiles.

### Accessibility, performance, and craft

- **A11y:** the flow board is a labelled list/region per stage, not a canvas;
  card state is conveyed by text/label in addition to colour; signals are
  focusable with explicit fix actions; keyboard traversal across columns.
- **Performance:** the board renders from cached aggregates; trend queries are
  paginated by range; SSE replaces polling so idle cost is one open connection;
  skeletons match final layout to avoid reflow.
- **Empty / first-run:** no products → a guided "create your first factory"
  flow (name, repo, WIP). Product with no work orders → roadmap-first prompt.
  Metrics with no history → "collecting" state with manual snapshot.
- **Resilience:** SSE down → silent fallback to bounded polling (status pill
  shows `live` / `reconnecting` / `polling`, reusing the coordination stream's
  status model).

## File / module changes

| Area | Change |
|---|---|
| `artifacts/dashboard/src/pages/factory/index.tsx` (new) | Portfolio view |
| `artifacts/dashboard/src/pages/factory/[productId].tsx` (new) | Control Room |
| `artifacts/dashboard/src/components/factory/*` (new) | Flow board, signal rail, trends band, governance, eval compare, roadmap, event log, health light |
| `artifacts/dashboard/src/hooks/use-factory.ts` (new) | Typed query/mutation layer for `/factory/*` |
| `artifacts/dashboard/src/hooks/use-factory-stream.ts` (new) | SSE hook mirroring `use-coordination-stream` |
| `artifacts/dashboard/src/App.tsx` | Add `/factory` and `/factory/:productId` routes |
| `artifacts/dashboard/src/components/layout/app-layout.tsx` | Add `Factory` nav item + portfolio badge |
| `artifacts/api-server/src/services/factory-event-emitter.ts` (new) | Factory SSE client registry + broadcast |
| `artifacts/api-server/src/routes/factory.ts` | Add `GET /factory/products/:id/stream`; emit events after dispatch/complete/rework/pipeline-advance |

No database schema changes. No change to dispatch/telemetry semantics — event
emission is additive and must not alter existing route responses.

## Phasing

### Phase 1 — The Floor, live (P0)
- Portfolio IA + Control Room shell, routing, nav.
- Flow board with WIP/effective-limit column headers, card flow states, held
  reasons.
- `factory-event-emitter` + `/stream` route + `use-factory-stream`; board goes
  live.
- Product header with WIP occupancy, cost rate, Run dispatch.

### Phase 2 — The Levers (P1)
- Trends band (recharts) with range selector + snapshot action.
- Signal rail with computed signals and one-click policy fixes.
- Governance console: WIP/caps, admission check, eval A/B compare.
- Roadmap → work panel.

### Phase 3 — Depth (P2)
- Event log with filtering and per-order drill-in linking to sessions/lanes.
- Pipeline stage detail (artifacts, gate detail) and run history.
- Portfolio-level cross-product resource contention view.
- Optional: promote factory routes into `openapi.yaml` and switch the hook
  layer to the generated client.

## Test plan

- **Rendering:** portfolio lists products with correct health derivation; control
  room renders board columns from `work-orders` + `stationUtilization` +
  `pipelineStages`.
- **WIP headers:** column WIP shows `used/limit`; effective limit reflects
  defect-adjusted value from `stationUtilization[].effectiveLimit`.
- **Held reasons:** work orders reported in `DispatchResult.held[]` render in
  their column with the stated reason and are not shown as dispatched.
- **Dispatch:** Run dispatch calls `POST /dispatch` and reconciles the board on
  success (optimistic or refetch-on-event).
- **Signals:** each signal fires on its threshold and its fix action calls the
  correct endpoint (caps, admission, eval).
- **Trends:** charts read `/metrics` history; empty history shows the collecting
  state; snapshot action appends a point.
- **Live layer:** a dispatch/complete/rework/pipeline-advance triggers a
  `factory_event` that invalidates the right query keys; SSE failure degrades to
  polling with the correct status pill.
- **Auth:** in production, requests carry the operator bearer; in dev the page
  works tokenless.
- **A11y:** stage regions labelled; state conveyed without colour alone;
  keyboard traversal across the board.
- **Regression:** existing `/factory/*` route responses unchanged by event
  emission; API server suite and dashboard suite stay green.

## Open questions

1. **Dispatch auto vs. manual.** Does the control room auto-run dispatch on an
   interval / on event, or is dispatch always an explicit operator action? (RFC
   0003's dispatcher is advisory; default here is explicit, with an opt-in
   auto-dispatch toggle.)
2. **Board time window.** Does the flow board show *all current* work orders, or
   the current pipeline run's orders? Proposed: all non-terminal + recently
   completed, with a run filter.
3. **Trends source of truth.** `/metrics` snapshots are periodic and may be
   sparse; do we snapshot on every terminal event to densify series, or accept
   coarse history and lean on the live point?
4. **Eval surface scope.** Is A/B eval an operator feature in the control room,
   or an advanced/dev affordance behind a toggle?
5. **Portfolio badge semantics.** What escalates to the portfolio badge —
   "any critical signal", "cost over cap", "stalled flow", or operator-defined?
6. **Roadmap authority.** Is `roadmapJson` authored in the dashboard, or
   mirrored read-only from the repo's plan/roadmap and decomposed elsewhere?

## Non-goals

- No new factory backend behavior — this RFC is a **surface** over existing
  services; the only backend additions are the SSE stream and additive event
  emission.
- No per-work-order mutation buttons for humans — those remain agent actions via
  MCP.
- No central control that overrides the dispatcher — the control room changes
  *policy* (WIP, caps, admission), and the scheduler re-plans.
- No new visual language — the control room uses the existing design tokens and
  `ui/` primitives.
- No canvas/WebGL DAG editor — the flow board is DOM, accessible, and cheap.
- No replacement of the session/lane surfaces — the control room links out to
  them for drill-in.
