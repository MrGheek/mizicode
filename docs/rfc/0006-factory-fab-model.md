# RFC 0006 — Factory Fab Model & Multi-Product Arbitration: Shared Lane Pool, Priority Dispatch, Live Events

| | |
|---|---|
| **Status** | Draft for review |
| **Author** | MIZI Intelligence Layer |
| **Created** | 2026-09-14 |
| **Area** | Factory backend — data model, resource arbitration, product specification, real-time events |
| **Depends on** | RFC 0001 (ledger, tripwires, cost), RFC 0002 (lane collaboration; `lane_claims` as the claim/release precedent), RFC 0003 (code factory: products, work orders, stations, pipeline, telemetry) |

## Summary

RFC 0003 built the factory as a **single assembly line**: one product, one
WIP-bounded dispatcher, stations permanently bound to a session
(`stations.sessionId` set at creation; `work_orders.sessionId` copied at
dispatch), and arbitration only over an in-memory GPU-unit pool
(`MemoryResourcePool`). It answers "one product, many lanes" but not **"one
factory, many products under the same roof."**

This RFC generalizes the factory into a **fab** — a tenant that owns products,
a shared lane pool, a budget, and default policies — and specifies its
backend, leaving the operator surface to RFC 0005. Concretely:

1. **Fab data model.** A `factories` table (the fab: name, lane-pool limit,
   budget, default policies). `products` gain `factoryId`, `priority`
   (P0/P1/P2), and an optional `dueDate` (SLA).
2. **Shared lane pool with claim/release.** Sessions (boxes) become the pool's
   units. Stations become role *definitions*; an executing station **claims**
   one session from the shared pool at dispatch, runs up to `capacity` orders
   inside it as swarm lanes, and **releases** it when idle — replacing the
   permanent station→session lease.
3. **Multi-product dispatcher.** One arbitration pass across all products in
   the fab scores ready work orders
   (`dispatchScore = productWeight · orderWeight · dueDatePressure ·
   budgetWeight`), dispatches greedily in score order against the shared pool,
   and returns a per-order **arbitration readout** ("why B got lanes over A").
4. **Product specification + roadmap seeding.** A new product is specified
   from intent (name, repo, priority, WIP, budget) which the backend
   decomposes into a roadmap — work starts from a spec, not an empty board.
5. **Backend event surface.** A `factory-event-emitter` broadcasts
   `factory_event`s over `GET /factory/products/:id/stream`, which RFC 0005's
   control room consumes. Dispatch/arbitration/pipeline mutations emit, so the
   board is live without polling.

The onboarding model (decision recorded here): **start with one product
running multiple lanes** — a pilot line seeded from a product spec — then add
products incrementally over the same pool. Products are never pre-provisioned
in bulk; each new product is a spec-first launch.

## Motivation

### The gap

Today the factory is single-line in four ways:

- **One dispatcher per product.** `dispatchWorkOrders(store, productId)` in
  `factory-dispatcher.ts` schedules one product's ready orders. There is no
  ordering *across* products, so two products competing for the same sessions
  have no arbitration — the winner is whichever calls dispatch first.
- **Permanent leases.** `stations.sessionId` is bound once at station
  creation and never returned. Capacity granted to a product is held forever,
  so a quiet product parks a session a busy product could use. `work_orders`
  inherit the lease via `sessionId = station.sessionId`.
- **No product-level escalation.** Products have no priority, no due dates,
  and `roadmapJson` is a hand-maintained array of work-order ids with no
  generation path from a product intent.
- **No live events.** Factory state changes happen in services, but nothing
  broadcasts them; a control room would poll.

### Why a "fab", not just more tables

A factory that only ever ran one product would not need this RFC. But the
moment a second product exists, three things become true at once: products
compete for the same sessions (money), products need an order of precedence
(priority/SLA), and the operator needs to see *why* one product's work moved
while another's sat (accountability). That is not an admin feature; it is the
difference between "a product" and "a code fab."

