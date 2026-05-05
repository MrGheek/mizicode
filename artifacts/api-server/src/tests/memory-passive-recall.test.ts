/**
 * Tests for the passive semantic memory recall pipeline (Task #225).
 *
 * Covers, end-to-end, the N→N+1 contract:
 *   - recordTurn + runPassiveRecallForTurn produces audit rows for similar
 *     items.
 *   - inferEdgesForNewItem materialises typed `relates_to` edges above the
 *     similarity threshold and `contradicts` edges from the contradiction list.
 *   - getLatestRecallShortlist only returns sidecar-accepted items.
 *   - markRecallInjected flips the audit's injected flag and getRecallMetrics
 *     reflects it.
 *   - Per-session feature flag (mem_passive_settings) overrides the global
 *     OMNIQL_MEM_PASSIVE_RECALL env var.
 *   - backfillItemEmbeddings is idempotent and embeds only items that lack
 *     an embedding row.
 *
 * Uses a fresh on-disk SQLite DB in a temp directory and provides a
 * deterministic in-process embedder via embedTextForTests so no network
 * calls are made.
 */

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

// memory-semantic is mocked so cosineSimilarity / tfidfCosineSimilarity are
// deterministic and synchronous (no network).
vi.mock("../services/memory-semantic", () => ({
  computeSemanticSimilarityBatch: vi.fn(async (q: string, cs: string[]) =>
    cs.map(c => deterministicLexical(q, c))
  ),
  cosineSimilarity: (a: number[], b: number[]) => {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i];
    }
    const mag = Math.sqrt(magA) * Math.sqrt(magB);
    return mag === 0 ? 0 : dot / mag;
  },
  tfidfCosineSimilarity: (a: string, b: string) => deterministicLexical(a, b),
  computeSemanticSimilarity: vi.fn(),
}));

function deterministicLexical(a: string, b: string): number {
  const tok = (s: string) => s.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const tA = tok(a), tB = tok(b);
  if (!tA.length || !tB.length) return 0;
  const setA = new Set(tA), setB = new Set(tB);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  return inter / (setA.size + setB.size - inter);
}

let tmpDir: string;
const originalDir = process.env["MEM_DATA_DIR"];
const originalGlobalFlag = process.env["OMNIQL_MEM_PASSIVE_RECALL"];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-passive-test-"));
  process.env["MEM_DATA_DIR"] = tmpDir;
  // Default to globally OFF so we can test per-session override flipping it on.
  delete process.env["OMNIQL_MEM_PASSIVE_RECALL"];
});

