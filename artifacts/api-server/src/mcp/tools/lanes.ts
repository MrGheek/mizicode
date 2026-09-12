import { z } from "zod";
import { db, sessionLanesTable, laneClaimsTable, laneHandoffsTable, sessionsTable } from "@workspace/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveValidLaneType, getLanePolicyAsync, LANE_DEFAULT_TTL_SECONDS } from "../../services/lane-policy.js";
import { checkLanePermission } from "../../services/lane-governor.js";
import { getLaneBranchName, getSessionBranchName } from "../../services/lane-branch.js";
import type { ClaimType } from "@workspace/db";

const VALID_INTENT_TYPES = ["intent_decision", "intent_interface_change", "intent_warning", "intent_verification"] as const;
const VALID_RESOLUTION_OUTCOMES = ["preserved_both", "chose_one", "escalated"] as const;

/**
 * RFC 0002 Phase 3 — enforce the lane's permission profile before a tool acts.
 * Returns a denial message when the lane type may not call this tool (or touch
 * the path); null when allowed.
 */
async function permissionDenial(
  sessionId: number,
  laneId: number,
  toolName: string,
  path?: string | null,
): Promise<string | null> {
  const [lane] = await db.select({ laneType: sessionLanesTable.laneType })
    .from(sessionLanesTable)
    .where(and(eq(sessionLanesTable.id, laneId), eq(sessionLanesTable.sessionId, sessionId)));
  if (!lane) return "Lane not found";
  const check = checkLanePermission(lane.laneType, toolName, path);
  return check.allowed ? null : check.reason;
}