The reference behavior is the best product-onboarding playbooks from code
factories: stand up **one line**, seed it from a real intent, measure it, then
fork out more products as capacity allows — never a cold start of a whole
product tree. RFC 0006 makes the backend support exactly that:
one pilot product by default, and priority arbitration the only way new
products intrude on the pool.

### Design constraints carried from RFC 0003

- **Advisory, no single point of failure.** The dispatcher and the pool are
  advisory (RFC 0003 non-goal). Stations keep working when arbitration is
  down. Claim/release is enforced at the *factory* boundary, not by blocking
  agent mutations.
- **Hands off the per-order lifecycle contract.** `dispatch`, `complete`,
  `rejectToRework`, `advancePipeline` semantics are unchanged; this RFC layers
  pool claims and arbitration *around* them additively.

## Design

### 1. Fab data model

New `factories` table — the tenant owning products and the pool:

```ts
export const factoriesTable = pgTable("factories", {
  id: serial("id").primaryKey(),
  /** Product-running environment: the fab's display name. */
  name: text("name").notNull(),
  /** Max concurrently claimed sessions across ALL products in the fab. */
  lanePoolLimit: integer("lane_pool_limit").notNull().default(8),
  /** Per-period spend budget (connected to the RFC 0001 ledger; null = untracked). */
  budgetUsd: real("budget_usd"),
  /** Fab-level defaults applied at product creation (WIP, station roles, gates). */
  defaultPolicyJson: jsonb("default_policy_json").$type<{
    defaultWipLimit: number;
    defaultStationRoles: string[];
    defaultQualityGateConfig: object | null;
    lanePool: { idleReleaseAfterMs: number; claimLapseAfterMs: number };
  }>().notNull().default({
    defaultWipLimit: 4,
    defaultStationRoles: ["build", "review"],
    defaultQualityGateConfig: null,
    lanePool: { idleReleaseAfterMs: 300000, claimLapseAfterMs: 900000 },
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```

`products` additions:

```ts
/** Migrations to add to productsTable (RFC 0006 Phase 1). */
factoryId: integer("factory_id")
  .references(() => factoriesTable.id, { onDelete: "restrict" }),
productPriority: text("product_priority")
  .notNull().default("p2").$type<ProductPriority>(),   // "p0" | "p1" | "p2"
dueDate: timestamp("due_date"),                        // SLA; null = none
```

`ProductPriority = "p0" | "p1" | "p2"` (distinct from the per-order
`WorkOrderPriority`). Product priority is the product's standing intent;
work-order priority is within-product urgency; both feed the dispatch score
(§3).

**Migration strategy (Phase 1).** `lib/db/migrations/0037_factory_fab.sql`:

1. Create `factories`, `station_claims` (see §2).
2. `ALTER TABLE products` add `factory_id`, `product_priority`, `due_date`.
3. Backfill: insert a default fab (`Mizi Fab`, `lane_pool_limit = 8`); set
   every existing `products.factory_id` to it; default `product_priority` to
   `p2` for legacy products.
4. `NOT NULL` on `factory_id` after the backfill (repeat the existing
   products→factories FK with `onDelete: "restrict"` — the fab outlives its
   products).

Design radical? No: this is the same "singleton resource pool becomes a row"
step RFC 0003's `MemoryResourcePool` (totalUnits 8 / defaultProductCap 4)
already implies. The fab is that pool made durable and scoped.

### 2. Shared lane pool — sessions with claim/release

**The lane pool is the set of eligible sessions.** A session is the execution
unit (it *is* the box: profile, provider, cost, team, task mode — RFC 0003's
`stations.sessionId` points at exactly this). Today ownership is permanent.
New model: participation is a **claim**, exactly mirroring RFC 0002's
`lane_claimsTable` (active partial unique index, expiry, heartbeat).

