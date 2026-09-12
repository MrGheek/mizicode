# RFC 0003 — MIZI Code Factory: Continuous, Capacity-Bounded, Telemetry-Driven Product Assembly

| | |
|---|---|
| **Status** | Draft for review |
| **Author** | MIZI Intelligence Layer |
| **Created** | 2026-09-08 |
| **Area** | Multi-product orchestration, capacity planning, continuous delivery, factory telemetry |
| **Depends on** | RFC 0001 (token budget, ledger, tripwires), RFC 0002 (lane collaboration, merge guarantee) |

## Summary

Lift MIZI from a **highly parallel session** to a **code factory**: a
continuous, multi-product assembly system where work orders flow through
capacity-bounded stations, every deliverable meets a standardized contract, and
management runs on telemetry (throughput, cycle time, defect rate, rework rate)
rather than intuition.

RFC 0002 made the **merge path the guarantee** for parallel lanes. RFC 0003
adds the layer *above* sessions that a factory needs: a `factory` abstraction
(products, work orders, stations, WIP limits, capacity scheduling), a
standardized **deliverable contract**, a **rework loop** with per-station
defect telemetry, a **continuous pipeline** from merge queue to ship, and
**multi-tenant isolation** across products.

The factory does not replace sessions or lanes — it **orchestrates them**.
Sessions become stations; lanes become workstations; the RFC 0002 merge queue
becomes the assembly line; the RFC 0001 ledger becomes the cost/telemetry
backbone.

## Motivation

MIZI today is session-bounded and batch-oriented:

- **One session = one repo = one goal.** There is no notion of a *product*
  (a repo with a roadmap) or a *work order* (a goal decomposed into tasks)
  that outlives a single session. A factory is continuous and multi-product.
- **No capacity planning.** Nothing decides *how many* lanes a product should
  run, *when* to spawn them, or *when to hold* — so parallelism is either
  under-utilized (idle stations) or over-subscribed (contention, token
  overspend, merge pileups).
