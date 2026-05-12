/**
 * Coordination API Routes
 *
 * Lane management, claim ownership, conflict detection, handoffs, and heavy job scheduling.
 * All lane overlays are strictly per-lane — Alice's UX overlay is only injected into Alice's
 * prompt path. The session core is the only layer shared across lanes.
 *
 * All responses match the OpenAPI contract in lib/api-spec/openapi.yaml.
 */

import { Router } from "express";
import { requireAgentAuth } from "../middlewares/agent-auth";
import {
  db,
  sessionLanesTable,
  laneClaimsTable,
  laneHandoffsTable,
  laneHeavyJobsTable,
  laneEventsTable,
  sessionsTable,
  sessionRepoContextTable,
  claimPurgeLogsTable,
  customLaneTypesTable,
} from "@workspace/db";
import { eq, and, desc, inArray, asc, sql, lt } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  getLanePolicy,
  getLanePolicyAsync,
  resolveValidLaneType,
  VALID_LANE_TYPES,
  BUILTIN_LANE_TYPE_NAMES,
  LANE_POLICIES,
  computeClaimOverlap,
  estimateBlastRadiusOverlap,
  computeSymbolAwareClaimOverlap,
  estimateBlastRadiusOverlapAnnotated,
  LANE_DEFAULT_TTL_SECONDS,
} from "../services/lane-policy";
import type { ClaimWithSymbols } from "../services/lane-policy";
import {
  enqueueHeavyJob,
  listHeavyJobs,
  markJobRunning,
  markJobCompleted,
  markJobFailed,
  markJobDeferred,
  refreshJobWeights,
  peekNextJob,
} from "../services/heavy-job-scheduler";
import { compileLaneBundles } from "../services/skills-bundler";
import { sweepExpiredClaims, expireStaleClaimsForSession } from "../services/claim-sweeper";
import { emitLaneEvent } from "../services/lane-event-emitter";
import {
  addCoordinationClient,
  removeCoordinationClient,
  broadcastCoordinationUpdate,
  broadcastLaneEvent,
} from "../services/lane-sse-broadcaster";
import type { HeavyJobClass, HeavyJobStatus, HandoffType, ClaimType, SessionLane, LaneClaim, LaneHandoff, LaneHeavyJob } from "@workspace/db";
import { createDraftPullRequest } from "../services/github-pr";
import { getLaneBranchName, getSessionBranchName } from "../services/lane-branch";

const router = Router({ mergeParams: true });

// ─── Per-method agent auth on lane routes ─────────────────────────────────────
// GETs require coordination:read; mutations (POST/PUT/DELETE) require
// coordination:write. MIZI_MEM_TOKEN bearer is accepted as a pass-through by
// requireAgentAuth for internal callers. Dev-mode bypass applies when
// MIZI_MEM_TOKEN is not set (open access, matching memory/ambient posture).

router.get("/sessions/:id/lanes", requireAgentAuth(["coordination:read"]));
router.get("/sessions/:id/lanes/:laneId", requireAgentAuth(["coordination:read"]));
router.post("/sessions/:id/lanes", requireAgentAuth(["coordination:write"]));
router.put("/sessions/:id/lanes/:laneId", requireAgentAuth(["coordination:write"]));
router.post("/sessions/:id/lanes/:laneId/claim", requireAgentAuth(["coordination:write"]));
router.delete("/sessions/:id/lanes/:laneId", requireAgentAuth(["coordination:write"]));
router.delete("/sessions/:id/lanes/:laneId/claim/:claimId", requireAgentAuth(["coordination:write"]));
router.post("/sessions/:id/lanes/:laneId/handoff", requireAgentAuth(["coordination:write"]));
router.get("/sessions/:id/coordination", requireAgentAuth(["coordination:read"]));
router.get("/sessions/:id/conflicts", requireAgentAuth(["coordination:read"]));
router.post("/sessions/:id/heavy-jobs", requireAgentAuth(["coordination:write"]));
router.get("/sessions/:id/heavy-jobs", requireAgentAuth(["coordination:read"]));
router.get("/sessions/:id/heavy-jobs/next", requireAgentAuth(["coordination:read"]));
router.patch("/sessions/:id/heavy-jobs/:jobId", requireAgentAuth(["coordination:write"]));
router.patch("/sessions/:id/lanes/:laneId/handoff/:handoffId", requireAgentAuth(["coordination:write"]));
router.get("/sessions/:id/coordination/stream", requireAgentAuth(["coordination:read"]));
router.get("/sessions/:id/lanes/:laneId/timeline", requireAgentAuth(["coordination:read"]));
router.get("/admin/claim-cleanup-stats", requireAgentAuth(["coordination:read"]));
router.post("/admin/sweep-claims", requireAgentAuth(["coordination:write"]));

// ─── Enums matching OpenAPI contract ──────────────────────────────────────────

const VALID_LANE_STATUSES = ["active", "blocked", "review-needed", "ready-to-merge"] as const;
const VALID_HANDOFF_TYPES: HandoffType[] = ["blocked", "needs_review", "safe_to_merge", "watch_files", "related_lane"];
const VALID_JOB_CLASSES: HeavyJobClass[] = ["indexing", "embedding", "eval", "blast_radius", "compile", "other"];
const VALID_JOB_STATUSES: HeavyJobStatus[] = ["queued", "running", "deferred", "completed", "failed"];

// ─── Claim strength helpers ────────────────────────────────────────────────────

/** Convert API strength float (0-1) to DB enum. */
function strengthToEnum(strength: number): "watching" | "editing" | "owner" {
  if (strength >= 0.75) return "owner";
  if (strength >= 0.4) return "editing";
  return "watching";
}

/** Convert DB claim strength enum to API float. */
function enumToStrength(s: string): number {
  if (s === "owner") return 0.9;
  if (s === "editing") return 0.6;
  return 0.3; // "watching"
}

// ─── Serializers ──────────────────────────────────────────────────────────────

/** Serialize a DB claim row + member identifier to the API LaneClaimItem shape. */
function serializeClaim(claim: LaneClaim, memberIdentifier: string) {
  const symbols = claim.claimSymbols as string[] | null | undefined;
  return {
    id: claim.id,
    laneId: claim.laneId,
    memberIdentifier,
    claimType: claim.claimType,
    resourcePath: claim.pathOrSymbol,
    symbolName: symbols && symbols.length > 0 ? symbols[0] ?? null : null,
    taskDescription: null,
    strength: enumToStrength(claim.claimStrength),
    expiresAt: claim.expiresAt.toISOString(),
    createdAt: claim.claimedAt.toISOString(),
  };
}

/** Serialize a DB lane row to the API LaneResponse shape. */
function serializeLane(lane: SessionLane) {
  return {
    id: lane.id,
    sessionId: lane.sessionId,
    memberIdentifier: lane.memberIdentifier,
    laneType: lane.laneType,
    status: lane.status,
    currentTask: lane.currentTask ?? null,
    tokenMode: lane.tokenMode ?? null,
    overlayBundleId: lane.overlayBundleId ?? null,
    createdAt: lane.createdAt.toISOString(),
    updatedAt: lane.updatedAt.toISOString(),
  };
}