export function registerLaneTools(server: McpServer): void {
  server.registerTool("list_lanes", {
    description: "[Read] List active lanes in a session.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
    }),
  }, async ({ sessionId }) => {
    const lanes = await db.select()
      .from(sessionLanesTable)
      .where(eq(sessionLanesTable.sessionId, sessionId))
      .orderBy(desc(sessionLanesTable.createdAt));

    const lanesWithClaims = await Promise.all(lanes.map(async (lane) => {
      const claims = await db.select().from(laneClaimsTable)
        .where(and(eq(laneClaimsTable.laneId, lane.id), eq(laneClaimsTable.active, true)));
      const policy = await getLanePolicyAsync(lane.laneType);
      return {
        id: lane.id,
        sessionId: lane.sessionId,
        memberIdentifier: lane.memberIdentifier,
        laneType: lane.laneType,
        status: lane.status,
        currentTask: lane.currentTask,
        tokenMode: lane.tokenMode,
        createdAt: lane.createdAt,
        updatedAt: lane.updatedAt,
        policy,
        claimCount: claims.length,
      };
    }));

    return { content: [{ type: "text", text: JSON.stringify({ sessionId, lanes: lanesWithClaims, total: lanesWithClaims.length }, null, 2) }] };
  });

  server.registerTool("create_lane", {
    description: "[Write] Create a new lane for a specific agent/role in a session.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
      memberIdentifier: z.string().describe("Agent/role identifier for this lane"),
      laneType: z.string().optional().describe("Lane type (coding, review, ux, etc.)"),
      tokenMode: z.string().optional().describe("Token mode for this lane"),
      currentTask: z.string().optional().describe("Current task description"),
    }),
  }, async ({ sessionId, memberIdentifier, laneType, tokenMode, currentTask }) => {
    const [session] = await db.select({ id: sessionsTable.id }).from(sessionsTable).where(eq(sessionsTable.id, sessionId));
    if (!session) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Session not found" }) }] };
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

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          id: lane.id,
          sessionId: lane.sessionId,
          memberIdentifier: lane.memberIdentifier,
          laneType: lane.laneType,
          status: lane.status,
          policy,
        }, null, 2),
      }],
    };
  });

  server.registerTool("claim_resource", {
    description: "[Write] Claim a file or symbol with a strength level (watching/editing/owner) in a lane.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
      laneId: z.number().int().describe("Lane ID"),
      resourcePath: z.string().describe("File path or symbol to claim"),
      strength: z.number().min(0).max(1).optional().describe("Claim strength: 0-0.4=watching, 0.4-0.75=editing, 0.75-1=owner"),
      claimType: z.enum(["file", "symbol", "directory"]).optional().describe("Type of resource being claimed"),
      ttlSeconds: z.number().int().optional().describe("Claim TTL in seconds"),
    }),
  }, async ({ sessionId, laneId, resourcePath, strength, claimType, ttlSeconds }) => {
    const denied = await permissionDenial(sessionId, laneId, "claim_resource", resourcePath);
    if (denied) {
      return { content: [{ type: "text", text: JSON.stringify({ error: denied }) }] };
    }

    const [lane] = await db.select().from(sessionLanesTable)
      .where(and(eq(sessionLanesTable.id, laneId), eq(sessionLanesTable.sessionId, sessionId)));
    if (!lane) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Lane not found" }) }] };
    }

    const resolvedStrength = typeof strength === "number" ? Math.max(0, Math.min(1, strength)) : 0.3;
    const claimStrength: "watching" | "editing" | "owner" = resolvedStrength >= 0.75 ? "owner" : resolvedStrength >= 0.4 ? "editing" : "watching";
    const ttl = typeof ttlSeconds === "number" && ttlSeconds > 0 ? ttlSeconds : LANE_DEFAULT_TTL_SECONDS;
    const now = new Date();
    const expiresAt = new Date(Date.now() + ttl * 1000);

    const [claim] = await db.insert(laneClaimsTable).values({
      laneId,
      claimType: (claimType ?? "file") as ClaimType,
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
        claimStrength,
        lastHeartbeatAt: now,
        expiresAt,
      },
    }).returning();

    return { content: [{ type: "text", text: JSON.stringify({ claim: { id: claim.id, laneId, resourcePath, claimStrength, expiresAt } }, null, 2) }] };
  });

  server.registerTool("lane_handoff", {
    description: "[Write] Signal task completion or blocking to other lanes.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
      laneId: z.number().int().describe("Source lane ID"),
      handoffType: z.enum(["blocked", "needs_review", "safe_to_merge", "watch_files", "related_lane"]).describe("Type of handoff signal"),
      toLaneIds: z.array(z.number().int()).optional().describe("Target lane IDs"),
      resourcePaths: z.array(z.string()).optional().describe("Relevant file paths"),
      message: z.string().optional().describe("Human-readable message"),
    }),
  }, async ({ sessionId, laneId, handoffType, toLaneIds, resourcePaths, message }) => {
    const denied = await permissionDenial(sessionId, laneId, "lane_handoff");
    if (denied) {
      return { content: [{ type: "text", text: JSON.stringify({ error: denied }) }] };
    }

    const [lane] = await db.select().from(sessionLanesTable)
      .where(and(eq(sessionLanesTable.id, laneId), eq(sessionLanesTable.sessionId, sessionId)));
    if (!lane) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Lane not found" }) }] };
    }

    const [handoff] = await db.insert(laneHandoffsTable).values({
      laneId,
      handoffType: handoffType as "blocked" | "needs_review" | "safe_to_merge" | "watch_files" | "related_lane",
      watchFiles: { toLaneIds: toLaneIds ?? [], resourcePaths: resourcePaths ?? [] },
      notes: message ?? null,
      status: "pending",
    }).returning();

    return { content: [{ type: "text", text: JSON.stringify({ handoffId: handoff.id, laneId, handoffType, status: "pending" }, null, 2) }] };
  });

  server.registerTool("merge_lane", {
    description: "[Write] Enqueue a lane's branch into the risk-sequenced merge queue (RFC 0002 Phase 1). The queue drains smallest/lowest-risk first.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
      laneId: z.number().int().describe("Lane ID"),
      handoffId: z.number().int().optional().describe("Handoff ID that triggered the merge"),
      headBranch: z.string().optional().describe("Lane branch to merge (defaults to the lane's branch name)"),
      baseBranch: z.string().optional().describe("Integration branch (defaults to the session branch)"),
      riskScore: z.number().min(0).max(1).optional().describe("Merge risk score; lower merges sooner"),
    }),
  }, async ({ sessionId, laneId, handoffId, headBranch, baseBranch, riskScore }) => {
    const denied = await permissionDenial(sessionId, laneId, "merge_lane");
    if (denied) {
      return { content: [{ type: "text", text: JSON.stringify({ error: denied }) }] };
    }

    const [lane] = await db.select().from(sessionLanesTable)
      .where(and(eq(sessionLanesTable.id, laneId), eq(sessionLanesTable.sessionId, sessionId)));
    if (!lane) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Lane not found" }) }] };
    }

    const { createDbMergeQueueStore } = await import("../../services/lane-merge.js");
    const resolvedHead = headBranch ?? getLaneBranchName(sessionId, lane.memberIdentifier);
    const resolvedBase = baseBranch ?? getSessionBranchName(sessionId);

    const job = await createDbMergeQueueStore().enqueue({
      sessionId,
      laneId,
      handoffId: handoffId ?? null,
      headBranch: resolvedHead,
      baseBranch: resolvedBase,
      riskScore: riskScore ?? 0.5,
    });

    await db.update(sessionLanesTable)
      .set({ status: "ready-to-merge", updatedAt: new Date() })
      .where(eq(sessionLanesTable.id, laneId));

    return { content: [{ type: "text", text: JSON.stringify({ job, laneId, status: "queued" }, null, 2) }] };
  });

  server.registerTool("publish_intent", {
    description: "[Write] Publish a durable, typed intent event for a lane (decisions, contract changes, warnings, verification).",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
      laneId: z.number().int().describe("Lane ID"),
      eventType: z.enum(VALID_INTENT_TYPES).describe("Type of intent event"),
      summary: z.string().describe("Human-readable summary of the intent"),
      file: z.string().optional().describe("File the intent concerns"),
      contract: z.string().optional().describe("Interface-change contract, e.g. UserIdentity(providerType, providerId)"),
      risk: z.string().optional().describe("Warning risk description"),
      evidence: z.string().optional().describe("Verification evidence"),
    }),
  }, async ({ sessionId, laneId, eventType, summary, file, contract, risk, evidence }) => {
    const denied = await permissionDenial(sessionId, laneId, "publish_intent");
    if (denied) {
      return { content: [{ type: "text", text: JSON.stringify({ error: denied }) }] };
    }

    const lane = await db.select({ id: sessionLanesTable.id }).from(sessionLanesTable)
      .where(and(eq(sessionLanesTable.id, laneId), eq(sessionLanesTable.sessionId, sessionId)));
    if (!lane[0]) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Lane not found" }) }] };
    }

    const { createDbIntentStore } = await import("../../services/lane-intent.js");
    const event = await createDbIntentStore().publish({
      sessionId,
      laneId,
      eventType,
      summary,
      file: file ?? null,
      contract: contract ?? null,
      risk: risk ?? null,
      evidence: evidence ?? null,
    });

    return { content: [{ type: "text", text: JSON.stringify({ event }, null, 2) }] };
  });

  server.registerTool("resolve_conflict", {
    description: "[Write] Record how a merge conflict was resolved, with the intent that drove it (RFC 0002 Phase 2).",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
      filePath: z.string().describe("File where the conflict occurred"),
      outcome: z.enum(VALID_RESOLUTION_OUTCOMES).describe("How it was resolved"),
      summary: z.string().describe("Summary of the resolution"),
      mergeJobId: z.number().int().optional().describe("Merge job this resolution belongs to"),
      intentEventIds: z.array(z.number().int()).optional().describe("Intent events that informed the resolution"),
      testVerified: z.boolean().optional().describe("Whether the resolution passed the test gate"),
    }),
  }, async ({ sessionId, filePath, outcome, summary, mergeJobId, intentEventIds, testVerified }) => {
    const { createDbResolutionStore } = await import("../../services/lane-intent.js");
    const resolution = await createDbResolutionStore().record({
      sessionId,
      mergeJobId: mergeJobId ?? null,
      filePath,
      outcome,
      summary,
      intentEventIds: intentEventIds ?? [],
      testVerified: testVerified ?? false,
    });

    return { content: [{ type: "text", text: JSON.stringify({ resolution }, null, 2) }] };
  });

  server.registerTool("reconcile", {
    description: "[Write] Run the post-session reconcile pass: surface orphan claims, uncommitted lanes, ghost worktrees, and goal gaps.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
    }),
  }, async ({ sessionId }) => {
    const { reconcileSession } = await import("../../services/lane-governor.js");

    const lanes = await db.select({ id: sessionLanesTable.id }).from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, sessionId));
    const laneIds = lanes.map((l) => l.id);
    const orphanClaims = laneIds.length === 0
      ? 0
      : (await db.select({ id: laneClaimsTable.id }).from(laneClaimsTable)
          .where(and(eq(laneClaimsTable.active, true), inArray(laneClaimsTable.laneId, laneIds)))).length;

    const uncommitted = laneIds.length === 0
      ? []
      : (await db.select({ memberIdentifier: sessionLanesTable.memberIdentifier }).from(sessionLanesTable)
          .where(and(eq(sessionLanesTable.sessionId, sessionId), eq(sessionLanesTable.status, "active"))))
          .map((l) => l.memberIdentifier);

    const result = reconcileSession({
      orphanClaims,
      uncommittedLanes: uncommitted,
      ghostWorktrees: [],
      goalGaps: [],
    });

    return { content: [{ type: "text", text: JSON.stringify({ sessionId, result }, null, 2) }] };
  });

  server.registerTool("takeover", {
    description: "[Write] Evidence-based lane takeover: adopt another lane's work after the previous lane is provably dead (stale heartbeat + no live process + stale lock).",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
      fromLaneId: z.number().int().describe("Lane being taken over (presumed dead)"),
      toLaneId: z.number().int().describe("Lane taking over"),
      reason: z.string().describe("Why the takeover is happening"),
      evidence: z.object({
        heartbeatStale: z.boolean().describe("Previous lane's claims have heartbeat-stale timestamps"),
        noLiveProcess: z.boolean().describe("No live process is associated with the previous lane"),
        lockStale: z.boolean().describe("Previous lane's lock is older than the takeover window"),
      }).describe("Evidence the previous lane is dead"),
    }),
  }, async ({ sessionId, fromLaneId, toLaneId, reason, evidence }) => {
    const denied = await permissionDenial(sessionId, toLaneId, "takeover");
    if (denied) {
      return { content: [{ type: "text", text: JSON.stringify({ error: denied }) }] };
    }

    const { createDbGovernanceStore, takeoverLane } = await import("../../services/lane-governor.js");
    const result = await takeoverLane(createDbGovernanceStore(), {
      sessionId,
      fromLaneId,
      toLaneId,
      reason,
      evidence: {
        heartbeatStale: evidence.heartbeatStale,
        noLiveProcess: evidence.noLiveProcess,
        lockStale: evidence.lockStale,
      },
    });

    return { content: [{ type: "text", text: JSON.stringify({ sessionId, result }, null, 2) }] };
  });
}
