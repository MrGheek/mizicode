import { Router } from "express";
import { db, sessionsTable, sessionModelSwitchesTable, nimCatalogTable } from "@workspace/db";
import { eq, desc, inArray } from "drizzle-orm";
import * as fly from "../services/fly";
import { logger } from "../lib/logger";

const router = Router();

// ── Phase-aware inference routing (Task #300) ─────────────────────────────────

// PATCH /sessions/:sessionId/phase — update the active reasoning phase for a
// NIM session and optionally trigger automatic model scoring/switching if
// modelRoutingMode is "auto".
// AUTHORIZATION: requires `Authorization: Bearer {ownerToken}`
router.patch("/sessions/:sessionId/phase", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const { phase } = req.body as { phase?: string };
  const VALID_PHASES = ["explore", "plan", "implement", "swarm", "synthesise", "review"];
  if (!phase || !VALID_PHASES.includes(phase)) {
    res.status(400).json({ error: `phase must be one of: ${VALID_PHASES.join(", ")}` });
    return;
  }

  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Owner-only: validate bearer token
  const providedToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!session.ownerToken || providedToken !== session.ownerToken) {
    logger.warn({ sessionId }, "Phase update: invalid or missing owner token");
    res.status(403).json({ error: "Forbidden: valid owner token required" });
    return;
  }

  await db
    .update(sessionsTable)
    .set({ currentPhase: phase, updatedAt: new Date() })
    .where(eq(sessionsTable.id, sessionId));

  // If auto-routing is enabled for this NIM session, score models and execute
  // a switch if the top candidate differs meaningfully from the active model.
  let autoSwitched: { modelId: string; provider: string } | null = null;
  let suggestion: { modelId: string; provider: string } | null = null;
  if (session.provider === "nim" && session.modelRoutingMode === "auto") {
    try {
      const { getBestModelForPhase, getProviderSnapshots } = await import("../services/inference-router");
      const { getConfiguredProviders } = await import("../services/nim-catalog");
      const configuredProviders = getConfiguredProviders();
      // Fetch live provider snapshots once — used for both scoring and liveness gate.
      const snapshots = await getProviderSnapshots().catch(() => ({}));
      const currentModelId = session.activeNimModelId ?? session.nimModelId;
      const currentProvider = session.activeNimProvider ?? session.nimProvider ?? null;
      const best = await getBestModelForPhase(
        phase as import("../services/inference-router").SessionPhase,
        currentModelId,
        { configuredProviders, snapshots, currentProvider },
      );
      if (best) {
        const newProvider = best.provider;
        // Execute the model swap internally (auto mode = no user prompt required).
        // Attempt LiteLLM hot-reload first; persist switch record only on success or
        // when there is no Fly machine (non-Fly sessions don't need a reload).
        // Resolve provider-specific credentials at switch time (same as PATCH /model)
        // so non-NVIDIA providers get correct api_base + api_key.
        let reloadOk = true;
        if (session.flyMachineId) {
          try {
            const { PROVIDER_CONFIG } = await import("../services/nim-catalog");
            const providerCfg = PROVIDER_CONFIG[newProvider];
            const providerApiBase = providerCfg?.apiBase ?? "https://integrate.api.nvidia.com/v1";
            const providerApiKey = providerCfg ? (process.env[providerCfg.envKey] ?? "") : "";
            const result = await fly.execMachine(
              session.flyMachineId,
              ["/opt/mizi/reload-model.sh"],
              {
                LITELLM_MODEL_ID: best.model.nimModelId,
                LITELLM_PROVIDER: newProvider,
                LITELLM_API_BASE: providerApiBase,
                LITELLM_API_KEY: providerApiKey,
              },
            );
            reloadOk = result.exit_code === 0;
            if (!reloadOk) {
              logger.warn({ sessionId, modelId: best.model.nimModelId, stderr: result.stderr },
                "Auto-route: LiteLLM reload failed — staying on current model");
            }
          } catch (err) {
            reloadOk = false;
            logger.warn({ err, sessionId }, "Auto-route: Fly exec failed — staying on current model");
          }
        }

        if (reloadOk) {
          // Persist only after a successful reload (graceful-degradation semantics).
          await db
            .update(sessionsTable)
            .set({ activeNimModelId: best.model.nimModelId, activeNimProvider: newProvider, updatedAt: new Date() })
            .where(eq(sessionsTable.id, sessionId));
          await db.insert(sessionModelSwitchesTable).values({
            sessionId,
            fromModelId: currentModelId ?? null,
            fromProvider: session.activeNimProvider ?? session.nimProvider ?? null,
            toModelId: best.model.nimModelId,
            toProvider: newProvider,
            phase,
            triggeredBy: "auto",
            reason: `phase changed to ${phase}`,
            switchedAt: new Date(),
          });
          autoSwitched = { modelId: best.model.nimModelId, provider: newProvider };
          logger.info({ sessionId, modelId: best.model.nimModelId, phase }, "Auto-route: model switched");
        } else {
          // Return a manual suggestion for the dashboard to action.
          suggestion = { modelId: best.model.nimModelId, provider: newProvider };
        }
      }
    } catch (err) {
      logger.warn({ err, sessionId }, "Inference router scoring failed (non-fatal)");
    }
  }

  res.json({ ok: true, phase, autoSwitched, suggestion });
});

