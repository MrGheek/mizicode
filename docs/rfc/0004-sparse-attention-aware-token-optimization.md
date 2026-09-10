# RFC 0004 — Sparse-Attention-Aware Token Optimization: Model-Size Compression, Billing-Aware ROI, and Guaranteed Working-Set Injection

| | |
|---|---|
| **Status** | Draft for review |
| **Author** | MIZI Intelligence Layer |
| **Created** | 2026-09-10 |
| **Area** | Token cost optimization, inference routing, prompt engineering, context assembly |
| **Depends on** | RFC 0001 (token budget, ledger, tripwires, graph-gated slicing), RFC 0002 (lane collaboration), RFC 0003 (code factory) |

## Summary

RFC 0001 built the Avoid → Compress → Cache → Decide → Cap pipeline. This RFC
adapts it to the reality that **the models MIZI serves are themselves becoming
sparse-attention models**. Moonshot AI's MoBA (Mixture of Block Attention,
arXiv:2502.13189) — deployed in Kimi's long-context serving — applies MoE
routing to attention: each query attends to the top-k most relevant context
*blocks* (81–95% sparsity) with near-full-attention quality. Its findings
change three things about how MIZI should spend its compression effort:

1. **Model-size-aware compression ratio.** MoBA's scaling-law experiments show
   the sparse-vs-full quality gap *narrows as models scale* — bigger models
   tolerate more aggressive context dropping. MIZI's `TOKEN_MODE_PROFILES`
   currently keys compression off task class + token mode only. It should also
   key off the **active model's size/capability**: big model → compress harder;
   small model → keep more context.
2. **Billing-aware compression ROI.** MoBA is deployed in Kimi's long-context
   serving, so the hosted Kimi endpoints MIZI routes to may already run sparse
   attention — long-context *compute* is already cheap server-side. MIZI's
   prompt-side compression therefore buys **token-bill savings** (per-token
   providers like Vultr) but little latency on flat-rate NVIDIA NIM. The
   router should weight compression aggressiveness by **provider billing
   model**.
3. **Guaranteed working-set injection.** MoBA's "always attend to the current
   block" (the shared-expert rule) is its strongest structural claim. MIZI's
   Aider-style personalization (chat files ×50) is a *soft* boost. This RFC
   makes it a **hard guarantee**: the working set (files being edited, mentioned
   identifiers, failing-test output) is always in-budget and never compressed
   away, regardless of token mode.

The RFC also records two MoBA findings that **validate** existing RFC 0001
choices (fine-grained context units; hybrid fidelity per region) so future
readers know they were externally confirmed rather than assumed.

## Motivation

RFC 0001's Compress layer assumes the model pays quadratic attention cost over
whatever context MIZI sends. That assumption is eroding:

- **Kimi models are Moonshot's.** MoBA is deployed to support Kimi's
  long-context requests. MIZI's hosted catalog (`nim-catalog.ts`) routes to
  Kimi models (`moonshotai/kimi-k2-instruct`, etc.). If the serving side already
  runs sparse attention, the *compute* cost of long context is mitigated
  server-side — MIZI's compression is no longer buying latency, only billed
  tokens (and quality).
- **Compression aggressiveness is a free knob.** MoBA treats sparsity
  (81–95%) as a hyperparameter and shows the trailing-loss gap narrows with
  model scale. MIZI's `inputBudgetTokens` (`token-budget.ts:191`) is a single
  number per task class × token mode. It ignores which model will actually
  serve the call — a missed free optimization.
- **The working set is soft-guaranteed.** `codeContextForTask`
  (`routes/repo.ts:481`) ranks symbols and fits them to a budget by binary
  search. A task-touched file can still be dropped when the budget is tight
  (lean/ultra modes). MoBA's current-block rule says the local context must
  never be gated out — only the long tail is. MIZI should make that a hard
  invariant.
- **Billing is heterogeneous.** `PROVIDER_TOKEN_RATES` (`nim-catalog.ts:491`)
  has a per-token rate for Vultr; NVIDIA NIM is flat-rate. Today the router
  scores providers on price/latency/quality but the *compression* layer does
  not know whether the active provider charges per token. On a flat-rate
  provider, aggressive compression saves nothing and risks quality; on a
  per-token provider it is the whole point.

## Existing assets (what MIZI already has)

- **`services/token-budget.ts`** — `resolveTokenDecision()` computes
  `inputBudgetTokens = floor(profile.maxContextBudget × TASK_INPUT_BUDGET_RATIO)`
  per task class. No model/provider awareness.
- **`services/skills-types.ts`** — `TOKEN_MODE_PROFILES` (full/core/lean/ultra)
  with `maxContextBudget` (128k/64k/32k/16k). No model-size dimension.
