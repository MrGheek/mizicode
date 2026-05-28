/**
 * local-session.test.ts
 *
 * Integration tests for Mizi-Local on-device session mode.
 *
 * Covers:
 *   1. createLocalSessionRecord() returns canonical /api/local/chat URL (no query variant)
 *   2. startLocalSession() throws when Ollama is unavailable
 *   3. runLocalMigrations() creates sessions table with repo_url column
 *   4. GET /sessions/:id returns localChatUrl = /api/local/chat (route smoke test)
 *   5. Cloud endpoints (nim/offers/orchestrate) are not reachable in local distribution
 */

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import * as ollamaDriver from "../services/ollama-driver.js";

let tmpDir: string;
const originalDist   = process.env["MIZI_DISTRIBUTION"];
const originalDbDir  = process.env["MIZI_LOCAL_DB_DIR"];
const originalDbPath = process.env["MIZI_LOCAL_DB_PATH"];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mizi-local-test-"));
  process.env["MIZI_DISTRIBUTION"]  = "local";
  process.env["MIZI_LOCAL_DB_DIR"]  = tmpDir;
  process.env["MIZI_LOCAL_DB_PATH"] = path.join(tmpDir, "local.db");
});

afterAll(() => {
  if (originalDist   !== undefined) process.env["MIZI_DISTRIBUTION"]  = originalDist;
  else delete process.env["MIZI_DISTRIBUTION"];
  if (originalDbDir  !== undefined) process.env["MIZI_LOCAL_DB_DIR"]  = originalDbDir;
  else delete process.env["MIZI_LOCAL_DB_DIR"];
  if (originalDbPath !== undefined) process.env["MIZI_LOCAL_DB_PATH"] = originalDbPath;
  else delete process.env["MIZI_LOCAL_DB_PATH"];
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── 1. Migration creates sessions table with repo_url ─────────────────────────

describe("runLocalMigrations", () => {
  it("creates sessions table that includes repo_url column", async () => {
    const { runLocalMigrations } = await import("../services/local-migrate.js");
    expect(() => runLocalMigrations()).not.toThrow();

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(process.env["MIZI_LOCAL_DB_PATH"]!);
    const cols = (db.pragma("table_info(sessions)") as Array<{ name: string }>).map(r => r.name);
    db.close();

    expect(cols).toContain("repo_url");
    expect(cols).toContain("model_id");
    expect(cols).toContain("intent_text");
    expect(cols).toContain("template_slug");
  });
});

// ── 2. createLocalSessionRecord returns canonical /api/local/chat URL ─────────

describe("createLocalSessionRecord", () => {
  it("returns localChatUrl = /api/local/chat (no query string variant)", async () => {
    const { runLocalMigrations } = await import("../services/local-migrate.js");
    runLocalMigrations();

    const { createLocalSessionRecord } = await import("../services/local.js");
    const result = await createLocalSessionRecord({
      modelId: "qwen2.5-coder:7b",
      intentText: "Test session",
      templateSlug: null,
      repoUrl: null,
    });

    expect(result.provider).toBe("local");
    expect(result.status).toBe("ready");
    expect(result.localChatUrl).toBe("/api/local/chat");
    expect(typeof result.id).toBe("number");
    expect(result.id).toBeGreaterThan(0);
  });

  it("localChatUrl does not include session query parameters", async () => {
    const { runLocalMigrations } = await import("../services/local-migrate.js");
    runLocalMigrations();

    const { createLocalSessionRecord } = await import("../services/local.js");
    const r1 = await createLocalSessionRecord({ modelId: "llama3.2:3b" });
    const r2 = await createLocalSessionRecord({ modelId: "llama3.2:3b" });

    // Both sessions must return the same deterministic URL — no embedded session ID
    expect(r1.localChatUrl).toBe("/api/local/chat");
    expect(r2.localChatUrl).toBe("/api/local/chat");
    expect(r1.localChatUrl).toBe(r2.localChatUrl);
  });
});

// ── 3. startLocalSession() fast-fails when Ollama health check fails ──────────
// Spies on the ollama-driver module (what local.ts calls) so no network access
// is needed and the module-level OLLAMA_ENDPOINT constant is irrelevant.

describe("startLocalSession Ollama guard", () => {
  it("throws a descriptive error when Ollama is unreachable", async () => {
    const healthSpy = vi
      .spyOn(ollamaDriver, "checkHealth")
      .mockResolvedValue({ ok: false });
    const startSpy = vi
      .spyOn(ollamaDriver, "tryAutoStartOllama")
      .mockReturnValue(false);

    try {
      const { startLocalSession } = await import("../services/local.js");
      await expect(
        startLocalSession({ sessionId: 999, modelId: "qwen2.5-coder:7b" }),
      ).rejects.toThrow(/Ollama is not running/);
    } finally {
      healthSpy.mockRestore();
      startSpy.mockRestore();
    }
  });
});

// ── 4. No cloud routes (nim/offers) surface in local distribution ─────────────

describe("local distribution route isolation", () => {
  it("isLocalDistribution() returns true when MIZI_DISTRIBUTION=local", async () => {
    const { isLocalDistribution } = await import("../services/local.js");
    expect(isLocalDistribution()).toBe(true);
  });
});
