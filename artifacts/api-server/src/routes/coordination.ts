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
import {
  db,
  sessionLanesTable,
  laneClaimsTable,
  laneHandoffsTable,
  laneHeavyJobsTable,
  sessionsTable,
  sessionRepoContextTable,
  claimPurgeLogsTable,
} from "@workspace/db";
import { eq, and, desc, inArray, asc, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  getLanePolicy,
  VALID_LANE_TYPES,
  computeClaimOverlap,
  estimateBlastRadiusOverlap,
  LANE_DEFAULT_TTL_SECONDS,
} from "../services/lane-policy";
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
import type { HeavyJobClass, HeavyJobStatus, HandoffType, ClaimType, SessionLane, LaneClaim, LaneHandoff, LaneHeavyJob } from "@workspace/db";

const router = Router({ mergeParams: true });

// ─── SSE broadcaster for real-time Team tab updates ───────────────────────────

type SseClient = import("express").Response;
const coordinationClients = new Map<number, Set<SseClient>>();

function addCoordinationClient(sessionId: number, res: SseClient): void {
  let clients = coordinationClients.get(sessionId);
  if (!clients) {
    clients = new Set();
    coordinationClients.set(sessionId, clients);
  }
  clients.add(res);
}

function removeCoordinationClient(sessionId: number, res: SseClient): void {
  const clients = coordinationClients.get(sessionId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) coordinationClients.delete(sessionId);
  }
}

function broadcastCoordinationUpdate(sessionId: number): void {
  const clients = coordinationClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify({ type: "coordination_update", sessionId })}\n\n`;
  const dead: SseClient[] = [];
  for (const res of clients) {
    try { res.write(payload); } catch { dead.push(res); }
  }
  for (const res of dead) clients.delete(res);
  if (clients.size === 0) coordinationClients.delete(sessionId);
}

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
  return {
    id: claim.id,
    laneId: claim.laneId,
    memberIdentifier,
    claimType: claim.claimType,
    resourcePath: claim.pathOrSymbol,
    symbolName: null,
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
    const policy = getLanePolicy(lane.laneType);
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

  const resolvedLaneType = laneType && VALID_LANE_TYPES.includes(laneType as typeof VALID_LANE_TYPES[number])
    ? laneType : "general";

  const policy = getLanePolicy(resolvedLaneType);

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
  if (laneType && VALID_LANE_TYPES.includes(laneType as typeof VALID_LANE_TYPES[number])) updates.laneType = laneType;
  if (status && VALID_LANE_STATUSES.includes(status as typeof VALID_LANE_STATUSES[number])) updates.status = status;
  if (tokenMode) updates.tokenMode = tokenMode;
  if (currentTask !== undefined) updates.currentTask = currentTask;

  const [updated] = await db.update(sessionLanesTable).set(updates)
    .where(eq(sessionLanesTable.id, laneId)).returning();

  broadcastCoordinationUpdate(sessionId);
  res.json(serializeLane(updated));
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

  const { claimType, resourcePath, strength, ttlSeconds, preserveHistory } = req.body as {
    claimType?: ClaimType;
    resourcePath?: string;
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
  };
  const overlaps: OverlapItem[] = [];

  if (conflictingLaneIds.length > 0) {
    const otherClaims = await db.select()
      .from(laneClaimsTable)
      .where(and(
        inArray(laneClaimsTable.laneId, conflictingLaneIds),
        eq(laneClaimsTable.active, true),
      ));

    const claimsByLane = new Map<number, string[]>();
    for (const c of otherClaims) {
      const paths = claimsByLane.get(c.laneId) ?? [];
      paths.push(c.pathOrSymbol);
      claimsByLane.set(c.laneId, paths);
    }

    for (const [otherId, otherPaths] of claimsByLane.entries()) {
      const overlapScore = computeClaimOverlap([resourcePath], otherPaths);
      const blastRadiusOverlap = 0; // no graph data at claim time
      if (overlapScore > 0) {
        const laneInfo = otherLanes.find(l => l.id === otherId);
        const recommendation: "no_conflict" | "warn" | "block" =
          overlapScore >= 0.75 ? "block" : overlapScore >= 0.4 ? "warn" : "no_conflict";
        overlaps.push({
          conflictingLaneId: otherId,
          conflictingMember: laneInfo?.memberIdentifier ?? "unknown",
          overlapScore: Math.round(overlapScore * 100) / 100,
          blastRadiusOverlap,
          recommendation,
        });
      }
    }
  }

  const overallRecommendation: "no_conflict" | "warn" | "block" =
    overlaps.some(o => o.recommendation === "block") ? "block"
    : overlaps.some(o => o.recommendation === "warn") ? "warn"
    : "no_conflict";

  broadcastCoordinationUpdate(sessionId);
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

  broadcastCoordinationUpdate(sessionId);
  logger.info({ handoffId: handoff.id, laneId, handoffType }, "Lane handoff signal created");
  res.status(201).json(serializeHandoff(handoff));
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
  };
  const conflicts: ConflictItem[] = [];

  const laneList = Array.from(claimsByLane.keys());
  for (let i = 0; i < laneList.length; i++) {
    for (let j = i + 1; j < laneList.length; j++) {
      const idA = laneList[i]!;
      const idB = laneList[j]!;
      const claimsA = (claimsByLane.get(idA) ?? []).map(c => c.pathOrSymbol);
      const claimsB = (claimsByLane.get(idB) ?? []).map(c => c.pathOrSymbol);

      const overlapScore = computeClaimOverlap(claimsA, claimsB);
      const blastRadiusOverlap = estimateBlastRadiusOverlap(claimsA, claimsB, repoEdges);

      if (overlapScore > 0 || blastRadiusOverlap > 0) {
        const laneA = lanes.find(l => l.id === idA);
        const laneB = lanes.find(l => l.id === idB);
        const conflicting = claimsA.filter(a => {
          const aNorm = a.toLowerCase();
          return claimsB.some(b => {
            const bNorm = b.toLowerCase();
            return aNorm === bNorm || aNorm.startsWith(bNorm + "/") || bNorm.startsWith(aNorm + "/");
          });
        });

        const recommendation: "no_conflict" | "warn" | "block" =
          overlapScore >= 0.75 ? "block" : overlapScore >= 0.4 ? "warn" : "no_conflict";
        const detail = overlapScore >= 0.75
          ? "High overlap: coordinate with the other lane before proceeding"
          : blastRadiusOverlap > 0
            ? "Blast-radius overlap detected: shared dependencies may cause conflicts"
            : "Low overlap: worth monitoring";

        conflicts.push({
          laneIdA: idA,
          laneIdB: idB,
          memberA: laneA?.memberIdentifier ?? "unknown",
          memberB: laneB?.memberIdentifier ?? "unknown",
          overlapScore: Math.round(overlapScore * 100) / 100,
          blastRadiusOverlap: Math.round(blastRadiusOverlap * 100) / 100,
          conflictingResources: conflicting,
          recommendation,
          detail,
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

  broadcastCoordinationUpdate(sessionId);
  res.json(serializeJob(updated));
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
  const adminToken = process.env.ADMIN_SWEEP_TOKEN;
  if (!adminToken || req.headers["x-admin-token"] !== adminToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
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