/** Serialize a DB handoff row to the API HandoffResponse shape. */
function serializeHandoff(handoff: LaneHandoff) {
  const meta = (handoff.watchFiles ?? {}) as { toLaneIds?: number[]; resourcePaths?: string[] };
  const status = (handoff.status ?? "pending") as "pending" | "acknowledged" | "dismissed" | "expired";
  return {
    id: handoff.id,
    fromLaneId: handoff.laneId,
    toLaneIds: meta.toLaneIds ?? [],
    handoffType: handoff.handoffType,
    resourcePaths: meta.resourcePaths ?? [],
    message: handoff.notes ?? null,
    status,
    acknowledgedAt: handoff.acknowledgedAt?.toISOString() ?? null,
    prUrl: handoff.prUrl ?? null,
    createdAt: handoff.createdAt.toISOString(),
  };
}

/** Serialize a DB heavy job row to the API HeavyJobResponse shape. */
function serializeJob(job: LaneHeavyJob) {
  return {
    id: job.id,
    sessionId: job.sessionId,
    laneId: job.laneId ?? null,
    memberIdentifier: null,
    jobClass: job.jobClass,
    status: job.status,
    priority: job.priority,
    ageWeight: job.ageWeight,
    laneFairnessWeight: job.laneWeight,
    score: job.effectiveScore,
    payload: job.payload ?? null,
    result: job.result ?? null,
    errorMessage: job.errorDetails ?? null,
    enqueuedAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    deferUntil: job.deferredUntil?.toISOString() ?? null,
  };
}

// ─── ID parser ────────────────────────────────────────────────────────────────

function getSessionId(req: { params: Record<string, string> }): number | null {
  const id = parseInt(req.params["sessionId"] ?? req.params["id"] ?? "");
  return Number.isFinite(id) ? id : null;
}

// ─── GET /api/sessions/:id/lanes ──────────────────────────────────────────────

router.get("/sessions/:id/lanes", async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) { res.status(400).json({ error: "Invalid session ID" }); return; }

  const [session] = await db.select({ id: sessionsTable.id })
    .from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  // Soft-expire stale claims for this session before returning the lane list so
  // callers always see an up-to-date active set without waiting for the background sweeper.
  await expireStaleClaimsForSession(sessionId);

  const lanes = await db.select().from(sessionLanesTable)
    .where(eq(sessionLanesTable.sessionId, sessionId))
    .orderBy(desc(sessionLanesTable.createdAt));

  const lanesWithClaims = await Promise.all(lanes.map(async (lane) => {
    const claims = await db.select().from(laneClaimsTable)
      .where(and(eq(laneClaimsTable.laneId, lane.id), eq(laneClaimsTable.active, true)));
    const policy = await getLanePolicyAsync(lane.laneType);
    return {
      ...serializeLane(lane),
      policy,
      claims: claims.map(c => serializeClaim(c, lane.memberIdentifier)),
    };
  }));

  res.json({ sessionId, lanes: lanesWithClaims, total: lanesWithClaims.length });
});

// ─── POST /api/sessions/:id/lanes ─────────────────────────────────────────────

router.post("/sessions/:id/lanes", async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) { res.status(400).json({ error: "Invalid session ID" }); return; }

  const [session] = await db.select({ id: sessionsTable.id })
    .from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  const { memberIdentifier, laneType, tokenMode, currentTask } = req.body as {
    memberIdentifier?: string;
    laneType?: string;
    tokenMode?: string;
    currentTask?: string;
  };

  if (!memberIdentifier || typeof memberIdentifier !== "string") {
    res.status(400).json({ error: "memberIdentifier is required" });
    return;
  }

  const resolvedLaneType = await resolveValidLaneType(laneType);
  const policy = await getLanePolicyAsync(resolvedLaneType);

  const [lane] = await db.insert(sessionLanesTable).values({
    sessionId,
    memberIdentifier,
    laneType: resolvedLaneType,
    taskMode: policy.defaultTaskMode,
    status: "active",
    tokenMode: tokenMode ?? policy.defaultTokenMode,
    currentTask: currentTask ?? null,
  }).returning();

  logger.info({ laneId: lane.id, sessionId, memberIdentifier, laneType: resolvedLaneType }, "Lane created");
  broadcastCoordinationUpdate(sessionId);
  emitLaneEvent(sessionId, lane.id, "lane_created", { memberIdentifier, laneType: resolvedLaneType });

  // Fire-and-forget: compile per-lane overlay bundles and persist overlayBundleId.
  // Does not block the response — overlay delivery is eventually consistent.
  (async () => {
    try {
      const allLanes = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, sessionId));
      const laneInputs = allLanes.map((l) => ({
        laneId: l.id,
        memberIdentifier: l.memberIdentifier,
        laneType: l.laneType,
        taskMode: l.taskMode ?? undefined,
        tokenMode: l.tokenMode ?? undefined,
      }));
      const ctx = {
        sessionType: "team" as const,
        taskMode: "build" as const,
        modelProfile: "default",
        repoLangs: [],
        tokenMode: "core" as const,
      };
      const result = await compileLaneBundles(sessionId, ctx, laneInputs);
      for (const overlay of result.laneOverlays) {
        if (overlay.overlayBundleId) {
          await db.update(sessionLanesTable)
            .set({ overlayBundleId: overlay.overlayBundleId })
            .where(eq(sessionLanesTable.id, overlay.laneId));
        }
      }
      logger.info({ sessionId, laneCount: laneInputs.length }, "Lane overlay bundles compiled");
    } catch (err) {
      logger.warn({ laneId: lane.id, err }, "Lane overlay compilation failed (non-fatal)");
    }
  })();

  res.status(201).json({
    ...serializeLane(lane),
    policy,
    claims: [],
  });
});

// ─── PUT /api/sessions/:id/lanes/:laneId ──────────────────────────────────────

router.put("/sessions/:id/lanes/:laneId", async (req, res) => {
  const sessionId = getSessionId(req);
  const laneId = parseInt(req.params["laneId"] ?? "");
  if (!sessionId || !Number.isFinite(laneId)) {
    res.status(400).json({ error: "Invalid session or lane ID" }); return;
  }

  const [lane] = await db.select().from(sessionLanesTable)
    .where(and(eq(sessionLanesTable.id, laneId), eq(sessionLanesTable.sessionId, sessionId)));
  if (!lane) { res.status(404).json({ error: "Lane not found" }); return; }

  const { laneType, status, tokenMode, currentTask } = req.body as {
    laneType?: string;
    status?: string;
    tokenMode?: string;
    currentTask?: string | null;
  };

  const updates: Partial<typeof sessionLanesTable.$inferInsert> = { updatedAt: new Date() };
  if (laneType) {
    const resolved = await resolveValidLaneType(laneType);
    updates.laneType = resolved;
  }
  if (status && VALID_LANE_STATUSES.includes(status as typeof VALID_LANE_STATUSES[number])) updates.status = status;
  if (tokenMode) updates.tokenMode = tokenMode;
  if (currentTask !== undefined) updates.currentTask = currentTask;

  const [updated] = await db.update(sessionLanesTable).set(updates)
    .where(eq(sessionLanesTable.id, laneId)).returning();

  broadcastCoordinationUpdate(sessionId);
  res.json(serializeLane(updated));
});

// ─── DELETE /api/sessions/:id/lanes/:laneId ────────────────────────────────────
// Permanently removes a lane and all its child claims. Emits a lane_destroyed
// event so the timeline captures the full lifecycle.

