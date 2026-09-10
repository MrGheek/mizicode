/**
 * repo-rank.ts — Graph-aware ranking + token-budget fitting (RFC 0001).
 *
 * A dependency-free toolkit for turning the repo graph (session_repo_context)
 * into a zero-cost context slicer:
 *
 *   - pageRankFiles()  — PageRank with a personalization vector over the
 *                        dependency edges. Biases relevance toward "seed"
 *                        files (task-touched files, blast radius, top search
 *                        hits) so import-heavy shared modules don't dominate.
 *                        Adapted from Aider's repo-map PageRank approach.
 *   - fitToBudget()    — binary-search largest prefix of a ranked, text-valued
 *                        list that fits a token budget (Aider-style), so the
 *                        most relevant N items are returned rather than
 *                        truncating arbitrarily.
 *   - estimateTokens() — deterministic 4-chars/token heuristic (RFC open
 *                        question #5: swap for gpt-tokenizer in a later phase).
 *
 * This module intentionally has NO data-access and NO cosine/embedding logic:
 * retrieval lives in routes/repo.ts (hybridSearch), and callers (routes, MCP
 * tools, the plan service) pass graph JSON + search results in. Keeps a clean
 * layering: services<services> never import routes.
 */

// ── Structural graph types (minimal subset of the persisted repo graph) ───────

export interface CodeFile {
  path?: string;
  lang?: string;
  sizeBytes?: number;
  centralityScore?: number;
  dependencyDegree?: number;
}

export interface CodeEdge {
  from?: string;
  to?: string;
  kind?: string;
}

// ── PageRank with personalization ────────────────────────────────────────────

const PR_DAMPING = 0.85;
const PR_ITERATIONS = 40;
const PR_TOLERANCE = 1e-6;

/**
 * Compute PageRank over the file-level dependency graph with a personalization
 * vector. `seedFiles` boosts relevance of files the model is likely to touch.
 * Returns Map<filePath, rank in [0..1])>.
 */
export function pageRankFiles(
  edges: CodeEdge[],
  files: CodeFile[],
  seedFiles: string[] = [],
): Map<string, number> {
  const paths = new Set<string>();
  for (const f of files) if (f.path) paths.add(f.path);
  for (const e of edges) {
    if (e.from) paths.add(e.from);
    if (e.to) paths.add(e.to);
  }

  const nodes = Array.from(paths);
  const index = new Map<string, number>();
  nodes.forEach((p, i) => index.set(p, i));
  const N = nodes.length || 1;

  const outDegree = new Array<number>(N).fill(0);
  const inNeighbors: number[][] = Array.from({ length: N }, () => []);
  for (const e of edges) {
    const f = e.from ? index.get(e.from) : undefined;
    const t = e.to ? index.get(e.to) : undefined;
    if (f === undefined || t === undefined || f === t) continue;
    outDegree[f] += 1;
    inNeighbors[t].push(f);
  }

  // Personalization: 1.0 for exact seed matches, 0.5 for prefix/substring
  // proximity, normalized to a probability vector.
  const personal = new Array<number>(N).fill(0);
  const seedSet = seedFiles.filter(Boolean);
  if (seedSet.length > 0) {
    let total = 0;
    for (let i = 0; i < N; i++) {
      const p = nodes[i];
      let score = 0;
      for (const s of seedSet) {
        if (s === p) score += 1.0;
        else if (p.includes(s) || s.includes(p)) score += 0.5;
      }
      personal[i] = score;
      total += score;
    }
    if (total > 0) {
      for (let i = 0; i < N; i++) personal[i] /= total;
    } else {
      personal.fill(1 / N);
    }
  } else {
    personal.fill(1 / N);
  }

  let ranks = new Array<number>(N).fill(1 / N);
  for (let iter = 0; iter < PR_ITERATIONS; iter++) {
    const next = new Array<number>(N).fill(0);
    const dangling = (1 - PR_DAMPING) / N;
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (const nb of inNeighbors[i]) sum += ranks[nb] / Math.max(1, outDegree[nb]);
      next[i] = (1 - PR_DAMPING) * personal[i] + PR_DAMPING * (sum + dangling);
    }
    let diff = 0;
    for (let i = 0; i < N; i++) diff += Math.abs(next[i] - ranks[i]);
    ranks = next;
    if (diff < PR_TOLERANCE) break;
  }

  const out = new Map<string, number>();
  for (let i = 0; i < N; i++) out.set(nodes[i], ranks[i]);
  return out;
}

// ── Token budget fitting ──────────────────────────────────────────────────────

/**
 * Deterministic token estimate via the standard ~4-chars/token heuristic.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Binary-search the largest prefix of `ranked` (already sorted by relevance,
 * descending) whose total estimated tokens fit `budgetTokens`. Always keeps at
 * least one item if any exist — the single best hit must never be silently
 * dropped (off-by-one in greedy truncation).
 */
export function fitToBudget<T extends { text: string }>(
  ranked: T[],
  budgetTokens: number,
): T[] {
  if (ranked.length === 0) return [];
  const lineTokens = ranked.map((r) => estimateTokens(r.text));

  let lo = 0;
  let hi = ranked.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let total = 0;
    for (let i = 0; i < mid; i++) total += lineTokens[i];
    if (total <= budgetTokens) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ranked.slice(0, Math.max(best, 1));
}

/**
 * RFC 0004 Phase 1 — guaranteed working-set injection.
 *
 * Splits a ranked, text-valued candidate list into a reserved working set
 * (task-touched files) and the ranked remainder, then fits each to its own
 * budget slice. The working set is always injected first, in full, before any
 * ranked symbol competes for the remaining budget — the prompt-side analogue of
 * MoBA's "always attend to the current block". If the working set alone exceeds
 * its reservation it is elided to the best-fitting prefix (never dropped
 * entirely). Returns the combined list (working set first) plus the reserved
 * token count.
 */
export function reserveWorkingSet<T extends { text: string; path?: string }>(
  ranked: T[],
  workingSetFiles: string[],
  budgetTokens: number,
  reservedFraction = 0.35,
): { fitted: T[]; workingSetTokens: number } {
  const ws = new Set(workingSetFiles.filter(Boolean));
  if (ws.size === 0) {
    return { fitted: fitToBudget(ranked, budgetTokens), workingSetTokens: 0 };
  }

  const workingSetCandidates = ranked.filter((c) => ws.has(c.path ?? ""));
  const rankedOnly = ranked.filter((c) => !ws.has(c.path ?? ""));

  const reservedBudget = Math.floor(budgetTokens * reservedFraction);
  const workingSetFitted = fitToBudget(workingSetCandidates, reservedBudget);
  const workingSetTokens = workingSetFitted.reduce((s, f) => s + estimateTokens(f.text), 0);
  const remainingBudget = Math.max(0, budgetTokens - workingSetTokens);

  return {
    fitted: [...workingSetFitted, ...fitToBudget(rankedOnly, remainingBudget)],
    workingSetTokens,
  };
}