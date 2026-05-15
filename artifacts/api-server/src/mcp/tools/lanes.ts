import { z } from "zod";
import { db, sessionLanesTable, laneClaimsTable, laneHandoffsTable, sessionsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveValidLaneType, getLanePolicyAsync, LANE_DEFAULT_TTL_SECONDS } from "../../services/lane-policy.js";
import type { ClaimType } from "@workspace/db";

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
    const [lane] = await db.select().from(sessionLanesTable)
      .where(and(eq(sessionLanesTable.id, laneId), eq(sessionLanesTable.sessionId, sessionId)));
    if (!lane) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Lane not found" }) }] };
    }

    const [handoff] = await db.insert(laneHandoffsTable).values({
      sessionId,
      laneId,
      handoffType: handoffType as "blocked" | "needs_review" | "safe_to_merge" | "watch_files" | "related_lane",
      watchFiles: { toLaneIds: toLaneIds ?? [], resourcePaths: resourcePaths ?? [] },
      notes: message ?? null,
      status: "pending",
    }).returning();

    return { content: [{ type: "text", text: JSON.stringify({ handoffId: handoff.id, laneId, handoffType, status: "pending" }, null, 2) }] };
  });
}
