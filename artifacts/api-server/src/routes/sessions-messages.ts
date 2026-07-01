import { Router } from "express";
import { db, sessionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { logger } from "../lib/logger";
import type { SessionRoutingStats } from "@workspace/db";
import {
  CALLBACK_TOKEN,
  SoftInterruptMessage,
  softInterruptQueues,
  softInterruptSseSubscribers,
  getSoftInterruptMessages,
  broadcastSoftInterruptUpdate,
} from "./sessions-common";

const router = Router();

// POST /sessions/:sessionId/messages
router.post("/sessions/:sessionId/messages", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const { text } = req.body as { text?: string };
  if (!text || typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text (non-empty string) is required" });
    return;
  }

  const [session] = await db
    .select({ status: sessionsTable.status })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const msg: SoftInterruptMessage = {
    id: randomBytes(8).toString("hex"),
    sessionId,
    text: text.trim().slice(0, 4000),
    state: "queued",
    sentAt: Date.now(),
    injectedAt: null,
  };

  if (!softInterruptQueues.has(sessionId)) {
    softInterruptQueues.set(sessionId, []);
  }
  softInterruptQueues.get(sessionId)!.push(msg);

  broadcastSoftInterruptUpdate(sessionId, msg);

  logger.info({ sessionId, msgId: msg.id }, "Soft-interrupt message queued");
  res.status(201).json(msg);
});

// GET /sessions/:sessionId/messages
router.get("/sessions/:sessionId/messages", (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }
  res.json(getSoftInterruptMessages(sessionId));
});

// POST /sessions/:sessionId/messages/:msgId/injected
router.post("/sessions/:sessionId/messages/:msgId/injected", (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  const msgId = req.params["msgId"] ?? "";
  if (isNaN(sessionId) || !msgId) {
    res.status(400).json({ error: "Invalid sessionId or msgId" });
    return;
  }

  if (CALLBACK_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== CALLBACK_TOKEN) {
      logger.warn({ sessionId, msgId }, "Messages /injected callback: invalid token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const queue = softInterruptQueues.get(sessionId);
  const msg = queue?.find((m) => m.id === msgId);
  if (!msg) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  if (msg.state === "sent") {
    res.json(msg);
    return;
  }

  msg.state = "sent";
  msg.injectedAt = Date.now();
  broadcastSoftInterruptUpdate(sessionId, msg);

  logger.info({ sessionId, msgId }, "Soft-interrupt message marked injected");
  res.json(msg);
});

// GET /sessions/:sessionId/messages/stream
router.get("/sessions/:sessionId/messages/stream", (req, res) => {
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

  // Send current snapshot so the client doesn't have to poll on connect.
  const existing = getSoftInterruptMessages(sessionId);
  if (existing.length > 0) {
    res.write(`data: ${JSON.stringify({ type: "snapshot", messages: existing })}\n\n`);
  }

  const keepAlive = setInterval(() => { res.write(": ping\n\n"); }, 20000);

  const cb = (msg: SoftInterruptMessage) => {
    res.write(`data: ${JSON.stringify({ type: "update", message: msg })}\n\n`);
  };

  if (!softInterruptSseSubscribers.has(sessionId)) {
    softInterruptSseSubscribers.set(sessionId, new Set());
  }
  softInterruptSseSubscribers.get(sessionId)!.add(cb);

  req.on("close", () => {
    clearInterval(keepAlive);
    const subs = softInterruptSseSubscribers.get(sessionId);
    if (subs) {
      subs.delete(cb);
      if (subs.size === 0) softInterruptSseSubscribers.delete(sessionId);
    }
  });
});

// ── Soft-interrupt telemetry endpoint ────────────────────────────────────────
// POST /sessions/:sessionId/telemetry/soft-interrupts
router.post("/sessions/:sessionId/telemetry/soft-interrupts", (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  if (CALLBACK_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== CALLBACK_TOKEN) {
      logger.warn({ sessionId }, "Soft-interrupt telemetry callback: invalid token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const body = req.body as { events?: unknown[] };
  if (!Array.isArray(body?.events)) {
    res.status(400).json({ error: "events (array) is required" });
    return;
  }

  const safeMs = (v: unknown): number => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  };
  const safeCount = (v: unknown): number => {
    const n = Number(v ?? 1);
    return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 1;
  };

  let accepted = 0;
  for (const raw of body.events) {
    const ev = raw as Record<string, unknown>;
    const timeInQueueMs = safeMs(ev["time_in_queue_ms"]);
    const coalescedWith = safeCount(ev["coalesced_with"]);
    logger.info(
      { sessionId, timeInQueueMs, coalescedWith, event: "soft_interrupt_injected" },
      "Soft interrupt injected — message waited in queue before safe-boundary injection"
    );
    accepted++;
  }

  res.json({ ok: true, accepted });
});

// ── Routing stats endpoints ──────────────────────────────────────────────────
// POST /sessions/:sessionId/routing-stats
router.post("/sessions/:sessionId/routing-stats", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  if (CALLBACK_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== CALLBACK_TOKEN) {
      logger.warn({ sessionId }, "Routing-stats callback: invalid token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const { totalBytesAvoided, totalShielded, totalArtifacts, totalBlocked, routingFailures } = req.body as Partial<SessionRoutingStats>;

  const safeInt = (v: unknown) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  };

  const stats: SessionRoutingStats = {
    totalBytesAvoided: safeInt(totalBytesAvoided),
    totalShielded: safeInt(totalShielded),
    totalArtifacts: safeInt(totalArtifacts),
    totalBlocked: safeInt(totalBlocked),
    routingFailures: safeInt(routingFailures),
    recordedAt: new Date().toISOString(),
  };

  try {
    const result = await db
      .update(sessionsTable)
      .set({ routingStatsJson: stats, updatedAt: new Date() })
      .where(eq(sessionsTable.id, sessionId))
      .returning({ id: sessionsTable.id });

    if (!result.length) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    logger.info({ sessionId, bytesAvoided: stats.totalBytesAvoided }, "Routing stats recorded for session");
    res.json({ ok: true, stats });
  } catch (err) {
    logger.error(err, "Failed to store routing stats");
    res.status(500).json({ error: "Failed to store routing stats" });
  }
});

// GET /sessions/:sessionId/routing-stats
router.get("/sessions/:sessionId/routing-stats", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  try {
    const [session] = await db
      .select({ routingStatsJson: sessionsTable.routingStatsJson })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId));

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    res.json({ stats: session.routingStatsJson ?? null });
  } catch (err) {
    logger.error(err, "Failed to fetch routing stats");
    res.status(500).json({ error: "Failed to fetch routing stats" });
  }
});

