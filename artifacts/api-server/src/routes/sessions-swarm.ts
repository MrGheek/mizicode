import { Router, type RequestHandler } from "express";
import { db, sessionsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import type { TeamMemberRecord } from "@workspace/db";
import { logger } from "../lib/logger";
import { SwarmSnapshot, CALLBACK_TOKEN, swarmCache, swarmSseSubscribers, STALE_THRESHOLD_MS } from "./sessions-common";

const router = Router();

const handleSwarmPush: RequestHandler = async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  if (CALLBACK_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== CALLBACK_TOKEN) {
      logger.warn({ sessionId }, "Swarm-push callback: invalid token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const snapshot = req.body as SwarmSnapshot;
  if (!snapshot || !snapshot.phase) {
    res.status(400).json({ error: "Missing snapshot phase" });
    return;
  }
  if (!snapshot.timestamp) snapshot.timestamp = new Date().toISOString();

  swarmCache.set(sessionId, { snapshot, receivedAt: Date.now() });

  const sseSubscribers = swarmSseSubscribers.get(sessionId);
  if (sseSubscribers && sseSubscribers.size > 0) {
    for (const cb of sseSubscribers) {
      try { cb(snapshot); } catch { /* ignore broken pipe */ }
    }
  }

  try {
    await db
      .update(sessionsTable)
      .set({ swarmSnapshotJson: snapshot as unknown as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(sessionsTable.id, sessionId));
  } catch (dbErr) {
    logger.warn({ err: dbErr, sessionId }, "Failed to persist swarm snapshot to DB (non-fatal)");
  }

  logger.info({ sessionId, phase: snapshot.phase }, "Swarm snapshot cached");

  let bestSwarmModel: { modelId: string; provider: string } | null = null;
  try {
    const [nimSession] = await db
      .select({ provider: sessionsTable.provider, nimModelId: sessionsTable.nimModelId,
                activeNimModelId: sessionsTable.activeNimModelId,
                activeNimProvider: sessionsTable.activeNimProvider,
                modelRoutingMode: sessionsTable.modelRoutingMode })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));
    if (nimSession?.provider === "nim" && nimSession.modelRoutingMode === "auto") {
      const { getBestModelForPhase } = await import("../services/inference-router");
      const { getConfiguredProviders } = await import("../services/nim-catalog");
      const currentModelId = nimSession.activeNimModelId ?? nimSession.nimModelId ?? "";
      const best = await getBestModelForPhase("swarm", currentModelId, { configuredProviders: getConfiguredProviders() });
      if (best) {
        bestSwarmModel = { modelId: best.model.nimModelId, provider: best.provider };
        logger.debug({ sessionId, ...bestSwarmModel }, "Swarm model re-evaluated at dispatch time");
      }
    }
  } catch (err) {
    logger.debug({ err, sessionId }, "Swarm model re-evaluation skipped (non-fatal)");
  }

  res.json({ ok: true, ...(bestSwarmModel ? { swarmModel: bestSwarmModel } : {}) });
};

router.post("/sessions/:sessionId/swarm-push", handleSwarmPush);

router.post("/sessions/:sessionId/swarm-status", handleSwarmPush);

router.get("/sessions/:sessionId/swarm-status", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  try {
    const [session] = await db
      .select({ status: sessionsTable.status, swarmSnapshotJson: sessionsTable.swarmSnapshotJson })
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

    const cached = swarmCache.get(sessionId);
    const dbSnapshot = session.swarmSnapshotJson as SwarmSnapshot | null;

    if (!cached && !dbSnapshot) {
      res.json({ availability: "unavailable", snapshot: null });
      return;
    }

    if (cached) {
      const ageMs = Date.now() - cached.receivedAt;
      if (ageMs <= STALE_THRESHOLD_MS) {
        res.json({ availability: "live", snapshot: cached.snapshot });
        return;
      }
      res.json({ availability: "stale", snapshot: cached.snapshot });
      return;
    }

    if (dbSnapshot) {
      swarmCache.set(sessionId, { snapshot: dbSnapshot, receivedAt: 0 });
      res.json({ availability: "stale", snapshot: dbSnapshot });
      return;
    }

    res.json({ availability: "unavailable", snapshot: null });
  } catch (err) {
    logger.error(err, "Failed to fetch swarm status");
    res.status(500).json({ error: "Failed to fetch swarm status" });
  }
});