router.delete("/sessions/:id/lanes/:laneId", async (req, res) => {
  const sessionId = getSessionId(req);
  const laneId = parseInt(req.params["laneId"] ?? "");
  if (!sessionId || !Number.isFinite(laneId)) {
    res.status(400).json({ error: "Invalid session or lane ID" }); return;
  }

  const [lane] = await db.select().from(sessionLanesTable)
    .where(and(eq(sessionLanesTable.id, laneId), eq(sessionLanesTable.sessionId, sessionId)));
  if (!lane) { res.status(404).json({ error: "Lane not found" }); return; }

  const [destroyedEvent] = await db.insert(laneEventsTable)
    .values({
      sessionId,
      laneId,
      eventType: "lane_destroyed" as const,
      payload: { memberIdentifier: lane.memberIdentifier, laneType: lane.laneType },
    })
    .returning()
    .catch((err: unknown) => {
      logger.warn({ err, laneId, sessionId }, "lane_destroyed event insert failed (non-fatal)");
      return [];
    });

  await db.delete(laneClaimsTable).where(eq(laneClaimsTable.laneId, laneId));
  await db.delete(laneHandoffsTable).where(eq(laneHandoffsTable.laneId, laneId));
  await db.delete(laneHeavyJobsTable).where(eq(laneHeavyJobsTable.laneId, laneId));
  await db.delete(sessionLanesTable).where(eq(sessionLanesTable.id, laneId));

  if (destroyedEvent) broadcastLaneEvent(sessionId, destroyedEvent);
  broadcastCoordinationUpdate(sessionId);

  logger.info({ laneId, sessionId, memberIdentifier: lane.memberIdentifier }, "Lane destroyed");
  res.status(204).end();
});

// ─── POST /api/sessions/:id/lanes/:laneId/claim ───────────────────────────────

router.post("/sessions/:id/lanes/:laneId/claim", async (req, res) => {
  const sessionId = getSessionId(req);
  const laneId = parseInt(req.params["laneId"] ?? "");
  if (!sessionId || !Number.isFinite(laneId)) {
    res.status(400).json({ error: "Invalid session or lane ID" }); return;
  }

  const [lane] = await db.select().from(sessionLanesTable)
    .where(and(eq(sessionLanesTable.id, laneId), eq(sessionLanesTable.sessionId, sessionId)));
  if (!lane) { res.status(404).json({ error: "Lane not found" }); return; }

  const { claimType, resourcePath, claimSymbols, strength, ttlSeconds, preserveHistory } = req.body as {
    claimType?: ClaimType;
    resourcePath?: string;
    claimSymbols?: string[];
    strength?: number;
    ttlSeconds?: number;
    preserveHistory?: boolean;
  };

  if (!resourcePath || typeof resourcePath !== "string") {
    res.status(400).json({ error: "resourcePath is required" }); return;
  }

  const resolvedStrength = typeof strength === "number" ? Math.max(0, Math.min(1, strength)) : 0.3;
  const claimStrength = strengthToEnum(resolvedStrength);
  const ttl = typeof ttlSeconds === "number" && ttlSeconds > 0 ? ttlSeconds : LANE_DEFAULT_TTL_SECONDS;
  const now = new Date();
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const resolvedSymbols = Array.isArray(claimSymbols) && claimSymbols.length > 0
    ? claimSymbols.filter(s => typeof s === "string" && s.length > 0)
    : null;

  let claim: typeof laneClaimsTable.$inferSelect;

  if (preserveHistory) {
    // History-preserving path: atomically deactivate any existing active claim and insert a fresh row.
    // Wrapped in a transaction so the resource is never left without an active claim if the insert
    // fails, and concurrent preserve-history calls cannot race on the partial-unique index.
    claim = await db.transaction(async (tx) => {
      await tx.update(laneClaimsTable)
        .set({ active: false })
        .where(and(
          eq(laneClaimsTable.laneId, laneId),
          eq(laneClaimsTable.pathOrSymbol, resourcePath),
          eq(laneClaimsTable.active, true),
        ));

      const [inserted] = await tx.insert(laneClaimsTable).values({
        laneId,
        claimType: claimType ?? "file",
        pathOrSymbol: resourcePath,
        claimSymbols: resolvedSymbols as unknown as Record<string, unknown> | null,
        claimedAt: now,
        lastHeartbeatAt: now,
        expiresAt,
        claimStrength,
        active: true,
      }).returning();
      return inserted;
    });
  } else {
    // Default path: atomic upsert — INSERT or refresh the existing active claim in place.
    // The partial unique index on (lane_id, path_or_symbol) WHERE active = true guarantees
    // that concurrent requests cannot produce duplicate active rows.
    const [upserted] = await db.insert(laneClaimsTable).values({
      laneId,
      claimType: claimType ?? "file",
      pathOrSymbol: resourcePath,
      claimSymbols: resolvedSymbols as unknown as Record<string, unknown> | null,
      claimedAt: now,
      lastHeartbeatAt: now,
      expiresAt,
      claimStrength,
      active: true,
    }).onConflictDoUpdate({
      target: [laneClaimsTable.laneId, laneClaimsTable.pathOrSymbol],
      targetWhere: eq(laneClaimsTable.active, true),
      set: {
        claimType: claimType ?? sql`${laneClaimsTable.claimType}`,
        claimStrength,
        claimSymbols: resolvedSymbols as unknown as Record<string, unknown> | null,
        lastHeartbeatAt: now,
        expiresAt,
      },
    }).returning();
    claim = upserted;
  }

  // Detect overlaps with other active lanes in the same session
  const otherLanes = await db.select({ id: sessionLanesTable.id, memberIdentifier: sessionLanesTable.memberIdentifier })
    .from(sessionLanesTable)
    .where(eq(sessionLanesTable.sessionId, sessionId));

  const conflictingLaneIds = otherLanes.filter(l => l.id !== laneId).map(l => l.id);

  type OverlapItem = {
    conflictingLaneId: number;
    conflictingMember: string;
    overlapScore: number;
    blastRadiusOverlap: number;
    recommendation: "no_conflict" | "warn" | "block";
    symbols: string[] | null;
    triggeringEdges: Array<{ fromPath: string; toPath: string; callerSymbol?: string; calleeSymbol?: string }>;
  };
  const overlaps: OverlapItem[] = [];

  if (conflictingLaneIds.length > 0) {
    const otherClaims = await db.select()
      .from(laneClaimsTable)
      .where(and(
        inArray(laneClaimsTable.laneId, conflictingLaneIds),
        eq(laneClaimsTable.active, true),
      ));

    // Index other claims by lane, retaining symbol metadata for symbol-aware detection
    const claimsByLane = new Map<number, ClaimWithSymbols[]>();
    for (const c of otherClaims) {
      const arr = claimsByLane.get(c.laneId) ?? [];
      arr.push({
        pathOrSymbol: c.pathOrSymbol,
        symbols: c.claimSymbols as string[] | null | undefined,
      });
      claimsByLane.set(c.laneId, arr);
    }

    // Load repo graph edges so claim-time overlap detection includes
    // shared-dependency analysis, matching the behaviour of GET /conflicts.
    // Non-blocking: if the session has no repo context yet (e.g. indexing
    // hasn't completed), proceed with edges = [] and only path overlap is
    // considered.
    let repoEdges: Array<{ from: string; to: string }> = [];
    try {
      const [repoCtx] = await db.select({ edgesJson: sessionRepoContextTable.edgesJson })
        .from(sessionRepoContextTable)
        .where(eq(sessionRepoContextTable.sessionId, sessionId))
        .orderBy(desc(sessionRepoContextTable.updatedAt))
        .limit(1);
      if (repoCtx?.edgesJson) {
        repoEdges = (repoCtx.edgesJson as unknown as Array<{ from: string; to: string }>) ?? [];
      }
    } catch (err) {
      logger.warn({ err, sessionId }, "Claim overlap: failed to load repo edges (proceeding without graph data)");
    }

    // The current claim as a ClaimWithSymbols for symbol-aware comparison
    const currentClaimWithSymbols: ClaimWithSymbols = {
      pathOrSymbol: resourcePath,
      symbols: resolvedSymbols,
    };

    for (const [otherId, otherClaimsForLane] of claimsByLane.entries()) {
      // Use symbol-aware overlap when both sides may carry symbol metadata
      const symbolResult = computeSymbolAwareClaimOverlap(
        [currentClaimWithSymbols],
        otherClaimsForLane,
      );

      // Blast-radius check uses file paths (symbol-level blast-radius not yet indexed)
      const blastResult = estimateBlastRadiusOverlapAnnotated(
        [currentClaimWithSymbols],
        otherClaimsForLane,
        repoEdges,
      );

      const overlapScore = symbolResult.score;
      const blastRadiusOverlap = blastResult.score;

      if (overlapScore > 0 || blastRadiusOverlap > 0) {
        const laneInfo = otherLanes.find(l => l.id === otherId);
        const effectiveScore = Math.max(overlapScore, blastRadiusOverlap * 0.75);
        const recommendation: "no_conflict" | "warn" | "block" =
          effectiveScore >= 0.75 ? "block" : effectiveScore >= 0.4 ? "warn" : "no_conflict";

        overlaps.push({
          conflictingLaneId: otherId,
          conflictingMember: laneInfo?.memberIdentifier ?? "unknown",
          overlapScore: Math.round(overlapScore * 100) / 100,
          blastRadiusOverlap: Math.round(blastRadiusOverlap * 100) / 100,
          recommendation,
          symbols: symbolResult.conflictingSymbols.length > 0 ? symbolResult.conflictingSymbols : null,
          triggeringEdges: blastResult.triggeringEdges,
        });
      }
    }
  }

  const overallRecommendation: "no_conflict" | "warn" | "block" =
    overlaps.some(o => o.recommendation === "block") ? "block"
    : overlaps.some(o => o.recommendation === "warn") ? "warn"
    : "no_conflict";

  broadcastCoordinationUpdate(sessionId);
  emitLaneEvent(sessionId, laneId, "claim_created", {
    claimId: claim.id,
    resourcePath,
    claimType: claimType ?? "file",
    strength: claimStrength,
  });
  logger.info({ claimId: claim.id, laneId, resourcePath, overlaps: overlaps.length }, "Lane claim created");
  res.status(201).json({
    claim: serializeClaim(claim, lane.memberIdentifier),
    overlaps,
    overallRecommendation,
  });
});

