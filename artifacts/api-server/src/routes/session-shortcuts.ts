/**
 * session-shortcuts.ts
 *
 * Session shortcut endpoints at /api/session/* for the MIZI Theia IDE frontend.
 *
 * These endpoints discover the caller's session from the ownerToken in the
 * Authorization header, so the frontend doesn't need to know the session ID.
 *
 * Mounted at /api/session by routes/index.ts.
 */

import { Router } from "express";
import { db, sessionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { logger } from "../lib/logger";

const router = Router();

// ── Helper: resolve session from owner token ──────────────────────────────────

async function resolveSession(req: import("express").Request):
  Promise<{ session: typeof sessionsTable.$inferSelect | null; error?: string; status?: number }> {
  const providedToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!providedToken) {
    return { session: null, error: "Authorization header with Bearer token required", status: 401 };
  }

  // Try ownerToken match first, then rawBearer match (for API-key-authenticated requests that
  // also pass the session's ownerToken as rawBearer).
  let [session] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.ownerToken, providedToken))
    .orderBy(desc(sessionsTable.updatedAt))
    .limit(1);

  if (!session && req.apiKey) {
    // Fall back to most recent session for this user's API key (if sessions are
    // discoverable without ownerToken — read-only endpoints).
    [session] = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.ownerToken, providedToken))
      .orderBy(desc(sessionsTable.updatedAt))
      .limit(1);
  }

  if (!session) {
    return { session: null, error: "No session found for this token", status: 404 };
  }
  return { session };
}

// ── GET /api/session/id ───────────────────────────────────────────────────────
// Returns session ID and owner token for the current session.

router.get("/id", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) {
    res.status(status ?? 404).json({ error });
    return;
  }
  res.json({ sessionId: session.id, ownerToken: session.ownerToken });
});

// ── GET /api/session/health ────────────────────────────────────────────────────
// Consolidated health/status for the current session.

router.get("/health", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) {
    res.status(status ?? 404).json({ error });
    return;
  }
  const tokenBudget = Number(session.tokenMode === "full" ? 128_000
    : session.tokenMode === "core" ? 65_536
    : session.tokenMode === "lean" ? 32_768
    : session.tokenMode === "ultra" ? 16_384
    : 65_536);
  const tokenUsed = (session.nimTokensIn ?? 0) + (session.nimTokensOut ?? 0);
  res.json({
    sessionId: session.id,
    phase: session.currentPhase ?? "unknown",
    activeModel: session.activeNimModelId ?? session.nimModelId ?? null,
    activeProvider: session.activeNimProvider ?? null,
    modelRoutingMode: session.modelRoutingMode ?? "auto",
    tokenBudget,
    tokenUsed,
    gpuCost: Number(session.totalCost ?? 0),
    status: session.status === "ready" || session.status === "running" ? "healthy"
      : session.status === "starting" || session.status === "pending" ? "degraded"
      : "error",
  });
});

// ── PATCH /api/session/model ──────────────────────────────────────────────────
// Switch the active model for the current session.
// Delegates by redirecting the body to PATCH /api/sessions/:sessionId/model.

router.patch("/model", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) {
    res.status(status ?? 404).json({ error });
    return;
  }
  // Proxy to the existing PATCH /sessions/:sessionId/model logic.
  // Since we can't easily chain routers, we delegate via direct import.
  try {
    const protocol = req.protocol;
    const host = req.get("host") ?? "localhost";
    const baseUrl = `${protocol}://${host}`;
    const proxyResp = await fetch(`${baseUrl}/api/sessions/${session.id}/model`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": req.headers["authorization"] ?? "",
      },
      body: JSON.stringify(req.body),
    });
    const data = await proxyResp.json();
    res.status(proxyResp.status).json(data);
  } catch (err) {
    logger.error({ err, sessionId: session.id }, "Session shortcut: model switch failed");
    res.status(502).json({ error: "Model switch proxy failed" });
  }
});

// ── PATCH /api/session/routing-mode ─────────────────────────────────────────────
// Toggle routing mode for the current session.

router.patch("/routing-mode", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) {
    res.status(status ?? 404).json({ error });
    return;
  }
  const { mode } = req.body as { mode?: string };
  if (mode !== "auto" && mode !== "pinned") {
    res.status(400).json({ error: 'mode must be "auto" or "pinned"' });
    return;
  }
  await db.update(sessionsTable).set({ modelRoutingMode: mode, updatedAt: new Date() }).where(eq(sessionsTable.id, session.id));
  res.json({ ok: true, mode });
});

// ── PATCH /api/session/phase ────────────────────────────────────────────────────
// Set the current phase for the current session.