- **No WIP limits.** Lanes spawn without bound; queue theory (Little's law)
  says unbounded WIP destroys cycle time and defect rate. The RFC 0002 merge
  queue has no admission control.
- **No deliverable contract.** A lane delivers "a branch." A factory needs a
  spec: what a lane must produce (diff + tests + intent + verification
  evidence) so the line can inspect it uniformly and reject non-conforming
  work at the station, not at the end.
- **No rework loop.** Defects are resolved once (Arbiter) and forgotten. A
  factory measures defect rate per station and feeds defects back into the
  process — rework is a first-class, tracked, telemetry-bearing flow.
- **No continuous pipeline.** The RFC 0002 test gate is per-session. A
  factory's merge queue must feed a build → test → stage → ship pipeline that
  runs continuously, not per-session.
- **No factory telemetry.** Management runs on throughput, cycle time, defect
  rate, rework rate, station utilization. MIZI has per-call cost accounting
  (RFC 0001) but no *process* metrics.

The industrial model is the right lens: you don't make a factory by making
each worker faster — you make it by bounding WIP, standardizing parts,
measuring defects per station, and running a continuous line.

## Existing assets (what MIZI already has)

- **Sessions as stations**: `sessionsTable` (repo fingerprint, GitHub token),
  `sessionRepoContextTable` (indexed graph), `gpuProfilesTable`,
  `templatesTable`, `provisioning.ts` (Fly/Vast.ai capacity).
- **Lanes as workstations**: RFC 0002's full lane/claim/handoff/merge model.
- **Plan board as work orders**: `project-plan.ts`, `plan.ts`,
  `plan-decompose.ts` (task decomposition), `plan-auto-advance.ts`.
- **Heavy-job scheduling**: `scheduler.ts`, `lane_heavy_jobs` (indexing,
  embedding, eval, blast_radius, compile) — the seed of a capacity scheduler.
- **Team bootstrap**: `orchestrate.ts` (decompose → spawn lanes → pre-register
  claims) — the seed of a work-order dispatcher.
- **Language tasks**: `mizi-language-tasks` (13 per-workspace test/lint/
  typecheck/build) — the deliverable contract's verification source.
- **RFC 0001 machinery**: universal ledger, tripwires, reserve-based
  auto-degrade, savings attribution — the telemetry backbone.
- **RFC 0002 machinery**: merge queue, test gate, Arbiter, intent events,
  governance, eval harness — the assembly line and QC.

## Design

### Layer 1 — FACTORY: products, work orders, stations

**1. Product registry.** A `products` table: repo URL, roadmap (ordered work
orders), active stations, WIP limit, quality gate config, pipeline config.
A product outlives any single session. Sessions attach to a product; a product
can have many sessions over time.

**2. Work orders.** A `work_orders` table: goal, decomposed tasks (from the
plan board), priority, dependencies (DAG), acceptance criteria, assigned
station, status. A work order is the unit of factory work — it flows through
stations, not through sessions.

**3. Stations.** A session becomes a *station* with a role (build, review,
debug, refactor, explore, team) and a capacity (max concurrent lanes). The
factory dispatches work orders to stations; stations run lanes (RFC 0002) to
execute them.

### Layer 2 — CAPACITY: WIP limits and scheduling

**4. WIP limits (Little's law).** Each product and each station has a WIP
limit. The dispatcher holds work orders when WIP is saturated instead of
spawning unbounded lanes. This is the single highest-leverage factory control:
bounded WIP → predictable cycle time → lower defect rate.

**5. Capacity scheduler.** Extend `scheduler.ts`/`lane_heavy_jobs` into a
factory dispatcher: given a product's WIP limit, station capacities, work-order
priorities, and dependency DAG, decide *what to spawn, when, and what to hold*.
Scheduling is topological (Kahn's algorithm over the work-order DAG) and
cost-aware (RFC 0001 reserve levels gate how many lanes a product may run).

**6. Admission control on the merge queue.** The RFC 0002 merge queue gains
admission control: a lane's merge is admitted only when the product's WIP and
the station's capacity allow it. Prevents merge pileups.

### Layer 3 — CONTRACT: standardized deliverables

**7. Deliverable contract.** A lane's output must satisfy a schema before it
can merge: diff, tests run + results, intent events (RFC 0002), verification
evidence, and a clean worktree. Non-conforming work is rejected at the station
and routed to rework — never merged.

**8. Per-station quality gates.** Each station role has a gate (build station
requires compile+test; review station requires lint+typecheck). Gates reuse
`mizi-language-tasks` and RFC 0002's test-gate machinery.

### Layer 4 — REWORK: defect loop with telemetry

**9. Rework loop.** A rejected deliverable (test failure, Arbiter rejection,
gate failure) becomes a rework work order with the defect attached. Rework is
tracked: which station produced it, what defect class, how many cycles to
clear. Defect rate per station is a first-class metric.

**10. Defect telemetry.** Per-station and per-product: defect rate, rework
rate, mean cycles-to-clear, defect classes. Fed back into capacity scheduling
(a high-defect station gets lower WIP) and into the RFC 0002 eval harness.

### Layer 5 — PIPELINE: continuous delivery

**11. Continuous pipeline.** The RFC 0002 merge queue feeds a build → test →
stage → ship pipeline that runs continuously per product (not per session).
Staged artifacts are the product's shippable state; ship is gated on the
product's quality gate config.

**12. Multi-tenant isolation.** Products are isolated: per-product WIP,
per-product pipeline, per-product telemetry, per-product resource budgets
(RFC 0001 tripwires scoped per product). Cross-product resource arbitration is
explicit (a shared GPU pool with per-product caps).

### Layer 6 — TELEMETRY: the factory dashboard

**13. Factory metrics.** Throughput (work orders completed/period), cycle time
(work order → merged), defect rate, rework rate, station utilization, WIP
occupancy, cost per work order (RFC 0001 ledger). Exposed via the existing
metrics/status-bar surface and a factory dashboard.

**14. Factory eval.** Extend RFC 0002's eval harness to factory scale:
multi-product, multi-station A/B on throughput, cycle time, defect rate, and
cost. The factory must not regress single-product correctness.

## File / module changes

| Area | Change |
|---|---|
| `services/factory.ts` (new) | Product registry + work-order lifecycle + station registry |
| `services/factory-dispatcher.ts` (new) | WIP-bounded, topological, defect-adjusted capacity scheduling |
| `services/factory-admission.ts` (new) | Merge-queue admission control (WIP + station capacity) |
| `services/deliverable-contract.ts` (new) | Deliverable schema validation + per-station quality gates |
| `services/rework-loop.ts` (new) | Defect → rework work order → re-verify → telemetry |
| `services/factory-pipeline.ts` (new) | Continuous build → test → stage → ship per product; quality-gate-config driven ship gate |
| `services/factory-telemetry.ts` (new) | Throughput/cycle-time/defect/rework/utilization/cost metrics (cost wired to RFC 0001 ledger) |
| `services/factory-resource-pool.ts` (new) | Shared GPU pool with per-product caps (advisory, no central scheduler) |
| `services/factory-eval.ts` (new) | Factory-scale eval harness (multi-product A/B) + deterministic virtual-clock simulator |
| `routes/factory.ts` (new) | Product, work-order, station, pipeline, telemetry, resource-pool, eval endpoints |
| `mcp/tools/factory.ts` (new) | `create_product`, `dispatch_work_order`, `admit_merge`, `rework`, `factory_status` tools |
| `routes/coordination.ts` | Merge-queue admission control (WIP/capacity) |
| `lib/db/src/schema/factory.ts` (new) | `products`, `work_orders`, `stations`, `rework_items`, `pipeline_runs`, `factory_metrics` tables |

## Phasing

### Phase 1 — Factory skeleton + WIP
- `factory.ts` product/work-order/station registry + `factory-dispatcher.ts`
  WIP-bounded, topological scheduling.
- Merge-queue admission control (RFC 0002 hook).

### Phase 2 — Deliverable contract + rework
- `deliverable-contract.ts` schema + per-station gates.
- `rework-loop.ts` defect → rework → re-verify → telemetry.

### Phase 3 — Continuous pipeline + telemetry
- `factory-pipeline.ts` build → test → stage → ship per product.
- `factory-telemetry.ts` + factory dashboard + metrics surface.

### Phase 4 — Factory eval + multi-tenant arbitration
- Factory-scale eval harness (multi-product A/B).
- Cross-product resource arbitration (shared GPU pool with per-product caps).

## Test plan

- **WIP limits**: saturated WIP holds work orders instead of spawning lanes;
  cycle time stays bounded under load (Little's law sanity check).
- **Scheduling**: topological dispatch over the work-order DAG; cost-aware
  (RFC 0001 reserve levels gate lane count); no deadlock on dependency cycles.
- **Admission control**: merge admitted only when product WIP + station
  capacity allow; no merge pileups.
- **Deliverable contract**: non-conforming work rejected at the station and
  routed to rework, never merged; per-station gates enforced.
- **Rework loop**: defect → rework work order → re-verify → telemetry; defect
  rate per station tracked; high-defect stations get lower WIP.
- **Pipeline**: merge queue → build → test → stage → ship runs continuously;
  ship gated on product quality config.
- **Isolation**: per-product WIP/pipeline/telemetry/budgets; cross-product
  arbitration respects per-product caps.
- **Telemetry**: throughput, cycle time, defect rate, rework rate, station
  utilization, cost per work order reported.
- **Eval**: factory scale does not regress single-product correctness.

## Open questions

1. **Product identity.** Is a product = repo URL, or repo + roadmap branch, or
   a higher-level grouping? (Sessions already key on repo fingerprint.)
2. **WIP limit defaults.** Per-product and per-station defaults — start from
   Little's law targets (cycle time = WIP / throughput) tuned on MIZI's repos.
3. **Station capacity model.** Is a station's capacity = max concurrent lanes,
   or a token/GPU budget (RFC 0001 reserve levels)? Probably both.
4. **Pipeline target.** Where does "ship" land — GitHub release, branch, PR,
   or a staging artifact? (RFC 0002 already auto-opens PRs on safe_to_merge.)
5. **Rework ownership.** Does a defect return to the same station, or get
   re-dispatched to the cheapest capable station?
6. **Telemetry storage.** In-memory (like the ledger) vs a `factory_metrics`
   table vs Prometheus (mizi-metrics-contributor already exists).

## Non-goals

- No replacement of sessions/lanes — the factory orchestrates them.
- No new VCS or CI system — git + the RFC 0002 merge path remain; the pipeline
  is an orchestration of existing test/build tasks.
- No unbounded parallelism — WIP limits are the point.
- No central scheduler as a single point of failure — the dispatcher is
  advisory; stations keep working when it is down.
- No vendoring of external factory/orchestration source (mechanisms
  re-implemented against MIZI's session/lane model).