// ─── DELETE /api/sessions/:id/lanes/:laneId/claim/:claimId ────────────────────
// ?heartbeat=true → refresh heartbeat instead of releasing

router.delete("/sessions/:id/lanes/:laneId/claim/:claimId", async (req, res) => {
  const sessionId = getSessionId(req);
  const laneId = parseInt(req.params["laneId"] ?? "");
  const claimId = parseInt(req.params["claimId"] ?? "");
  if (!sessionId || !Number.isFinite(laneId) || !Number.isFinite(claimId)) {
    res.status(400).json({ error: "Invalid session, lane, or claim ID" }); return;
  }

  // Security: verify the lane belongs to this session BEFORE allowing claim mutation.
  // Without this, callers could forge path params and mutate claims across sessions (IDOR).
  const [lane] = await db.select({ id: sessionLanesTable.id })
    .from(sessionLanesTable)
    .where(and(eq(sessionLanesTable.id, laneId), eq(sessionLanesTable.sessionId, sessionId)));
  if (!lane) { res.status(404).json({ error: "Lane not found in this session" }); return; }

  const [claim] = await db.select().from(laneClaimsTable)
    .where(and(eq(laneClaimsTable.id, claimId), eq(laneClaimsTable.laneId, laneId)));
  if (!claim) { res.status(404).json({ error: "Claim not found" }); return; }

  const isHeartbeat = req.query["heartbeat"] === "true";
  if (isHeartbeat) {
    const ttlSeconds = parseInt(String(req.query["ttlSeconds"] ?? "")) || LANE_DEFAULT_TTL_SECONDS;
    const newExpiry = new Date(Date.now() + ttlSeconds * 1000);
    await db.update(laneClaimsTable)
      .set({ lastHeartbeatAt: new Date(), expiresAt: newExpiry, active: true })
      .where(eq(laneClaimsTable.id, claimId));
    res.json({ claimId, action: "heartbeat_refreshed", expiresAt: newExpiry.toISOString() });
    return;
  }

  await db.delete(laneClaimsTable)
    .where(eq(laneClaimsTable.id, claimId));

  broadcastCoordinationUpdate(sessionId);
  emitLaneEvent(sessionId, laneId, "claim_released", {
    claimId,
    resourcePath: claim.pathOrSymbol,
    claimType: claim.claimType,
  });
  logger.info({ claimId, laneId }, "Lane claim released");
  res.json({ claimId, action: "released", expiresAt: null });
});

// ─── POST /api/sessions/:id/lanes/:laneId/handoff ─────────────────────────────

