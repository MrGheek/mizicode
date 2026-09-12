# RFC 0002 — MIZI Lane Collaboration: Parallel-Isolated, Test-Gated, Intent-Aware Code Development

| | |
|---|---|
| **Status** | Draft for review |
| **Author** | MIZI Intelligence Layer |
| **Created** | 2026-09-08 |
| **Area** | Multi-agent coordination, lane system, merge/integration, safety |
| **Depends on** | RFC 0001 (token budget, ledger, tripwires), existing lane/claim system, `mizi-language-tasks` |

## Summary

Make MIZI's session/lane system the strongest parallel code-development
collaboration layer available by converting its **advisory** coordination
(claims, conflicts, handoffs) into **real guarantees** at the integration path,
and by adding the durable-intent and governance layers that make parallel lanes
safe, efficient, and self-correcting.

The core thesis, validated against the reference implementations in this space
(pact, cooperative-worktree-agents, orchestra): **write-path enforcement of
claims is the wrong place to spend effort — it is advisory by design in every
serious system. The real guarantee lives at the merge path: risk-sequenced,
test-gated, intent-aware integration.** MIZI already has the strongest
*detection* layer (symbol-aware overlap, blast-radius, warn/block, sweeper,
handoffs, PR-on-safe-to-merge). This RFC adds the *guarantee* layer on top of
it, plus the durable intent and governance that make the whole system learn.

## Motivation

MIZI's lane system today detects and reports collisions but never prevents or
recovers from them:

- **Claims are advisory.** A lane can write to a file another lane owns; the
  system only returns a `warn`/`block` recommendation in JSON. Nothing in the
  tool-execution path consults claims before a write lands.
- **No integration guarantee.** When lanes finish, work lands via manual
  handoffs and a fire-and-forget draft PR. There is no risk-sequenced merge
  queue, no test gate, no conflict recovery — so the *only* real guarantee a
  parallel system can offer (safe landing) is missing.
- **No durable intent.** Lanes publish claims but not *why* — no decisions,
  interface/contract changes, warnings, or verification results. Conflict
  resolution therefore has no context to preserve both sides' objectives.
- **No governance.** No per-lane permission profiles, no circuit breakers, no
  post-session reconcile, no takeover protocol. A crashed lane leaves ghost
  claims (swept, but never recovered) and its work is orphaned.
- **No evaluation.** There is no harness to prove the lane system beats
  single-agent development, so improvements are unmeasurable.

The reference implementations converge on the same architecture:

| Idea | pact | cooperative-worktree-agents | orchestra | MIZI today |
|---|---|---|---|---|
| Isolated worktrees per agent | ✅ | ✅ | ✅ | ✅ (lane branches) |
| Advisory claims | ✅ | ✅ (soft claims) | ✅ | ✅ |
| Symbol-aware conflict detection | partial | — | — | ✅ (strongest) |
| Risk-sequenced merge | ✅ | — | ✅ (topo order) | ❌ |
| Test-gated merge | ✅ | ✅ | ✅ | ❌ |
| JSON-aware structural merge | ✅ | — | — | ❌ |
| AI conflict resolution verified by tests | ✅ (Arbiter) | ✅ (intent-aware) | — | ❌ |
| Durable intent ledger | partial | ✅ | ✅ (blackboard) | ❌ |
| Per-role permission profiles | — | — | ✅ | partial (safety.ts) |
| Circuit breakers / runaway detection | — | — | ✅ | partial (tripwires) |
| Reconcile / orphan recovery | — | ✅ | ✅ | partial (sweeper) |
| Takeover protocol | — | ✅ | ✅ | ❌ |
| Eval harness (multi vs single) | — | — | ✅ | ❌ |

## Existing assets (what MIZI already has)

- **Lane model** (`lib/db/src/schema/coordination.ts`): `session_lanes`,
  `lane_claims` (partial unique index on `(lane_id, path_or_symbol) WHERE
  active=true` for race-free upserts), `lane_handoffs`, `lane_events`,
  `lane_heavy_jobs`, `claim_purge_logs`, `custom_lane_types`.
- **REST API** (`routes/coordination.ts`, 1426 lines): lane CRUD, claim
  create/release (transactional `preserveHistory` + atomic upsert), handoffs
  that auto-open a draft PR on `safe_to_merge`, conflicts endpoint, cursor-
  paginated timeline, SSE stream, heavy-jobs queue, admin sweep.
- **Conflict detection** (`services/lane-policy.ts`, 526 lines):
  `computeSymbolAwareClaimOverlap` (distinct functions in the same file don't
  conflict), `estimateBlastRadiusOverlapAnnotated` (edge-level caller→callee
  annotations with symbol gating), warn/block thresholds.
- **Lifecycle** (`services/claim-sweeper.ts`): 30s background sweeper
  hard-deletes ghost claims; soft-expire on read; heartbeat-based expiry.
