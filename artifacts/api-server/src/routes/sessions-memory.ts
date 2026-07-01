import { Router } from "express";
import { logger } from "../lib/logger";
import { listObservations, listSessions, searchMemory, subscribeToObservations, backupDb, restoreDb, addSummary, getGovernanceStats, runStaleSweep, bulkUpdateStaleItems, getReviewNeededCount, listStaleItems, listConflicts } from "../services/memory";
import { listRecallAudit, getRecallMetrics, setPassiveRecallForSession, isPassiveRecallEnabled, passiveRecallGloballyEnabled } from "../services/memory-passive";
import fs from "fs";

const router = Router();

const MEM_USER_ID = process.env["MIZI_MEM_USER_ID"] || "operator";

// Dashboard memory proxy — these routes exist so the dashboard can fetch
// operator-scoped memory without needing the MIZI_MEM_TOKEN bearer header.
// MIZI is a single-operator platform: all sessions share one userId
// (MIZI_MEM_USER_ID, default "operator") for cross-session memory continuity.
// The :sessionId path parameter identifies the Vast.ai/MIZI session for
// route namespacing; memory records are scoped by MEM_USER_ID globally, not
// by individual session, since the intent is cross-session recall.
router.get("/sessions/:sessionId/memory/observations", (_req, res) => {
  const limit = 50;
  try {
    const observations = listObservations(MEM_USER_ID, limit, 0);
    res.json(observations);
  } catch (err) {
    logger.error(err, "Failed to list memory observations for dashboard");
    res.status(500).json({ error: "Failed to list observations" });
  }
});