router.patch("/phase", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) {
    res.status(status ?? 404).json({ error });
    return;
  }
  try {
    const protocol = req.protocol;
    const host = req.get("host") ?? "localhost";
    const baseUrl = `${protocol}://${host}`;
    const proxyResp = await fetch(`${baseUrl}/api/sessions/${session.id}/phase`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": req.headers["authorization"] ?? "",
      },
      body: JSON.stringify(req.body),
    });
    const data = await proxyResp.json();
    res.status(proxyResp.status).json(data);
  } catch (err) {
    logger.error({ err, sessionId: session.id }, "Session shortcut: phase update failed");
    res.status(502).json({ error: "Phase update proxy failed" });
  }
});

// ── GET /api/session/inference-ranking ────────────────────────────────────────────
// Ranked model list for the current session's current phase.

router.get("/inference-ranking", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) {
    res.status(status ?? 404).json({ error });
    return;
  }
  try {
    const { scoreModelsForPhase, VALID_PHASES } = await import("../services/inference-router");
    const { getConfiguredProviders } = await import("../services/nim-catalog");
    const phase = (VALID_PHASES.includes(session.currentPhase as typeof VALID_PHASES[number])
      ? session.currentPhase
      : "implement") as import("../services/inference-router").SessionPhase;
    const configuredProviders = getConfiguredProviders();
    const { getProviderSnapshots } = await import("../services/inference-router");
    const snapshots = await getProviderSnapshots().catch(() => ({}));
    const ranked = await scoreModelsForPhase(phase, { configuredProviders, snapshots });
    res.json({
      phase,
      ranked: ranked.map((s) => ({
        nimModelId: s.model.nimModelId,
        displayName: s.model.displayName,
        provider: s.provider,
        latencyMs: s.latencyMs,
        score: Math.round(s.score * 1000) / 1000,
        qualityComponent: Math.round(s.qualityComponent * 1000) / 1000,
        costComponent: Math.round(s.costComponent * 1000) / 1000,
        throughputComponent: Math.round(s.throughputComponent * 1000) / 1000,
        sweBenchScore: s.model.sweBenchScore ?? null,
        throughputClass: s.model.throughputClass ?? null,
      })),
    });
  } catch (err) {
    logger.error({ err, sessionId: session.id }, "Session shortcut: inference ranking failed");
    res.status(500).json({ error: "Failed to compute ranking" });
  }
});

// ── GET /api/session/swarm-model ──────────────────────────────────────────────────
// Best swarm model for the current session.

router.get("/swarm-model", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) {
    res.status(status ?? 404).json({ error });
    return;
  }
  try {
    const { getBestModelForPhase, scoreModelsForPhase } = await import("../services/inference-router");
    const { getConfiguredProviders } = await import("../services/nim-catalog");
    const currentModelId = session.activeNimModelId ?? session.nimModelId ?? "";
    const configuredProviders = getConfiguredProviders();
    const [best, scored] = await Promise.all([
      getBestModelForPhase("swarm", currentModelId, { configuredProviders }),
      scoreModelsForPhase("swarm", { configuredProviders }),
    ]);
    const bestLatencyMs = best
      ? (scored.find((s) => s.model.nimModelId === best.model.nimModelId && s.provider === best.provider)?.latencyMs ?? null)
      : null;
    res.json({
      sessionId: session.id,
      phase: "swarm",
      recommendation: best
        ? { modelId: best.model.nimModelId, provider: best.provider, latencyMs: bestLatencyMs }
        : null,
      scored: scored.slice(0, 5).map((s) => ({
        modelId: s.model.nimModelId,
        provider: s.provider,
        score: s.score,
        latencyMs: s.latencyMs,
      })),
    });
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, "Session shortcut: swarm model scoring failed");
    res.status(503).json({ error: "Scoring temporarily unavailable" });
  }
});

// ── GET /api/session/model-history ──────────────────────────────────────────────
// Model switch audit log for the current session.

router.get("/model-history", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) {
    res.status(status ?? 404).json({ error });
    return;
  }
  try {
    const { sessionModelSwitchesTable } = await import("@workspace/db");
    const { desc: orderDesc } = await import("drizzle-orm");
    const switches = await db
      .select()
      .from(sessionModelSwitchesTable)
      .where(eq(sessionModelSwitchesTable.sessionId, session.id))
      .orderBy(orderDesc(sessionModelSwitchesTable.switchedAt));
    res.json(switches);
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, "Session shortcut: model history failed");
    res.status(500).json({ error: "Failed to retrieve model history" });
  }
});

export default router;