- **Orchestration** (`routes/orchestrate.ts`): pre-registers `owner`-strength
  claims from `teamMembers[].claimPaths` at bootstrap.
- **MCP tools** (`mcp/tools/lanes.ts`, `repo.ts`, `sessions.ts`):
  `list_lanes`, `create_lane`, `claim_resource`, `lane_handoff`, blast-radius.
- **Language tasks** (`mizi-language-tasks`): 13 per-workspace test/lint/
  typecheck/build tasks — the natural test-gate source.
- **RFC 0001 machinery**: universal ledger, tripwires, reserve-based
  auto-degrade, savings attribution — reusable for lane governance.
- **~2700 lines of lane tests** (`coordination*.test.ts`, `lane-policy*.test.ts`).

## Design

### Layer 1 — INTEGRATE: the merge path is the real guarantee

The single highest-value change. Lanes implement in parallel; landing is
serialized, risk-sequenced, and test-gated.

**1. Lane merge queue.** Extend `lane_handoffs`/`lane_heavy_jobs` into a
first-class merge queue. When a lane signals `safe_to_merge` (or the operator
triggers it), the lane's branch is:
  1. auto-committed (message derived from the lane's task),
  2. merged onto the session integration branch **smallest/lowest-risk first**
     (risk = diff size, touched-file count, blast-radius overlap, lane type),
  3. **skip-not-abort** on conflict — one conflicting lane never blocks the
     rest of the batch,
  4. recorded in the operation log with a resumable `resolve` path.

**2. Test-gated merges.** Every clean merge is gated on the session's test
command (from `mizi-language-tasks`). A failure **undoes just that one merge**
and skips the lane, then continues. Distinct from the Arbiter's test gate
(which verifies a conflict *resolution*, not a clean merge).

**3. JSON-aware structural merge.** Before falling back to a text conflict,
`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, and similar
dependency manifests get a **structural union-merge** of their dependency
blocks (comments/formatting untouched). Verified pattern: four concurrent
agents editing disjoint regions of the same root manifest merged correctly,
13/13 changes landed, zero conflicts.

**4. Arbiter — verified AI conflict resolution.** When a real conflict
survives, a one-shot LLM proposes a resolution **reconstructed from both
lanes' durable intent** (Layer 2), and the proposal is only accepted after the
real test command passes against it in a candidate worktree. A rejection leaves
the lane as a normal skipped conflict, resumable. True requirement conflicts
(one lane removes what another adds) are **escalated to a human**, never
guessed.

### Layer 2 — INTENT: durable context that makes integration smart

**5. Typed intent events.** Extend `lane_events` with typed payloads:
`decision`, `interface_change` (with a `contract` field), `warning` (with a
`risk` field), `verification` (test results). Lanes publish these as they
work; every lane can read every other lane's intent. This is the raw material
for Arbiter's intent-aware resolution and for plan-reassessment's code context.

**6. Conflict-resolution notes.** Every resolved conflict records *how* it was
resolved (preserved-both / chose-one / escalated) and the intent that drove it.
These notes feed the eval harness and future resolution heuristics.

### Layer 3 — GOVERN: operational safety and self-correction

**7. Per-lane permission profiles.** Allow/deny tool lists per lane type
(extending `safety.ts` + `custom_lane_types`), enforced in the MCP tool layer.
A `review` lane cannot run `docker`; a `backend` lane cannot touch
`frontend/**` unless claimed.

**8. Lane circuit breakers.** Per-lane failure counters (3 consecutive
failures trips the breaker), feeding RFC 0001's tripwire/reserve machinery.
A tripped lane auto-degrades (tightens review, deepens terminal filtering,
downgrades model) instead of failing or overspending.

**9. Reconcile pass.** Post-session scan for orphan worktrees, uncommitted
work, ghost claims, and goal-alignment gaps. Extends `claim-sweeper` from
"delete stale rows" to "surface and recover abandoned work."

**10. Takeover protocol.** A lane can adopt another lane's branch, worktree,
events, and claims after **evidence-based lock-break** (the previous lane is
provably dead: no heartbeat, no live process, stale lock). Forced breaks are
recorded as recovery incidents.

### Layer 4 — EVALUATE: prove the system works

**11. Lane-system eval harness.** LLM-as-judge A/B: multi-lane vs single-agent
on the same goal, scoring correctness, merge cleanliness, and wall-clock.
Reuses `skills-evals.ts` scoring. This is the gate that keeps the lane system
honest as it grows.

## File / module changes

| Area | Change |
|---|---|
| `services/lane-merge.ts` (new) | Risk-sequenced merge queue: auto-commit, risk scoring, skip-not-abort, resumable resolve |
| `services/lane-test-gate.ts` (new) | Test-gated merge: run session test command, roll back a single failed merge |
| `services/json-merge.ts` (new) | Structural union-merge for dependency manifests (package.json, Cargo.toml, pyproject.toml, go.mod) |
| `services/lane-arbiter.ts` (new) | LLM conflict resolution reconstructed from intent, verified against the test command |
| `services/lane-intent.ts` (new) | Typed intent events (decision / interface_change / warning / verification) + conflict-resolution notes |
| `services/lane-governor.ts` (new) | Per-lane permission profiles + circuit breakers + reconcile + takeover |
| `routes/coordination.ts` | Merge-queue endpoints; intent-event endpoints; reconcile/takeover endpoints |
| `mcp/tools/lanes.ts` | `merge_lane`, `publish_intent`, `resolve_conflict`, `reconcile`, `takeover` tools |
| `services/lane-policy.ts` | Risk scoring for merge sequencing; permission-profile resolution |
| `services/claim-sweeper.ts` | Reconcile pass (orphan worktrees, uncommitted work, goal-alignment gaps) |
| `services/safety.ts` | Per-lane permission profiles (allow/deny tool lists) |
| `services/skills-evals.ts` | Lane-system eval harness (multi-lane vs single-agent A/B) |
| `lib/db/src/schema/coordination.ts` | `lane_merge_queue`, `lane_conflict_resolutions`, `lane_governance` tables (intent events reuse `lane_events`) |

## Phasing

### Phase 1 — Integration guarantee (highest ROI, self-contained)
- `lane-merge.ts` risk-sequenced merge queue + `lane-test-gate.ts` test-gated
  merges + `json-merge.ts` structural dependency merge.
- Wire `safe_to_merge` handoff → merge queue instead of fire-and-forget PR.
- Resumable `resolve` path for skipped conflicts.

### Phase 2 — Intent-aware resolution
- `lane-intent.ts` typed intent events + conflict-resolution notes.
- `lane-arbiter.ts` intent-reconstructed, test-verified conflict resolution.
- Feed intent events into plan-reassessment code context.

### Phase 3 — Governance
- `lane-governor.ts`: per-lane permission profiles, circuit breakers,
  reconcile pass, takeover protocol.
- Enforce profiles in the MCP tool layer; wire breakers into RFC 0001
  tripwire/reserve machinery.

### Phase 4 — Evaluation
- Lane-system eval harness (multi-lane vs single-agent A/B).
- Enforce a quality gate: lane system must not regress single-agent
  correctness on the eval suite.

## Test plan

- **Merge queue**: risk ordering (small/low-risk first); skip-not-abort on
  conflict; one conflicting lane never blocks the batch; resumable resolve.
- **Test gate**: clean merge gated on the session test command; failure undoes
  exactly one merge and continues; distinct from Arbiter's resolution gate.
- **JSON merge**: disjoint-region edits to the same manifest merge structurally
  with zero conflicts; comments/formatting preserved; non-dependency regions
  still fall back to text conflict.
- **Arbiter**: proposal only accepted when the test command passes against it
  in a candidate worktree; rejection leaves a resumable skipped conflict; true
  requirement conflicts escalate to a human.
- **Intent events**: typed payloads round-trip; every lane can read every other
  lane's intent; conflict-resolution notes recorded.
- **Governance**: permission profiles enforced in the MCP tool layer; circuit
  breaker trips after 3 failures and auto-degrades; reconcile surfaces orphan
  worktrees/uncommitted work; takeover requires evidence-based lock-break.
- **Eval**: multi-lane vs single-agent A/B on correctness, merge cleanliness,
  wall-clock; lane system must not regress single-agent correctness.

## Open questions

1. **Enforcement depth.** Should claims ever hard-block writes (e.g. only for
   `owner`-strength claims on explicitly claimed files), or stay advisory
   forever with the merge path as the sole guarantee? (Reference systems say
   advisory; MIZI's `owner` strength is a candidate exception.)
2. **Test-gate source.** Which `mizi-language-tasks` task is authoritative per
   session, and how is it configured (per-session, per-lane, per-repo)?
3. **Risk scoring weights.** Defaults for merge sequencing (diff size vs
   touched-file count vs blast-radius overlap vs lane type) — tune on MIZI's
   own repos.
4. **Cross-session awareness.** `lane_claims` has no `sessionId` column;
   should claims be visible across sessions on the same repo (join via lane →
   session → repo fingerprint)?
5. **Arbiter model.** Which task class / model for the one-shot resolution
   proposal (RFC 0001 `plan-reassess`-class quality vs cheap)?
6. **Reconcile cadence.** Background interval vs on-demand vs both.

## Non-goals

- No write-path enforcement of advisory claims as the primary mechanism (the
  merge path is the guarantee; claims stay cooperative).
- No new VCS — git worktrees/branches remain the isolation mechanism.
- No central scheduler — lanes stay independent; integration is serialized.
- No vendoring of pact / cooperative-worktree-agents / orchestra source (all
  MIT, but the mechanisms are re-implemented against MIZI's existing lane
  model, not copied).
