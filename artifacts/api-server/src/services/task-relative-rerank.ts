/**
 * task-relative-rerank.ts — RFC 0001 Phase 4 (retrieval gates + task relativization)
 *
 * Pure, dependency-free helpers for making retrieval *task-relative* instead of
 * only query-relative (LLMLingua two-loss idea — no vendored source):
 *
 *   - tokenJaccard()         — token-set overlap, the deterministic similarity
 *                              basis for both task relativization and the
 *                              near-duplicate embedding reuse gate (Layer 3 §11).
 *   - taskRelativeRerank()   — blend each candidate's base score (query
 *                              relevance / graph centrality) with its lexical
 *                              distance to the *task* text, so symbols that
 *                              matter only to the current intent rank higher
 *                              than global relevance alone would suggest.
 *   - RETRIEVAL_SIMILARITY_FLOOR — similarity floor below which candidates
 *                              shouldn't reach a prompt (Layer 2 §10).
 *
 * Everything here is pure text math: no network, no DB, no embeddings API.
 */

export interface TokenSimilarityOptions {
  /** Minimum token-set overlap for the near-duplicate embedding gate. */
  nearDupIou?: number;
}

/** Lower bound for admitting retrieval candidates into a prompt (Layer 2 §10). */
export const RETRIEVAL_SIMILARITY_FLOOR = 0.05;

/** Token-set overlap at which two texts are treated as near-duplicates and a
 *  stored embedding can be reused instead of paying the embeddings API. */
export const NEAR_DUP_TOKEN_IOU = 0.95;

/** Split text into a set of lowercased word tokens (len > 2 to dodge noise). */
export function tokenize(text: string): Set<string> {
  const set = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (t.length > 2) set.add(t);
  }
  return set;
}

/** Jaccard token-set similarity between two texts, in [0, 1]. */
export function tokenJaccard(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * True when `b` is a near-duplicate of `a` under the given token-IoU gate.
 * Used to decide embedding reuse before calling the embeddings API.
 */
export function isNearDuplicate(a: string, b: string, opts: TokenSimilarityOptions = {}): boolean {
  return tokenJaccard(a, b) >= (opts.nearDupIou ?? NEAR_DUP_TOKEN_IOU);
}

export interface RelativeRerankItem {
  /** Stable candidate id (e.g. `path:line`) for tie-breaking and dedup. */
  id: string;
  /** Rendered line used for tokenization (name/snippet/path). */
  text: string;
  /** Base relevance from the upstream retrieval (query + graph). */
  base: number;
}

export interface RelativeRerankResult<T extends RelativeRerankItem> {
  item: T;
  /** Base score from upstream retrieval. */
  base: number;
  /** Lexical distance from the candidate to the task text. */
  taskRelevance: number;
  /** Two-loss blend: 0.6 base + 0.4 task relevance. */
  relative: number;
  /** Passed the similarity floor after the blend. */
  admitted: boolean;
}

/**
 * Task-relative rerank (LLMLingua two-loss): for each candidate, combine its
 * base score with token similarity to the *task* — not just the query — and
 * sort descending. Candidates below the blend floor are flagged for dropping.
 */
export function taskRelativeRerank<T extends RelativeRerankItem>(
  items: T[],
  taskText: string,
  opts: { floor?: number; weightBase?: number } = {},
): Array<RelativeRerankResult<T>> {
  const floor = opts.floor ?? RETRIEVAL_SIMILARITY_FLOOR;
  const wBase = opts.weightBase ?? 0.6;
  const taskTokens = tokenize(taskText);

  const scored = items.map((item) => {
    const tTokens = tokenize(item.text);
    let inter = 0;
    for (const t of tTokens) if (taskTokens.has(t)) inter++;
    const union = taskTokens.size + tTokens.size - inter;
    const taskRelevance = taskTokens.size === 0 || union === 0 ? 0 : inter / union;
    const relative = wBase * item.base + (1 - wBase) * taskRelevance;
    return { item, base: item.base, taskRelevance, relative, admitted: relative >= floor };
  });

  scored.sort((a, b) => b.relative - a.relative);
  return scored;
}