```ts
export const stationClaimsTable = pgTable("station_claims", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => productsTable.id, { onDelete: "cascade" }),
  stationId: integer("station_id").notNull().references(() => stationsTable.id, { onDelete: "cascade" }),
  /** The session (box) claimed from the pool to back this station's work. */
  sessionId: integer("session_id").notNull().references(() => sessionsTable.id, { onDelete: "cascade" }),
  /** Current order on the claim — audit only; null while the claim sits idle.
   *  Orders ride the claim via `work_orders.sessionId` (one claim → many orders). */
  workOrderId: integer("work_order_id").references(() => workOrdersTable.id, { onDelete: "set null" }),
  claimedAt: timestamp("claimed_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at").notNull().defaultNow(),
  releasedAt: timestamp("released_at"),
  active: boolean("active").notNull().default(true),
}, (table) => [
  uniqueIndex("station_claims_active_session_unique_idx")
    .on(table.sessionId)
    .where(sql`${table.active} = true`),   // a session (box) can back one station at a time
]);
```

**Semantics.**

- **Claim** — the multi-product dispatcher (§3), about to dispatch a work
  order to a station, asks the pool for a session. A session is claimable
  when (a) its `sessions.status` indicates a runnable environment — any
  non-stopped session (per-status refinement is a follow-up, not a gate),
  (b) no active `station_claims` row holds it, and (c) the fab's
  `lanePoolLimit` has headroom. Grant sets `work_orders.sessionId` and writes
  the claim. A session backs **one station at a time** (the active partial
  unique index).
- **Fan-out inside the claim.** A claimed session runs up to `capacity`
  concurrent work orders as swarm lanes, reusing the RFC 0002 team/lane
  machinery already on sessions (`teamMembers`, `swarmSnapshotJson`, lanes).
  Claims are session-scoped; orders ride them via `work_orders.sessionId`.
  `workOrderId` on the claim is the *current* order for audit.
- **Release / idle return.** On `completeWorkOrder` (done/skip) or
  `rejectToRework` (defect → back to queued): if that was the session's last
  in-flight order, the claim is released. **Idle return is the load-bearing
  rule, not completion**: a claim whose session has zero in-flight orders for
  longer than `idleReleaseAfterMs` (default 5 min) is auto-released, so a
  product never parks a box between priorities.
- **Heartbeat + lapse (factory-specific policy — decision).** A station must
  heartbeat the claim; without one for `claimLapseAfterMs` (default 15 min)
  the claim lapses and the box is re-claimable, independent of order status —
  how a crashed station's box is reclaimed rather than parked. Orders with a
  large expected cycle time may request a longer lapse (up to a configured
  ceiling) so a long build is not reaped mid-run. These timers live on
  `factories.defaultPolicyJson.lanePool` — RFC 0002's lane-claim expiry is the
  pattern's ancestor, not a mechanism this RFC adopts verbatim.

**Station semantics change.** `stations.sessionId` is dropped from the
"ownership" reading: stations remain **role definitions** (role, base
capacity, WIP, defect telemetry) scoped to a product. Executing sessions
change per dispatch; RFC 0003's `capacity` (default 2) is now *max concurrent
orders the claimed session may run as fan-out lanes*.

`services/factory-lane-pool.ts` (new) is the pure pool: `claim(session)`,
`release(session)`, `listClaims(productId)`, `poolStatus()`
(`{ lanePoolUsed, lanePoolLimit, freeLanes }`). It reads/writes
`station_claims` and `sessions` directly and is advisory — a missing pool does
not stop dispatching (station falls back to its last-known session, RFC 0003
non-goal preserved).

### 3. Multi-product dispatcher

`services/factory-arbitration.ts` (new) runs a fab-wide pass.

**Ready set.** Across all products in the fab: orders with
`status = queued` whose dependencies are done/skipped (the existing
`readyWorkOrders` logic in `factory-dispatcher.ts`, reused per product).

**Dispatch score.** For each ready order:

```ts
type ArbitrationFactors = {
  productWeight: number;     // P0=1.0, P1=0.6, P2=0.3   (from product.productPriority)
  orderWeight: number;       // high=1.0, normal=0.6, low=0.3 (from order.priority)
  dueDatePressure: number;   // no dueDate → 1; slack >= 2 → 0.5; slack >= 0 → 1.0; overdue → 1.5
  budgetWeight: number;      // 0.25 + 0.75·clamp(remainingBudget/budgetHighWater, 0, 1); no budget → 1
};

dispatchScore = productWeight · orderWeight · dueDatePressure · budgetWeight;
```

