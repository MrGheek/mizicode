import { Router, type RequestHandler } from "express";
import { db, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { CALLBACK_TOKEN, PlanSnapshot, planCache, planSseSubscribers, PLAN_STALE_THRESHOLD_MS } from "./sessions-common";

// ── Shared push handler ──────────────────────────────────────────────────────
// Mounted on two paths:
//   POST /sessions/:sessionId/plan-push    — canonical receiver (preferred)
//   POST /sessions/:sessionId/plan-status  — alias for Claw Runner compatibility
//
// The Claw Runner derives its push URL by replacing /status with /plan-status
// on MIZI_CALLBACK_URL, so it always POSTs to /plan-status rather than
// /plan-push. Registering both routes here ensures snapshots are never silently
// dropped without requiring an external proxy rewrite.
//
// GET /sessions/:sessionId/plan-status (below) is the dashboard reader and is
// unaffected — Express matches routes by method, so the GET and POST on the
// same path coexist.

const handlePlanPush: RequestHandler = async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  if (CALLBACK_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== CALLBACK_TOKEN) {
      logger.warn({ sessionId }, "Plan-push callback: invalid token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const snapshot = req.body as PlanSnapshot;
  if (!snapshot) {
    res.status(400).json({ error: "Missing snapshot body" });
    return;
  }
  if (!snapshot.updatedAt) snapshot.updatedAt = new Date().toISOString();

  planCache.set(sessionId, { snapshot, receivedAt: Date.now() });

  const sseSubscribers = planSseSubscribers.get(sessionId);
  if (sseSubscribers && sseSubscribers.size > 0) {
    for (const cb of sseSubscribers) {
      try { cb(snapshot); } catch { /* ignore broken pipe */ }
    }
  }

  try {
    await db
      .update(sessionsTable)
      .set({ planSnapshotJson: snapshot as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(sessionsTable.id, sessionId));
  } catch (dbErr) {
    logger.warn({ err: dbErr, sessionId }, "Failed to persist plan snapshot to DB (non-fatal)");
  }

  logger.info({ sessionId, activeTask: snapshot.activeTask }, "Plan snapshot cached");
  res.json({ ok: true });
};

// ── Router ───────────────────────────────────────────────────────────────────

const router = Router();

// POST /sessions/:sessionId/plan-push — canonical receiver.
router.post("/sessions/:sessionId/plan-push", handlePlanPush);

// POST /sessions/:sessionId/plan-status — alias used by the Claw Runner
// (mirrors the /swarm-status alias pattern).
router.post("/sessions/:sessionId/plan-status", handlePlanPush);

// GET /sessions/:sessionId/plan-status — cockpit polls this every ~5 seconds.
router.get("/sessions/:sessionId/plan-status", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  try {
    const [session] = await db
      .select({ status: sessionsTable.status, planSnapshotJson: sessionsTable.planSnapshotJson })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    if (["pending", "provisioning", "downloading", "starting"].includes(session.status)) {
      res.json({ availability: "starting", snapshot: null });
      return;
    }

    const cached = planCache.get(sessionId);
    const dbSnapshot = session.planSnapshotJson as PlanSnapshot | null;

    if (!cached && !dbSnapshot) {
      res.json({ availability: "unavailable", snapshot: null });
      return;
    }

    if (cached) {
      const ageMs = Date.now() - cached.receivedAt;
      res.json({
        availability: ageMs <= PLAN_STALE_THRESHOLD_MS ? "live" : "stale",
        snapshot: cached.snapshot,
      });
      return;
    }

    if (dbSnapshot) {
      planCache.set(sessionId, { snapshot: dbSnapshot, receivedAt: 0 });
      res.json({ availability: "stale", snapshot: dbSnapshot });
      return;
    }

    res.json({ availability: "unavailable", snapshot: null });
  } catch (err) {
    logger.error(err, "Failed to fetch plan status");
    res.status(500).json({ error: "Failed to fetch plan status" });
  }
});

// GET /sessions/:sessionId/plan-stream — SSE endpoint for live plan updates.
router.get("/sessions/:sessionId/plan-stream", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const cb = (snapshot: PlanSnapshot) => {
    res.write(`data: ${JSON.stringify({ availability: "live", snapshot })}\n\n`);
  };

  const cleanup = () => {
    if (keepAlive) clearInterval(keepAlive);
    const subs = planSseSubscribers.get(sessionId);
    if (subs) {
      subs.delete(cb);
      if (subs.size === 0) planSseSubscribers.delete(sessionId);
    }
  };

  req.on("close", cleanup);

  try {
    const [session] = await db
      .select({ status: sessionsTable.status, planSnapshotJson: sessionsTable.planSnapshotJson })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!session) {
      res.write(`data: ${JSON.stringify({ availability: "unavailable", snapshot: null })}\n\n`);
      res.end();
      return;
    }

    const cached = planCache.get(sessionId);
    const dbSnapshot = session.planSnapshotJson as PlanSnapshot | null;
    let initialPayload: { availability: string; snapshot: PlanSnapshot | null };

    if (["pending", "provisioning", "downloading", "starting"].includes(session.status)) {
      initialPayload = { availability: "starting", snapshot: null };
    } else if (cached) {
      const ageMs = Date.now() - cached.receivedAt;
      initialPayload = { availability: ageMs <= PLAN_STALE_THRESHOLD_MS ? "live" : "stale", snapshot: cached.snapshot };
    } else if (dbSnapshot) {
      initialPayload = { availability: "stale", snapshot: dbSnapshot };
    } else {
      initialPayload = { availability: "unavailable", snapshot: null };
    }
    res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);
  } catch (initErr) {
    logger.warn({ err: initErr, sessionId }, "plan-stream: failed to send initial snapshot (non-fatal)");
  }

  keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 20000);

  if (!planSseSubscribers.has(sessionId)) {
    planSseSubscribers.set(sessionId, new Set());
  }
  planSseSubscribers.get(sessionId)!.add(cb);
});

export default router;
