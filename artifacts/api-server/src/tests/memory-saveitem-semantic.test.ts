/**
 * Integration-style tests for saveMemoryItem contradiction detection
 * with the semantic flag enabled.
 *
 * Uses a real (in-process) SQLite database in a temp directory and mocks
 * computeSemanticSimilarityBatch so no network calls are made.
 * Verifies that the blending pipeline in saveMemoryItem correctly flags
 * contradictions when the embedding path returns high similarity scores.
 */

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

// ─── Module-level mock (hoisted by vitest above imports) ─────────────────────
vi.mock("../services/memory-semantic", () => ({
  computeSemanticSimilarityBatch: vi.fn(),
  cosineSimilarity: (a: number[], b: number[]) => {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i];
    }
    const mag = Math.sqrt(magA) * Math.sqrt(magB);
    return mag === 0 ? 0 : dot / mag;
  },
  tfidfCosineSimilarity: (a: string, b: string) => {
    const tok = (s: string) => s.toLowerCase().split(/\W+/).filter(t => t.length > 2);
    const tA = tok(a), tB = tok(b);
    if (!tA.length || !tB.length) return 0;
    const shared = tA.filter(t => tB.includes(t)).length;
    return shared / (tA.length + tB.length - shared);
  },
  computeSemanticSimilarity: vi.fn(),
}));

import { computeSemanticSimilarityBatch } from "../services/memory-semantic";
import { saveMemoryItem } from "../services/memory";

// ─── Temp DB setup ────────────────────────────────────────────────────────────

let tmpDir: string;
const originalMEMDir = process.env["MEM_DATA_DIR"];
const originalFlag = process.env["OMNIQL_MEM_SEMANTIC_CONTRADICTION"];

// Note: MEM_DATA_DIR and the module-level DB singleton in memory.ts are
// evaluated at import time.  We use a unique userId per test so that each
// test works against its own isolated slice of whatever DB is initialised.
// The temp dir assignment here ensures a clean on-disk SQLite file is used
// when this test module is the first to load memory.ts in the vitest worker.

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-semantic-int-"));
  // Set flag before memory.ts lazily opens the DB (first call to saveMemoryItem)
  process.env["OMNIQL_MEM_SEMANTIC_CONTRADICTION"] = "1";
});