// PATCH /sessions/:sessionId/model — swap the active LLM model for a NIM session.
// Records the switch in session_model_switches and attempts a LiteLLM hot-reload
// via Fly.io exec if the session is hosted on Fly.
// AUTHORIZATION: requires `Authorization: Bearer {ownerToken}`
router.patch("/sessions/:sessionId/model", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  // Accept both `provider` and `providerId` for contract compatibility.
  // Optional tokensIn/tokensOut/costUsd: when the Claw Runner or orchestrator
  // reports actual usage at switch time, we store it for metric-backed cost attribution.
  const { modelId, provider: providerField, providerId, triggeredBy = "manual", reason,
          tokensIn, tokensOut, costUsd } = req.body as {
    modelId?: string;
    provider?: string;
    providerId?: string;
    triggeredBy?: "manual" | "auto";
    reason?: string;
    tokensIn?: number | null;
    tokensOut?: number | null;
    costUsd?: number | null;
  };
  const provider = providerField ?? providerId;

  if (!modelId || typeof modelId !== "string" || modelId.length > 200) {
    res.status(400).json({ error: "modelId (string, max 200 chars) is required" });
    return;
  }
  if (!provider || typeof provider !== "string" || provider.length > 100) {
    res.status(400).json({ error: "provider or providerId (string, max 100 chars) is required" });
    return;
  }

  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Owner-only: validate bearer token
  const providedToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!session.ownerToken || providedToken !== session.ownerToken) {
    logger.warn({ sessionId }, "Model switch: invalid or missing owner token");
    res.status(403).json({ error: "Forbidden: valid owner token required" });
    return;
  }

  if (session.provider !== "nim") {
    res.status(400).json({ error: "Model switching is only supported for NIM sessions" });
    return;
  }

  // Model switching only makes sense on an active session.
  // "ready" is the steady active state for NIM sessions; also allow starting/pending.
  const runningStatuses = ["running", "pending", "starting", "ready"];
  if (!runningStatuses.includes(session.status ?? "")) {
    res.status(409).json({ error: `Cannot switch model: session is in '${session.status}' state (must be ready/running)` });
    return;
  }

  // Validate modelId against the NIM catalog and check provider liveness.
  const [catalogEntry] = await db
    .select({
      nimModelId: nimCatalogTable.nimModelId,
      nimTypes: nimCatalogTable.nimTypes,
      partnerProviders: nimCatalogTable.partnerProviders,
    })
    .from(nimCatalogTable)
    .where(eq(nimCatalogTable.nimModelId, modelId))
    .limit(1);
  if (!catalogEntry) {
    res.status(400).json({ error: `modelId '${modelId}' is not in the NIM catalog` });
    return;
  }

  // Verify the requested provider is configured, serves this model, and is currently live.
  // nvidia is always allowed for preview/free-tier models; partner providers
  // must be both configured in env and listed in the catalog's partnerProviders.
  const { getConfiguredProviders } = await import("../services/nim-catalog");
  const { getProviderSnapshots } = await import("../services/inference-router");
  const configuredProviders = getConfiguredProviders();
  const snapshots: Record<string, import("../services/inference-router").ProviderSnapshot> =
    await getProviderSnapshots().catch(() => ({}));
  const partnerProviders: string[] = Array.isArray(catalogEntry.partnerProviders)
    ? catalogEntry.partnerProviders as string[]
    : [];
  const nimTypes: string[] = Array.isArray(catalogEntry.nimTypes)
    ? catalogEntry.nimTypes as string[]
    : [];
  const isFreeNvidia = provider === "nvidia" && nimTypes.includes("nim_type_preview");
  const isConfiguredPartner = configuredProviders[provider] && partnerProviders.includes(provider);
  if (!isFreeNvidia && !isConfiguredPartner) {
    res.status(400).json({
      error: `Provider '${provider}' is not configured or does not serve model '${modelId}'`,
    });
    return;
  }
  // Liveness gate: reject the switch if the target provider is currently unreachable.
  const snap = snapshots[provider];
  if (snap && !snap.live) {
    res.status(503).json({
      error: `Provider '${provider}' is currently unreachable — model switch aborted`,
    });
    return;
  }

  const prevModelId = session.activeNimModelId ?? session.nimModelId;
  const prevProvider = session.activeNimProvider ?? session.nimProvider;

  // Nothing to do if the requested model is already active.
  if (prevModelId === modelId && prevProvider === provider) {
    res.json({ ok: true, switched: false, modelId, provider });
    return;
  }

  // Attempt LiteLLM hot-reload FIRST (validate liveness before persisting switch).
  // Pass model/provider as env vars — no shell interpolation risk.
  // Sessions without a Fly machine (local dev / non-Fly deploys) skip the reload.
  let reloadResult: { attempted: boolean; exitCode: number | null; ok: boolean } = { attempted: false, exitCode: null, ok: true };
  if (session.flyMachineId) {
    try {
      // Resolve provider-specific credentials at switch time — not from launch-time env.
      // This ensures the new provider's api_base and api_key are written to the LiteLLM
      // config, so inference actually routes to the new upstream.
      const { PROVIDER_CONFIG } = await import("../services/nim-catalog");
      const providerCfg = PROVIDER_CONFIG[provider];
      const providerApiBase = providerCfg?.apiBase ?? "https://integrate.api.nvidia.com/v1";
      const providerApiKey = providerCfg ? (process.env[providerCfg.envKey] ?? "") : "";
      const result = await fly.execMachine(
        session.flyMachineId,
        ["/opt/mizi/reload-model.sh"],
        {
          LITELLM_MODEL_ID: modelId,
          LITELLM_PROVIDER: provider,
          LITELLM_API_BASE: providerApiBase,
          LITELLM_API_KEY: providerApiKey,
        },
      );
      const reloadOk = result.exit_code === 0;
      reloadResult = { attempted: true, exitCode: result.exit_code, ok: reloadOk };
      if (!reloadOk) {
        logger.warn({ sessionId, modelId, provider, stderr: result.stderr },
          "LiteLLM hot-reload failed — aborting model switch to preserve DB consistency");
        res.status(503).json({
          error: "Model switch aborted: LiteLLM reload failed on the session machine",
          reloadResult,
          currentModelId: prevModelId,
          currentProvider: prevProvider,
        });
        return;
      }
      logger.info({ sessionId, modelId, provider }, "LiteLLM hot-reload succeeded");
    } catch (err) {
      logger.warn({ err, sessionId }, "LiteLLM hot-reload exec failed — aborting model switch");
      res.status(503).json({
        error: "Model switch aborted: could not reach session machine for reload",
        currentModelId: prevModelId,
        currentProvider: prevProvider,
      });
      return;
    }
  }

  // Persist only after a successful reload (or for non-Fly sessions where no reload is needed).
  await db
    .update(sessionsTable)
    .set({ activeNimModelId: modelId, activeNimProvider: provider, updatedAt: new Date() })
    .where(eq(sessionsTable.id, sessionId));

  // Record the switch in the audit log.
  // tokensIn/tokensOut/costUsd are optional — populated when the caller (Claw Runner
  // or orchestrator) reports actual usage; NULL otherwise (cost chart uses estimates).
  await db.insert(sessionModelSwitchesTable).values({
    sessionId,
    fromModelId: prevModelId ?? null,
    fromProvider: prevProvider ?? null,
    toModelId: modelId,
    toProvider: provider,
    phase: session.currentPhase ?? null,
    triggeredBy: triggeredBy === "auto" ? "auto" : "manual",
    reason: reason ?? (triggeredBy === "auto" ? "auto phase routing" : "user selected"),
    switchedAt: new Date(),
    ...(tokensIn != null ? { tokensIn } : {}),
    ...(tokensOut != null ? { tokensOut } : {}),
    ...(costUsd != null ? { costUsd: String(costUsd) } : {}),
  });

  res.json({ ok: true, switched: true, modelId, provider, reloadResult });
});

