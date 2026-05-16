/**
 * Workspace Snapshot Routes
 *
 *   GET  /api/sessions/:id/snapshots              — list mizi-created snapshot commits
 *   POST /api/sessions/:id/snapshots/:sha/rollback — roll back to a snapshot commit
 *
 * Auth posture: consistent with other dashboard-accessible session routes (e.g.
 * GET /sessions, GET /sessions/active, POST /sessions/:id/status). These routes
 * are invoked by the operator dashboard via plain browser fetch with no Bearer
 * token. requireAgentAuth is NOT used here — the same pattern as the rest of
 * the sessions API surface that the dashboard consumes directly.
 *
 * The rollback endpoint is protected against misuse by SHA-format validation
 * and a commit-subject check in rollbackToSnapshot (must start with
 * "mizi: snapshot") before any git reset --hard is executed.
 */

import { Router } from "express";
import { isLaneBusy } from "../mcp/tools/bridge";
import { listSnapshots, rollbackToSnapshot } from "../services/snapshot";
import { logger } from "../lib/logger";

const router = Router();

router.get("/sessions/:id/snapshots", async (req, res) => {
  const sessionId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const laneId = parseInt(String(req.query["laneId"] ?? "1"), 10) || 1;

  if (isLaneBusy(sessionId, laneId)) {
    res.status(409).json({ error: "Lane is busy — an agent exec is in progress. Retry after it completes." });
    return;
  }

  try {
    const snapshots = await listSnapshots(sessionId, laneId);
    res.json({ snapshots });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Bridge not connected")) {
      res.status(503).json({ error: "Bridge not connected — session container must be running" });
      return;
    }
    if (msg.includes("timed out")) {
      res.status(504).json({ error: "Bridge command timed out" });
      return;
    }
    logger.error({ err, sessionId, laneId }, "[snapshots] listSnapshots failed");
    res.status(500).json({ error: msg });
  }
});

router.post("/sessions/:id/snapshots/:sha/rollback", async (req, res) => {
  const sessionId = parseInt(String(req.params["id"] ?? ""), 10);
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const sha = String(req.params["sha"] ?? "").trim();
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    res.status(400).json({ error: "Invalid or missing SHA" });
    return;
  }

  const laneId = parseInt(String(req.query["laneId"] ?? "1"), 10) || 1;

  if (isLaneBusy(sessionId, laneId)) {
    res.status(409).json({ error: "Lane is busy — an agent exec is in progress. Rollback is not allowed while the agent is running." });
    return;
  }

  try {
    await rollbackToSnapshot(sessionId, laneId, sha);
    logger.info({ sessionId, laneId, sha }, "[snapshots] Rollback successful");
    res.json({ ok: true, sha });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Bridge not connected")) {
      res.status(503).json({ error: "Bridge not connected — session container must be running" });
      return;
    }
    if (msg.includes("timed out")) {
      res.status(504).json({ error: "Bridge command timed out" });
      return;
    }
    if (msg.includes("is not a mizi-created snapshot commit")) {
      res.status(400).json({ error: msg });
      return;
    }
    logger.error({ err, sessionId, laneId, sha }, "[snapshots] rollback failed");
    res.status(500).json({ error: msg });
  }
});

export default router;