router.post("/sessions/:id/lanes/:laneId/handoff", async (req, res) => {
  const sessionId = getSessionId(req);
  const laneId = parseInt(req.params["laneId"] ?? "");
  if (!sessionId || !Number.isFinite(laneId)) {
    res.status(400).json({ error: "Invalid session or lane ID" }); return;
  }

  const [lane] = await db.select().from(sessionLanesTable)
    .where(and(eq(sessionLanesTable.id, laneId), eq(sessionLanesTable.sessionId, sessionId)));
  if (!lane) { res.status(404).json({ error: "Lane not found" }); return; }

  const { handoffType, toLaneIds, resourcePaths, message } = req.body as {
    handoffType?: HandoffType;
    toLaneIds?: number[];
    resourcePaths?: string[];
    message?: string;
  };

  if (!handoffType || !VALID_HANDOFF_TYPES.includes(handoffType)) {
    res.status(400).json({ error: `handoffType must be one of: ${VALID_HANDOFF_TYPES.join(", ")}` }); return;
  }

  const [handoff] = await db.insert(laneHandoffsTable).values({
    laneId,
    handoffType,
    notes: message ?? null,
    watchFiles: {
      toLaneIds: toLaneIds ?? [],
      resourcePaths: resourcePaths ?? [],
    } as unknown as Record<string, unknown>,
  }).returning();

  // Auto-update lane status based on handoff type
  const statusMap: Record<HandoffType, string | null> = {
    blocked: "blocked",
    needs_review: "review-needed",
    safe_to_merge: "ready-to-merge",
    watch_files: null,
    related_lane: null,
  };
  const newStatus = statusMap[handoffType];
  if (newStatus) {
    await db.update(sessionLanesTable)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(sessionLanesTable.id, laneId));
  }

  // When a lane signals "safe to merge", attempt to open a draft PR automatically.
  // This is fire-and-forget: PR creation failure must never block the handoff response.
  // The PR URL (if created) is stored in the handoff row so the Team tab can link to it.
  let finalHandoff = handoff;
  if (handoffType === "safe_to_merge") {
    (async () => {
      try {
        const [session] = await db.select({ repoFingerprintJson: sessionsTable.repoFingerprintJson, hasGithubToken: sessionsTable.hasGithubToken })
          .from(sessionsTable)
          .where(eq(sessionsTable.id, sessionId));

        if (!session?.hasGithubToken) return;

        const fp = session.repoFingerprintJson as Record<string, unknown> | null;
        const repoUrl = fp && typeof fp["url"] === "string" ? fp["url"] : null;
        if (!repoUrl) {
          logger.debug({ sessionId, laneId }, "handoff safe_to_merge: no repoUrl in session fingerprint — skipping PR");
          return;
        }

        const headBranch = getLaneBranchName(sessionId, lane.memberIdentifier);
        const baseBranch = getSessionBranchName(sessionId);

        const prTitle = `[MIZI] ${lane.memberIdentifier} — safe to merge into session branch`;
        const prBody = [
          `Auto-opened by MIZI on lane handoff signal (\`safe_to_merge\`).`,
          ``,
          `**Lane:** \`${lane.memberIdentifier}\` (${lane.laneType})`,
          `**Head branch:** \`${headBranch}\``,
          `**Base branch:** \`${baseBranch}\``,
          message ? `**Note:** ${message}` : "",
        ].filter(Boolean).join("\n");

        const prUrl = await createDraftPullRequest({ repoUrl, headBranch, baseBranch, title: prTitle, body: prBody });

        if (prUrl) {
          const [updated] = await db.update(laneHandoffsTable)
            .set({ prUrl })
            .where(eq(laneHandoffsTable.id, handoff.id))
            .returning();
          if (updated) finalHandoff = updated;
          logger.info({ handoffId: handoff.id, prUrl }, "Draft PR opened for safe_to_merge handoff");
          broadcastCoordinationUpdate(sessionId, prUrl);
        }
      } catch (err) {
        logger.warn({ err, handoffId: handoff.id }, "PR creation for safe_to_merge handoff failed (non-fatal)");
      }
    })();
  }

  broadcastCoordinationUpdate(sessionId);
  emitLaneEvent(sessionId, laneId, "handoff_sent", {
    handoffId: handoff.id,
    handoffType,
    toLaneIds: toLaneIds ?? [],
    resourcePaths: resourcePaths ?? [],
  });
  logger.info({ handoffId: handoff.id, laneId, handoffType }, "Lane handoff signal created");
  res.status(201).json(serializeHandoff(finalHandoff));
});

// ─── PATCH /api/sessions/:id/lanes/:laneId/handoff/:handoffId ─────────────────
// Acknowledge or dismiss a handoff signal.

const VALID_HANDOFF_STATUSES = ["acknowledged", "dismissed"] as const;
type HandoffUpdateStatus = typeof VALID_HANDOFF_STATUSES[number];

router.patch("/sessions/:id/lanes/:laneId/handoff/:handoffId", async (req, res) => {
  const sessionId = getSessionId(req);
  const laneId = parseInt(req.params["laneId"] ?? "");
  const handoffId = parseInt(req.params["handoffId"] ?? "");
  if (!sessionId || !Number.isFinite(laneId) || !Number.isFinite(handoffId)) {
    res.status(400).json({ error: "Invalid session, lane, or handoff ID" }); return;
  }

  const [lane] = await db.select({ id: sessionLanesTable.id })
    .from(sessionLanesTable)
    .where(and(eq(sessionLanesTable.id, laneId), eq(sessionLanesTable.sessionId, sessionId)));
  if (!lane) { res.status(404).json({ error: "Lane not found in this session" }); return; }

  // Scope handoff lookup by both handoffId AND laneId to prevent IDOR attacks.
  const [existing] = await db.select().from(laneHandoffsTable)
    .where(and(eq(laneHandoffsTable.id, handoffId), eq(laneHandoffsTable.laneId, laneId)));
  if (!existing) { res.status(404).json({ error: "Handoff not found" }); return; }

  const { status } = req.body as { status?: string };
  if (!status || !VALID_HANDOFF_STATUSES.includes(status as HandoffUpdateStatus)) {
    res.status(400).json({ error: `status must be one of: ${VALID_HANDOFF_STATUSES.join(", ")}` }); return;
  }

  const now = new Date();
  // Update is scoped to both handoffId and laneId for defense in depth.
  const [updated] = await db.update(laneHandoffsTable)
    .set({ status, acknowledgedAt: now })
    .where(and(eq(laneHandoffsTable.id, handoffId), eq(laneHandoffsTable.laneId, laneId)))
    .returning();

  logger.info({ handoffId, laneId, status }, "Handoff signal updated");
  res.json(serializeHandoff(updated));
  broadcastCoordinationUpdate(sessionId);
  if (status === "acknowledged") {
    emitLaneEvent(sessionId, laneId, "handoff_acknowledged", {
      handoffId,
      handoffType: existing.handoffType,
    });
  }
});

// ─── GET /api/sessions/:id/coordination ───────────────────────────────────────

router.get("/sessions/:id/coordination", async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) { res.status(400).json({ error: "Invalid session ID" }); return; }

  // Soft-expire stale claims before building the summary so counts are accurate.
  await expireStaleClaimsForSession(sessionId);

  const lanes = await db.select().from(sessionLanesTable)
    .where(eq(sessionLanesTable.sessionId, sessionId))
    .orderBy(asc(sessionLanesTable.createdAt));

  const laneIds = lanes.map(l => l.id);

  const [allClaims, recentHandoffs, allJobs] = await Promise.all([
    laneIds.length > 0
      ? db.select().from(laneClaimsTable)
          .where(and(inArray(laneClaimsTable.laneId, laneIds), eq(laneClaimsTable.active, true)))
      : Promise.resolve([]),
    laneIds.length > 0
      ? db.select().from(laneHandoffsTable)
          .where(inArray(laneHandoffsTable.laneId, laneIds))
          .orderBy(desc(laneHandoffsTable.createdAt))
          .limit(20)
      : Promise.resolve([]),
    laneIds.length > 0
      ? db.select({ id: laneHeavyJobsTable.id, laneId: laneHeavyJobsTable.laneId, status: laneHeavyJobsTable.status })
          .from(laneHeavyJobsTable)
          .where(and(
            eq(laneHeavyJobsTable.sessionId, sessionId),
            inArray(laneHeavyJobsTable.status, ["queued", "running"] as HeavyJobStatus[]),
          ))
      : Promise.resolve([]),
  ]);

  const claimCountByLane = new Map<number, number>();
  for (const c of allClaims) {
    claimCountByLane.set(c.laneId, (claimCountByLane.get(c.laneId) ?? 0) + 1);
  }

  const handoffCountByLane = new Map<number, number>();
  for (const h of recentHandoffs) {
    handoffCountByLane.set(h.laneId, (handoffCountByLane.get(h.laneId) ?? 0) + 1);
  }

  const jobCountByLane = new Map<number, number>();
  for (const j of allJobs) {
    if (j.laneId) jobCountByLane.set(j.laneId, (jobCountByLane.get(j.laneId) ?? 0) + 1);
  }

  const lanesSummary = lanes.map(lane => ({
    lane: serializeLane(lane),
    activeClaims: claimCountByLane.get(lane.id) ?? 0,
    pendingHandoffs: handoffCountByLane.get(lane.id) ?? 0,
    queuedJobs: jobCountByLane.get(lane.id) ?? 0,
  }));

  res.json({
    sessionId,
    lanes: lanesSummary,
    totalActiveClaims: allClaims.length,
    totalQueuedJobs: allJobs.length,
    pendingHandoffs: recentHandoffs.length,
    recentHandoffs: recentHandoffs.map(serializeHandoff),
  });
});