// GET /sessions/:sessionId/model-history — return the model switch audit log for a session.
// Read-only endpoint consumed by the dashboard Inference tab — no owner auth required
// (session data is already visible in the cockpit; ownerToken gates mutations only).
router.get("/sessions/:sessionId/model-history", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const [session] = await db
    .select({ id: sessionsTable.id, nimModelId: sessionsTable.nimModelId, nimProvider: sessionsTable.nimProvider,
              activeNimModelId: sessionsTable.activeNimModelId, activeNimProvider: sessionsTable.activeNimProvider,
              currentPhase: sessionsTable.currentPhase, modelRoutingMode: sessionsTable.modelRoutingMode,
              createdAt: sessionsTable.createdAt })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const switches = await db
    .select()
    .from(sessionModelSwitchesTable)
    .where(eq(sessionModelSwitchesTable.sessionId, sessionId))
    .orderBy(desc(sessionModelSwitchesTable.switchedAt));

  // Enrich each switch with durationMs and estimated cost.
  // Cost estimation uses throughputClass → approx token/s and provider → cost/M tokens.
  // These are rough estimates — real costs depend on actual request volumes — but they
  // provide a useful relative split across models for the cost-attribution chart.
  const THROUGHPUT_TPS: Record<string, number> = { high: 200, standard: 80, economy: 150 };
  const COST_PER_MILLION: Record<string, number> = {
    nvidia: 0.80, vultr: 0.30, together: 0.25, deepinfra: 0.20,
  };

  // Load throughputClass for each distinct toModelId in one batch.
  const distinctModelIds = [...new Set(switches.map((s) => s.toModelId))];
  const catalogRows = distinctModelIds.length > 0
    ? await db
        .select({ nimModelId: nimCatalogTable.nimModelId, throughputClass: nimCatalogTable.throughputClass })
        .from(nimCatalogTable)
        .where(inArray(nimCatalogTable.nimModelId, distinctModelIds))
    : [];
  const throughputByModel = new Map(catalogRows.map((r) => [r.nimModelId, r.throughputClass]));

  // Synthesize the "launch model" interval as the zeroth entry in the timeline.
  // This guarantees the cost-split chart is populated even for sessions that have
  // never triggered a mid-session switch (the common case for pinned-mode sessions
  // and early-phase auto-routed sessions that haven't hit a phase boundary yet).
  // The interval runs from session.createdAt to the first real switch (or now).
  const launchModelId = session.nimModelId;
  const launchProvider = session.nimProvider ?? "nvidia";
  const launchSyntheticSwitch =
    launchModelId
      ? {
          id: -1, // synthetic — not a real DB row
          sessionId,
          fromModelId: null as string | null,
          fromProvider: null as string | null,
          toModelId: launchModelId,
          toProvider: launchProvider,
          reason: "session_launch" as const,
          phase: null as string | null,
          switchedAt: session.createdAt,
          tokensIn: null as number | null,
          tokensOut: null as number | null,
          costUsd: null as string | null,
        }
      : null;

  // Switches arrive newest-first (desc order); reverse to compute chronologically.
  const chronological = [
    ...(launchSyntheticSwitch ? [launchSyntheticSwitch] : []),
    ...[...switches].reverse(),
  ];
  const enriched = chronological.map((sw, i) => {
    const end = i < chronological.length - 1
      ? new Date(chronological[i + 1]!.switchedAt).getTime()
      : Date.now();
    const durationMs = Math.max(end - new Date(sw.switchedAt).getTime(), 0);

    // Prefer real token/cost metrics reported by the caller (stored in DB).
    // Fall back to throughput-class estimates only when real data is absent.
    const realTokensIn = sw.tokensIn ?? null;
    const realTokensOut = sw.tokensOut ?? null;
    const realCostUsd = sw.costUsd != null ? Number(sw.costUsd) : null;

    const hasRealMetrics = realTokensIn != null || realCostUsd != null;

    let estimatedTokens: number;
    let estimatedCostUsd: number;
    if (hasRealMetrics) {
      estimatedTokens = (realTokensIn ?? 0) + (realTokensOut ?? 0);
      estimatedCostUsd = realCostUsd ?? 0;
    } else {
      const tc = throughputByModel.get(sw.toModelId) ?? "standard";
      const tps = THROUGHPUT_TPS[tc] ?? 80;
      const costPerM = COST_PER_MILLION[sw.toProvider] ?? 0.50;
      estimatedTokens = Math.round((durationMs / 1000) * tps);
      estimatedCostUsd = Number(((estimatedTokens / 1_000_000) * costPerM).toFixed(6));
    }

    return { ...sw, durationMs, estimatedTokens, estimatedCostUsd, hasRealMetrics };
  }).reverse(); // back to newest-first for the client

  // Aggregate cost by model for the cost-split summary.
  const costByModel: Record<string, { modelId: string; provider: string; estimatedCostUsd: number; estimatedTokens: number }> = {};
  for (const sw of enriched) {
    const key = `${sw.toModelId}::${sw.toProvider}`;
    if (!costByModel[key]) costByModel[key] = { modelId: sw.toModelId, provider: sw.toProvider, estimatedCostUsd: 0, estimatedTokens: 0 };
    costByModel[key]!.estimatedCostUsd += sw.estimatedCostUsd;
    costByModel[key]!.estimatedTokens += sw.estimatedTokens;
  }
  const costSplit = Object.values(costByModel).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);

  res.json({
    sessionId,
    currentModelId: session.activeNimModelId ?? session.nimModelId,
    currentProvider: session.activeNimProvider ?? session.nimProvider,
    currentPhase: session.currentPhase,
    modelRoutingMode: session.modelRoutingMode ?? "auto",
    switches: enriched,
    costSplit,
    totalEstimatedCostUsd: Number(costSplit.reduce((s, c) => s + c.estimatedCostUsd, 0).toFixed(6)),
    totalEstimatedTokens: costSplit.reduce((s, c) => s + c.estimatedTokens, 0),
  });
});