router.get("/sessions/:sessionId/memory/sessions", (req, res) => {
  const limit = 30;
  const projectPath = (req.query["projectPath"] as string | undefined) || undefined;
  try {
    const sessions = listSessions(MEM_USER_ID, limit, 0, projectPath);
    res.json(sessions);
  } catch (err) {
    logger.error(err, "Failed to list memory sessions for dashboard");
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

// SSE stream: pushes new tool observations in real time as they are recorded.
// The dashboard subscribes when the session is active and falls back to polling when stopped.
router.get("/sessions/:sessionId/memory/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 20000);

  const unsubscribe = subscribeToObservations(MEM_USER_ID, (obs) => {
    res.write(`data: ${JSON.stringify(obs)}\n\n`);
  });

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

router.get("/sessions/:sessionId/memory/search", (req, res) => {
  const q = (req.query["q"] as string | undefined) || "";
  const projectPath = (req.query["projectPath"] as string | undefined) || undefined;
  if (!q.trim()) {
    res.json({ observations: [], sessions: [], totalObservations: 0, totalSessions: 0 });
    return;
  }
  const limit = Math.min(100, Math.max(1, parseInt((req.query["limit"] as string | undefined) || "30", 10) || 30));
  const offset = Math.max(0, parseInt((req.query["offset"] as string | undefined) || "0", 10) || 0);
  try {
    const results = searchMemory(MEM_USER_ID, q, limit, offset, projectPath);
    res.json(results);
  } catch (err) {
    logger.error(err, "Failed to search memory for dashboard");
    res.status(500).json({ error: "Failed to search memory" });
  }
});

router.patch("/sessions/:sessionId/memory/sessions/:memSessionId/summary", (req, res) => {
  const { memSessionId } = req.params;
  const { summary } = req.body as { summary?: string };
  if (typeof summary !== "string") {
    res.status(400).json({ error: "summary (string) is required" });
    return;
  }
  try {
    addSummary(memSessionId, MEM_USER_ID, summary.trim());
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, "Failed to update mem session summary");
    res.status(500).json({ error: "Failed to update summary" });
  }
});

router.get("/memory/search", (req, res) => {
  const q = (req.query["q"] as string | undefined) || "";
  const projectPath = (req.query["projectPath"] as string | undefined) || undefined;
  if (!q.trim()) {
    res.json({ observations: [], sessions: [], totalObservations: 0, totalSessions: 0 });
    return;
  }
  const limit = Math.min(100, Math.max(1, parseInt((req.query["limit"] as string | undefined) || "30", 10) || 30));
  const offset = Math.max(0, parseInt((req.query["offset"] as string | undefined) || "0", 10) || 0);
  try {
    const results = searchMemory(MEM_USER_ID, q, limit, offset, projectPath);
    res.json(results);
  } catch (err) {
    logger.error(err, "Failed to search global memory for dashboard");
    res.status(500).json({ error: "Failed to search memory" });
  }
});

router.patch("/memory/sessions/:memSessionId/summary", (req, res) => {
  const { memSessionId } = req.params;
  const { summary } = req.body as { summary?: string };
  if (typeof summary !== "string") {
    res.status(400).json({ error: "summary (string) is required" });
    return;
  }
  try {
    addSummary(memSessionId, MEM_USER_ID, summary.trim());
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, "Failed to update mem session summary (global proxy)");
    res.status(500).json({ error: "Failed to update summary" });
  }
});

router.get("/memory/sessions", (req, res) => {
  const projectPath = (req.query["projectPath"] as string | undefined) || undefined;
  const limit = Math.min(200, Math.max(1, parseInt((req.query["limit"] as string | undefined) || "100", 10) || 100));
  const offset = Math.max(0, parseInt((req.query["offset"] as string | undefined) || "0", 10) || 0);
  try {
    const sessions = listSessions(MEM_USER_ID, limit, offset, projectPath);
    res.json(sessions);
  } catch (err) {
    logger.error(err, "Failed to list all memory sessions for dashboard");
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

router.get("/memory/governance-stats", (_req, res) => {
  try {
    const stats = getGovernanceStats({ userId: MEM_USER_ID });
    res.json(stats);
  } catch (err) {
    logger.error(err, "Failed to get memory governance stats for dashboard");
    res.status(500).json({ error: "Failed to get governance stats" });
  }
});

router.get("/memory/backup", async (_req, res) => {
  let tmpPath: string | null = null;
  try {
    tmpPath = await backupDb();
    const stat = fs.statSync(tmpPath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="mem-backup-${new Date().toISOString().slice(0, 10)}.db"`);
    res.setHeader("Content-Length", stat.size);
    const stream = fs.createReadStream(tmpPath);
    stream.on("end", () => {
      if (tmpPath) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    });
    stream.on("error", (err) => {
      logger.error(err, "Error streaming memory backup");
      if (!res.headersSent) res.status(500).json({ error: "Failed to stream backup" });
    });
    stream.pipe(res);
  } catch (err) {
    logger.error(err, "Failed to create memory backup");
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    if (!res.headersSent) res.status(500).json({ error: "Failed to create backup" });
  }
});

router.get("/memory/review-count", (_req, res) => {
  try {
    const counts = getReviewNeededCount(MEM_USER_ID);
    res.json(counts);
  } catch (err) {
    logger.error(err, "Failed to get memory review count");
    res.status(500).json({ error: "Failed to get review count" });
  }
});

router.post("/memory/sweep", (_req, res) => {
  try {
    const markedStale = runStaleSweep(MEM_USER_ID);
    const counts = getReviewNeededCount(MEM_USER_ID);
    res.json({ ok: true, markedStale, reviewNeeded: counts });
  } catch (err) {
    logger.error(err, "Failed to run memory stale sweep");
    res.status(500).json({ error: "Failed to run stale sweep" });
  }
});

router.get("/memory/stale", (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt((req.query["limit"] as string | undefined) || "50", 10) || 50));
  const offset = Math.max(0, parseInt((req.query["offset"] as string | undefined) || "0", 10) || 0);
  try {
    const items = listStaleItems({ userId: MEM_USER_ID, limit, offset });
    res.json({ items, count: items.length });
  } catch (err) {
    logger.error(err, "Failed to list stale memory items");
    res.status(500).json({ error: "Failed to list stale items" });
  }
});

// ─── Dashboard proxies for passive recall (Task #225) ───────────────────────

router.get("/memory/recall-audit", (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt((req.query["limit"] as string | undefined) || "50", 10) || 50));
  const offset = Math.max(0, parseInt((req.query["offset"] as string | undefined) || "0", 10) || 0);
  const sessionId = (req.query["sessionId"] as string | undefined) || undefined;
  try {
    const entries = listRecallAudit({ userId: MEM_USER_ID, sessionId, limit, offset });
    res.json({ entries });
  } catch (err) {
    logger.error(err, "Failed to list recall audit for dashboard");
    res.status(500).json({ error: "Failed to list recall audit" });
  }
});

router.get("/memory/recall-metrics", (_req, res) => {
  try {
    const metrics = getRecallMetrics(MEM_USER_ID);
    res.json(metrics);
  } catch (err) {
    logger.error(err, "Failed to get recall metrics for dashboard");
    res.status(500).json({ error: "Failed to get recall metrics" });
  }
});

router.get("/memory/passive-config", (req, res) => {
  const sessionId = (req.query["sessionId"] as string | undefined) || undefined;
  try {
    res.json({
      globalDefault: passiveRecallGloballyEnabled(),
      sessionEnabled: sessionId ? isPassiveRecallEnabled(sessionId) : null,
    });
  } catch (err) {
    logger.error(err, "Failed to get passive config");
    res.status(500).json({ error: "Failed to get passive config" });
  }
});

router.post("/memory/passive-config", (req, res) => {
  const { sessionId, enabled } = req.body as { sessionId?: string; enabled?: boolean };
  if (!sessionId || typeof enabled !== "boolean") {
    res.status(400).json({ error: "sessionId and enabled (boolean) are required" });
    return;
  }
  try {
    setPassiveRecallForSession(sessionId, enabled);
    res.json({ ok: true, sessionId, enabled, globalDefault: passiveRecallGloballyEnabled() });
  } catch (err) {
    logger.error(err, "Failed to set passive config");
    res.status(500).json({ error: "Failed to set passive config" });
  }
});

router.get("/memory/governance/conflicts", (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt((req.query["limit"] as string | undefined) || "20", 10) || 20));
  const offset = Math.max(0, parseInt((req.query["offset"] as string | undefined) || "0", 10) || 0);
  try {
    const conflicts = listConflicts({ userId: MEM_USER_ID, conflictStatus: "open", limit, offset });
    res.json({ conflicts });
  } catch (err) {
    logger.error(err, "Failed to list open conflict groups");
    res.status(500).json({ error: "Failed to list conflicts" });
  }
});

router.patch("/memory/stale/bulk", (req, res) => {
  const { itemIds, action } = req.body as { itemIds?: number[]; action?: string };
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    res.status(400).json({ error: "itemIds (non-empty array) is required" });
    return;
  }
  if (action !== "dismiss" && action !== "retract") {
    res.status(400).json({ error: "action must be 'dismiss' or 'retract'" });
    return;
  }
  try {
    const updated = bulkUpdateStaleItems(MEM_USER_ID, itemIds, action);
    const counts = getReviewNeededCount(MEM_USER_ID);
    res.json({ ok: true, updated, reviewNeeded: counts });
  } catch (err) {
    logger.error(err, "Failed to bulk update stale items");
    res.status(500).json({ error: "Failed to bulk update stale items" });
  }
});

const RESTORE_MAX_BYTES = 200 * 1024 * 1024; // 200 MB

router.post("/memory/restore", (req, res) => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let rejected = false;

  req.on("data", (chunk: Buffer) => {
    if (rejected) return;
    totalBytes += chunk.length;
    if (totalBytes > RESTORE_MAX_BYTES) {
      rejected = true;
      res.status(413).json({ error: "File too large. Restore files must be 200 MB or smaller." });
      res.once("finish", () => req.destroy());
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (rejected) return;
    const buf = Buffer.concat(chunks);
    if (!buf.length) {
      res.status(400).json({ error: "No file data received" });
      return;
    }
    try {
      restoreDb(buf);
      res.json({ ok: true, message: "Memory database restored successfully" });
    } catch (err) {
      logger.error(err, "Failed to restore memory database");
      const msg = err instanceof Error ? err.message : "Failed to restore database";
      res.status(400).json({ error: msg });
    }
  });
  req.on("error", (err) => {
    if (rejected) return;
    logger.error(err, "Error reading restore upload body");
    res.status(500).json({ error: "Failed to read uploaded file" });
  });
});

export default router;