afterAll(() => {
  // Restore env
  if (originalMEMDir !== undefined) {
    process.env["MEM_DATA_DIR"] = originalMEMDir;
  } else {
    delete process.env["MEM_DATA_DIR"];
  }
  if (originalFlag !== undefined) {
    process.env["OMNIQL_MEM_SEMANTIC_CONTRADICTION"] = originalFlag;
  } else {
    delete process.env["OMNIQL_MEM_SEMANTIC_CONTRADICTION"];
  }
  // Clean up temp dir
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("saveMemoryItem — semantic contradiction detection integration", () => {
  it("detects no contradiction when mock batch returns low similarity scores", async () => {
    const userId = `test-low-sim-${Date.now()}`;

    // First item: save a convention
    vi.mocked(computeSemanticSimilarityBatch).mockResolvedValue([]);
    await saveMemoryItem({
      userId,
      memoryType: "convention",
      scope: "session_core",
      content: "always use tabs for indentation throughout the codebase",
    });

    // Second item: semantically UNrelated (low sim) — should NOT be flagged
    vi.mocked(computeSemanticSimilarityBatch).mockResolvedValue([0.05]); // low similarity
    const result = await saveMemoryItem({
      userId,
      memoryType: "convention",
      scope: "session_core",
      content: "unit tests must cover all public API endpoints",
    });

    expect(result.contradictions).toHaveLength(0);
    expect(result.conflictGroupId).toBeNull();
    // Batch was called once (for the one existing candidate)
    expect(vi.mocked(computeSemanticSimilarityBatch)).toHaveBeenCalledTimes(1);
  });

  it("detects a contradiction when mock batch returns high embedding similarity", async () => {
    const userId = `test-high-sim-${Date.now()}`;

    // Save the first item (no candidates yet → batch not called)
    vi.mocked(computeSemanticSimilarityBatch).mockResolvedValue([]);
    const first = await saveMemoryItem({
      userId,
      memoryType: "convention",
      scope: "session_core",
      content: "always use tabs for indentation throughout the codebase",
    });

    // Save a contradictory item:
    // Lexical Jaccard ≈ 0 (different words: "tab" vs "tabs", "indent" vs "indentation")
    // Embedding similarity = 0.95 (same semantic space — as a real embedding API would return)
    // Blended score = (0 + 0.95) / 2 = 0.475 > 0.4 threshold → contradiction
    vi.mocked(computeSemanticSimilarityBatch).mockResolvedValue([0.95]);
    const second = await saveMemoryItem({
      userId,
      memoryType: "convention",
      scope: "session_core",
      content: "never indent with tab characters — spaces only please",
    });

    // The first item should be flagged as a contradiction
    expect(second.contradictions).toContain(first.itemId);
    expect(second.contradictions).toHaveLength(1);
    expect(second.conflictGroupId).not.toBeNull();

    // Verify batch was called with the right inputs
    expect(vi.mocked(computeSemanticSimilarityBatch)).toHaveBeenCalledWith(
      "never indent with tab characters — spaces only please",
      expect.arrayContaining([
        "always use tabs for indentation throughout the codebase",
      ]),
    );
  });

  it("falls back to lexical-only when batch returns all-zero semScores", async () => {
    const userId = `test-zero-sem-${Date.now()}`;

    // Save first item
    vi.mocked(computeSemanticSimilarityBatch).mockResolvedValue([]);
    const first = await saveMemoryItem({
      userId,
      memoryType: "convention",
      scope: "session_core",
      content: "always use tabs for indentation throughout the codebase",
    });

    // Batch returns 0 (simulates API failure → TF-IDF also returned 0 for this pair)
    vi.mocked(computeSemanticSimilarityBatch).mockResolvedValue([0]);
    const second = await saveMemoryItem({
      userId,
      memoryType: "convention",
      scope: "session_core",
      content: "never indent with tab characters — spaces only please",
    });

    // semScore == 0 → no blending → lexical-only → Jaccard is 0 → no contradiction
    expect(second.contradictions).toHaveLength(0);
    expect(first.conflictGroupId).toBeNull();
  });

  it("batches all candidates in a single call rather than N per-item calls", async () => {
    const userId = `test-batch-calls-${Date.now()}`;

    // Save three existing items
    vi.mocked(computeSemanticSimilarityBatch).mockResolvedValue([]);
    await saveMemoryItem({ userId, memoryType: "convention", scope: "session_core", content: "item one about indentation rules" });
    vi.mocked(computeSemanticSimilarityBatch).mockResolvedValue([0.1]);
    await saveMemoryItem({ userId, memoryType: "convention", scope: "session_core", content: "item two about formatting style" });
    vi.mocked(computeSemanticSimilarityBatch).mockResolvedValue([0.1, 0.1]);
    await saveMemoryItem({ userId, memoryType: "convention", scope: "session_core", content: "item three about code structure" });

    vi.clearAllMocks();

    // Save a fourth item — should produce ONE batch call with 3 candidates, not 3 separate calls
    vi.mocked(computeSemanticSimilarityBatch).mockResolvedValue([0.1, 0.2, 0.1]);
    await saveMemoryItem({ userId, memoryType: "convention", scope: "session_core", content: "item four about testing conventions" });

    // Exactly ONE batch call was made regardless of candidate count
    expect(vi.mocked(computeSemanticSimilarityBatch)).toHaveBeenCalledTimes(1);
    const [, batchCandidates] = vi.mocked(computeSemanticSimilarityBatch).mock.calls[0]!;
    // All 3 existing items were sent in one shot
    expect(batchCandidates).toHaveLength(3);
  });
});