// GET /sessions/:sessionId/swarm-model — return the best model for the swarm phase
// at the time of the request, using live provider latency data.
// Intended to be called by the Claw Runner immediately before dispatching each
// worker batch, so that swarm workers always get the freshest model recommendation
// rather than the one computed at session launch.
// Read-only — no owner auth required.
router.get("/sessions/:sessionId/swarm-model", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const [session] = await db
    .select({
      provider: sessionsTable.provider,
      nimModelId: sessionsTable.nimModelId,
      activeNimModelId: sessionsTable.activeNimModelId,
      activeNimProvider: sessionsTable.activeNimProvider,
      modelRoutingMode: sessionsTable.modelRoutingMode,
    })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  if (session.provider !== "nim") {
    res.status(400).json({ error: "swarm-model is only available for NIM sessions" });
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
      sessionId,
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
    logger.warn({ err, sessionId }, "swarm-model scoring failed");
    res.status(503).json({ error: "Scoring temporarily unavailable" });
  }
});

// PATCH /sessions/:sessionId/routing-mode — toggle between "auto" and "pinned" routing.
// AUTHORIZATION: requires `Authorization: Bearer {ownerToken}`
router.patch("/sessions/:sessionId/routing-mode", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const { mode } = req.body as { mode?: string };
  if (mode !== "auto" && mode !== "pinned") {
    res.status(400).json({ error: 'mode must be "auto" or "pinned"' });
    return;
  }

  const [session] = await db
    .select({ id: sessionsTable.id, provider: sessionsTable.provider, ownerToken: sessionsTable.ownerToken })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Owner-only: validate bearer token
  const providedToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!session.ownerToken || providedToken !== session.ownerToken) {
    logger.warn({ sessionId }, "Routing mode update: invalid or missing owner token");
    res.status(403).json({ error: "Forbidden: valid owner token required" });
    return;
  }

  if (session.provider !== "nim") {
    res.status(400).json({ error: "Routing mode is only applicable to NIM sessions" });
    return;
  }

  await db.update(sessionsTable).set({ modelRoutingMode: mode, updatedAt: new Date() }).where(eq(sessionsTable.id, sessionId));
  res.json({ ok: true, mode });
});

// GET /sessions/:sessionId/inference-ranking — score all available NIM models
// for the session's current phase and return the ranked list.
// Read-only endpoint consumed by the dashboard Inference tab — no owner auth required.
router.get("/sessions/:sessionId/inference-ranking", async (req, res) => {
  const sessionId = parseInt(String(req.params["sessionId"] ?? ""), 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const [session] = await db
    .select({
      currentPhase: sessionsTable.currentPhase,
      provider: sessionsTable.provider,
      nimProvider: sessionsTable.nimProvider,
    })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
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
    // Pass snapshots so ranking uses the same live probes (avoids double-probe).
    const ranked = await scoreModelsForPhase(phase, { configuredProviders, snapshots });

    // ScoredModel already includes the best `provider` selected by the live scorer.
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
    logger.error({ err, sessionId }, "Failed to compute inference ranking");
    res.status(500).json({ error: "Failed to compute ranking" });
  }
});

export default router;
