# RFC 0005 — Factory Control Room: Flow-First, Live, Governance-Oriented Factory UX

| | |
|---|---|
| **Status** | Draft for review |
| **Author** | MIZI Intelligence Layer |
| **Created** | 2026-09-13 |
| **Area** | Dashboard UX, factory observability, human-in-the-loop governance, real-time surfaces |
| **Depends on** | RFC 0001 (ledger, tripwires, cost), RFC 0003 (code factory: products, work orders, stations, pipeline, telemetry), RFC 0006 (fab model, shared lane pool, multi-product dispatcher, backend events) |

## Summary

RFC 0003 built the **factory** as a backend: products, work orders, stations,
WIP-bounded dispatch, a deliverable contract, a rework loop, a continuous
build → test → stage → ship pipeline, and a telemetry surface. Every one of
those mechanisms is live on the API (`routes/factory.ts`) and reachable over
MCP (`mcp/tools/factory.ts`) — but **none of it has a human interface**. The
"factory dashboard" named in RFC 0003 §13 does not exist in the product.

This RFC specifies that interface: a **Factory Control Room** in the MIZI
dashboard. It is deliberately *not* a CRUD admin panel. And it is deliberately
**a surface, not a system**: the backend it renders — the factory-as-fab data
model, the shared lane pool with claim/release, the multi-product dispatcher's
arbitration, and the live event stream — is specified in RFC 0006. A control
room needs three things from the system: a *model of what's in the room*
(RFC 0003), *scheduler reasoning it can render* (RFC 0006's arbitration
readout), and *events to watch* (RFC 0006's event stream). This RFC composes
them.

It is a control room built on three convictions:

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
- **It ignores contention.** The moment the fab hosts more than one product
  (RFC 0006), the operator's first question becomes "why did lanes go to
  product B and not A?" A single-product KPI page cannot answer that — only
  the dispatcher's arbitration readout can.
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
| `GET /factory/arbitration/latest` + `GET /factory/products/:id/arbitration` (RFC 0006) | The dispatcher's per-order `dispatchScore`, factors, and `lostTo` — the arbitration-readout source |
| `GET /factory/products/:id/stream` + `factory-event-emitter.ts` (RFC 0006) | The live `factory_event` stream the board listens to |
| `services/lane-sse-broadcaster.ts` | The SSE client-registry + broadcast pattern that RFC 0006's emitter mirrors |
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
│  GOVERNANCE          WIP & caps · Admission · Eval A/B · Arbitration        │
│  ROADMAP → WORK      roadmapJson items → decompose to work orders            │
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
  (WIP saturated / dependency unmet / outranked by a higher dispatch score /
  budget exhausted), reusing the `DispatchResult.held[]` and RFC 0006
  arbitration-readout shapes (`{ workOrderId, reason }`,
  `{ dispatchScore, factors, lostTo }`). The board doubles as an explanation
  of the dispatcher's decisions.

**3. Signal rail.** In-app computations over the same payloads, each with a
rationale and a one-click **policy fix**:

| Signal | Source | Fix |
|---|---|---|
| Station saturated / defect-clamped | `stationUtilization[].effectiveLimit` vs `wipLimit` | Raise station WIP or investigate defect class |
| Admission blocked | `POST /admission/check` result | Review blocker / raise product WIP |
| Blocked on dependencies | work-order `dependenciesJson` + statuses | View dependency chain |
| Cost trending up | `totalSpendUsd`, `costPerWorkOrder` over `metrics` history | Adjust product cap (`/resources/caps`) |
| Rework spike | `reworkRate`, `meanCyclesToClear` | Open rework items for the offending station |
| Outranked by priority | arbitration readout `reason: "outranked…"` + `lostTo` | Change product priority / pull due date — arbitration panel (decision) |
| Budget exhausted | arbitration readout `reason: "budget exhausted"` | Raise/refill product budget (RFC 0006 §4) |

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
- **Arbitration** — render RFC 0006's readout for the most recent fab pass:
  per held work order its `dispatchScore`, the `factors`
  (`productWeight · orderWeight · dueDatePressure · budgetWeight`), and the
  `lostTo` list ("what it lost to and by how much"), plus fab lane-pool
  occupancy (`lanePoolUsed / lanePoolLimit`). The panel is **actionable**
  (decision): an "outranked" order offers **change-priority / pull-due-date**
  actions that mutate the product via RFC 0006 and **re-run arbitration
  immediately** so the operator sees the effect of the lever in one gesture.
  This is the answer to "why B not A" and the product's standing with the
  fab.

**6. Roadmap → Work.** Render `products.roadmapJson` as backlog cards and
support decomposing an item into a work order (via the existing plan/board
decomposition path), so the product's own roadmap is the entry point to work —
complementing agent-side `create_work_order`.

**7. Event log (footer, collapsible).** A live feed of factory events (see
below): dispatched, completed, defect recorded, stage advanced. This is the
"watch the line" surface and the debug view when the board looks wrong.

### Live layer — factory events over SSE

The backend of this layer is **RFC 0006 §5**: `services/factory-event-emitter.ts`
(a client registry keyed by `productId` plus broadcast, mirroring
`lane-sse-broadcaster.ts`) and `GET /factory/products/:id/stream` (SSE with
`event: ping` heartbeats), emitting the `factory_event` union after dispatch,
complete, rework, pipeline-advance, arbitration passes, and pool changes. This
RFC only defines the dashboard half:

- `hooks/use-factory-stream.ts` (new) mirrors `use-coordination-stream.ts`
  (EventSource + `useVisibilityReconnect`): it opens the RFC 0006 `/stream`
  route and, on each `factory_event`, invalidates the `["factory", productId,
  ...]` query keys so the board, signals, and trends reconcile from fresh data.
  Polling is used only as the reconnect fallback, never as the steady state.
- Cardinality: one EventSource per open control room; the portfolio optionally
  opens the fab-wide channel for its live badge.

### Data-access layer

Factory is **not** in `lib/api-spec/openapi.yaml`, so there is no generated
client. Follow the established dashboard convention for un-generated endpoints
(as `schema-templates.tsx` and `intelligence.tsx` do): a single typed hook
module.

- `hooks/use-factory.ts` (new): typed `useQuery`/`useMutation` wrappers for
  every endpoint above — including the RFC 0006 additions
  (`POST /factory/products/:id/decompose`, the arbitration endpoints, the
  `/stream` hook) — keys namespaced `["factory", "products"]`,
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
  `eval-compare.tsx`, `arbitration-panel.tsx`, `product-spec-wizard.tsx`,
  `roadmap-panel.tsx`, `event-log.tsx`, `product-health-light.tsx`,
  `fab-header.tsx`. Portfolio page reuses `product-health-light` + compact
  metric tiles + the fab-level pool/budget readout.

### Accessibility, performance, and craft

- **A11y:** the flow board is a labelled list/region per stage, not a canvas;
  card state is conveyed by text/label in addition to colour; signals are
  focusable with explicit fix actions; keyboard traversal across columns.
- **Performance:** the board renders from cached aggregates; trend queries are
  paginated by range; SSE replaces polling so idle cost is one open connection;
  skeletons match final layout to avoid reflow.
- **Empty / first-run:** no products → a guided **product-spec launch** (the
  role RFC 0006 §4 decompose plays on the backend): name, repo, priority,
  WIP/budget, and a free-text intent that yields a roadmap preview before the
  product exists. Product with no work orders → roadmap-first prompt. Metrics
  with no history → "collecting" state with manual snapshot.
- **Resilience:** SSE down → silent fallback to bounded polling (status pill
  shows `live` / `reconnecting` / `polling`, reusing the coordination stream's
  status model).

## File / module changes

| Area | Change |
|---|---|
| `artifacts/dashboard/src/pages/factory/index.tsx` (new) | Portfolio view (fab pool/budget header + product minis) |
| `artifacts/dashboard/src/pages/factory/[productId].tsx` (new) | Control Room |
| `artifacts/dashboard/src/pages/factory/new.tsx` (new) | Product-spec launch (intent → decompose preview) |
| `artifacts/dashboard/src/components/factory/*` (new) | Flow board, signal rail, trends band, governance, eval compare, arbitration panel, product-spec wizard, roadmap, event log, health light, fab header |
| `artifacts/dashboard/src/hooks/use-factory.ts` (new) | Typed query/mutation layer for `/factory/*` (+ RFC 0006 endpoints) |
| `artifacts/dashboard/src/hooks/use-factory-stream.ts` (new) | SSE hook over RFC 0006 `/stream`, mirroring `use-coordination-stream` |
| `artifacts/dashboard/src/App.tsx` | Add `/factory`, `/factory/new`, `/factory/:productId` routes |
| `artifacts/dashboard/src/components/layout/app-layout.tsx` | Add `Factory` nav item + portfolio badge |

**RFC 0005 makes no backend changes.** The fab data model, lane pool with
claim/release, multi-product dispatcher, and the `factory_event` stream are
RFC 0006. This RFC's runtime surface is confined to the dashboard.

## Phasing

### Phase 1 — The Floor, live (P0)
- Portfolio IA + Control Room shell, routing, nav.
- Flow board with WIP/effective-limit column headers, card flow states, held
  reasons (incl. outranked / budget exhausted from RFC 0006).
- `use-factory-stream` over RFC 0006's `/stream`; board goes live.
- Product header with WIP occupancy, cost rate, Run dispatch.
- Empty-state product-spec launch (name/repo/priority/WIP + intent → roadmap
  preview via RFC 0006 §4 decompose).

### Phase 2 — The Levers (P1)
- Trends band (recharts) with range selector + snapshot action.
- Signal rail with computed signals and one-click policy fixes.
- Governance console: WIP/caps, admission check, eval A/B compare.
- Arbitration panel (RFC 0006 readout: scores, factors, `lostTo`, pool
  occupancy) with change-priority / pull-due-date actions that re-arbitrate
  immediately (decision).
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
- **Live layer:** a dispatch/complete/rework/pipeline-advance/arbitration-pass
  emits a RFC 0006 `factory_event` that invalidates the right query keys; SSE
  failure degrades to polling with the correct status pill.
- **Arbitration:** held "outranked" orders render score/factors/`lostTo`; fab
  pool occupancy reconciles to `pool_changed`; a change-priority/pull-due-date
  action mutates the product and triggers an immediate re-arbitration that
  reconciles the board.
- **Product spec:** intent → decompose preview → create → the committed
  roadmap renders on the board as the product's first flow.
- **Auth:** in production, requests carry the operator bearer; in dev the page
  works tokenless.
- **A11y:** stage regions labelled; state conveyed without colour alone;
  keyboard traversal across the board.
- **Regression:** existing `/factory/*` route responses unchanged by event
  emission; API server suite and dashboard suite stay green.

## Recorded decisions (2026-09-14) & open questions

Decisions taken in review:

1. **Dispatch mode** — explicit Run dispatch by default, with an opt-in
   auto-dispatch toggle.
2. **Board time window** — all non-terminal + recently completed orders, with
   a run filter.
3. **Trends source of truth** — coarse `/metrics` snapshot history plus the
   live dashboard point; "Take snapshot" offered when history is sparse.
4. **Eval scope** — A/B eval is an operator feature in the control room.
5. **Portfolio badge** — any product with a critical signal escalates the
   badge.
6. **Roadmap authority** — decompose-seeded at launch (RFC 0006 §4
   `POST /factory/products/:id/decompose`), free-form edits afterward.
7. **Arbitration affordance** — actionable: change-priority / pull-due-date
   actions on held orders that re-arbitrate immediately.

Still open:

1. **Auto-dispatch triggers** — which events (`order_completed`,
   `claim_released`, `pool_changed`) or a fixed cadence drive the optional
   auto-dispatch loop?
2. **Run-filter semantics** — after a new pipeline run, how long do older
   runs' orders linger on the board before dropping off?

## Non-goals

- No backend changes at all — this RFC is a **surface**; the fab model, lane
  pool, multi-product dispatcher, and event stream are RFC 0006. The only new
  runtime code here is in the dashboard.
- No per-work-order mutation buttons for humans — those remain agent actions via
  MCP.
- No central control that overrides the dispatcher — the control room changes
  *policy* (WIP, caps, admission), and the scheduler re-plans.
- No new visual language — the control room uses the existing design tokens and
  `ui/` primitives.
- No canvas/WebGL DAG editor — the flow board is DOM, accessible, and cheap.
- No replacement of the session/lane surfaces — the control room links out to
  them for drill-in.
