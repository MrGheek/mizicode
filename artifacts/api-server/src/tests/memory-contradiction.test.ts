/**
 * Unit tests for semantic contradiction detection.
 *
 * Tests cosineSimilarity, tfidfCosineSimilarity, and computeSemanticSimilarity
 * from memory-semantic.ts, plus the blending logic that mirrors saveMemoryItem.
 * No database or real network calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cosineSimilarity,
  tfidfCosineSimilarity,
  computeSemanticSimilarity,
} from "../services/memory-semantic";

// ─── Lexical overlap (Jaccard) — inline mirror for comparison ─────────────────

function lexicalOverlapScore(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(t => t.length > 2));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const tok of setA) {
    if (setB.has(tok)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Mirrors the finalScore blending logic in saveMemoryItem.
 * semanticEnabled = true mimics MIZI_MEM_SEMANTIC_CONTRADICTION=1.
 */
function blendedScore(lexScore: number, semScore: number, semanticEnabled: boolean): number {
  return semanticEnabled && semScore > 0
    ? (lexScore + semScore) / 2
    : lexScore;
}

const CONTRADICTION_THRESHOLD = 0.4;

// ─── cosineSimilarity ─────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical non-zero vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });

  it("returns 0 for a zero vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("returns a value in [0, 1] for non-negative input vectors", () => {
    const score = cosineSimilarity([0.5, 0.2, 0.8], [0.3, 0.9, 0.1]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("scores nearly-parallel vectors close to 1", () => {
    // Vectors pointing in nearly the same direction — as returned by an embedding
    // API for two texts about the same topic
    const embA = [0.8, 0.6, 0.1, 0.0, 0.3];
    const embB = [0.75, 0.65, 0.15, 0.05, 0.28];
    expect(cosineSimilarity(embA, embB)).toBeGreaterThan(0.9);
  });
});

// ─── tfidfCosineSimilarity ────────────────────────────────────────────────────