- **`services/inference-router.ts`** — `scoreModelsForPhase` /
  `getBestModelForPhase` score models across providers on
  `sweBench × qualityWeight × (1000/latency) × costFactor × throughputBonus`.
  `PHASE_COST_WEIGHTS` amplifies provider price differentials per phase.
- **`services/llm-client.ts`** — `resolveLlmConfig()` picks the provider;
  `callLlm()` runs the budget gate then the call. `PROVIDER_TOKEN_RATES` is
  consulted only for the per-token ledger write (`recordTokenUsage`), not for
  compression decisions.
- **`services/nim-catalog.ts`** — `PROVIDER_CONFIG` (apiBase/envKey/displayName)
  and `PROVIDER_TOKEN_RATES` (currently Vultr-only).
- **`routes/repo.ts`** — `codeContextForTask(sessionId, query, { budgetTokens,
  seedFiles, topN, taskText })` → ranked, budget-fitted symbol signatures.
- **`services/code-context.ts`** — `loadCodeContextBlock()` wrapper with a
  default `budgetTokens = 600`.
- **`services/token-accounting.ts`** — universal ledger, tripwires,
  `recordSaving` (bytes/tokens avoided + est USD). The savings attribution
  surface for billing-aware ROI.

## Design

### Change 1 — Model-size-aware compression ratio (Decide → Compress)

**Problem.** `inputBudgetTokens` ignores the serving model. A 128k-context
Kimi model can absorb a larger prompt than a 16k model without quality loss;
MoBA's scaling laws say the gap narrows with model scale.

**Design.** Add a model-capability dimension to the budget resolver:

- Extend `TokenModeProfile` with a **compression aggressiveness** factor
  `contextCompression: number` (0 = keep everything, 1 = compress maximally),
  defaulting per token mode today (full=0.2, core=0.4, lean=0.6, ultra=0.8).