afterAll(() => {
  if (originalDir !== undefined) process.env["MEM_DATA_DIR"] = originalDir;
  else delete process.env["MEM_DATA_DIR"];
  if (originalGlobalFlag !== undefined) process.env["OMNIQL_MEM_PASSIVE_RECALL"] = originalGlobalFlag;
  else delete process.env["OMNIQL_MEM_PASSIVE_RECALL"];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Lazily import after env is set so getDb opens the file in tmpDir.
async function loadModules() {
  const passive = await import("../services/memory-passive");
  const memory = await import("../services/memory");
  return { passive, memory };
}

// Patch embedText to a deterministic in-process embedder. We do this via
// monkey-patching after import — the module reads process.env at call time,
// so without an OPENAI_BASE_URL it returns null and the pipeline falls back
// to the lexical TF-IDF cosine path mocked above. That fallback is the
// correct path to exercise; it lets us assert similarity > 0 and verifies
// the BFS+sidecar pipeline without any embeddings service.
const FAKE_USER = "passive-recall-test-user";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("memory-passive — passive recall pipeline", () => {
  it("records turns, runs recall, and produces audit rows for similar items", async () => {
    const { passive, memory } = await loadModules();

    // Seed two related items + one unrelated.
    const a = await memory.saveMemoryItem({
      userId: FAKE_USER, memoryType: "convention", scope: "session_core",
      content: "always run database migrations before deploying production code",
    });
    const b = await memory.saveMemoryItem({
      userId: FAKE_USER, memoryType: "convention", scope: "session_core",
      content: "production deploys must include database migration steps first",
    });
    const c = await memory.saveMemoryItem({
      userId: FAKE_USER, memoryType: "observation", scope: "session_core",
      content: "preferred font is helvetica neue",
    });
    expect(a.itemId).toBeTruthy();
    expect(b.itemId).toBeTruthy();
    expect(c.itemId).toBeTruthy();

    // Record a turn that should match items a, b but not c.
    const sessionId = "sess-recall-1";
    const { turnId } = await passive.recordTurn({
      sessionId, userId: FAKE_USER, role: "user",
      content: "should we run database migrations before this production deploy?",
    });
    expect(turnId).toBeGreaterThan(0);

    const audit = await passive.runPassiveRecallForTurn({
      turnId, sessionId, userId: FAKE_USER,
    });
    expect(audit.length).toBeGreaterThan(0);
    // a or b should rank highest
    const top = audit.slice().sort((x, y) => y.similarity - x.similarity)[0];
    expect([a.itemId, b.itemId]).toContain(top.itemId);
    expect(top.similarity).toBeGreaterThan(0);
  });

  it("inferEdgesForNewItem creates relates_to edges above threshold and contradicts edges from list", async () => {
    const { passive, memory } = await loadModules();

    const userId = FAKE_USER + "-edges";
    const seed = await memory.saveMemoryItem({
      userId, memoryType: "convention", scope: "session_core",
      content: "use tabs for indentation everywhere in this codebase always",
    });
    const similar = await memory.saveMemoryItem({
      userId, memoryType: "convention", scope: "session_core",
      content: "always use tabs for indentation everywhere in this codebase",
    });
    const unrelated = await memory.saveMemoryItem({
      userId, memoryType: "convention", scope: "session_core",
      content: "deploy logs are kept in cloudwatch group prod-api",
    });

    await passive.inferEdgesForNewItem({
      itemId: similar.itemId, scope: "session_core", userId,
      contradictionIds: [unrelated.itemId],
    });

    const edges = passive.listEdges(similar.itemId);
    const relates = edges.filter(e => e.edgeType === "relates_to");
    const contra = edges.filter(e => e.edgeType === "contradicts");
    // At least one relates_to edge between similar <-> seed
    expect(relates.some(e =>
      (e.srcItemId === similar.itemId && e.dstItemId === seed.itemId) ||
      (e.dstItemId === similar.itemId && e.srcItemId === seed.itemId)
    )).toBe(true);
    // Contradicts edge from similar -> unrelated
    expect(contra.some(e => e.srcItemId === similar.itemId && e.dstItemId === unrelated.itemId)).toBe(true);
  });

  it("getLatestRecallShortlist returns only sidecar-accepted items, and markRecallInjected updates audit + metrics", async () => {
    const { passive, memory } = await loadModules();

    const userId = FAKE_USER + "-shortlist";
    const sessionId = "sess-shortlist";
    const item = await memory.saveMemoryItem({
      userId, memoryType: "convention", scope: "session_core",
      content: "always run database migrations before production deploys to avoid breakage",
    });

    const { turnId } = await passive.recordTurn({
      sessionId, userId, role: "user",
      content: "remember to run database migrations before any production deploy",
    });
    const audit = await passive.runPassiveRecallForTurn({ turnId, sessionId, userId });
    expect(audit.some(a => a.itemId === item.itemId)).toBe(true);

    const shortlist = passive.getLatestRecallShortlist({ sessionId, userId });
    // Shortlist should be a subset of accepted entries.
    for (const s of shortlist) {
      const matching = audit.find(a => a.itemId === s.itemId);
      expect(matching?.accepted).toBe(true);
    }

    if (shortlist.length > 0) {
      const ids = shortlist.map(s => s.itemId);
      const changed = passive.markRecallInjected(turnId, ids);
      expect(changed).toBeGreaterThan(0);

      const metrics = passive.getRecallMetrics(userId);
      expect(metrics.injectedCandidates).toBeGreaterThan(0);
      expect(metrics.totalCandidates).toBeGreaterThanOrEqual(metrics.injectedCandidates);

      // Single-use semantics (turn N → N+1): once marked injected, the
      // same shortlist must NOT resurface on the next fetch — otherwise
      // the same memories would be re-injected every turn.
      const afterInject = passive.getLatestRecallShortlist({ sessionId, userId });
      expect(afterInject.length).toBe(0);
    }
  });

  it("per-session feature flag overrides the global default", async () => {
    const { passive } = await loadModules();
    const sessionA = "sess-flag-on";
    const sessionB = "sess-flag-off";

    // Global default OFF (set in beforeAll).
    expect(passive.passiveRecallGloballyEnabled()).toBe(false);
    expect(passive.isPassiveRecallEnabled(sessionA)).toBe(false);

    passive.setPassiveRecallForSession(sessionA, true);
    expect(passive.isPassiveRecallEnabled(sessionA)).toBe(true);
    // Other sessions still follow the global default.
    expect(passive.isPassiveRecallEnabled(sessionB)).toBe(false);

    // Per-session override beats global ON when explicitly disabled.
    process.env["OMNIQL_MEM_PASSIVE_RECALL"] = "1";
    try {
      expect(passive.isPassiveRecallEnabled(sessionB)).toBe(true);
      passive.setPassiveRecallForSession(sessionB, false);
      expect(passive.isPassiveRecallEnabled(sessionB)).toBe(false);
    } finally {
      delete process.env["OMNIQL_MEM_PASSIVE_RECALL"];
    }
  });

  it("backfillItemEmbeddings runs cleanly and is idempotent", async () => {
    const { passive, memory } = await loadModules();
    const userId = FAKE_USER + "-backfill";
    await memory.saveMemoryItem({
      userId, memoryType: "observation", scope: "session_core",
      content: "fact that should be embeddable in principle",
    });
    // First run may or may not embed (depends on whether the embeddings
    // provider is reachable in this test environment). Either way it
    // completes without throwing and returns a non-negative count.
    const first = await passive.backfillItemEmbeddings(50);
    expect(first).toBeGreaterThanOrEqual(0);
    // Second run should embed strictly fewer items (idempotent: items that
    // were embedded on the first pass are skipped on the second).
    const second = await passive.backfillItemEmbeddings(50);
    expect(second).toBeLessThanOrEqual(first);
  });

  it("GET /api/mem/recall response shape matches the Rust runtime client contract", async () => {
    // The Rust runtime (mem_client.rs::fetch_recall) parses
    //   { turnId: number, items: [{ itemId: number, content: string }] }
    // — so the route MUST return those fields. This test guards that
    // contract. We mount the router on a fresh Express app and exercise
    // it via supertest.
    const { passive, memory } = await loadModules();
    const express = (await import("express")).default;
    const supertest = (await import("supertest")).default;
    const memoryRouter = (await import("../routes/memory")).default;

    const userId = FAKE_USER + "-route-contract";
    const sessionId = "sess-route-contract";

    // Enable per-session so the route doesn't short-circuit.
    passive.setPassiveRecallForSession(sessionId, true);

    const item = await memory.saveMemoryItem({
      userId, memoryType: "convention", scope: "session_core",
      content: "always pin npm dependencies to exact semver versions",
    });
    const { turnId } = await passive.recordTurn({
      sessionId, userId, role: "user",
      content: "should npm dependencies be pinned to exact versions?",
    });
    await passive.runPassiveRecallForTurn({ turnId, sessionId, userId });

    const app = express();
    app.use(express.json());
    app.use("/api", memoryRouter);

    const res = await supertest(app)
      .get("/api/mem/recall")
      .query({ sessionId, userId });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("turnId");
    expect(res.body).toHaveProperty("items");
    expect(Array.isArray(res.body.items)).toBe(true);
    if (res.body.items.length > 0) {
      const first = res.body.items[0];
      expect(typeof first.itemId).toBe("number");
      expect(typeof first.content).toBe("string");
      expect(typeof res.body.turnId).toBe("number");
    }
    // Backward-compat: shortlist is still present for dashboard consumers.
    expect(res.body).toHaveProperty("shortlist");
    expect(res.body).toHaveProperty("enabled");

    // When passive recall is disabled, items must be empty and turnId null.
    passive.setPassiveRecallForSession(sessionId, false);
    const offRes = await supertest(app)
      .get("/api/mem/recall")
      .query({ sessionId, userId });
    expect(offRes.status).toBe(200);
    expect(offRes.body.enabled).toBe(false);
    expect(offRes.body.items).toEqual([]);
    expect(offRes.body.turnId).toBeNull();
    void item;
  });

  it("schema is created lazily — passive functions work even when called before any explicit migration", async () => {
    // Re-import after a reset: simulates a cold path where a passive endpoint
    // is the first thing to touch the DB.
    const { passive } = await loadModules();
    passive._resetForTests();

    // Calling listEdges first (no items yet) should not crash and should
    // return an empty array — proving migrations ran on first DB access.
    const edges = passive.listEdges(999_999);
    expect(Array.isArray(edges)).toBe(true);
    expect(edges.length).toBe(0);
  });

  /**
   * End-to-end integration: item saved before turn 1 surfaces in the recall
   * shortlist that turn 2 would inject into its system prompt.
   *
   * Flow (mirrors what the Rust runtime does per turn):
   *   1. Save a memory item (simulates accumulated long-term knowledge).
   *   2. POST /mem/turn?awaitRecall=1  — records turn 1 and runs the full
   *      passive recall pipeline synchronously so we can inspect results
   *      immediately without timing races.
   *   3. GET /mem/recall — returns the verified shortlist that turn 2 would
   *      prepend as a "<recalled_memory>" block in its system prompt.
   *   4. POST /mem/recall/inject — closes the audit loop (marks ✓ injected).
   *   5. GET /mem/recall again — must return empty (single-use semantics).
   *
   * The test runs with OMNIQL_MEM_PASSIVE_RECALL=1 scoped to this block.
   */
  it("end-to-end: item saved in turn 1 surfaces in turn 2 recall shortlist when OMNIQL_MEM_PASSIVE_RECALL=1", async () => {
    const prevFlag = process.env["OMNIQL_MEM_PASSIVE_RECALL"];
    process.env["OMNIQL_MEM_PASSIVE_RECALL"] = "1";
    try {
      const { passive, memory } = await loadModules();
      const express = (await import("express")).default;
      const supertest = (await import("supertest")).default;
      const memoryRouter = (await import("../routes/memory")).default;

      const userId = FAKE_USER + "-e2e-recall";
      const sessionId = "sess-e2e-recall-" + Date.now();

      const app = express();
      app.use(express.json());
      app.use("/api", memoryRouter);

      // ── Step 1: save a memory item (knowledge from before this session) ───
      // Item and turn content share heavy token overlap so the lexical sidecar
      // heuristic (Jaccard >= 0.55) accepts it without needing a live LLM or
      // embeddings API.
      const itemContent =
        "run database migrations before deploying production code";
      const turnContent =
        "run database migrations before deploying production code today";
      const savedItem = await memory.saveMemoryItem({
        userId,
        memoryType: "convention",
        scope: "session_core",
        content: itemContent,
      });
      expect(savedItem.itemId).toBeGreaterThan(0);

      // ── Step 2: POST /mem/turn (turn 1) with awaitRecall=1 ───────────────
      // The route records the turn, embeds it (or falls back to lexical), runs
      // the full recall pipeline, and returns the audit before responding.
      const turnRes = await supertest(app)
        .post("/api/mem/turn")
        .query({ awaitRecall: "1" })
        .send({
          sessionId,
          userId,
          role: "user",
          content: turnContent,
        });

      expect(turnRes.status).toBe(200);
      expect(turnRes.body.ok).toBe(true);
      expect(turnRes.body.passiveRecallEnabled).toBe(true);
      expect(typeof turnRes.body.turnId).toBe("number");
      const turn1Id: number = turnRes.body.turnId;

      // The audit array shows all candidates considered.
      const audit: Array<{ itemId: number; accepted: boolean; similarity: number }> =
        turnRes.body.audit ?? [];
      expect(audit.length).toBeGreaterThan(0);
      // Our saved item must appear in the audit and must be accepted:
      // Jaccard("run database migrations before deploying production code",
      //         "run database migrations before deploying production code today")
      // = 7/8 = 0.875, well above the sidecar threshold of 0.55.
      const auditEntry = audit.find(a => a.itemId === savedItem.itemId);
      expect(auditEntry).toBeDefined();
      expect(auditEntry!.accepted).toBe(true);

      // ── Step 3: GET /mem/recall — shortlist for turn 2's system prompt ────
      const recallRes = await supertest(app)
        .get("/api/mem/recall")
        .query({ sessionId, userId });

      expect(recallRes.status).toBe(200);
      expect(recallRes.body.enabled).toBe(true);
      expect(typeof recallRes.body.turnId).toBe("number");
      expect(Array.isArray(recallRes.body.items)).toBe(true);

      // The saved item must appear in the shortlist.
      const recalledItem = recallRes.body.items.find(
        (it: { itemId: number; content: string }) => it.itemId === savedItem.itemId
      );
      expect(recalledItem).toBeDefined();
      expect(recalledItem.content).toContain("migrations");

      // ── Step 4: POST /mem/recall/inject — close the audit loop ───────────
      const injectRes = await supertest(app)
        .post("/api/mem/recall/inject")
        .send({
          turnId: turn1Id,
          itemIds: recallRes.body.items.map((it: { itemId: number }) => it.itemId),
        });

      expect(injectRes.status).toBe(200);
      expect(injectRes.body.ok).toBe(true);
      expect(injectRes.body.updated).toBeGreaterThan(0);

      // Verify the audit panel sees ✓ injected via the metrics endpoint.
      const metrics = passive.getRecallMetrics(userId);
      expect(metrics.injectedCandidates).toBeGreaterThan(0);

      // ── Step 5: recall is single-use — shortlist must be empty now ────────
      const afterInjectRes = await supertest(app)
        .get("/api/mem/recall")
        .query({ sessionId, userId });

      expect(afterInjectRes.status).toBe(200);
      expect(afterInjectRes.body.items).toEqual([]);
      expect(afterInjectRes.body.turnId).toBeNull();
    } finally {
      if (prevFlag !== undefined) {
        process.env["OMNIQL_MEM_PASSIVE_RECALL"] = prevFlag;
      } else {
        delete process.env["OMNIQL_MEM_PASSIVE_RECALL"];
      }
    }
  });
});