// ─── GET /api/sessions/:id/conflicts ──────────────────────────────────────────

router.get("/sessions/:id/conflicts", async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) { res.status(400).json({ error: "Invalid session ID" }); return; }

  const lanes = await db.select().from(sessionLanesTable)
    .where(eq(sessionLanesTable.sessionId, sessionId));

  if (lanes.length === 0) {
    res.json({ sessionId, conflicts: [], totalConflicts: 0, highSeverity: 0 });
    return;
  }

  const laneIds = lanes.map(l => l.id);
  const allClaims = await db.select()
    .from(laneClaimsTable)
    .where(and(
      inArray(laneClaimsTable.laneId, laneIds),
      eq(laneClaimsTable.active, true),
    ));

  // Load repo graph edges for blast-radius analysis
  let repoEdges: Array<{ from: string; to: string }> = [];
  try {
    const [repoCtx] = await db.select({ edgesJson: sessionRepoContextTable.edgesJson })
      .from(sessionRepoContextTable)
      .where(eq(sessionRepoContextTable.sessionId, sessionId))
      .orderBy(desc(sessionRepoContextTable.updatedAt))
      .limit(1);
    if (repoCtx?.edgesJson) {
      repoEdges = (repoCtx.edgesJson as unknown as Array<{ from: string; to: string }>) ?? [];
    }
  } catch {
    // Non-blocking: proceed without graph data
  }

  const claimsByLane = new Map<number, typeof allClaims>();
  for (const claim of allClaims) {
    const arr = claimsByLane.get(claim.laneId) ?? [];
    arr.push(claim);
    claimsByLane.set(claim.laneId, arr);
  }

  type ConflictItem = {
    laneIdA: number;
    laneIdB: number;
    memberA: string;
    memberB: string;
    overlapScore: number;
    blastRadiusOverlap: number;
    conflictingResources: string[];
    recommendation: "no_conflict" | "warn" | "block";
    detail: string;
    symbols: string[] | null;
  };
  const conflicts: ConflictItem[] = [];

  const laneList = Array.from(claimsByLane.keys());
  for (let i = 0; i < laneList.length; i++) {
    for (let j = i + 1; j < laneList.length; j++) {
      const idA = laneList[i]!;
      const idB = laneList[j]!;
      const claimsForA: ClaimWithSymbols[] = (claimsByLane.get(idA) ?? []).map(c => ({
        pathOrSymbol: c.pathOrSymbol,
        symbols: c.claimSymbols as string[] | null | undefined,
      }));
      const claimsForB: ClaimWithSymbols[] = (claimsByLane.get(idB) ?? []).map(c => ({
        pathOrSymbol: c.pathOrSymbol,
        symbols: c.claimSymbols as string[] | null | undefined,
      }));

      // Use symbol-aware overlap so distinct functions in the same file don't conflict
      const symbolResult = computeSymbolAwareClaimOverlap(claimsForA, claimsForB);

      // Annotated blast-radius check preserves file-level dependency info + edge symbols
      const blastResult = estimateBlastRadiusOverlapAnnotated(claimsForA, claimsForB, repoEdges);

      const overlapScore = symbolResult.score;
      const blastRadiusOverlap = blastResult.score;

      if (overlapScore > 0 || blastRadiusOverlap > 0) {
        const laneA = lanes.find(l => l.id === idA);
        const laneB = lanes.find(l => l.id === idB);

        const effectiveScore = Math.max(overlapScore, blastRadiusOverlap * 0.75);
        const recommendation: "no_conflict" | "warn" | "block" =
          effectiveScore >= 0.75 ? "block" : effectiveScore >= 0.4 ? "warn" : "no_conflict";

        // Build a detail message that reflects whether symbol-level info is available
        let detail: string;
        if (symbolResult.conflictingSymbols.length > 0) {
          const symList = symbolResult.conflictingSymbols.slice(0, 3).join(", ");
          const more = symbolResult.conflictingSymbols.length > 3
            ? ` and ${symbolResult.conflictingSymbols.length - 3} more` : "";
          detail = overlapScore >= 0.75
            ? `High overlap on symbol(s): ${symList}${more} — coordinate before proceeding`
            : `Symbol conflict detected: ${symList}${more}`;
        } else if (blastRadiusOverlap > 0) {
          const edgeDetail = blastResult.triggeringEdges.length > 0 && blastResult.triggeringEdges[0]?.callerSymbol
            ? ` via ${blastResult.triggeringEdges[0].callerSymbol} → ${blastResult.triggeringEdges[0].toPath}`
            : "";
          detail = `Blast-radius overlap detected: shared dependencies may cause conflicts${edgeDetail}`;
        } else if (overlapScore >= 0.75) {
          detail = "High overlap: coordinate with the other lane before proceeding";
        } else {
          detail = "Low overlap: worth monitoring";
        }

        conflicts.push({
          laneIdA: idA,
          laneIdB: idB,
          memberA: laneA?.memberIdentifier ?? "unknown",
          memberB: laneB?.memberIdentifier ?? "unknown",
          overlapScore: Math.round(overlapScore * 100) / 100,
          blastRadiusOverlap: Math.round(blastRadiusOverlap * 100) / 100,
          conflictingResources: symbolResult.conflictingResources,
          recommendation,
          detail,
          symbols: symbolResult.conflictingSymbols.length > 0 ? symbolResult.conflictingSymbols : null,
        });
      }
    }
  }

  const highSeverity = conflicts.filter(c => c.recommendation === "block").length;
  res.json({ sessionId, conflicts, totalConflicts: conflicts.length, highSeverity });
});

// ─── POST /api/sessions/:id/heavy-jobs ────────────────────────────────────────

router.post("/sessions/:id/heavy-jobs", async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) { res.status(400).json({ error: "Invalid session ID" }); return; }

  const [session] = await db.select({ id: sessionsTable.id })
    .from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  const { jobClass, laneId, priority, payload } = req.body as {
    jobClass?: string;
    laneId?: number;
    priority?: number;
    payload?: Record<string, unknown>;
  };

  if (!jobClass || !VALID_JOB_CLASSES.includes(jobClass as HeavyJobClass)) {
    res.status(400).json({ error: `jobClass must be one of: ${VALID_JOB_CLASSES.join(", ")}` }); return;
  }

  const job = await enqueueHeavyJob({
    sessionId,
    laneId,
    jobClass: jobClass as HeavyJobClass,
    priority: priority ?? 5,
    payload,
  });

  broadcastCoordinationUpdate(sessionId);
  res.status(201).json(serializeJob(job));
});

// ─── GET /api/sessions/:id/heavy-jobs ─────────────────────────────────────────