router.get("/sessions/:sessionId/swarm-stream", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const providedToken = typeof req.query["token"] === "string" ? req.query["token"].trim() : "";
  if (!providedToken) {
    res.status(401).json({ error: "Unauthorized: token query parameter is required" });
    return;
  }

  try {
    const [sessionAuth] = await db
      .select({ ownerToken: sessionsTable.ownerToken, teamMembers: sessionsTable.teamMembers })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!sessionAuth) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const isOwner = !!sessionAuth.ownerToken && providedToken === sessionAuth.ownerToken;
    const memberPasswords = (sessionAuth.teamMembers as TeamMemberRecord[] | null ?? []).map((m) => m.password).filter(Boolean);
    const isMember = memberPasswords.some((pw) => pw === providedToken);

    if (!isOwner && !isMember) {
      logger.warn({ sessionId }, "swarm-stream: rejected unauthorized connection attempt");
      res.status(403).json({ error: "Forbidden: valid owner token or member password required" });
      return;
    }
  } catch (authErr) {
    logger.error({ err: authErr, sessionId }, "swarm-stream: auth check failed");
    res.status(500).json({ error: "Internal server error during auth check" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const cb = (snapshot: SwarmSnapshot) => {
    res.write(`data: ${JSON.stringify({ availability: "live", snapshot })}\n\n`);
  };

  const cleanup = () => {
    if (keepAlive) clearInterval(keepAlive);
    const subs = swarmSseSubscribers.get(sessionId);
    if (subs) {
      subs.delete(cb);
      if (subs.size === 0) swarmSseSubscribers.delete(sessionId);
    }
  };

  req.on("close", cleanup);

  try {
    const [session] = await db
      .select({ status: sessionsTable.status, swarmSnapshotJson: sessionsTable.swarmSnapshotJson })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!session) {
      res.write(`data: ${JSON.stringify({ availability: "unavailable", snapshot: null })}\n\n`);
      res.end();
      return;
    }

    const cached = swarmCache.get(sessionId);
    const dbSnapshot = session.swarmSnapshotJson as SwarmSnapshot | null;
    let initialPayload: { availability: string; snapshot: SwarmSnapshot | null };
    if (["pending", "provisioning", "downloading", "starting"].includes(session.status)) {
      initialPayload = { availability: "starting", snapshot: null };
    } else if (cached) {
      const ageMs = Date.now() - cached.receivedAt;
      initialPayload = { availability: ageMs <= STALE_THRESHOLD_MS ? "live" : "stale", snapshot: cached.snapshot };
    } else if (dbSnapshot) {
      initialPayload = { availability: "stale", snapshot: dbSnapshot };
    } else {
      initialPayload = { availability: "unavailable", snapshot: null };
    }
    res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);
  } catch (initErr) {
    logger.warn({ err: initErr, sessionId }, "swarm-stream: failed to send initial snapshot (non-fatal)");
  }

  keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 20000);

  if (!swarmSseSubscribers.has(sessionId)) {
    swarmSseSubscribers.set(sessionId, new Set());
  }
  swarmSseSubscribers.get(sessionId)!.add(cb);
});

router.post("/sessions/:sessionId/swarm/abort", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const authHeader = req.headers["authorization"] || "";
  const providedToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  try {
    const [session] = await db
      .select({ status: sessionsTable.status, ownerToken: sessionsTable.ownerToken })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    if (!session.ownerToken || providedToken !== session.ownerToken) {
      logger.warn({ sessionId, hasToken: !!session.ownerToken }, "Swarm abort: invalid or missing owner token");
      res.status(403).json({ error: "Forbidden: valid owner token required to abort swarm" });
      return;
    }

    if (session.status === "stopped" || session.status === "error") {
      res.status(409).json({ error: "Session is already stopped — nothing to abort" });
      return;
    }

    const abortedTimestamp = new Date().toISOString();
    const cached = swarmCache.get(sessionId);
    const baseSnapshot: SwarmSnapshot = cached?.snapshot ?? {
      phase: "aborted",
      timestamp: abortedTimestamp,
    };
    const abortedSnapshot: SwarmSnapshot = {
      ...baseSnapshot,
      phase: "aborted",
      timestamp: abortedTimestamp,
    };

    swarmCache.set(sessionId, { snapshot: abortedSnapshot, receivedAt: Date.now() });

    try {
      await db
        .update(sessionsTable)
        .set({ swarmSnapshotJson: abortedSnapshot as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(sessionsTable.id, sessionId));
    } catch (dbErr) {
      logger.warn({ err: dbErr, sessionId }, "Failed to persist abort snapshot to DB (non-fatal)");
    }

    logger.info({ sessionId }, "Swarm abort recorded");
    res.json({ ok: true, message: "Abort signal recorded. The runner will process it on next check." });
  } catch (err) {
    logger.error(err, "Failed to process swarm abort");
    res.status(500).json({ error: "Failed to process abort" });
  }
});

router.get("/sessions/swarm-status-batch", async (req, res) => {
  const raw = typeof req.query["ids"] === "string" ? req.query["ids"] : "";
  const ids = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (ids.length === 0) {
    res.json({});
    return;
  }

  try {
    const rows = await db
      .select({ id: sessionsTable.id, status: sessionsTable.status, swarmSnapshotJson: sessionsTable.swarmSnapshotJson })
      .from(sessionsTable)
      .where(inArray(sessionsTable.id, ids));

    const result: Record<number, { availability: string; snapshot: SwarmSnapshot | null }> = {};

    for (const session of rows) {
      const sessionId = session.id;

      if (["pending", "provisioning", "downloading", "starting"].includes(session.status)) {
        result[sessionId] = { availability: "starting", snapshot: null };
        continue;
      }

      const cached = swarmCache.get(sessionId);
      const dbSnapshot = session.swarmSnapshotJson as SwarmSnapshot | null;

      if (!cached && !dbSnapshot) {
        result[sessionId] = { availability: "unavailable", snapshot: null };
        continue;
      }

      if (cached) {
        const ageMs = Date.now() - cached.receivedAt;
        if (ageMs <= STALE_THRESHOLD_MS) {
          result[sessionId] = { availability: "live", snapshot: cached.snapshot };
        } else {
          result[sessionId] = { availability: "stale", snapshot: cached.snapshot };
        }
        continue;
      }

      if (dbSnapshot) {
        swarmCache.set(sessionId, { snapshot: dbSnapshot, receivedAt: 0 });
        result[sessionId] = { availability: "stale", snapshot: dbSnapshot };
        continue;
      }

      result[sessionId] = { availability: "unavailable", snapshot: null };
    }

    res.json(result);
  } catch (err) {
    logger.error(err, "Failed to fetch batch swarm status");
    res.status(500).json({ error: "Failed to fetch batch swarm status" });
  }
});

export default router;