Where `slack = (dueDate − now) / expectedCycleTime` (product's rolling
`avgCycleTimeMs`, or a default of 1 h when unavailable), and budget reads from
the RFC 0001 ledger as a **rolling 30-day per-product cap** (`budgetUsd` ×
spend in the window; untracked → factor 1).

**Greedy descent.** Sort ready orders by `dispatchScore` desc (tie-break:
`createdAt`, then `id`). For each order, in order:

1. Product WIP headroom? (RFC 0003 gate — unchanged.)
2. Pool grant? (§2 factory-lane-pool, honors `lanePoolLimit`. A product may
   hold more orders than the pool has free sessions — the pool is the binding
   constraint across products; product WIP is the per-product bound.)
3. Station headroom? (least-loaded station with defect-adjusted effective WIP,
   RFC 0003 gate — unchanged.)
4. Budget? (if `budgetWeight < 1` and the product is out of budget → held.)

Pass `N` orders, then **release nothing** (that is lifecycle's job) and return
a `DispatchResult` extended with arbitration lines.

**Arbitration readout** — the accountability answer to "why B, not A":

```ts
type ArbitrationLine = {
  workOrderId: number;
  productId: number;
  productPriority: ProductPriority;
  orderPriority: WorkOrderPriority;
  dueDate: string | null;
  dispatchScore: number;
  factors: ArbitrationFactors;
  outcome: "dispatched" | "held";
  reason: string | null;   // product WIP saturated / pool saturated /
                           // outranked by higher dispatchScore / budget exhausted / no station headroom
  lostTo: Array<{ workOrderId: number; dispatchScore: number; productId: number }>;
};

type ArbitrationPass = {
  passId: number;
  ranAt: string;
  lines: ArbitrationLine[];
};
```

`lostTo` lists exactly which orders beat a held order (only for
`outranked`), so the readout is self-explaining. Exposed via
`GET /factory/arbitration/latest` (fab-wide, most recent pass) and
`GET /factory/products/:id/arbitration` (per product) — consumed by RFC 0005's
arbitration panel.

**Emit.** After the pass: a `factory_event` of type `arbitration_recomputed`
carrying `{ passId, dispatched, held }` (§5).

Per-product `dispatchWorkOrders` keeps working (unaffected); the fab pass
becomes the recommended entry point, invoked by
`POST /factory/dispatch` (dispatch all products) or per-product
`POST /factory/products/:id/dispatch` (dispatches that product under the fab
pool).

### 4. Product specification + roadmap seeding

A product is born from a specification, not from an empty board. Backend:

- **`POST /factory/products`** — extended create: accepts `name`, `repoUrl`,
  `wipLimit`, `qualityGateConfig`, `pipelineConfig`, plus `factoryId`
  (default: the fab), `priority` (P0/P1/P2), `dueDate`, `budgetUsd` (period
  budget wired to the ledger), and optional `intent`.
- **`POST /factory/products/:id/decompose`** — decompose a free-text intent
  (or `repoUrl` scan) into an ordered `roadmapJson` via the existing plan
  decomposition path (`/plan/generate` family): returns proposed roadmap as a
  preview that the caller commits (`roadmapJson`), or commits directly with
  `?commit=true`. The pilot line is: *product spec → intent → decompose →
  roadmap → first dispatch*. The wizard UI is RFC 0005; this is the endpoint
  it calls.

No new spec-of-record table in Phase 1 — products carry the spec fields
(decision); a first-class product-spec record (description, acceptance goals,
owner) is Phase 3.

### 5. Backend event surface

Mirror the coordination broadcaster (`lane-sse-broadcaster.ts`) at factory
scale:

- `services/factory-event-emitter.ts` (new): client registry keyed by
  `productId`; `addFactoryClient` / `removeFactoryClient` /
  `broadcastFactoryEvent`; a fab-wide channel for portfolio-level events.
- `GET /factory/products/:id/stream` (new route in `routes/factory.ts`): SSE,
  `event: ping` heartbeats, register-on-open, cleanup-on-close (same shape as
  `GET /sessions/:id/coordination/stream`).
- Emit points (additive; no response-shape changes): after
  `dispatchWorkOrders` / `rejectToRework` / `completeWorkOrder` /
  `submitDeliverable` / `advancePipeline` and after each arbitration pass.

```ts
type FactoryEvent =
  | { type: "order_dispatched"; workOrderId: number; stationId: number; sessionId: number }
  | { type: "order_completed"; workOrderId: number; status: "done" | "skipped" }
  | { type: "defect_recorded"; workOrderId: number; stationId: number; defectClass: string; cycle: number }
  | { type: "stage_advanced"; pipelineRunId: number; stage: PipelineStage; status: PipelineStatus }
  | { type: "wip_changed"; productWip: { used: number; limit: number } }
  | { type: "pool_changed"; lanePool: { lanePoolUsed: number; lanePoolLimit: number; freeLanes: number } }
  | { type: "arbitration_recomputed"; passId: number; dispatched: number; held: number }
  | { type: "claim_released"; workOrderId: number; sessionId: number };
```

Events carry payloads only (no auth material); the route applies the same
`requireAgentAuth(["coordination:read"])` guard as the rest of `/factory/*`.

## File / module changes (backend)

| Area | Change |
|---|---|
| `lib/db/src/schema/factory.ts` | Add `factoriesTable`, `stationClaimsTable`, `ProductPriority`, `products.factoryId` / `productPriority` / `dueDate` |
| `lib/db/migrations/0037_factory_fab.sql` (new) | Fab, product columns, station_claims, default-fab backfill, partial unique index |
| `artifacts/api-server/src/services/factory-lane-pool.ts` (new) | Pure claim/release pool over sessions + `station_claims` |
| `artifacts/api-server/src/services/factory-arbitration.ts` (new) | Fab-wide ready set, dispatch-score, arbitration readout |
| `artifacts/api-server/src/services/factory-dispatcher.ts` | Add `dispatchScore`-aware ordering hooks; keep per-product signature stable |
| `artifacts/api-server/src/services/factory-event-emitter.ts` (new) | Factory SSE client registry + broadcast |
| `artifacts/api-server/src/services/factory.ts` | Store methods for claims + parse `products.productPriority` |
| `artifacts/api-server/src/routes/factory.ts` | Extended `POST /factory/products`; `POST /factory/products/:id/decompose`; `GET /factory/arbitration/latest`; per-product arbitration; `GET /factory/products/:id/stream`; emit hooks; `POST /factory/dispatch` |
| `lib/api-spec/openapi.yaml` | (Optional, Phase 3) promote factory routes for codegen |

## Phasing

### Phase 1 — The Pool, made durable (P0)
- `factories` + product columns + `station_claims`; migration + default-fab
  backfill; legacy `stations.sessionId` backfilled as active claims.
- `factory-lane-pool` claim/release; dispatcher claims a session at dispatch,
  releases on completion/rework or idle timeout.
- `factory-event-emitter` + `/stream`; emit dispatch/complete/rework/claim.

### Phase 2 — The Arbitrator (P1)
- Fab-wide `POST /factory/dispatch` with dispatch-score ordering + arbitration
  readout (incl. `lostTo`).
- `budgetWeight` wired to RFC 0001 ledger; leading budget-exhaustion hold.
- `POST /factory/products/:id/decompose`; extended product create (priority,
  dueDate, budget, intent).

### Phase 3 — Depth (P2)
- Per-product lane caps within the pool (default: pure arbitration).
- Due-date SLA policies (auto-escalate from P2 → P1 near `dueDate`).
- Fab summary endpoint (pool occupancy, budget, product WIP share) for the
  portfolio surface.
- Optional: promote factory routes into `openapi.yaml`.

## Test plan

- **Migration:** backfill creates the default fab; every legacy product gets
  `factory_id`; legacy stations-with-sessions become active claims; the
  partial unique index rejects a second active claim on one session.
- **Claim lifecycle:** dispatch claims an eligible session (sets
  `work_orders.sessionId`); a second order for the same station rides the same
  claim (fan-out) up to `capacity`; completion/rework of the last in-flight
  order — or the `idleReleaseAfterMs` timer — releases the claim; a released
  session is claimable by another product's station next pass.
- **Pool bound:** with `lanePoolLimit = 1`, two products' orders serialize —
  the second dispatches only after the first releases; `pool_changed` fires.
- **Arbitration ordering:** a P0 product's normal order beats a P2 product's
  high order; an overdue order outranks a distant-due-date order by the same
  product; `lostTo` lists the winner(s) of a held "outranked" order.
- **Budget:** a product at/over budget holds orders with "budget exhausted"
  before WIP checks; budgetWeight factor appears in the readout.
- **Advisory fallback:** with the pool/arbitration layer down, per-product
  `dispatchWorkOrders` still dispatches (RFC 0003 non-goal preserved).
- **Events:** each mutation emits one event of the right type with no change
  to the existing route response shape (regression: full factory route suite).
- **Integration:** decompose(intent) → roadmapJson → dispatch round-trips for
  a brand-new product (the pilot line).

## Recorded decisions (2026-09-14) & open questions

Decisions taken in review:

1. **Pool eligibility** — any runnable, unclaimed session (non-stopped status,
   not held by an active claim); per-status refinement is a follow-up, not a
   gate.
2. **Claim lifecycle** — factory-specific policy: idle auto-release
   (`idleReleaseAfterMs`), heartbeat lapse (`claimLapseAfterMs`), long-claim
   override for large orders (§2). RFC 0002 lane-claim timers are an ancestor
   pattern, not adopted verbatim.
3. **Per-product share** — pure priority arbitration; per-product lane caps
   are an optional Phase 3 affordance, not the default.
4. **Budget period** — rolling 30-day per-product cap from the RFC 0001
   ledger.
5. **Product spec depth** — spec fields on `products` now; first-class spec
   record deferred to Phase 3.
6. **Station↔session mapping** — swarm sessions with fan-out lanes: the pool
   arbitrates boxes (expensive), order parallelism is lanes inside a claimed
   box (cheap); `capacity` = concurrent orders per claim. 1:1 claims were
   rejected because they make parallelism cost boxes — the wrong scarce
   resource for a GPU-accounted factory.

Still open:

1. **Score-weight tuning** — `productWeight` (P0=1.0 / P1=0.6 / P2=0.3) and
   the `dueDatePressure` thresholds are starting defaults; validate against
   real workloads and expose overrides in `defaultPolicyJson`.
2. **Lifecycle durations** — `idleReleaseAfterMs` (5 min) and
   `claimLapseAfterMs` (15 min) are initial; confirm against swarm session
   heartbeat rates.
3. **Preemption** — may a higher-priority product's dispatch *steal* a
   lapsed-but-still-heartbeating session (abort + release), or must it wait
   for lapse? Proposal: no preemption in Phase 1.

## Non-goals

- **No per-product leased stations.** The shared pool with claim/release is
  the model; a product never permanently owns a session.
- **No QoS guarantees / no SPOF.** Arbitration and the pool are advisory (RFC
  0003 non-goal); stations keep working when they are down.
- **No session lifecycle control.** The pool claims *existing* sessions; it
  does not create, resize, or kill them — provisioning stays with the
  session/swarm system.
- **No change to the GPU-unit pool (`MemoryResourcePool`).** That stays
  in-memory and advisory; the *lane* pool is what becomes durable. Persisting
  GPU-unit reservations is a separate effort.
- **No sales/CRM.** Product "owner", health scores for humans, and billing
  workflows are out of scope.
- **No change to RFC 0005's per-work-order contract.** This RFC is backend —
  it defines what the RFC 0005 control room renders, not how it renders it.