/**
 * RFC 0001 Phase 4 — embedding dedupe (Layer 3 §11).
 *
 * A turn whose content is a token-level near-duplicate of an already-embedded
 * item reuses that stored vector instead of paying the embeddings API. Verified
 * against a real embeddings HTTP endpoint (in-process stub) so we count actual
 * API calls, and against the savings ledger for attribution.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import Database from "better-sqlite3";
import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";

let server: http.Server;
let port: number;
let embedCalls = 0;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-dedupe-test-"));
const originalDataDir = process.env["MEM_DATA_DIR"];
const originalBase = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
const originalKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

function deterministicVector(text: string): number[] {
  const h = crypto.createHash("sha256").update(text).digest();
  const vec: number[] = [];
  let norm = 0;
  for (let i = 0; i < 8; i++) {
    const v = (h[i]! / 255) * 2 - 1;
    vec.push(v);
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

beforeAll(async () => {
  process.env["MEM_DATA_DIR"] = tmpDir;
  process.env["MIZI_MEM_PASSIVE_RECALL"] = "1";
  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key";

  server = http.createServer((req, res) => {
    if (req.url?.endsWith("/embeddings") && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        embedCalls++;
        const input = (JSON.parse(body) as { input: string[] }).input;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: input.map((t) => ({ embedding: deterministicVector(t) })) }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = `http://127.0.0.1:${port}/v1`;
      resolve();
    });
  });
});

afterAll(async () => {
  server?.close();
  if (originalDataDir !== undefined) process.env["MEM_DATA_DIR"] = originalDataDir;
  else delete process.env["MEM_DATA_DIR"];
  if (originalBase !== undefined) process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = originalBase;
  else delete process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  if (originalKey !== undefined) process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = originalKey;
  else delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

const SEED = "always run database migrations before production deploy";

// 40 unique tokens; a single swapped token leaves IoU = 39/41 ≈ 0.951 ≥ 0.95.
const LONG = Array.from({ length: 40 }, (_, i) => `alpha${String(i).padStart(3, "0")}`).join(" ");
const LONG_NEAR = (() => {
  const t = LONG.split(" ");
  t[7] = "zzz";
  return t.join(" ");
})();

describe("embedding dedupe (RFC 0001 Layer 3 §11)", () => {
  it("reuses a stored vector for near-duplicate turns without extra API calls", async () => {
    const passive = await import("../services/memory-passive");
    const memory = await import("../services/memory");
    const { getSavingStore, _resetSavingsForTest } = await import("../services/token-accounting");
    _resetSavingsForTest();

    const user = "dedupe-user-1";

    // Seed an item; the async write embeds via the stub (1 API call). Wait for
    // BOTH the API call AND the mem_embeddings write so the dedupe sweep below
    // finds a reusable vector.
    const item = await memory.saveMemoryItem({ userId: user, memoryType: "convention", scope: "session_core", content: LONG });
    expect(item.itemId).toBeTruthy();
    const seedWrite = await waitFor(() => {
      try {
        const db = new Database(path.join(tmpDir, "mem.db"), { readonly: true });
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM mem_embeddings`).get() as { n: number }).n;
        db.close();
        return n >= 1 && embedCalls >= 1;
      } catch {
        return false;
      }
    });
    expect(seedWrite).toBe(true);
    expect(embedCalls).toBe(1);

    // Turn 1: near-duplicate (one swapped token of 40) — IoU 39/41≥0.95, no API call.
    await passive.recordTurn({ sessionId: "sess-dedupe-1", userId: user, role: "user", content: LONG_NEAR });
    // Turn 2: byte-identical — IoU 1.0, no API call.
    await passive.recordTurn({ sessionId: "sess-dedupe-1", userId: user, role: "user", content: LONG });

    // Both turns should persist a vector with the reuse marker (asynchronous).
    const dbPath = path.join(tmpDir, "mem.db");
    const rowsHaveReuseMarker = await waitFor(() => {
      try {
        const db = new Database(dbPath, { readonly: true });
        const row = db.prepare(`SELECT COUNT(*) AS n FROM mem_turns WHERE model = ?`).get("cached:near-duplicate") as { n: number };
        db.close();
        return row.n >= 2;
      } catch {
        return false;
      }
    });
    expect(rowsHaveReuseMarker).toBe(true);

    // Same user/session, but the dedupe turn never paid the embeddings API.
    expect(embedCalls).toBe(1);
    await waitFor(() => getSavingStore().all().some((e) => e.kind === "embedding_dedupe"));
    expect(getSavingStore().all().filter((e) => e.kind === "embedding_dedupe").length).toBeGreaterThanOrEqual(2);
  });
});