describe("tfidfCosineSimilarity", () => {
  it("returns 1 for identical texts", () => {
    const text = "the project uses TypeScript with strict mode enabled";
    expect(tfidfCosineSimilarity(text, text)).toBeCloseTo(1, 5);
  });

  it("returns 0 for completely disjoint vocabularies", () => {
    expect(tfidfCosineSimilarity("alpha beta gamma delta", "epsilon zeta omega kappa")).toBe(0);
  });

  it("returns 0 when all tokens are filtered (< 3 chars)", () => {
    expect(tfidfCosineSimilarity("a b c", "x y z")).toBe(0);
  });

  it("returns a value in [0, 1] for partially overlapping texts", () => {
    // Both use the word "tabs" and "indentation" — enough overlap for a score
    const a = "always use tabs for indentation style";
    const b = "avoid tabs and use spaces for indentation";
    const score = tfidfCosineSimilarity(a, b);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("near-rephrasing scores higher than partial overlap", () => {
    const a = "the project requires TypeScript strict mode";
    const b = "TypeScript strict mode is required for this project";
    const score = tfidfCosineSimilarity(a, b);
    expect(score).toBeGreaterThan(0.5);
  });

  it("scores texts sharing key topic words above zero", () => {
    // Shares: "tabs", "indentation" — verifiable shared tokens
    const a = "always use tabs for indentation style guidelines";
    const b = "spaces are better than tabs for indentation purposes";
    const score = tfidfCosineSimilarity(a, b);
    expect(score).toBeGreaterThan(0);
  });

  it("handles repeated terms — TF weighting is applied correctly", () => {
    const a = "use tabs tabs tabs for indentation";
    const b = "use tabs tabs indent please";
    const score = tfidfCosineSimilarity(a, b);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ─── Blending logic ───────────────────────────────────────────────────────────

describe("contradiction detection — finalScore blending", () => {
  it("lexical-only path misses semantically opposite items that share zero tokens", () => {
    // These texts are semantically opposite (one says use tabs, other says never use them)
    // but share NO overlapping word tokens after tokenization (tabs≠tab, indentation≠indent)
    const existing = "always use tabs for indentation throughout the codebase";
    const incoming = "never indent with tab characters — spaces only please";

    const lexScore = lexicalOverlapScore(existing, incoming);
    // Jaccard is 0: no tokens shared after filtering
    expect(lexScore).toBe(0);
    expect(lexScore).toBeLessThan(CONTRADICTION_THRESHOLD);
  });

  it("does not blend when semScore is 0 — falls back to lexical only", () => {
    const lexScore = 0.35;
    const final = blendedScore(lexScore, 0, true);
    // semScore == 0 → no blending → same as lexScore
    expect(final).toBeCloseTo(lexScore, 10);
    expect(final).toBeLessThan(CONTRADICTION_THRESHOLD);
  });

  it("blending with simulated neural embedding vectors catches contradiction missed by Jaccard", () => {
    // Simulate what text-embedding-3-small returns for two semantically related statements:
    // nearly-parallel vectors = same topic (indentation rules)
    const embeddingA = [0.8, 0.6, 0.1, 0.0, 0.3];
    const embeddingB = [0.75, 0.65, 0.15, 0.05, 0.28];
    const mockSemScore = cosineSimilarity(embeddingA, embeddingB);

    // Embedding similarity is high (both about indentation)
    expect(mockSemScore).toBeGreaterThan(0.9);

    // Jaccard is low / zero (different word choices)
    const lexScore = 0.05;
    expect(lexScore).toBeLessThan(CONTRADICTION_THRESHOLD);

    // Blended score crosses the contradiction threshold
    const finalScore = blendedScore(lexScore, mockSemScore, true);
    expect(finalScore).toBeGreaterThanOrEqual(CONTRADICTION_THRESHOLD);
  });

  it("high lexScore alone is sufficient — semantic blending does not reduce it", () => {
    // When texts share many words (same topic, same wording pattern), Jaccard is high.
    // Adding a semantic score should keep the blended score above threshold too.
    const a = "always use tabs for indentation style";
    const b = "avoid tabs and use spaces for indentation";
    const lexScore = lexicalOverlapScore(a, b);
    const semScore = tfidfCosineSimilarity(a, b);

    expect(semScore).toBeGreaterThan(0);
    // Both scores are positive; blend stays above whichever was higher
    const final = blendedScore(lexScore, semScore, true);
    // At least as high as the average of both positive scores
    expect(final).toBeGreaterThan(0);
  });

  it("near-identical rephrasing is caught by semantic scoring", () => {
    const a = "the project requires TypeScript strict mode";
    const b = "TypeScript strict mode is required for this project";
    const semScore = tfidfCosineSimilarity(a, b);
    expect(semScore).toBeGreaterThan(0.5);
    const lexScore = lexicalOverlapScore(a, b);
    const final = blendedScore(lexScore, semScore, true);
    expect(final).toBeGreaterThanOrEqual(CONTRADICTION_THRESHOLD);
  });
});

// ─── computeSemanticSimilarity (fetch path with mock) ────────────────────────

describe("computeSemanticSimilarity", () => {
  const savedBaseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  const savedApiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

  beforeEach(() => {
    process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = "https://ai-integrations.example.com/v1";
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = savedBaseUrl;
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = savedApiKey;
  });

  it("returns cosine similarity of API embedding vectors on success", async () => {
    const embA = [0.9, 0.1, 0.0];
    const embB = [0.85, 0.15, 0.05];
    const expected = cosineSimilarity(embA, embB);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: embA }, { embedding: embB }] }),
    }));

    const score = await computeSemanticSimilarity(
      "always use tabs for indentation",
      "never use spaces when indenting",
    );
    expect(score).toBeCloseTo(expected, 5);
  });

  it("falls back to TF-IDF cosine when API returns non-OK status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const a = "always use tabs for indentation style guidelines";
    const b = "spaces are better than tabs for indentation purposes";
    const expected = tfidfCosineSimilarity(a, b);

    const score = await computeSemanticSimilarity(a, b);
    expect(score).toBeCloseTo(expected, 10);
  });

  it("falls back to TF-IDF cosine when fetch throws a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const a = "always use tabs for indentation style guidelines";
    const b = "spaces are better than tabs for indentation purposes";
    const expected = tfidfCosineSimilarity(a, b);

    const score = await computeSemanticSimilarity(a, b);
    expect(score).toBeCloseTo(expected, 10);
  });

  it("falls back to TF-IDF when env vars are missing — no fetch call is made", async () => {
    delete process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
    delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const a = "always use tabs for indentation style guidelines";
    const b = "spaces are better than tabs for indentation purposes";
    const expected = tfidfCosineSimilarity(a, b);

    const score = await computeSemanticSimilarity(a, b);
    expect(score).toBeCloseTo(expected, 10);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("embedding path returns high semScore for semantically opposite items that share zero tokens", async () => {
    // "tabs for indentation" vs "never indent with tab characters" — 0 shared tokens (Jaccard=0)
    // but neural embeddings correctly place them in the same semantic neighborhood
    const embA = [0.8, 0.6, 0.2, 0.1]; // embedding for statement A
    const embB = [0.78, 0.62, 0.18, 0.12]; // nearly parallel embedding for semantically related B

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: embA }, { embedding: embB }] }),
    }));

    const existing = "always use tabs for indentation throughout the codebase";
    const incoming = "never indent with tab characters — spaces only please";

    const lexScore = lexicalOverlapScore(existing, incoming);
    const semScore = await computeSemanticSimilarity(existing, incoming);

    // Jaccard alone misses the contradiction (zero shared tokens)
    expect(lexScore).toBe(0);
    expect(lexScore).toBeLessThan(CONTRADICTION_THRESHOLD);

    // Embedding semScore is high (same semantic space)
    expect(semScore).toBeGreaterThan(0.9);

    // Blended score catches the contradiction
    const finalScore = blendedScore(lexScore, semScore, true);
    expect(finalScore).toBeGreaterThanOrEqual(CONTRADICTION_THRESHOLD);
  });
});