// ── Token-usage callback ──────────────────────────────────────────────────────
// POST /sessions/:sessionId/token-usage
router.post("/sessions/:sessionId/token-usage", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  if (CALLBACK_TOKEN) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== CALLBACK_TOKEN) {
      logger.warn({ sessionId }, "Token-usage callback: invalid token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const safeInt = (v: unknown) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  };

  const deltaIn  = safeInt((req.body as Record<string, unknown>)["promptTokens"]);
  const deltaOut = safeInt((req.body as Record<string, unknown>)["completionTokens"]);

  if (deltaIn === 0 && deltaOut === 0) {
    res.json({ ok: true, skipped: true });
    return;
  }

  try {
    const [updated] = await db
      .update(sessionsTable)
      .set({
        nimTokensIn:  sql`COALESCE(${sessionsTable.nimTokensIn},  0) + ${deltaIn}`,
        nimTokensOut: sql`COALESCE(${sessionsTable.nimTokensOut}, 0) + ${deltaOut}`,
        updatedAt: new Date(),
      })
      .where(eq(sessionsTable.id, sessionId))
      .returning({ nimTokensIn: sessionsTable.nimTokensIn, nimTokensOut: sessionsTable.nimTokensOut, nimProvider: sessionsTable.nimProvider });

    if (!updated) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    logger.info({ sessionId, deltaIn, deltaOut, nimTokensIn: updated.nimTokensIn, nimTokensOut: updated.nimTokensOut, provider: updated.nimProvider }, "Token usage recorded");
    res.json({ ok: true, nimTokensIn: updated.nimTokensIn, nimTokensOut: updated.nimTokensOut });
  } catch (err) {
    logger.error(err, "Failed to record token usage");
    res.status(500).json({ error: "Failed to record token usage" });
  }
});

export { softInterruptQueues, softInterruptSseSubscribers };
export default router;
