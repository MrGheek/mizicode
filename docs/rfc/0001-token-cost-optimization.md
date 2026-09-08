# RFC 0001 — MIZI Token Cost Optimization: Avoid → Compress → Cache → Decide → Cap

| | |
|---|---|
| **Status** | Draft for review |
| **Author** | MIZI Intelligence Layer |
| **Created** | 2026-09-08 |
| **Area** | Cost efficiency, inference routing, prompt engineering, repo graph |
| **Depends on** | Existing provider work (NIM / Vast.ai peers + local Ollama) |

## Summary

Reduce token spend across **every action that hits an LLM or embedding API** by
routing all calls through a single **TokenBudgetCore** that applies five layers
in priority order: **Avoid → Compress → Cache → Decide → Cap**. The core new
asset is the **repo graph as a zero-cost context slicer** — cutting tokens by
never re-sending code the system already knows — rather than merely improving
model/provider selection.

## Motivation

MIZI's token-efficiency measures today are fragmented:

- `inference-router.ts` optimizes **which model/provider** per phase (cost  +
  throughput + local-Ollama bonuses), but never touches prompt size.
- `llm-client.ts` caps **output** tokens (`max_tokens`) and meters
  per-token billing (currently Vultr-only).
- `skills-bundler.ts` / `skills-types.ts` bound **injected context** via
  `TOKEN_MODE_PROFILES` (`maxContextBudget`, `activeSkillCountLimit`,
  `DESIGN_CONTEXT_LIMIT`).
- `memory-passive.ts` bounds recall (topK, BFS depth).
- **The repo graph (`session_repo_context`) is indexed but not wired into
  prompt assembly at all** — the largest untapped lever.

These silos never talk to one another. A plan-decompose call can be routed to a
cheap model (Decide) while still re-sending the same 20k-token file chunk on
every swarm turn (no Avoid/Compress/Cache). This RFC unifies them.

## Existing assets (what MIZI already has)

### 1. Repo graph — `session_repo_context` (per session)

`symbolsJson`, `edgesJson`, `chunksJson`, `embeddingsJson` (+ `hasEmbeddings`,
`embeddingDim`), `filesJson` (with `centralityScore`, `dependencyDegree`),
`summaryJson`, `fingerprintJson`, `fingerprintHash`, `confidenceLevel`, `isStale`.

A real **hybrid search** already exists at `GET /api/repo/search`
(`routes/repo.ts:336` → `hybridSearch` at `:899`): lexical BM25 + semantic
cosine + graph centrality, with admission thresholds and confidence scores.

**Gap:** the MCP `repo_search` tool my agents call (`mcp/tools/repo.ts:50`)
performs naive substring matching over `edgesJson` and is the *only* consumer —
`hybridSearch` is not exposed to agents and no prompt-assembly path uses it.

### 2. Router — `inference-router.ts`