router.get("/sessions/:id/heavy-jobs", async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) { res.status(400).json({ error: "Invalid session ID" }); return; }

  const rawStatus = req.query["status"] as string | undefined;
  let statusFilter: HeavyJobStatus[] | undefined;
  if (rawStatus) {
    const parts = rawStatus.split(",").map(s => s.trim()) as HeavyJobStatus[];
    const invalid = parts.filter(s => !VALID_JOB_STATUSES.includes(s));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Invalid status values: ${invalid.join(", ")}. Must be one of: ${VALID_JOB_STATUSES.join(", ")}` });
      return;
    }
    statusFilter = parts;
  }

  await refreshJobWeights(sessionId);
  const jobs = await listHeavyJobs(sessionId, statusFilter);
  res.json({ sessionId, jobs: jobs.map(serializeJob), total: jobs.length });
});

// ─── GET /api/sessions/:id/heavy-jobs/next ────────────────────────────────────
// Returns the single highest-scored queued job without dequeuing it.
// Lets external orchestrators poll for work and decide scheduling timing.

router.get("/sessions/:id/heavy-jobs/next", async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) { res.status(400).json({ error: "Invalid session ID" }); return; }

  const job = await peekNextJob(sessionId);
  if (!job) {
    res.status(204).end();
    return;
  }
  res.json({ sessionId, job: serializeJob(job) });
});

// ─── PATCH /api/sessions/:id/heavy-jobs/:jobId ────────────────────────────────

router.patch("/sessions/:id/heavy-jobs/:jobId", async (req, res) => {
  const sessionId = getSessionId(req);
  const jobId = parseInt(req.params["jobId"] ?? "");
  if (!sessionId || !Number.isFinite(jobId)) {
    res.status(400).json({ error: "Invalid session or job ID" }); return;
  }

  const [job] = await db.select().from(laneHeavyJobsTable)
    .where(and(eq(laneHeavyJobsTable.id, jobId), eq(laneHeavyJobsTable.sessionId, sessionId)));
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }

  const { status, result, errorMessage, deferUntilSeconds } = req.body as {
    status?: string;
    result?: Record<string, unknown>;
    errorMessage?: string;
    deferUntilSeconds?: number;
  };

  const validTransitions: HeavyJobStatus[] = ["running", "completed", "failed", "deferred"];
  if (!status || !validTransitions.includes(status as HeavyJobStatus)) {
    res.status(400).json({ error: `status must be one of: ${validTransitions.join(", ")}` }); return;
  }

  switch (status as HeavyJobStatus) {
    case "running":
      await markJobRunning(jobId); break;
    case "completed":
      await markJobCompleted(jobId, result); break;
    case "failed":
      await markJobFailed(jobId, errorMessage ?? "Unknown error"); break;
    case "deferred": {
      const deferUntil = new Date(Date.now() + (deferUntilSeconds ?? 300) * 1000);
      await markJobDeferred(jobId, deferUntil); break;
    }
  }

  const [updated] = await db.select().from(laneHeavyJobsTable)
    .where(eq(laneHeavyJobsTable.id, jobId));
  if (!updated) { res.status(404).json({ error: "Job not found after update" }); return; }

  if (updated.laneId) {
    if (status === "running") {
      emitLaneEvent(sessionId, updated.laneId, "heavy_job_started", {
        jobId,
        jobClass: updated.jobClass,
      });
    } else if (status === "completed") {
      emitLaneEvent(sessionId, updated.laneId, "heavy_job_completed", {
        jobId,
        jobClass: updated.jobClass,
      });
    }
  }

  broadcastCoordinationUpdate(sessionId);
  res.json(serializeJob(updated));
});

// ─── GET /api/sessions/:id/lanes/:laneId/timeline ─────────────────────────────
// Returns paginated lane_events for a specific lane, newest first.
// ?cursor=<id>&limit=<n> — cursor is the lowest event id from the previous page.

router.get("/sessions/:id/lanes/:laneId/timeline", async (req, res) => {
  const sessionId = getSessionId(req);
  const laneId = parseInt(req.params["laneId"] ?? "");
  if (!sessionId || !Number.isFinite(laneId)) {
    res.status(400).json({ error: "Invalid session or lane ID" }); return;
  }

  const [lane] = await db.select({ id: sessionLanesTable.id })
    .from(sessionLanesTable)
    .where(and(eq(sessionLanesTable.id, laneId), eq(sessionLanesTable.sessionId, sessionId)));

  if (!lane) {
    const [historyEvent] = await db.select({ id: laneEventsTable.id })
      .from(laneEventsTable)
      .where(and(eq(laneEventsTable.laneId, laneId), eq(laneEventsTable.sessionId, sessionId)))
      .limit(1);
    if (!historyEvent) { res.status(404).json({ error: "Lane not found" }); return; }
  }

  const rawLimit = parseInt(String(req.query["limit"] ?? ""));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 25;

  const rawCursor = parseInt(String(req.query["cursor"] ?? ""));
  const cursor = Number.isFinite(rawCursor) ? rawCursor : null;

  const conditions = [
    eq(laneEventsTable.laneId, laneId),
    eq(laneEventsTable.sessionId, sessionId),
  ];
  if (cursor != null) {
    conditions.push(lt(laneEventsTable.id, cursor));
  }

  const events = await db
    .select()
    .from(laneEventsTable)
    .where(and(...conditions))
    .orderBy(desc(laneEventsTable.id))
    .limit(limit + 1);

  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(0, limit) : events;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  res.json({
    laneId,
    events: page.map((e) => ({
      id: e.id,
      sessionId: e.sessionId,
      laneId: e.laneId,
      eventType: e.eventType,
      payload: e.payload ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
    nextCursor,
    total: page.length,
  });
});

// ─── Lane Types: auth middleware ───────────────────────────────────────────────
// GET is public (sessions need to list available lane types).
// Mutations require MIZI_MEM_TOKEN bearer auth (operator-only).

router.post("/coordination/lane-types", requireAgentAuth(["coordination:write"]));
router.patch("/coordination/lane-types/:id", requireAgentAuth(["coordination:write"]));
router.delete("/coordination/lane-types/:id", requireAgentAuth(["coordination:write"]));

// ─── GET /api/coordination/lane-types ─────────────────────────────────────────
// Returns built-in types (read-only) merged with operator-defined custom types.

function serializeLaneType(row: typeof customLaneTypesTable.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    maxConcurrentClaims: row.maxConcurrentClaims,
    heavyJobSlots: row.heavyJobSlots,
    isBuiltin: false,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function builtinLaneTypeSummary(name: string) {
  const policy = LANE_POLICIES[name as keyof typeof LANE_POLICIES];
  return {
    id: null,
    name,
    description: policy?.description ?? "",
    maxConcurrentClaims: policy?.limits.maxConcurrentClaims ?? 20,
    heavyJobSlots: policy?.limits.heavyJobSlots ?? 2,
    isBuiltin: true,
    createdAt: null,
    updatedAt: null,
  };
}

router.get("/coordination/lane-types", async (_req, res) => {
  const customs = await db.select().from(customLaneTypesTable).orderBy(asc(customLaneTypesTable.createdAt));
  const builtins = BUILTIN_LANE_TYPE_NAMES.map(builtinLaneTypeSummary);
  res.json({
    builtins,
    custom: customs.map(serializeLaneType),
    all: [...builtins, ...customs.map(serializeLaneType)],
  });
});

// ─── POST /api/coordination/lane-types ────────────────────────────────────────

const RESERVED_LANE_NAMES = new Set(BUILTIN_LANE_TYPE_NAMES);
const LANE_NAME_RE = /^[a-z][a-z0-9_-]{0,49}$/;

router.post("/coordination/lane-types", async (req, res) => {
  const { name, description, maxConcurrentClaims, heavyJobSlots } = req.body as {
    name?: string;
    description?: string;
    maxConcurrentClaims?: number;
    heavyJobSlots?: number;
  };

  if (!name || typeof name !== "string" || !LANE_NAME_RE.test(name)) {
    res.status(400).json({ error: "name must be lowercase letters/numbers/hyphens/underscores, 1-50 chars, starting with a letter" });
    return;
  }
  if (RESERVED_LANE_NAMES.has(name)) {
    res.status(409).json({ error: `'${name}' is a built-in lane type and cannot be used as a custom type name` });
    return;
  }

  const maxClaims = typeof maxConcurrentClaims === "number" && maxConcurrentClaims > 0 ? Math.floor(maxConcurrentClaims) : 20;
  const heavySlots = typeof heavyJobSlots === "number" && heavyJobSlots > 0 ? Math.floor(heavyJobSlots) : 2;

  try {
    const [created] = await db.insert(customLaneTypesTable).values({
      name,
      description: description ?? "",
      maxConcurrentClaims: maxClaims,
      heavyJobSlots: heavySlots,
    }).returning();
    logger.info({ name }, "Custom lane type created");
    res.status(201).json(serializeLaneType(created));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      res.status(409).json({ error: `A custom lane type named '${name}' already exists` });
    } else {
      logger.error({ err }, "Failed to create custom lane type");
      res.status(500).json({ error: "Failed to create lane type" });
    }
  }
});

// ─── PATCH /api/coordination/lane-types/:id ───────────────────────────────────

router.patch("/coordination/lane-types/:id", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "");
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid lane type ID" }); return; }

  const [existing] = await db.select().from(customLaneTypesTable).where(eq(customLaneTypesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Custom lane type not found" }); return; }

  const { description, maxConcurrentClaims, heavyJobSlots } = req.body as {
    description?: string;
    maxConcurrentClaims?: number;
    heavyJobSlots?: number;
  };

  const updates: Partial<typeof customLaneTypesTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof description === "string") updates.description = description;
  if (typeof maxConcurrentClaims === "number" && maxConcurrentClaims > 0) updates.maxConcurrentClaims = Math.floor(maxConcurrentClaims);
  if (typeof heavyJobSlots === "number" && heavyJobSlots > 0) updates.heavyJobSlots = Math.floor(heavyJobSlots);

  const [updated] = await db.update(customLaneTypesTable).set(updates)
    .where(eq(customLaneTypesTable.id, id)).returning();
  logger.info({ id, name: existing.name }, "Custom lane type updated");
  res.json(serializeLaneType(updated));
});

// ─── DELETE /api/coordination/lane-types/:id ──────────────────────────────────
// Blocked if any active lane uses this type.

router.delete("/coordination/lane-types/:id", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "");
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid lane type ID" }); return; }

  const [existing] = await db.select().from(customLaneTypesTable).where(eq(customLaneTypesTable.id, id));
  if (!existing) { res.status(404).json({ error: "Custom lane type not found" }); return; }

  // Check if any non-terminal lane is currently using this type.
  // "Active" means status is not a done/merged/cancelled terminal state.
  const ACTIVE_LANE_STATUSES = ["active", "blocked", "review-needed", "ready-to-merge"] as const;
  const [activeUsage] = await db.select({ id: sessionLanesTable.id })
    .from(sessionLanesTable)
    .where(and(
      eq(sessionLanesTable.laneType, existing.name),
      inArray(sessionLanesTable.status, [...ACTIVE_LANE_STATUSES]),
    ))
    .limit(1);

  if (activeUsage) {
    res.status(409).json({
      error: `Cannot delete lane type '${existing.name}': it is currently in use by one or more active lanes. Change those lanes first.`,
    });
    return;
  }

  await db.delete(customLaneTypesTable).where(eq(customLaneTypesTable.id, id));
  logger.info({ id, name: existing.name }, "Custom lane type deleted");
  res.json({ deleted: true, id, name: existing.name });
});

// ─── GET /api/admin/claim-cleanup-stats ───────────────────────────────────────
// Returns cumulative purge statistics and the 30 most recent purge run records.
// Lets operators verify the purge job is running and detect abnormal accumulation.

router.get("/admin/claim-cleanup-stats", async (_req, res) => {
  try {
    const [aggregate] = await db
      .select({
        totalRuns: sql<number>`count(*)::int`,
        totalRowsDeleted: sql<number>`coalesce(sum(${claimPurgeLogsTable.rowsDeleted}), 0)::int`,
        lastPurgedAt: sql<string | null>`max(${claimPurgeLogsTable.purgedAt})`,
        lastRowsDeleted: sql<number | null>`(array_agg(${claimPurgeLogsTable.rowsDeleted} order by ${claimPurgeLogsTable.purgedAt} desc))[1]`,
      })
      .from(claimPurgeLogsTable);

    const recentRuns = await db
      .select()
      .from(claimPurgeLogsTable)
      .orderBy(desc(claimPurgeLogsTable.purgedAt))
      .limit(30);

    res.json({
      totalRuns: aggregate?.totalRuns ?? 0,
      totalRowsDeleted: aggregate?.totalRowsDeleted ?? 0,
      lastPurgedAt: aggregate?.lastPurgedAt ?? null,
      lastRowsDeleted: aggregate?.lastRowsDeleted ?? null,
      recentRuns: recentRuns.map(r => ({
        id: r.id,
        purgedAt: r.purgedAt.toISOString(),
        rowsDeleted: r.rowsDeleted,
        retentionDays: r.retentionDays,
      })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch claim cleanup stats");
    res.status(500).json({ error: "Failed to fetch claim cleanup stats" });
  }
});

// ─── POST /api/admin/sweep-claims ─────────────────────────────────────────────
// Manual trigger for the background claim sweeper. Useful for debugging or
// for shrinking the ghost-claim window immediately without waiting for the
// next scheduled interval. No session scope: sweeps ALL sessions globally.

router.post("/admin/sweep-claims", async (req, res) => {
  // Auth is enforced by the requireAgentAuth(["coordination:write"]) middleware
  // registered above. The legacy ADMIN_SWEEP_TOKEN/x-admin-token gate is removed
  // so that valid API keys can trigger sweeps without an extra secret.
  try {
    const result = await sweepExpiredClaims();
    logger.info(result, "Manual claim sweep triggered via admin endpoint");
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Manual claim sweep failed");
    res.status(500).json({ error: "Sweep failed" });
  }
});

// ─── GET /api/sessions/:id/coordination/stream ────────────────────────────────
// SSE endpoint: pushes a `coordination_update` event whenever lanes, claims,
// conflicts, handoffs, or heavy jobs change for this session.

router.get("/sessions/:id/coordination/stream", (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) { res.status(400).json({ error: "Invalid session ID" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  addCoordinationClient(sessionId, res);

  const keepAlive = setInterval(() => {
    try { res.write("event: ping\ndata: {}\n\n"); } catch { /* ignore */ }
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    removeCoordinationClient(sessionId, res);
  });
});

export { router as coordinationRouter };
export default router;