- Add a **model-size class** derived from the active model's context window
  (from `nim-catalog` metadata or the session's `activeNimModelId`):
  `small` (< 32k), `mid` (32k–128k), `large` (> 128k).
- `resolveTokenDecision()` multiplies the task input budget by a
  model-size factor: `large → ×1.15`, `mid → ×1.0`, `small → ×0.85`. Bigger
  models get *more* budget headroom (they tolerate it), smaller models get
  *less* (they can't absorb it). Equivalently, the compression ratio is
  `1 − contextCompression × modelSizeFactor`.
- The model-size class is resolved from the same source the router uses
  (`activeNimModelId` / `activeNimProvider` on the session row), so it is
  consistent with what actually serves the call.

**Why this is safe.** MoBA's scaling-law result is that sparse attention
matches full attention *better* at larger scale. Injecting more context into a
larger model is the same trade: the model can afford it. The factor is bounded
(±15%) so it never blows a budget.

### Change 2 — Billing-aware compression ROI (Decide layer)

**Problem.** Compression saves money only when the provider bills per token.
On flat-rate NVIDIA NIM, aggressive compression risks quality for zero savings.

**Design.** Add a **billing model** to provider metadata and feed it into both
the router and the budget resolver:

- Extend `PROVIDER_CONFIG` entries with `billing: "per-token" | "flat-rate"`
  (nvidia → flat-rate; vultr → per-token; together/deepinfra → per-token;
  ollama-local/ollama-cloud → per-token or flat per deployment).
- In `resolveTokenDecision()`, when the active provider is **flat-rate**,
  relax the input budget (×1.1) and skip the most aggressive compression
  stages (deep terminal filtering, aggressive signature elision) — quality
  wins because tokens are free.
- When the provider is **per-token**, keep (or tighten) compression — this is
  where RFC 0001's savings ledger pays.
- In `inference-router.ts`, add a small **compression-ROI term** to the model
  score: per-token providers get a bonus when the phase is context-heavy
  (plan-generate, plan-decompose, swarm-step) because compression is
  monetizable there; flat-rate providers get a neutral term. This makes the
  router prefer per-token providers for compressible work and flat-rate for
  quality-critical work — a second-order effect of MoBA's "compute is cheap"
  insight.

**Why this is safe.** The billing model is static metadata; the change is a
budget multiplier, not a routing rewrite. The router's existing
`PHASE_COST_WEIGHTS` already prefers economy providers in cost-sensitive
phases; this adds the compression dimension on top.

### Change 3 — Guaranteed working-set injection (Compress layer)

**Problem.** `codeContextForTask` fits ranked symbols to a budget by binary
search. Under lean/ultra budgets, task-touched files can be dropped. MoBA's
current-block rule says local context is never gated out.

**Design.** Make the working set a **hard reservation** in the context
assembler:

- `codeContextForTask` already accepts `seedFiles` (task-touched files). Add a
  **reserved budget** for them: the working set is always injected first, in
  full, before any ranked symbol competes for the remaining budget.
- Concretely: `reservedTokens = min(workingSetTokens, budget × 0.35)` is carved
  out; the binary-search fit runs over the *remaining* budget. If the working
  set alone exceeds the budget, it is elided to signatures (never dropped
  entirely).
- The working set is derived from the same signals RFC 0001 already uses:
  `seedFiles` (claims/blast radius), mentioned identifiers (from the intent
  text), and the session's active files. This is the prompt-side analogue of
  MoBA's current-block + shared-expert rule.
- `loadCodeContextBlock()` (`services/code-context.ts`) passes the session's
  working set through so every prompt site gets the guarantee, not just the
  plan paths.

**Why this is safe.** The reservation is bounded (35% of budget) and the
working set is small (a handful of files). It hardens an existing soft signal
(Aider personalization) into an invariant, matching MoBA's structural choice.

### Validated (no change — recorded for future readers)

- **Fine-grained units beat coarse.** MoBA's ablation (64 blocks > 8 at equal
  sparsity, ~1e-2 loss) confirms RFC 0001's symbol-signature slicing over
  file/chunk dumps. Keep granularity fine; do not regress to file-level.
- **Hybrid fidelity per region.** MoBA/full hybrid (sparse for 90% of
  training, full for the last layers) recovering full-attention quality
  confirms the RTK/Headroom caution already in RFC 0001: compress
  structural/repetitive content, keep full fidelity for the task-critical tail.

## File / module changes

| Area | Change |
|---|---|
| `services/skills-types.ts` | Add `contextCompression` to `TokenModeProfile`; add `ModelSizeClass` type |
| `services/token-budget.ts` | Model-size factor + billing-aware budget multiplier in `resolveTokenDecision()` |
| `services/nim-catalog.ts` | Add `billing: "per-token" \| "flat-rate"` to `PROVIDER_CONFIG` |
| `services/inference-router.ts` | Compression-ROI term in model scoring; expose active provider billing |
| `routes/repo.ts` | `codeContextForTask()` working-set reservation (reserved budget before ranked fit) |
| `services/code-context.ts` | Pass session working set through `loadCodeContextBlock()` |
| `services/token-accounting.ts` | Record compression-ROI savings per provider billing model (flat-rate → no savings claim) |

## Phasing

### Phase 1 — Working-set guarantee (highest ROI, self-contained)
- `codeContextForTask()` reserved-budget carve-out; `loadCodeContextBlock()`
  passes working set. Test: task-touched files always present under lean/ultra.

### Phase 2 — Model-size-aware budgets
- `ModelSizeClass` + factor in `resolveTokenDecision()`. Test: large-model
  calls get more input budget, small-model calls less, budgets stay bounded.

### Phase 3 — Billing-aware ROI
- `billing` field on `PROVIDER_CONFIG`; budget multiplier + router term.
- Savings ledger stops claiming savings on flat-rate providers.

## Test plan

- **Working-set guarantee**: under every token mode, `codeContextForTask`
  output contains all `seedFiles` symbols; elision to signatures when the
  working set alone exceeds budget; never dropped.
- **Model-size budgets**: `resolveTokenDecision` returns larger
  `inputBudgetTokens` for `large` models, smaller for `small`, bounded within
  the token-mode ceiling; no budget regression for `mid`.
- **Billing-aware**: flat-rate provider → relaxed budget + no savings claim;
  per-token provider → normal compression + savings recorded. Router score
  shifts toward per-token providers in context-heavy phases.
- **Regression**: RFC 0001 suites (token-budget, hybrid-search, plan paths)
  stay green; E2E cost gate (95.5% avg prompt-token reduction) does not regress
  on per-token providers.

## Open questions

1. **Model-size source of truth.** Derive from `nim-catalog` context-length
   metadata, or a static map keyed by model family? (Catalog metadata is
   preferred — it already carries `contextLength`.)
2. **Working-set definition.** `seedFiles` from claims/blast radius is the
   seed; should mentioned identifiers and the session's active files be merged
   in, and at what cap? (Proposal: seedFiles + mentioned idents, capped at 8
   files.)
3. **Flat-rate relaxation bound.** ×1.1 budget on flat-rate is conservative;
   should it be larger for quality-critical phases (plan-generate) and smaller
   for swarm? (Proposal: scale by `PHASE_QUALITY_WEIGHTS`.)
4. **Billing metadata completeness.** `together`/`deepinfra` are per-token in
   practice but unverified; confirm before marking. NVIDIA NIM preview is
   flat-rate today but may become per-token — keep the field configurable.

## Non-goals

- No implementation of MoBA or any model-side sparse attention — MIZI cannot
  touch model internals.
- No learned router — MoBA's gate is trained on attention scores MIZI cannot
  see; the heuristic graph router (BM25 + cosine + centrality) remains.
- No change to the Avoid/Cache/Cap layers — result caching, tripwires, and the
  ledger are orthogonal and stay as-is.
- No new provider — billing metadata is added to existing providers only.
