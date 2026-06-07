/**
 * sessions-local.ts
 *
 * Minimal session router for MIZI_DISTRIBUTION=local.
 *
 * Uses better-sqlite3 directly — zero Drizzle / pgTable / cloud service imports.
 * Mounted by routes/index.ts INSTEAD of routes/sessions.ts when in local mode,
 * so that esbuild can eliminate the cloud sessions module (vastai, fly, vLLM,
 * Neon, Tigris, etc.) from local distribution bundles entirely.
 *
 * Endpoints provided:
 *   POST   /sessions           — create local session (Ollama + ACP)
 *   GET    /sessions           — list sessions from local SQLite
 *   GET    /sessions/:id       — get session by id from local SQLite
 *   GET    /sessions/:id/status — status shortcut (same as GET /:id)
 *   DELETE /sessions/:id       — delete session record
 */

import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger.js";

const router = Router();

const OLLAMA_ENDPOINT = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
// URL the user opens to interact with the local claw runner's web UI.
// Defaults to port 5182 (docker/claw-runner.js PORT constant).
// Override with MIZI_CLAW_CHAT_URL for custom deployments.
const LOCAL_CHAT_PATH = process.env.MIZI_CLAW_CHAT_URL || "http://localhost:5182";

// ── SQLite helper ─────────────────────────────────────────────────────────────

async function openLocalDb() {
  const { default: Database } = await import("better-sqlite3");
  const path = await import("path");
  const os   = await import("os");
  const LOCAL_DB_DIR  = process.env.MIZI_LOCAL_DB_DIR  || path.join(os.homedir(), ".mizi");
  const LOCAL_DB_PATH = process.env.MIZI_LOCAL_DB_PATH || path.join(LOCAL_DB_DIR, "local.db");
  const db = new Database(LOCAL_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

// ── POST /sessions ─────────────────────────────────────────────────────────────
// Create a local session. All cloud-specific body fields are ignored.

router.post("/sessions", async (req: Request, res: Response) => {
  const rawModelId = typeof req.body.localModelId === "string" && req.body.localModelId.trim()
    ? req.body.localModelId.trim()
    : typeof req.body.nimModelId === "string" && req.body.nimModelId.trim()
      ? req.body.nimModelId.trim()
      : "qwen2.5-coder:7b";

  try {
    const { createLocalSessionRecord, startLocalSession } = await import("../services/local.js");
    const record = await createLocalSessionRecord({
      modelId:      rawModelId,
      intentText:   typeof req.body.intentText   === "string" ? req.body.intentText.trim().slice(0, 500) : null,
      templateSlug: typeof req.body.templateSlug === "string" ? req.body.templateSlug : null,
      repoUrl:      typeof req.body.repoUrl       === "string" ? req.body.repoUrl.trim() : null,
    });
    await startLocalSession({
      sessionId:    record.id,
      modelId:      rawModelId,
      templateSlug: typeof req.body.templateSlug === "string" ? req.body.templateSlug : undefined,
    });
    res.status(201).json({
      id:             record.id,
      provider:       "local",
      status:         record.status,
      ollamaEndpoint: record.ollamaEndpoint,
      localChatUrl:   record.localChatUrl,
    });
  } catch (err) {
    logger.error({ err }, "[sessions-local] Failed to create session");
    res.status(500).json({ error: "Failed to create local session", detail: String(err) });
  }
});

// ── GET /sessions ──────────────────────────────────────────────────────────────
// List all sessions from local SQLite, newest first.

router.get("/sessions", async (_req: Request, res: Response) => {
  try {
    const db = await openLocalDb();
    const rows = db.prepare(
      `SELECT id, provider, status, status_message, model_id, intent_text,
              template_slug, repo_url, created_at, updated_at
       FROM sessions ORDER BY created_at DESC LIMIT 100`
    ).all() as Record<string, unknown>[];
    db.close();
    res.json(rows.map(r => ({
      id:             r["id"],
      provider:       r["provider"],
      status:         r["status"],
      statusMessage:  r["status_message"],
      modelId:        r["model_id"],
      intentText:     r["intent_text"],
      templateSlug:   r["template_slug"],
      repoUrl:        r["repo_url"],
      createdAt:      r["created_at"],
      updatedAt:      r["updated_at"],
      ollamaEndpoint: OLLAMA_ENDPOINT,
      localChatUrl:   LOCAL_CHAT_PATH,
    })));
  } catch (err) {
    logger.error({ err }, "[sessions-local] Failed to list sessions");
    res.status(500).json({ error: "Failed to list local sessions", detail: String(err) });
  }
});

// ── GET /sessions/:id ──────────────────────────────────────────────────────────
// Get a single session by numeric id.

router.get("/sessions/:id", async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  try {
    const db  = await openLocalDb();
    const row = db.prepare(
      `SELECT id, provider, status, status_message, model_id, intent_text,
              template_slug, repo_url, created_at, updated_at
       FROM sessions WHERE id = ?`
    ).get(id) as Record<string, unknown> | undefined;
    db.close();
    if (!row) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({
      id:             row["id"],
      provider:       row["provider"],
      status:         row["status"],
      statusMessage:  row["status_message"],
      modelId:        row["model_id"],
      intentText:     row["intent_text"],
      templateSlug:   row["template_slug"],
      repoUrl:        row["repo_url"],
      createdAt:      row["created_at"],
      updatedAt:      row["updated_at"],
      ollamaEndpoint: OLLAMA_ENDPOINT,
      localChatUrl:   LOCAL_CHAT_PATH,
    });
  } catch (err) {
    logger.error({ err, id }, "[sessions-local] Failed to get session");
    res.status(500).json({ error: "Failed to get local session", detail: String(err) });
  }
});

// ── GET /sessions/:id/status ───────────────────────────────────────────────────
// Lightweight status check — same data as GET /:id but semantically a status poll.

router.get("/sessions/:id/status", async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  try {
    const db  = await openLocalDb();
    const row = db.prepare(
      `SELECT id, status, status_message, model_id, updated_at FROM sessions WHERE id = ?`
    ).get(id) as Record<string, unknown> | undefined;
    db.close();
    if (!row) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({
      id:            row["id"],
      status:        row["status"],
      statusMessage: row["status_message"],
      modelId:       row["model_id"],
      updatedAt:     row["updated_at"],
      provider:      "local",
    });
  } catch (err) {
    logger.error({ err, id }, "[sessions-local] Failed to get session status");
    res.status(500).json({ error: "Failed to get session status", detail: String(err) });
  }
});

// ── DELETE /sessions/:id ───────────────────────────────────────────────────────
// Delete a session record from local SQLite.

router.delete("/sessions/:id", async (req: Request, res: Response) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }
  try {
    const db     = await openLocalDb();
    const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    db.close();
    if (result.changes === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    logger.error({ err, id }, "[sessions-local] Failed to delete session");
    res.status(500).json({ error: "Failed to delete local session", detail: String(err) });
  }
});

export default router;
