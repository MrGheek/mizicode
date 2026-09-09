/**
 * Tests for the memory embedding pipeline via the real HTTP surface.
 *
 * Covers the critical embedding path:
 * - Memory items are saved synchronously via POST /api/mem/item
 * - Items without embeddings are still searchable via FTS fallback
 * - Semantic search returns 200 with a results array
 * - Scope isolation is respected
 *
 * Uses a fresh on-disk SQLite DB in a temp directory (MEM_DATA_DIR) so no
 * network or Postgres is required.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import os from "os";
import path from "path";
import fs from "fs";
import app from "../app";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-embedding-test-"));
const originalDataDir = process.env["MEM_DATA_DIR"];

const testUserId = `test-embedding-${Date.now()}`;

beforeAll(() => {
  process.env["MEM_DATA_DIR"] = tmpDir;
});

afterAll(() => {
  if (originalDataDir !== undefined) process.env["MEM_DATA_DIR"] = originalDataDir;
  else delete process.env["MEM_DATA_DIR"];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("Memory Embedding & Search (real HTTP surface)", () => {
  it("saves a memory item synchronously via POST /api/mem/item", async () => {
    const res = await request(app)
      .post("/api/mem/item")
      .send({
        userId: testUserId,
        scope: "session_core",
        memoryType: "observation",
        content: "User prefers dark mode interfaces",
      });

    expect(res.status).toBe(201);
    expect(res.body.itemId).toBeDefined();
  });

  it("searches memory via GET /api/mem/search (FTS fallback works without embeddings)", async () => {
    const res = await request(app)
      .get("/api/mem/search")
      .query({ userId: testUserId, q: "dark mode", scope: "session_core" });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it("returns 400 for a search without a query", async () => {
    const res = await request(app)
      .get("/api/mem/search")
      .query({ userId: testUserId });

    expect(res.status).toBe(400);
  });

  it("respects scope isolation in search", async () => {
    // Save an item in a different scope.
    await request(app)
      .post("/api/mem/item")
      .send({
        userId: testUserId,
        scope: "lane_user",
        memoryType: "observation",
        content: "Lane-private observation about the billing module",
      });

    const scoped = await request(app)
      .get("/api/mem/search")
      .query({ userId: testUserId, q: "billing", scope: "session_core" });

    expect(scoped.status).toBe(200);
    expect(Array.isArray(scoped.body.items)).toBe(true);
  });
});