`PHASE_COST_WEIGHTS`, `PHASE_THROUGHPUT_BONUS`, `PHASE_QUALITY_WEIGHTS`,
`PHASE_LOCAL_BONUS`, local-Ollama candidates. `getBestModelForPhase` excludes
local (workspace litellm can't reach the host daemon); `scoreModelsForPhase`
includes local for server-side calls. **Current gap:** cost signals never reach
`llm-client`, which picks one provider and one default `max_tokens`.

### 3. Prompts — `prompts/contracts.ts`

Versioned renderers (`renderPlanGenerate`, `renderPlanReassess`,
`renderMemorySidecarVerify`). Truncation is hard-coded
(`.slice(0,7)`, `.slice(0,5)`) not token-aware.

### 4. Token accounting — `llm-client.ts:99-135`

Accumulates prompt+completion tokens on the session row (currently only for
per-token providers). Not a universal ledger, no tripwires, no degradation.

### 5. Token modes — `skills-types.ts` / `skills-bundler.ts`

`TOKEN_MODE_PROFILES` drives skill count, design-context limit, and a 5%-of-budget
skill overhead cap.

## Design

### External validation & prior art (materially strengthens this design)

A deep scan of seven leading token-efficiency projects confirms the core
mechanisms and contributes concrete algorithms MIZI adopts rather than
re-inventing (see full appendix at the end). License and quality cautions apply
and are called out.

| Project | Mechanism MIZI adopts | Where it lands |
|---|---|---|
| **Aider** (repo-map) | **PageRank with personalization** over the dependency graph (bias: chat files ×50, mentioned identifiers ×10, long names ×10; `sqrt(num_refs)` dampening). **Binary-search budget fitting** onto `--map-tokens` (15% error tolerance). Renders only definitions + parent scope, not bodies. | Layer 2/G1 ranking + budget fit |
| **LLMLingua** | **Question-aware two-loss filtering** — keep tokens whose probability drops most when the task instruction is added (`self_loss − question_loss > threshold`). **Cascade budget: global `target_token` → per-chunk thresholds, earlier stages over-keep, later over-compress.** | Layer 2 retrieval task-relativity + Layer 5 budget distribution |
| **Headroom** | **Cache-aware compression math** — whether compressing a section saves tokens net of KV-cache invalidation (`gain = ΔT·(w + r·(R−1)) − P_alive·(w−r)·(S+ΔT)`). **Live-zone compression**: frozen prefix stays byte-identical; only new bytes compressed. **Entropy mask** (preserve tokens with entropy > 0.85: UUIDs/hashes). **Reversible CCR**: originals cached, model retrieves on demand. | Layer 1/3 cache + Layer 2 lossiness policy |
| **context-mode** (study-only, **ELv2**) | **Externalize tool output >100 KB to an index, return a search pointer** (recoverable verbatim). FTS5 BM25/trigram + embeddings hybrid. Per-event `bytes_avoided`/`bytes_returned` + `model-prices` → `$ saved`. On-compaction "table of contents + exact runnable search" resume snapshot. | Layer 1/3 big-output handling + Layer 5 measurement |
| **repomix** | **Per-language tree-sitter signature extraction** (query captures → parse-strategy keeps signatures/decorators/imports, strips bodies, dedup by name+content, explicit `⋮----` elision markers). **`gpt-tokenizer`** with `disallowedSpecial = new Set()` + per-encoding cache → cheap exact token counts. | Layer 2/7 token counting + chunk compression |
| **RTK** | **Semantic output filtering** that preserves exit codes, `path:line`, imports, signatures; collapses passing tests to counts; **tee-recovery on failure** so the LLM can re-read full output without re-executing. | Layer 1 + claw/swarm terminal output |
| **serena** | **Symbol-body-level edits** (`replace_symbol_body`, `insert_after_symbol`) via LSP `TextEdit` — read only the symbol, edit only the body. Progressive `max_answer_chars` shortening (always return *something*). | Layer 2/G1 + MCP edit tools |

**Cautions adopted (material, not incidental):**
- **context-mode is ELv2** — MIZI may *study/rebuild* the mechanisms but must NOT vendor its source into a hosted service. Mechanisms only.
- **Multiple lossy stages can hide the exact error/test line the model needs.** RTK mitigates by tee-recovery; Headroom by entropy-mask + reversible CCR; repomix by elision markers. MIZI must preserve `path:line`, signatures, exit codes, and high-entropy tokens across ALL compression layers, and keep originals recoverable.
- **Aggressive brevity prompts degrade reasoning** (kimi-k2.5): MIZI compresses *structural/code/repetitive* content, never dictates answer prose beyond existing token-mode directives.

### TokenBudgetCore — the single integration point

A new module (`services/token-budget.ts`) that every API-hitting action imports
once, exposing:

```ts
interface TokenTask {
  taskClass: "sidecar-verify" | "classify" | "recommend"
           | "plan-generate" | "plan-reassess" | "plan-decompose"
           | "palette-map"   | "swarm-step" | "embed" | "summarize";
  intentText?: string;        // for graph-gated slicing
  sessionId?: number;
  phase?: SessionPhase;       // lets router cost signals flow through
  tokenMode: TokenMode;
}

interface TokenDecision {
  model: string;              // from Decide layer (router + local-Ollama)
  provider: string;
  inputBudget: number;        // tokens — Compress layer enforces
  maxOutputTokens: number;    // per task class
  context: LlmMessage[];      // graph-sliced, cache-aware, budget-capped
  skip: boolean;              // Avoid layer: cached/known answer, no API call
}
```

`callLlm` (and future `embed`) route through `TokenBudgetCore.resolve(task)`
before firing. All layers below are enforced there so call sites stay thin.

### Layer 1 — AVOID: never pay for what you already know

1. **Prompt-cache / speculative reuse.** Hash the *rendered* prompt
   (`content hash` + `promptVersion`). If a byte-identical prompt was served
   within TTL, return the cached result without an API call. Combine with
   provider-native `cached:` prefix blocks in multi-turn swarm turns so the
   system prompt is billed once, not per turn.
   - Apply **Headroom's cache-aware mutation math**: never mutate the frozen
     conversation prefix (busts the provider KV cache); only compress/alter
     *new* bytes. Only compress a section when its token savings outweigh the
     cache-invalidation cost (per the `gain` formula above).
2. **Result short-circuiting.**
   - `memory-sidecar-verify`: heuristic is the default; escalate to the LLM
     (80-token) only when heuristic confidence is in a narrow band
     (~0.45–0.65). Eliminates the majority of sidecar LLM calls.
   - `palette-intent`: deterministic keyword→action map first; LLM only on
     rule miss.
3. **Graph-gated known-answer.** When the plan/decompose answer is derivable
   purely from the stored graph (fingerprint unchanged), skip the LLM and emit
   the graph-derived structure directly.
4. **Externalize-big-output (context-mode pattern).** Any tool/grep/read result
   larger than a threshold (default ~100 KB, or ~25 KB when intent-scoped)
   goes to the memory/index store and returns a **searchable pointer**
   (`use ctx_search(source:...)`) instead of the raw bytes. Recoverable
   verbatim via FTS5 trigram/BM25 + embeddings hybrid — MIZI's `memory-semantic`
   + an added FTS5/trigram index on code chunks.
5. **Semantic terminal filtering + tee-recovery (RTK pattern, claw/swarm).**
   Condense shell/test/lint output in claw-runner jobs: collapse passing tests
   to counts, dedup repeated lines, keep **exit codes, `path:line`, signatures,
   imports**, and failure details. Persist the full unfiltered output so a
   failed run can be re-read without re-executing.

### Layer 2 — COMPRESS: fewer input tokens per prompt

> Core asset: **repo graph as a zero-cost code slicer.**

6. **Graph-gated context slicing (G1).** Before sending repo/skill context,
   run ranking + retrieval over the **stored** graph (free — in-memory cosine +
   `edgesJson`, no embedding/API call) and inject only the top-k relevant symbol
   **signatures + `path:line` refs** + high-centrality callees. The model reads
   only what it needs instead of receiving full file/chunk dumps.
   - **Rank symbols with Aider's PageRank-with-personalization** over MIZI's
     existing dependency graph: bias toward task-touched files (via claims /
     blast radius), mentioned identifiers, and meaningful names;
     `sqrt(num_refs)` dampening so import-heavy symbols don't dominate.
   - **Task-relativize retrieval (LLMLingua two-loss)**: rank candidate chunks
     by how much more relevant they are given the task/intent, not just
     standalone similarity to the query.
   - **Render signatures only** via per-language tree-sitter query + parse
     strategy (repomix pattern): decorators, `def/class/func` signature lines,
     imports, docstrings retained; bodies stripped; dedup by name+content with
     explicit `⋮----` elision markers.
7. **Known-file skipping (G2).** Track files already injected into the active
   context (via `callers[]`/`callees[]` + chunks). Re-inject by `path:line`
   reference instead of content. Kills the dominant swarm-loop waste.
8. **Blast-radius-aware scoping (G3).** Use `computeBlastRadius`
   (`routes/repo.ts:1077`) to scope context to the affected module + callees
   rather than the whole repo tree.
9. **Token-aware input budgeting.** Extend `TOKEN_MODE_PROFILES` with a
   per-call `inputBudget`; enforce in the context assembler via **real token
   counting** using `gpt-tokenizer` (`disallowedSpecial = new Set()`, per-encoding
   cache) — not `LENGTH/4` or `.slice(0,7)`. **Fit ranked symbols to the budget
   by binary search** (Aider's method) on the tag/symbol count rather than
   greedy truncation.
10. **Retrieval gates before injection.** Similarity floors for memory and
    repo/design context so low-relevance items never reach the prompt; always
    preserve `path:line`, signatures, exit codes, and high-entropy tokens
    (UUIDs/hashes) across every compression stage.

### Layer 3 — CACHE: deduplicate across sessions

11. **Cross-session embedding dedupe.** Reuse a stored vector when a turn is a
    near-duplicate (cosine > 0.95) instead of hitting the embeddings API
    (`memory-passive.ts:339` re-embeds every turn today).
12. **Result cache.** Persist plan / reassess / sidecar outputs keyed by
    `(promptHash, phase, tokenMode, fingerprintHash)` with TTL. Team members
    requesting similar plans don't re-pay.

### Layer 4 — DECIDE: cheapest adequate model per task

13. **Task-class routing in `llm-client`.** Each call site declares a
    `taskClass`; the router returns the cheapest **live** model meeting it:
    - `sidecar-verify`, `classify`, `recommend`, `palette-map` → local Ollama
      or smallest hosted (already small-output).
    - `plan-generate` / `reassess` / `decompose` → mid quality.
    - `swarm-step` → throughput-optimized.
    This is the missing link that finally lets `inference-router`'s cost
    signals reach the calling layer (including the local-Ollama peer work).

### Layer 5 — CAP: hard ceilings + universal ledger

14. **Universal ledger.** Generalize the per-token accounting in
    `llm-client.ts` to all providers. Reuse the `ambient.ts`
    `tokenBudget`/`tokensUsed` ledger pattern. Adopt context-mode's **per-event
    `bytes_avoided`/`bytes_returned` + `model-prices`** accounting so savings
    are honestly attributable per tool/session/org (feeds a `ctx_stats`-style
    dashboard).
15. **Per-action hard caps.** Input + output ceilings per `taskClass`, plus a
    **wall-clock/token tripwire** that aborts runaway multi-turn swarm turns.
    Distribute budgets via **LLMLingua's cascade** (global target → per-chunk
    thresholds; earlier stages over-keep, later over-ensure-fit).
16. **Reserve-based auto-degrade.** When budget tightens, degrade gracefully
    (downgrade to local Ollama, tighten review, skip sidecar, deepen terminal
    filtering) instead of failing or overspending.

## File / module changes

| Area | Change |
|---|---|
| `services/token-budget.ts` (new) | TokenBudgetCore — layered resolve() entry point (Avoid→Compress→Cache→Decide→Cap) |
| `services/token-accounting.ts` (new) | Universal spend ledger + tripwires + `bytes_avoided`/`$ saved` measurement |
| `services/repo-rank.ts` (new) | PageRank-with-personalization over `edgesJson`/`callers`/`callees` (Aider method) |
| `routes/repo.ts` | Export a `codeContextForTask(sessionId, intent, budget)` assembler built on `hybridSearch` + ranker; add FTS5/trigram index on code chunks |
| `mcp/tools/repo.ts` | Fix `repo_search` to use `hybridSearch` + ranker (semantic + graph), not substring matching |
| `services/llm-client.ts` | Route through TokenBudgetCore; task-class model selection; universal ledger; `gpt-tokenizer` counting |
| `services/inference-router.ts` | Accept task-class hints; expose cheapest *live* model per task |
| `services/hybrid-search.ts` (new) | Externalize-big-output + semantic terminal filtering (RTK/context-mode pattern) |
| `services/skills-types.ts` | Add per-call `inputBudget` to `TokenModeProfile`; cascade budget distribution |
| `prompts/contracts.ts` | Token-aware context assembly; tree-sitter signature rendering; version bumps |
| `services/plan.ts`, `plan-decompose.ts`, `palette-intent.ts`, `memory-passive.ts` | Call TokenBudgetCore; heuristics-first where applicable |
| `services/memory-passive.ts` | Embedding dedupe + heuristic-first sidecar + FTS5/trigram fallback |

## Phasing

### Phase 1 — Graph slicing + MCP tool fix (highest ROI, self-contained)
- Fix `mcp/tools/repo.ts` `repo_search` → `hybridSearch` + PageRank ranker.
- Add `codeContextForTask()` to `routes/repo.ts` (ranker + binary-search budget
  fit + tree-sitter signature rendering).
- Wire graph-gated slicing into `plan-generate` / `plan-decompose` prompts
  (G1/G2/G3). Measure per-prompt token delta.

### Phase 2 — Task-class routing + heuristic-first
- Task-class model selection in `llm-client` (realize local-Ollama/peer work).
- Heuristic-first for `palette-intent` and `memory-sidecar-verify`.
- Externalize-big-output + semantic terminal filtering (RTK/context-mode).

### Phase 3 — Cache + ledger
- Prompt/result cache keyed by hashes, with Headroom's cache-aware mutation math.
- Universal ledger + per-action caps + auto-degrade + `$ saved` measurement.

### Phase 4 — Embedding dedupe + retrieval gates + task-relative rerank
- Near-duplicate embedding reuse; similarity floors; LLMLingua two-loss
  task-relativization of `codeContextForTask`.

## Test plan

- **Provider/router**: existing 38 provider tests must stay green; add
  task-class routing tests (mock provider health + local-Ollama daemon).
- **Graph slicing**: test `codeContextForTask` returns token-capped,
  `path:line`-referenced snippet sets; verify PageRank personalization biases
  toward task files; verify binary-search budget fit stays within tolerance;
  verify known-file skipping (G2).
- **Preservation contract**: assert `path:line`, signatures, exit codes, and
  high-entropy tokens survive every compression stage; verify tees/originals
  remain recoverable.
- **MCP repo_search**: assert semantic + graph results (not just substring).
- **Cache**: byte-identical prompt → no API call; TTL expiry honored; frozen
  prefix never mutated (cache-aware math on).
- **Externalization**: >threshold tool output returns a pointer, recoverable
  verbatim via search.
- **Ledger/caps**: token accumulation across providers; tripwire aborts;
  `bytes_avoided`/`$ saved` metrics reported.
- **E2E cost assertion**: snapshot prompt token counts before/after each phase;
  enforce a % reduction gate per phase (target ≥ 40% on plan/decompose paths).

## Open questions

1. **Provider-native `cached:` blocks** — which providers (DeepInfra, Together,
   Vultr, NVIDIA NIM) reliably support prefix caching? Should we gate on a
   capability flag in `PROVIDER_CONFIG`? (Headroom's cache-write/read cost
   multipliers inform whether live-zone compression is worth it per provider.)
2. **Graph freshness** — what's the acceptable `isStale` threshold before we
   invalidate the fingerprint-hash context cache?
3. **Tripwire defaults** — reasonable wall-clock/token ceilings for swarm turns
   vs. quality impact?
4. **Should `codeContextForTask` be an MCP tool too?** (In addition to being
   injected into prompt assembly) so the workspace can self-serve graph context.
5. **Tokenizer** — adopt `gpt-tokenizer` (repomix-proven, pure-JS, per-encoding
   cache) as the production counter. Confirm per-model-family encodings for the
   workspace's litellm proxy paths.
6. **Local retrieval engines** — given context-mode defaults to SQLite FTS5
   BM25/trigram + fuzzy, should MIZI's `/api/mcp` use FTS5 or Postgres FTS for
   the exact-identifier layer alongside its embeddings?
7. **Ranking parameters** — defaults for PageRank personalization weights
   (reuse Aider's ×50 files / ×10 identifiers as a starting point, tuned on
   MIZI's repos).

## Non-goals

- No new model training or fine-tuning.
- No change to the existing provider architecture (NIM / Vast.ai / local
  Ollama remain peers).
- No regression to output quality on quality-first phases (plan/explore).
- **No vendoring of context-mode source** (ELv2 restricts hosted-service
  redistribution). Its mechanisms are re-implemented independently; MIT/Apache
  sources (Aider, repomix, RTK, Headroom, LLMLingua) may be referenced.
- **No stacking of multiple lossy compression stages** on the same content in
  a way that hides `path:line`, exit codes, or error lines. Compression is
  structural/extractive first; reversible originals kept for recovery.

## References

- **Aider repo-map** — `aider/repomap.py`: NetworkX `MultiDiGraph`, tree-sitter
  `tags.scm`, PageRank w/ personalization (chat files ×50, identifiers ×10,
  long names ×10), binary-search `--map-tokens` fit, `grep_ast.TreeContext`
  signature-only rendering.
- **serena** — LSP-server symbol lookup (`solidlsp`), `replace_symbol_body` /
  `insert_after_symbol` via `TextEdit`, progressive `max_answer_chars`
  shortening.
- **repomix** — `src/core/treeSitter/*` query + parse-strategy per language,
  `gpt-tokenizer` counting (`disallowedSpecial = new Set()`), `--stdin` file
  list bounds, `--token-budget` CI guard.
- **LLMLingua** — `prompt_compressor.py`: coarse-to-fine cascade
  (context→sentence→200-token chunk), question-aware two-loss filtering,
  LLMLingua-2 token-classifier (XLM-R). ~2–5× practical compression; aggressive
  ratios degrade quality (use sparingly on code).
- **headroom** — Rust core: `smart_crusher` (JSON), `code_compressor`
  (AST-aware), `live_zone`, `anchor_selector`, `adaptive_sizer`, cache-aware
  mutation math, entropy mask (>0.85), reversible CCR.
- **RTK** — PTY interceptor, 12 filtering strategies, TOML per-command filters,
  tee-recovery on failure; preserves exit codes/`path:line`.
- **context-mode** — `src/server.ts` externalize >100 KB, FTS5 BM25 +
  trigram + fuzzy + RRF, session resume "table of contents + search pointers",
  per-event `bytes_avoided`/`bytes_returned`, `model-prices.json`. **ELv2 —
  study/re-implement only.**

